import { describe, it, expect, afterEach } from "vitest";
import { KVDB } from "../../src/core/kvdb.js";
import { AutoIndexManager } from "../../src/core/auto-index.js";

let db: KVDB;
afterEach(async () => {
  await db?.close();
});

describe("AutoIndexManager", () => {
  it("returns a path once it crosses the threshold, only once", () => {
    const manager = new AutoIndexManager(3);
    expect(manager.record(["a"])).toEqual([]);
    expect(manager.record(["a"])).toEqual([]);
    expect(manager.record(["a"])).toEqual(["a"]); // 3rd time
    expect(manager.record(["a"])).toEqual([]); // already indexed
  });

  it("tracks paths independently", () => {
    const manager = new AutoIndexManager(2);
    expect(manager.record(["a", "b"])).toEqual([]);
    expect(manager.record(["a"])).toEqual(["a"]);
    expect(manager.record(["b"])).toEqual(["b"]);
  });
});

describe("KVDB.purgeExpired (SQLite)", () => {
  it("removes expired rows and reports the count", async () => {
    db = new KVDB({ driver: "sqlite", url: ":memory:" });
    const t = db.table<number>("n");
    await t.set("live", 1, { ttlMs: 60_000 });
    await t.set("dead1", 1, { ttlMs: -1 });
    await t.set("dead2", 1, { ttlMs: -1 });
    expect(await db.purgeExpired()).toBe(2);
    expect(await db.purgeExpired()).toBe(0);
    expect(await t.get("live")).toBe(1);
  });
});

describe("KVDB autoIndex option (SQLite)", () => {
  it("creates an index after the threshold and keeps queries correct", async () => {
    db = new KVDB({ driver: "sqlite", url: ":memory:", autoIndex: { threshold: 2 } });
    const t = db.table<{ profile: { age: number } }>("u");
    await t.set("u1", { profile: { age: 30 } });

    await t.find({ where: { "profile.age": { $gt: 10 } } });
    await t.find({ where: { "profile.age": { $gt: 10 } } }); // 2nd -> triggers ensureIndex

    const raw = (await db.raw()) as import("better-sqlite3").Database;
    const indexes = raw
      .prepare("SELECT name FROM sqlite_master WHERE type='index'")
      .all() as { name: string }[];
    expect(indexes.some((index) => index.name.includes("json_profile_age"))).toBe(true);

    // Query still returns the right rows after the index exists.
    const rows = await t.find({ where: { "profile.age": { $gte: 30 } } });
    expect(rows.map((r) => r.key)).toEqual(["u1"]);
  });
});
