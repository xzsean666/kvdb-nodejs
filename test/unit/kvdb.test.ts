import { describe, it, expect, afterEach } from "vitest";
import { KVDB } from "../../src/core/kvdb.js";

// End-to-end through the public KVDB/Table API against in-memory SQLite.

interface User {
  name: string;
  profile: { age: number };
  status: string;
}

let db: KVDB;

afterEach(async () => {
  await db?.close();
});

describe("KVDB end-to-end (SQLite)", () => {
  it("connects lazily and does CRUD", async () => {
    db = new KVDB({ driver: "sqlite", url: ":memory:", tablePrefix: "app_" });
    const users = db.table<User>("users");

    await users.set("u1", { name: "Ann", profile: { age: 20 }, status: "active" });
    expect(await users.get("u1")).toEqual({ name: "Ann", profile: { age: 20 }, status: "active" });
    expect(await users.exists("u1")).toBe(true);
    expect(await users.delete("u1")).toBe(true);
    expect(await users.get("u1")).toBeUndefined();
  });

  it("isolates namespaces", async () => {
    db = new KVDB({ driver: "sqlite", url: ":memory:" });
    const a = db.table("a");
    const b = db.table("b");
    await a.set("k", 1);
    await b.set("k", 2);
    expect(await a.get("k")).toBe(1);
    expect(await b.get("k")).toBe(2);
    await a.clear();
    expect(await a.get("k")).toBeUndefined();
    expect(await b.get("k")).toBe(2); // unaffected
  });

  it("runs JSON find queries", async () => {
    db = new KVDB({ driver: "sqlite", url: ":memory:" });
    const users = db.table<User>("users");
    await users.setMany([
      { key: "u1", value: { name: "Ann", profile: { age: 30 }, status: "active" } },
      { key: "u2", value: { name: "Bob", profile: { age: 17 }, status: "active" } },
      { key: "u3", value: { name: "Cid", profile: { age: 40 }, status: "gone" } },
    ]);

    const adults = await users.find({ where: { "profile.age": { $gt: 18 } } });
    expect(adults.map((r) => r.key).sort()).toEqual(["u1", "u3"]);

    const activeAdults = await users.find({
      where: { "profile.age": { $gt: 18 }, status: "active" },
    });
    expect(activeAdults.map((r) => r.key)).toEqual(["u1"]);

    const top = await users.find({
      sort: [{ path: "profile.age", direction: "desc" }],
      limit: 2,
    });
    expect(top.map((r) => r.key)).toEqual(["u3", "u1"]);
  });

  it("uses an integrated cache for point reads", async () => {
    db = new KVDB({ driver: "sqlite", url: ":memory:", cache: { driver: "memory" } });
    const t = db.table<number>("nums");
    await t.set("k", 1);
    // Mutate the backend directly behind the cache's back.
    const raw = (await db.raw()) as import("better-sqlite3").Database;
    raw.prepare("UPDATE kvdb_kv SET value = '999' WHERE key = ?").run("nums:k");
    // Cache still serves the original value.
    expect(await t.get("k")).toBe(1);
  });

  it("honors TTL through the facade", async () => {
    db = new KVDB({ driver: "sqlite", url: ":memory:" });
    const t = db.table<number>("nums");
    await t.set("k", 1, { ttlMs: -1 }); // already expired
    expect(await t.get("k")).toBeUndefined();
  });

  it("throws a clear error for unimplemented drivers", () => {
    expect(() => new KVDB({ driver: "postgresql", url: "x" })).toThrow(/PostgreSQL/);
  });
});
