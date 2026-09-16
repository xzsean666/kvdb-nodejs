import { describe, it, expect, beforeEach, afterEach } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import { SqliteDriverFactory } from "../../src/drivers/sqlite/sqlite-driver.js";
import type { Driver, SchemaTableDriver } from "../../src/drivers/types.js";
import type { MultiKeySchema } from "../../src/core/table-schema.js";

describe("SQLite Multi-Key Physical Driver (TASK-017)", () => {
  let driver: Driver;
  let rawDb: BetterSqlite3.Database;

  beforeEach(async () => {
    const factory = new SqliteDriverFactory({ url: ":memory:" });
    driver = await factory.connect();
    rawDb = driver.raw() as BetterSqlite3.Database;
  });

  afterEach(async () => {
    await driver.close();
  });

  it("creates physical table with integer primary key and secondary keys", async () => {
    const schema: MultiKeySchema = {
      primaryKey: { name: "blockNumber", type: "integer" },
      keys: {
        hash: { type: "string", index: { unique: true } },
        txCount: { type: "integer", default: 0 },
        gasUsed: { type: "number", nullable: true },
        isFinalized: { type: "boolean", default: false },
        extra: { type: "json", nullable: true },
      },
      indexes: [
        { name: "block_tx_idx", keys: ["blockNumber", "txCount"] },
      ],
    };

    const table = (await driver.openSchemaTable!("blocks", schema)) as SchemaTableDriver;
    expect(table).toBeDefined();

    // Verify SQLite table schema in sqlite_master
    const tableName = (
      rawDb
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'kvdb_schema_blocks_%'")
        .get() as { name: string }
    ).name;
    const tableInfo = rawDb.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{
      name: string;
      type: string;
      pk: number;
    }>;


    expect(tableInfo.some((col) => col.name === "blockNumber" && col.pk === 1 && col.type === "INTEGER")).toBe(true);
    expect(tableInfo.some((col) => col.name === "hash" && col.type === "TEXT")).toBe(true);
    expect(tableInfo.some((col) => col.name === "txCount" && col.type === "INTEGER")).toBe(true);
    expect(tableInfo.some((col) => col.name === "gasUsed" && col.type === "REAL")).toBe(true);
    expect(tableInfo.some((col) => col.name === "isFinalized" && col.type === "INTEGER")).toBe(true);

    // Write record with number PK
    await table.setRecord(1001, JSON.stringify({ miner: "0x123" }), {
      hash: "0xabc",
      txCount: 42,
      gasUsed: 123456.78,
      isFinalized: true,
      extra: { tag: "mainnet" },
    });

    // Read by primary key
    const record = await table.getRecord(1001);
    expect(record).toBeDefined();
    expect(record?.key).toBe(1001);
    expect(record?.columns.hash).toBe("0xabc");
    expect(record?.columns.txCount).toBe(42);
    expect(record?.columns.gasUsed).toBe(123456.78);
    expect(record?.columns.isFinalized).toBe(true);
    expect(record?.columns.extra).toEqual({ tag: "mainnet" });
    expect(JSON.parse(record!.value)).toEqual({ miner: "0x123" });
  });

  it("supports getRecordByKey for point-lookup on unique secondary key", async () => {
    const schema: MultiKeySchema = {
      primaryKey: { name: "blockNumber", type: "integer" },
      keys: {
        hash: { type: "string", index: { unique: true } },
      },
    };

    const table = (await driver.openSchemaTable!("blocks_lookup", schema)) as SchemaTableDriver;

    await table.setRecord(1002, JSON.stringify({ miner: "0x456" }), { hash: "0xdef" });

    // Lookup by secondary key "hash"
    const byKey = await table.getRecordByKey!("hash", "0xdef");
    expect(byKey).toBeDefined();
    expect(byKey?.key).toBe(1002);
    expect(byKey?.columns.hash).toBe("0xdef");
    expect(JSON.parse(byKey!.value)).toEqual({ miner: "0x456" });

    // Lookup non-existent
    const notFound = await table.getRecordByKey!("hash", "0xnone");
    expect(notFound).toBeUndefined();

    // Lookup via primary key alias
    const byPk = await table.getRecordByKey!("blockNumber", 1002);
    expect(byPk?.columns.hash).toBe("0xdef");
  });

  it("dynamically adds a new key via addKey and immediately allows reads/writes", async () => {
    const schema: MultiKeySchema = {
      primaryKey: { name: "id", type: "integer" },
      keys: {
        title: { type: "string" },
      },
    };

    const table = (await driver.openSchemaTable!("articles", schema)) as SchemaTableDriver;

    // Write record 1 before dynamic key
    await table.setRecord(1, JSON.stringify({ content: "hello" }), { title: "First Post" });

    // Dynamically add "status" key with index
    await table.addKey!("status", { type: "string", default: "draft", index: true });

    // Write record 2 using new key
    await table.setRecord(2, JSON.stringify({ content: "world" }), { title: "Second Post", status: "published" });

    // Read record 1: status should receive default or null
    const rec1 = await table.getRecord(1);
    expect(rec1?.columns.title).toBe("First Post");
    expect(rec1?.columns.status).toBe("draft");

    // Read record 2
    const rec2 = await table.getRecord(2);
    expect(rec2?.columns.title).toBe("Second Post");
    expect(rec2?.columns.status).toBe("published");

    // Point lookup by newly added key
    const byStatus = await table.getRecordByKey!("status", "published");
    expect(byStatus?.key).toBe(2);
  });

  it("dynamically adds a composite index via addIndex", async () => {
    const schema: MultiKeySchema = {
      primaryKey: { name: "id", type: "integer" },
      keys: {
        category: { type: "string" },
        views: { type: "integer", default: 0 },
      },
    };

    const table = (await driver.openSchemaTable!("stats", schema)) as SchemaTableDriver;

    await table.addIndex!({
      name: "cat_views_idx",
      keys: ["category", "views"],
    });

    // Verify index exists in SQLite master
    const indexRow = rawDb
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='cat_views_idx'")
      .get() as { name: string } | undefined;

    expect(indexRow?.name).toBe("cat_views_idx");
  });

  it("persists schema changes in kvdb_schema_registry and reopens correctly", async () => {
    const schema: MultiKeySchema = {
      primaryKey: { name: "blockNumber", type: "integer" },
      keys: {
        hash: { type: "string" },
      },
    };

    const table = (await driver.openSchemaTable!("chain", schema)) as SchemaTableDriver;
    await table.setRecord(500, JSON.stringify({ data: "init" }), { hash: "0x500" });

    // Dynamic evolution
    await table.addKey!("difficulty", { type: "number", default: 1.0 });

    // Reopen table WITHOUT providing schema
    const reopened = (await driver.openSchemaTable!("chain")) as SchemaTableDriver;
    expect(reopened).toBeDefined();
    expect(reopened.schema.primaryKey?.name).toBe("blockNumber");
    expect(reopened.schema.keys?.difficulty).toBeDefined();

    const record = await reopened.getRecord(500);
    expect(record?.key).toBe(500);
    expect(record?.columns.hash).toBe("0x500");
    expect(record?.columns.difficulty).toBe(1.0);
  });

  it("enforces TTL expiration on multi-key records", async () => {
    const schema: MultiKeySchema = {
      primaryKey: { name: "sessionId", type: "string" },
      keys: {
        userId: { type: "integer" },
      },
    };

    const table = (await driver.openSchemaTable!("sessions", schema)) as SchemaTableDriver;

    // Write with -100ms TTL (already expired)
    await table.setRecord("sess_expired", JSON.stringify({ role: "guest" }), { userId: 99 }, -100);

    const record = await table.getRecord("sess_expired");
    expect(record).toBeUndefined();

    const byKey = await table.getRecordByKey!("userId", 99);
    expect(byKey).toBeUndefined();
  });
});
