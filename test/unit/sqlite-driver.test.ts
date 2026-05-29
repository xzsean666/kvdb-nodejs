import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SqliteDriverFactory } from "../../src/drivers/sqlite/sqlite-driver.js";
import type { Driver } from "../../src/drivers/types.js";
import { parseWhere } from "../../src/query/parser.js";
import { serialize } from "../../src/core/serializer.js";

// Exercises the SQLite driver directly against an in-memory database, with
// physical keys (as the core would pass) and canonical JSON values.

let driver: Driver;

beforeEach(async () => {
  driver = await new SqliteDriverFactory({ url: ":memory:" }).connect();
});

afterEach(async () => {
  await driver.close();
});

const put = (key: string, value: unknown, ttlMs?: number) =>
  driver.set(key, serialize(value), ttlMs);

describe("SqliteDriver KV", () => {
  it("set/get/delete/has", async () => {
    await put("users:u1", { name: "Ann" });
    expect((await driver.get("users:u1"))?.value).toBe('{"name":"Ann"}');
    expect(await driver.has("users:u1")).toBe(true);
    expect(await driver.delete("users:u1")).toBe(true);
    expect(await driver.get("users:u1")).toBeUndefined();
  });

  it("honors TTL", async () => {
    await put("k", 1, -1); // already expired
    expect(await driver.get("k")).toBeUndefined();
  });

  it("batch operations", async () => {
    await driver.setMany!([
      { key: "n:a", value: serialize(1) },
      { key: "n:b", value: serialize(2) },
    ]);
    const got = await driver.getMany!(["n:a", "n:b", "n:missing"]);
    expect(got.map((entry) => entry?.value)).toEqual(["1", "2", undefined]);
    expect(await driver.deleteMany!(["n:a", "n:b"])).toBe(2);
  });

  it("prefix scan and delete", async () => {
    await put("users:1", { n: 1 });
    await put("users:2", { n: 2 });
    await put("posts:1", { n: 3 });
    expect((await driver.getByPrefix("users:")).map((e) => e.key).sort()).toEqual([
      "users:1",
      "users:2",
    ]);
    expect(await driver.deleteByPrefix("users:")).toBe(2);
    expect(await driver.getByPrefix("users:")).toHaveLength(0);
    expect(await driver.getByPrefix("posts:")).toHaveLength(1);
  });
});

describe("SqliteDriver find (JSON query)", () => {
  beforeEach(async () => {
    await put("u:1", { name: "Ann", profile: { age: 30 }, status: "active" });
    await put("u:2", { name: "Bob", profile: { age: 17 }, status: "active" });
    await put("u:3", { name: "Cid", profile: { age: 40 }, status: "gone" });
  });

  const find = (where: Record<string, unknown>, options?: object) =>
    driver.find(parseWhere(where), options);

  it("filters by nested numeric comparison", async () => {
    const rows = await find({ "profile.age": { $gt: 18 } });
    expect(rows.map((r) => r.key).sort()).toEqual(["u:1", "u:3"]);
  });

  it("combines conditions", async () => {
    const rows = await find({ "profile.age": { $gt: 18 }, status: "active" });
    expect(rows.map((r) => r.key)).toEqual(["u:1"]);
  });

  it("supports $or", async () => {
    const rows = await find({ $or: [{ status: "gone" }, { "profile.age": { $lt: 18 } }] });
    expect(rows.map((r) => r.key).sort()).toEqual(["u:2", "u:3"]);
  });

  it("sorts and limits", async () => {
    const rows = await find({}, { sort: [{ path: { segments: [{ key: "profile" }, { key: "age" }], source: "profile.age" }, direction: "desc" }], limit: 2 });
    expect(rows.map((r) => r.key)).toEqual(["u:3", "u:1"]);
  });

  it("ensureIndex does not break queries", async () => {
    await driver.ensureIndex("profile.age");
    const rows = await find({ "profile.age": { $gte: 30 } });
    expect(rows.map((r) => r.key).sort()).toEqual(["u:1", "u:3"]);
  });
});
