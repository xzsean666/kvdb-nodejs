import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { KVDB } from "../../src/core/kvdb.js";
import { WriteBatcher, compareKeysDeterministic, sanitizeSecondaryKeys } from "../../src/core/batcher.js";
import type { MultiKeySchema } from "../../src/core/table-schema.js";
import { KvdbError } from "../../src/core/errors.js";

describe("TASK-029: Auto Batch & Write Coalescing Engine", () => {
  let db: KVDB;

  beforeEach(() => {
    db = new KVDB({ driver: "sqlite", url: ":memory:" });
  });

  afterEach(async () => {
    await db.close();
  });

  describe("1. Deterministic Sorting & Security Sanitization", () => {
    it("sorts keys deterministically to eliminate row-lock deadlocks in PostgreSQL", () => {
      const keys = ["user:99", "user:1", "user:50", "user:10"];
      const sorted = [...keys].sort(compareKeysDeterministic);
      expect(sorted).toEqual(["user:1", "user:10", "user:50", "user:99"]);

      const numKeys = [99, 1, 50, 10];
      const numSorted = [...numKeys].sort(compareKeysDeterministic);
      expect(numSorted).toEqual([1, 10, 50, 99]);
    });

    it("sanitizes prototype pollution keys from secondary keys", () => {
      const malicious = JSON.parse('{"role":"admin","__proto__":{"polluted":true},"constructor":{"bad":1},"prototype":{}}');
      const clean = sanitizeSecondaryKeys(malicious);
      expect(clean).toBeDefined();
      expect(clean).toEqual({ role: "admin" });
      expect((Object.prototype as any).polluted).toBeUndefined();
    });
  });

  describe("2. WriteBatcher Unit Mechanics", () => {
    it("accumulates writes and auto-flushes on timer window", async () => {
      let flushedCount = 0;
      const batcher = new WriteBatcher<string>(
        async (payload) => {
          flushedCount += payload.sets.length;
        },
        { maxBatchSize: 10, maxWaitMs: 30 },
      );

      const p1 = batcher.enqueue({ key: "k1", value: "v1" });
      const p2 = batcher.enqueue({ key: "k2", value: "v2" });
      expect(batcher.pendingCount).toBe(2);
      expect(flushedCount).toBe(0);

      await Promise.all([p1, p2]);
      expect(flushedCount).toBe(2);
      expect(batcher.pendingCount).toBe(0);
    });

    it("immediately flushes when maxBatchSize threshold is reached", async () => {
      let flushedCount = 0;
      const batcher = new WriteBatcher<number>(
        async (payload) => {
          flushedCount += payload.sets.length;
        },
        { maxBatchSize: 3, maxWaitMs: 1000 },
      );

      const p1 = batcher.enqueue({ key: "k1", value: 1 });
      const p2 = batcher.enqueue({ key: "k2", value: 2 });
      expect(flushedCount).toBe(0);

      const p3 = batcher.enqueue({ key: "k3", value: 3 }); // Hits maxBatchSize=3 immediately
      await Promise.all([p1, p2, p3]);
      expect(flushedCount).toBe(3);
      expect(batcher.pendingCount).toBe(0);
    });

    it("propagates errors to all callers without swallowing", async () => {
      const testErr = new Error("Database connection dropped");
      const batcher = new WriteBatcher<number>(
        async () => {
          throw testErr;
        },
        { maxBatchSize: 2, maxWaitMs: 50 },
      );

      const p1 = batcher.enqueue({ key: "k1", value: 1 });
      const p2 = batcher.enqueue({ key: "k2", value: 2 });

      await expect(p1).rejects.toThrow("Database connection dropped");
      await expect(p2).rejects.toThrow("Database connection dropped");
      expect(batcher.isFlushingNow).toBe(false);
    });

    it("applies backpressure flush when buffer exceeds maxBufferSize", async () => {
      let flushCount = 0;
      const batcher = new WriteBatcher<number>(
        async (payload) => {
          flushCount += payload.sets.length;
        },
        { maxBatchSize: 2, maxBufferSize: 4, maxWaitMs: 500 },
      );

      // Enqueue 4 items rapidly
      const promises = [
        batcher.enqueue({ key: "k1", value: 1 }),
        batcher.enqueue({ key: "k2", value: 2 }),
        batcher.enqueue({ key: "k3", value: 3 }),
        batcher.enqueue({ key: "k4", value: 4 }),
      ];

      // Next item triggers immediate backpressure flush
      const p5 = batcher.enqueue({ key: "k5", value: 5 });
      promises.push(p5);

      await Promise.all(promises);
      expect(flushCount).toBe(5);
    });
  });

  describe("3. Table Integration with AutoBatch (Standard KV)", () => {
    it("batches concurrent writes and supports manual table.flush()", async () => {
      const table = db.table<string>("batched_kv", {
        autoBatch: { maxBatchSize: 100, maxWaitMs: 200 },
      });

      const p1 = table.set("k1", "val1");
      const p2 = table.set("k2", "val2");
      expect(table.pendingBatchCount).toBe(2);

      await table.flush();
      expect(table.pendingBatchCount).toBe(0);
      await Promise.all([p1, p2]);

      expect(await table.get("k1")).toBe("val1");
      expect(await table.get("k2")).toBe("val2");
    });

    it("guarantees Read-Your-Own-Writes (RYW) through in-memory fast-path overlay", async () => {
      const table = db.table<{ score: number }>("ryw_test", {
        autoBatch: { maxBatchSize: 100, maxWaitMs: 500 },
      });

      // Write into buffer (not flushed to SQLite yet)
      const setPromise = table.set("player:1", { score: 100 });
      expect(table.pendingBatchCount).toBe(1);

      // Immediate get without waiting for timer
      const readVal = await table.get("player:1");
      expect(readVal).toEqual({ score: 100 });

      // Range query triggers automatic flush barrier
      const queryResults = await table.find();
      expect(queryResults.length).toBe(1);
      expect(queryResults[0]?.value).toEqual({ score: 100 });

      await setPromise;
    });

    it("coalesces duplicate writes in memory (Net-Delta mode)", async () => {
      const table = db.table<{ count: number }>("coalesce_kv", {
        autoBatch: { maxBatchSize: 100, maxWaitMs: 50, coalesce: true },
      });

      // Rapidly write to the same key 5 times
      const p1 = table.set("counter", { count: 1 });
      const p2 = table.set("counter", { count: 2 });
      const p3 = table.set("counter", { count: 3 });
      const p4 = table.set("counter", { count: 4 });
      const p5 = table.set("counter", { count: 5 });

      // In-memory pending count should be 1 due to coalesce
      expect(table.pendingBatchCount).toBe(1);

      await Promise.all([p1, p2, p3, p4, p5]);
      expect(await table.get("counter")).toEqual({ count: 5 });
    });

    it("cancels write on delete in the same window (Set-Delete Cancellation)", async () => {
      const table = db.table<string>("cancel_kv", {
        autoBatch: { maxBatchSize: 100, maxWaitMs: 50, coalesce: true },
      });

      const p1 = table.set("temp", "should_not_persist");
      const p2 = table.delete("temp");

      const [resSet, resDel] = await Promise.all([p1, p2]);
      expect(resSet).toBeUndefined();
      expect(resDel).toBe(true);

      expect(await table.get("temp")).toBeUndefined();
      expect(await table.exists("temp")).toBe(false);
    });

    it("preserves sequential FIFO operations when coalesce: false", async () => {
      const table = db.table<number>("seq_kv", {
        autoBatch: { maxBatchSize: 100, maxWaitMs: 50, coalesce: false },
      });

      const p1 = table.set("key", 1);
      const p2 = table.set("key", 2);
      const p3 = table.set("key", 3);

      expect(table.pendingBatchCount).toBe(3); // Every operation is preserved
      await Promise.all([p1, p2, p3]);

      expect(await table.get("key")).toBe(3);
    });
  });

  describe("4. Multi-Key Schema Table Integration & Incremental Merging", () => {
    interface UserDoc {
      name: string;
      level: number;
    }
    interface UserKeys {
      role: string;
      status: string;
    }

    const userSchema: MultiKeySchema<UserKeys> = {
      primaryKey: { name: "id", type: "string" },
      keys: {
        role: { type: "string", index: true },
        status: { type: "string", index: true },
      },
    };

    it("incrementally merges secondary keys on concurrent updates to the same key", async () => {
      const table = db.table<UserDoc, UserKeys>("users_multikey", {
        schema: userSchema,
        autoBatch: { maxBatchSize: 50, maxWaitMs: 40, coalesce: true },
      });

      // Write 1: sets role
      const p1 = table.set(
        "u1",
        { name: "Alice", level: 1 },
        { keys: { role: "developer" } },
      );

      // Write 2: sets status (different secondary key) within same micro-batch window
      const p2 = table.set(
        "u1",
        { name: "Alice", level: 2 },
        { keys: { status: "active" } },
      );

      await Promise.all([p1, p2]);

      // Verify physical record contains merged secondary keys
      const record = await table.getRecord("u1");
      expect(record).toBeDefined();
      expect(record?.value).toEqual({ name: "Alice", level: 2 });
      expect(record?.keys?.role).toBe("developer");
      expect(record?.keys?.status).toBe("active");

      // Verify both secondary key lookups succeed
      const byRole = await table.getBy("role", "developer");
      expect(byRole?.key).toBe("u1");

      const byStatus = await table.getBy("status", "active");
      expect(byStatus?.key).toBe("u1");
    });

    it("supports sqlAggregation: false (individual statements per transaction)", async () => {
      const table = db.table<UserDoc, UserKeys>("users_no_sql_agg", {
        schema: userSchema,
        autoBatch: { maxBatchSize: 50, maxWaitMs: 30, sqlAggregation: false },
      });

      await Promise.all([
        table.set("u1", { name: "User1", level: 10 }, { keys: { role: "admin", status: "active" } }),
        table.set("u2", { name: "User2", level: 20 }, { keys: { role: "guest", status: "inactive" } }),
      ]);

      expect(await table.get("u1")).toEqual({ name: "User1", level: 10 });
      expect(await table.get("u2")).toEqual({ name: "User2", level: 20 });
    });
  });

  describe("5. High-Concurrency Conflict Handling ('如果我同时对一个改，会处理好吗？')", () => {
    it("handles 50 concurrent table.update() operations on the same key without lost updates", async () => {
      const table = db.table<{ count: number }>("counter_stress", {
        autoBatch: { maxBatchSize: 20, maxWaitMs: 30, coalesce: true },
      });

      // Initialize counter
      await table.set("hits", { count: 0 });

      // Launch 50 concurrent increments simultaneously
      const concurrency = 50;
      const updates = Array.from({ length: concurrency }, () =>
        table.update("hits", (prev) => ({
          count: (prev?.count ?? 0) + 1,
        })),
      );

      await Promise.all(updates);

      // Zero lost updates: count must equal exactly 50
      const finalVal = await table.get("hits");
      expect(finalVal?.count).toBe(50);
    });

    it("synchronously applies in-memory fast path for chained updates", async () => {
      const table = db.table<{ step: number }>("chain_update", {
        autoBatch: { maxBatchSize: 50, maxWaitMs: 100 },
      });

      await table.set("flow", { step: 1 });

      const u1 = table.update("flow", (v) => ({ step: v.step + 1 }));
      const u2 = table.update("flow", (v) => ({ step: v.step + 10 }));
      const u3 = table.update("flow", (v) => ({ step: v.step * 2 }));

      const [r1, r2, r3] = await Promise.all([u1, u2, u3]);
      expect(r1.step).toBe(2);
      expect(r2.step).toBe(12);
      expect(r3.step).toBe(24);

      expect((await table.get("flow"))?.step).toBe(24);
    });

    it("throws appropriate error when updating a key that does not exist in buffer or DB", async () => {
      const table = db.table<{ count: number }>("missing_update", {
        autoBatch: { maxBatchSize: 50, maxWaitMs: 50 },
      });

      await expect(
        table.update("non_existent", (v) => ({ count: v.count + 1 })),
      ).rejects.toThrow("it does not exist");
    });
  });

  describe("6. Lifecycle, Graceful Shutdown & kvdb.close() Auto-Drain", () => {
    it("auto-flushes all pending batches when kvdb.close() is called", async () => {
      const customDb = new KVDB({ driver: "sqlite", url: ":memory:" });
      const table = customDb.table<string>("drain_table", {
        autoBatch: { maxBatchSize: 100, maxWaitMs: 10000 }, // Long wait time
      });

      // Enqueue writes without awaiting timer
      void table.set("saved1", "alpha");
      void table.set("saved2", "beta");
      expect(table.pendingBatchCount).toBe(2);

      // Close database: must cleanly flush all tables before closing driver
      await customDb.close();

      expect(table.pendingBatchCount).toBe(0);
    });

    it("inherits global autoBatch option from KVDB instance", async () => {
      const globalDb = new KVDB({
        driver: "sqlite",
        url: ":memory:",
        autoBatch: { maxBatchSize: 25, maxWaitMs: 15 },
      });

      const table = globalDb.table<string>("inherited");
      void table.set("k1", "v1");
      expect(table.pendingBatchCount).toBe(1);

      await globalDb.close();
    });
  });
});
