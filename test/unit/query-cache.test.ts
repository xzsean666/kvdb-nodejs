import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { KVDB } from "../../src/core/kvdb.js";
import { Cache } from "../../src/cache/cache.js";
import type { TableSchema } from "../../src/core/table-schema.js";

describe("Query Cache with Automatic Write Invalidation (TASK-024)", () => {
  let db: KVDB;
  let cache: Cache;

  beforeEach(() => {
    cache = new Cache({ driver: "memory" });
    db = new KVDB({ driver: "sqlite", url: ":memory:", cache });
  });

  afterEach(async () => {
    await db.close();
  });

  it("caches query results on find() and serves subsequent calls from cache", async () => {
    const table = db.table<{ name: string; age: number }>("users", {
      queryCache: true,
    });

    await table.set("u1", { name: "Alice", age: 25 });
    await table.set("u2", { name: "Bob", age: 30 });

    // First find: populates query cache
    const res1 = await table.find({ where: { age: { $gte: 20 } } });
    expect(res1).toHaveLength(2);

    // Spy on underlying driver.find
    const driver = await (table as any).deps.getDriver();
    const findSpy = vi.spyOn(driver, "find");

    // Second find with identical query: must hit query cache
    const res2 = await table.find({ where: { age: { $gte: 20 } } });
    expect(res2).toEqual(res1);
    expect(findSpy).not.toHaveBeenCalled();

    findSpy.mockRestore();
  });

  it("produces identical cache hits for semantically equivalent queries with different key order", async () => {
    const table = db.table<{ name: string; age: number; city: string }>("profiles", {
      queryCache: true,
    });

    await table.set("p1", { name: "Carol", age: 28, city: "London" });

    // Order 1: age first, then city
    const res1 = await table.find({ where: { age: 28, city: "London" } });
    expect(res1).toHaveLength(1);

    const driver = await (table as any).deps.getDriver();
    const findSpy = vi.spyOn(driver, "find");

    // Order 2: city first, then age -> deterministic canonical fingerprint
    const res2 = await table.find({ where: { city: "London", age: 28 } });
    expect(res2).toEqual(res1);
    expect(findSpy).not.toHaveBeenCalled();

    findSpy.mockRestore();
  });

  it("invalidates query cache automatically upon set() write mutation", async () => {
    const table = db.table<{ title: string; views: number }>("posts", {
      queryCache: true,
    });

    await table.set("post1", { title: "KVDB Deep Dive", views: 100 });

    const q1 = await table.find({ where: { views: { $gte: 50 } } });
    expect(q1).toHaveLength(1);

    // Insert new matching post via set()
    await table.set("post2", { title: "Fast Query Caching", views: 200 });

    // Subsequent find must return fresh data (2 posts)
    const q2 = await table.find({ where: { views: { $gte: 50 } } });
    expect(q2).toHaveLength(2);
  });

  it("invalidates query cache automatically upon delete() and update()", async () => {
    const table = db.table<{ item: string; stock: number }>("inventory", {
      queryCache: true,
    });

    await table.set("item1", { item: "Widget", stock: 10 });
    await table.set("item2", { item: "Gadget", stock: 5 });

    let inStock = await table.find({ where: { stock: { $gt: 0 } } });
    expect(inStock).toHaveLength(2);

    // Update item stock
    await table.update("item1", { stock: 0 });
    inStock = await table.find({ where: { stock: { $gt: 0 } } });
    expect(inStock).toHaveLength(1);
    expect(inStock[0]?.key).toBe("item2");

    // Delete item
    await table.delete("item2");
    inStock = await table.find({ where: { stock: { $gt: 0 } } });
    expect(inStock).toHaveLength(0);
  });

  it("invalidates query cache automatically upon setMany() and deleteMany()", async () => {
    const table = db.table<{ score: number }>("scores", {
      queryCache: true,
    });

    await table.setMany([
      { key: "s1", value: { score: 90 } },
      { key: "s2", value: { score: 95 } },
    ]);

    let highScores = await table.find({ where: { score: { $gte: 90 } } });
    expect(highScores).toHaveLength(2);

    await table.deleteMany(["s1"]);
    highScores = await table.find({ where: { score: { $gte: 90 } } });
    expect(highScores).toHaveLength(1);
    expect(highScores[0]?.key).toBe("s2");
  });

  it("supports queryCache on physical schema tables with findRecords()", async () => {
    interface MemberCols extends Record<string, unknown> {
      tier: string;
      points: number;
    }

    const memberSchema: TableSchema<MemberCols> = {
      primaryKey: { name: "id", type: "string" },
      columns: {
        tier: { type: "string", index: true },
        points: { type: "integer", index: true },
      },
    };

    const table = db.table<{ email: string }, MemberCols>("members", {
      schema: memberSchema,
      queryCache: true,
    });

    await table.set("m1", { email: "m1@example.com" }, { keys: { tier: "gold", points: 500 } });
    await table.set("m2", { email: "m2@example.com" }, { keys: { tier: "silver", points: 200 } });

    // Initial query
    const records1 = await table.findRecords({ where: { tier: "gold" } });
    expect(records1).toHaveLength(1);
    expect(records1[0]?.columns.tier).toBe("gold");

    // Add another gold member
    await table.set("m3", { email: "m3@example.com" }, { keys: { tier: "gold", points: 800 } });

    // Write invalidation must update query cache
    const records2 = await table.findRecords({ where: { tier: "gold" } });
    expect(records2).toHaveLength(2);
  });

  it("invalidates query cache when autoBatch flushes buffered writes", async () => {
    const table = db.table<{ val: number }>("batched", {
      queryCache: true,
      autoBatch: { maxWaitMs: 50 },
    });

    await table.set("k1", { val: 10 });
    const initial = await table.find({ where: { val: { $gte: 10 } } });
    expect(initial).toHaveLength(1);

    // Enqueue write into autoBatch buffer
    await table.set("k2", { val: 20 });
    await table.flush();

    // Query should reflect newly flushed write
    const afterFlush = await table.find({ where: { val: { $gte: 10 } } });
    expect(afterFlush).toHaveLength(2);
  });
});
