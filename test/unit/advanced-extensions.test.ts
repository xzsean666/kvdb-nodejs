import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { KVDB } from "../../src/core/kvdb.js";
import { PubSubManager } from "../../src/pubsub/pubsub.js";
import { BlobStorage } from "../../src/blob/blob.js";
import { MetricsCollector } from "../../src/metrics/metrics.js";

describe("Advanced Productivity Extensions (TASK-036)", () => {
  let db: KVDB;

  beforeEach(async () => {
    db = new KVDB({ driver: "sqlite", url: ":memory:" });
    await db.connect();
  });

  afterEach(async () => {
    await db?.close();
  });

  describe("1. Soft Delete & Restore (docs/SPEC.md §23)", () => {
    it("handles soft delete, querying, restoring, and hard deletion", async () => {
      const table = db.table<{ id: string; name: string }>("users", {
        softDelete: true,
      });

      expect(table.softDeleteEnabled).toBe(true);

      // Create record
      await table.set("u1", { id: "u1", name: "Alice" });
      expect(await table.get("u1")).toEqual({ id: "u1", name: "Alice" });
      expect(await table.exists("u1")).toBe(true);
      expect(await table.isDeleted("u1")).toBe(false);

      // Logical soft delete
      const deleted = await table.delete("u1");
      expect(deleted).toBe(true);

      // Normal read sees non-existent
      expect(await table.get("u1")).toBeUndefined();
      expect(await table.exists("u1")).toBe(false);
      expect(await table.isDeleted("u1")).toBe(true);

      // Find queries exclude soft-deleted
      const found = await table.find();
      expect(found).toHaveLength(0);
      expect(await table.count()).toBe(0);

      // Bypass with includeDeleted: true
      const withDeleted = await table.get("u1", { includeDeleted: true });
      expect(withDeleted).toBeDefined();
      expect(withDeleted?.id).toBe("u1");
      expect((withDeleted as any)?._deletedAt).toBeTypeOf("number");

      const foundWithDeleted = await table.find({ includeDeleted: true });
      expect(foundWithDeleted).toHaveLength(1);
      expect(foundWithDeleted[0]?.key).toBe("u1");

      // Restore
      const restored = await table.restore("u1");
      expect(restored).toBe(true);
      expect(await table.isDeleted("u1")).toBe(false);
      expect(await table.get("u1")).toEqual({ id: "u1", name: "Alice" });
      expect(await table.count()).toBe(1);

      // Hard delete removes physically
      const hardDeleted = await table.hardDelete("u1");
      expect(hardDeleted).toBe(true);
      expect(await table.get("u1", { includeDeleted: true })).toBeUndefined();
      expect(await table.isDeleted("u1")).toBe(false);
    });

    it("supports soft deleting primitive values", async () => {
      const table = db.table<string>("settings", { softDelete: true });
      await table.set("theme", "dark");
      expect(await table.get("theme")).toBe("dark");

      await table.delete("theme");
      expect(await table.get("theme")).toBeUndefined();
      expect(await table.isDeleted("theme")).toBe(true);

      await table.restore("theme");
      expect(await table.get("theme")).toBe("dark");
    });
  });

  describe("2. Pub/Sub & Key Watching (docs/SPEC.md §24)", () => {
    it("publishes and subscribes to events across channels with isolation", async () => {
      const ps = db.pubsub();
      expect(ps).toBeInstanceOf(PubSubManager);

      const receivedA: string[] = [];
      const receivedB: string[] = [];

      const subA = await ps.subscribe<string>("orders", (payload) => {
        receivedA.push(payload);
      });

      const subB = await ps.subscribe<string>("alerts", (payload) => {
        receivedB.push(payload);
      });

      await ps.publish("orders", "order_101");
      await ps.publish("alerts", "cpu_high");
      await ps.publish("orders", "order_102");

      expect(receivedA).toEqual(["order_101", "order_102"]);
      expect(receivedB).toEqual(["cpu_high"]);

      await subA.unsubscribe();
      await ps.publish("orders", "order_103");
      expect(receivedA).toEqual(["order_101", "order_102"]); // No new events

      await subB.unsubscribe();
    });

    it("watches key mutations with table.watch()", async () => {
      const table = db.table<{ count: number }>("counters");
      const keyEvents: any[] = [];
      const wildcardEvents: any[] = [];

      const subKey = await table.watch("c1", (evt) => {
        keyEvents.push(evt);
      });

      const subWildcard = await table.watch("*", (evt) => {
        wildcardEvents.push(evt);
      });

      await table.set("c1", { count: 1 });
      await table.set("c2", { count: 10 });
      await table.delete("c1");

      // Specific key subscriber received c1 mutations
      expect(keyEvents).toHaveLength(2);
      expect(keyEvents[0]).toMatchObject({ key: "c1", type: "set", value: { count: 1 } });
      expect(keyEvents[1]).toMatchObject({ key: "c1", type: "delete" });

      // Wildcard subscriber received both c1 and c2 mutations
      expect(wildcardEvents).toHaveLength(3);
      expect(wildcardEvents.map((e) => e.key)).toEqual(["c1", "c2", "c1"]);

      await subKey.unsubscribe();
      await subWildcard.unsubscribe();
    });
  });

  describe("3. Chunked Blob Storage (docs/SPEC.md §25)", () => {
    it("stores and reassembles large binary buffers in chunks", async () => {
      const table = db.table("assets");

      // Generate a 1 MB payload of pseudo-random bytes
      const original = Buffer.alloc(1024 * 1024);
      for (let i = 0; i < original.length; i++) {
        original[i] = i % 256;
      }

      // Write with 256KB chunks (total 4 chunks)
      const meta = await table.putBlob("sample.bin", original, {
        chunkSize: 256 * 1024,
        contentType: "application/octet-stream",
      });

      expect(meta.key).toBe("sample.bin");
      expect(meta.size).toBe(1024 * 1024);
      expect(meta.chunkSize).toBe(256 * 1024);
      expect(meta.totalChunks).toBe(4);
      expect(meta.contentType).toBe("application/octet-stream");

      // Read metadata manifest
      const readMeta = await table.getBlobMeta("sample.bin");
      expect(readMeta).toEqual(meta);

      // Reassemble and compare bit-for-bit
      const retrieved = await table.getBlob("sample.bin");
      expect(retrieved).toBeDefined();
      expect(retrieved!.length).toBe(original.length);
      expect(Buffer.compare(original, retrieved!)).toBe(0);

      // Delete blob and all its chunks
      const deleted = await table.deleteBlob("sample.bin");
      expect(deleted).toBe(true);

      expect(await table.getBlobMeta("sample.bin")).toBeUndefined();
      expect(await table.getBlob("sample.bin")).toBeUndefined();
    });

    it("handles zero-length blobs and string payloads", async () => {
      const table = db.table("docs");

      // Zero-length
      const emptyMeta = await table.putBlob("empty.txt", Buffer.alloc(0));
      expect(emptyMeta.size).toBe(0);
      const emptyRetrieved = await table.getBlob("empty.txt");
      expect(emptyRetrieved?.length).toBe(0);

      // String payload
      const strData = "Hello World! 🚀".repeat(100);
      await table.putBlob("greeting.txt", strData, { contentType: "text/plain" });
      const strRetrieved = await table.getBlob("greeting.txt");
      expect(strRetrieved?.toString("utf8")).toBe(strData);
    });
  });

  describe("4. Observability & Metrics (docs/SPEC.md §26)", () => {
    it("tracks reads, writes, deletes, cache hit ratio, and latency", async () => {
      const dbWithCache = new KVDB({
        driver: "sqlite",
        url: ":memory:",
        cache: { driver: "memory" },
      });
      await dbWithCache.connect();

      const table = dbWithCache.table<{ val: number }>("metrics_test");

      // Initial clean metrics
      const initialMetrics = dbWithCache.getMetrics();
      expect(initialMetrics.reads).toBe(0);
      expect(initialMetrics.writes).toBe(0);
      expect(initialMetrics.deletes).toBe(0);

      // Perform writes
      await table.set("k1", { val: 1 });
      await table.set("k2", { val: 2 });

      // First read: cache hit (cache was primed by set)
      const r1 = await table.get("k1");
      expect(r1).toEqual({ val: 1 });

      // Delete
      await table.delete("k2");

      const snapshot = dbWithCache.getMetrics();
      expect(snapshot.writes).toBe(2);
      expect(snapshot.reads).toBe(1);
      expect(snapshot.deletes).toBe(1);
      expect(snapshot.cacheHits).toBe(1);
      expect(snapshot.cacheHitRatio).toBe(1);
      expect(snapshot.latency.avgMs).toBeGreaterThanOrEqual(0);

      // Real-time metric hook
      const capturedHooks: any[] = [];
      const unhook = dbWithCache.metrics.onMetric((event) => {
        capturedHooks.push(event);
      });

      await table.set("k3", { val: 3 });
      expect(capturedHooks).toHaveLength(1);
      expect(capturedHooks[0]).toMatchObject({
        type: "write",
        key: "k3",
        success: true,
      });

      unhook();
      await table.set("k4", { val: 4 });
      expect(capturedHooks).toHaveLength(1); // Hook removed

      // Reset
      dbWithCache.resetMetrics();
      const resetSnapshot = dbWithCache.getMetrics();
      expect(resetSnapshot.writes).toBe(0);
      expect(resetSnapshot.reads).toBe(0);

      await dbWithCache.close();
    });
  });
});
