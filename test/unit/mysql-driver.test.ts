import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { KVDB } from "../../src/core/kvdb.js";
import { KvdbConfigError } from "../../src/core/errors.js";

const MYSQL_URL = process.env.KVDB_TEST_MYSQL_URL ?? "mysql://root:kvdb_test@127.0.0.1:3307/kvdb_test";

describe("MySQL Driver and KVDB Integration", () => {
  let db: KVDB;

  beforeEach(async () => {
    db = new KVDB({
      driver: "mysql",
      url: MYSQL_URL,
      table: "kvdb_unit_test",
    });
    const table = db.table("users");
    await table.clear();
  });

  afterEach(async () => {
    const table = db.table("users");
    await table.clear();
    await db.close();
  });

  it("throws if url is missing for mysql driver", () => {
    expect(() => new KVDB({ driver: "mysql" as any })).toThrow(KvdbConfigError);
  });

  it("handles basic KV operations via Table API", async () => {
    const users = db.table<{ name: string; role: string }>("users");
    await users.set("u1", { name: "Bob", role: "developer" });
    expect(await users.exists("u1")).toBe(true);

    const val = await users.get("u1");
    expect(val).toEqual({ name: "Bob", role: "developer" });

    expect(await users.delete("u1")).toBe(true);
    expect(await users.exists("u1")).toBe(false);
    expect(await users.get("u1")).toBeUndefined();
  });

  it("supports batch operations and TTL", async () => {
    const scores = db.table<{ score: number }>("scores");
    await scores.setMany([
      { key: "u1", value: { score: 100 } },
      { key: "u2", value: { score: 200 }, ttlMs: 100 },
      { key: "u3", value: { score: 300 } },
    ]);

    const results = await scores.getMany(["u1", "u2", "missing", "u3"]);
    expect(results).toEqual([
      { score: 100 },
      { score: 200 },
      undefined,
      { score: 300 },
    ]);

    const deleted = await scores.deleteMany(["u1", "u3"]);
    expect(deleted).toBe(2);
    expect(await scores.exists("u1")).toBe(false);
  });

  it("supports MultiKey Schema Table via Table API", async () => {
    const schemaTable = db.table<{ desc: string }>("orders_unit", {
      schema: {
        primaryKey: { name: "orderId", type: "integer" },
        keys: {
          customerId: { type: "string", index: true },
          amount: { type: "number" },
          status: { type: "string" },
        },
      },
    });

    await schemaTable.set(1001, { desc: "Laptop" }, { keys: { customerId: "c_1", amount: 1200, status: "paid" } });
    await schemaTable.set(1002, { desc: "Mouse" }, { keys: { customerId: "c_1", amount: 50, status: "paid" } });
    await schemaTable.set(1003, { desc: "Keyboard" }, { keys: { customerId: "c_2", amount: 100, status: "pending" } });

    const rec = await schemaTable.get(1001);
    expect(rec).toEqual({ desc: "Laptop" });

    const matches = await schemaTable.find({
      where: { customerId: "c_1", status: "paid" },
      sort: [{ path: "amount", direction: "desc" }],
    });
    expect(matches).toHaveLength(2);
    expect(matches[0]?.key).toBe("1001");
    expect(matches[0]?.value).toEqual({ desc: "Laptop" });
    expect(matches[1]?.key).toBe("1002");

    await db.dropTable("orders_unit");
  });

  it("handles high concurrency updates without lost writes", async () => {
    const counter = db.table<{ count: number }>("counter");
    await counter.set("hits", { count: 0 });

    const concurrency = 25;
    await Promise.all(
      Array.from({ length: concurrency }, () =>
        counter.update("hits", (curr) => ({
          count: (curr?.count ?? 0) + 1,
        })),
      ),
    );

    const final = await counter.get("hits");
    expect(final?.count).toBe(concurrency);
  });
});
