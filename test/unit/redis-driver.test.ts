import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { KVDB } from "../../src/core/kvdb.js";
import { Cache } from "../../src/cache/cache.js";
import { RedisStore } from "../../src/cache/stores/redis-store.js";
import { RedisDriverFactory } from "../../src/drivers/redis/redis-driver.js";

const REDIS_URL = process.env.KVDB_TEST_REDIS_URL ?? "redis://127.0.0.1:6380";

describe("Redis Driver and KVDB Integration", () => {
  let db: KVDB;

  beforeEach(async () => {
    db = new KVDB({
      driver: "redis",
      url: REDIS_URL,
      tablePrefix: "test_kvdb",
    });
    const table = db.table("users");
    await table.clear();
  });

  afterEach(async () => {
    const table = db.table("users");
    await table.clear();
    await db.close();
  });

  it("handles basic KV operations via Table API", async () => {
    const users = db.table<{ name: string; role: string }>("users");
    await users.set("u1", { name: "Alice", role: "admin" });
    expect(await users.exists("u1")).toBe(true);

    const val = await users.get("u1");
    expect(val).toEqual({ name: "Alice", role: "admin" });

    expect(await users.delete("u1")).toBe(true);
    expect(await users.exists("u1")).toBe(false);
    expect(await users.get("u1")).toBeUndefined();
  });

  it("supports batch operations and TTL", async () => {
    const scores = db.table<{ score: number }>("scores");
    await scores.setMany([
      { key: "u1", value: { score: 10 } },
      { key: "u2", value: { score: 20 }, ttlMs: 100 },
      { key: "u3", value: { score: 30 } },
    ]);

    const results = await scores.getMany(["u1", "u2", "missing", "u3"]);
    expect(results).toEqual([
      { score: 10 },
      { score: 20 },
      undefined,
      { score: 30 },
    ]);

    const deleted = await scores.deleteMany(["u1", "u3"]);
    expect(deleted).toBe(2);
    expect(await scores.exists("u1")).toBe(false);
  });

  it("supports AST-based JSON filtering and sorting in Redis", async () => {
    const users = db.table("users");
    await users.set("a", { age: 30, tag: "dev", level: 1 });
    await users.set("b", { age: 20, tag: "dev", level: 2 });
    await users.set("c", { age: 40, tag: "ops", level: 3 });

    const devs = await users.find({
      where: { tag: "dev", age: { $gte: 20 } },
      sort: [{ path: "age", direction: "desc" }],
    });

    expect(devs).toEqual([
      { key: "a", value: { age: 30, tag: "dev", level: 1 } },
      { key: "b", value: { age: 20, tag: "dev", level: 2 } },
    ]);
  });

  it("supports atomic updates under concurrency", async () => {
    const counter = db.table<{ count: number }>("counter");
    await counter.set("counter", { count: 0 });

    await Promise.all(
      Array.from({ length: 20 }, () =>
        counter.update("counter", (current) => ({
          count: (current?.count ?? 0) + 1,
        })),
      ),
    );

    const finalVal = await counter.get("counter");
    expect(finalVal?.count).toBe(20);
  });
});

describe("RedisStore standalone Cache subsystem", () => {
  let cache: Cache;

  beforeEach(async () => {
    cache = new Cache({
      stores: [
        new RedisStore({
          url: REDIS_URL,
          keyPrefix: "test_cache:",
        }),
      ],
    });
    await cache.clear();
  });

  afterEach(async () => {
    await cache.clear();
  });

  it("performs cache get, set, delete, and prefix deletion", async () => {
    await cache.set("user:101", { name: "John" }, { ttlMs: 5000 });
    await cache.set("user:102", { name: "Jane" }, { ttlMs: 5000 });
    await cache.set("order:201", { amount: 99 });

    expect(await cache.get("user:101")).toEqual({ name: "John" });
    expect(await cache.deleteByPrefix("user:")).toBe(2);
    expect(await cache.get("user:101")).toBeUndefined();
    expect(await cache.get("order:201")).toEqual({ amount: 99 });
  });

  it("supports wrap() with stampede collapse over Redis", async () => {
    let callCount = 0;
    const fetchFresh = async () => {
      callCount++;
      return { token: "abc-xyz" };
    };

    const results = await Promise.all(
      Array.from({ length: 15 }, () =>
        cache.wrap("session:token", fetchFresh, { ttlMs: 5000 }),
      ),
    );

    expect(callCount).toBe(1);
    for (const res of results) {
      expect(res).toEqual({ token: "abc-xyz" });
    }
  });
});
