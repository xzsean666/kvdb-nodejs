import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Pool, QueryResult } from "pg";
import { PostgresDriver } from "../../src/drivers/postgres/postgres-driver.js";
import type { MultiKeySchema } from "../../src/core/table-schema.js";
import type { SchemaTableDriver } from "../../src/drivers/types.js";

describe("PostgreSQL Multi-Key Driver (TASK-018)", () => {
  let mockPool: Pool;
  let executedQueries: Array<{ sql: string; params?: unknown[] }>;
  let mockRows: Record<string, unknown[]>;

  beforeEach(() => {
    executedQueries = [];
    mockRows = {};

    mockPool = {
      query: vi.fn(async (sql: string, params?: unknown[]): Promise<QueryResult> => {
        executedQueries.push({ sql: sql.trim(), params });

        // Simulate kvdb_schema_registry query
        if (sql.includes("SELECT schema_json FROM kvdb_schema_registry")) {
          const tableName = params?.[0] as string;
          const rows = mockRows[`registry_${tableName}`] ?? [];
          return { rows, rowCount: rows.length, command: "SELECT", oid: 0, fields: [] };
        }

        // Simulate SELECT * FROM table WHERE
        if (sql.includes("SELECT * FROM kvdb_schema_")) {
          const rows = mockRows.data ?? [];
          return { rows, rowCount: rows.length, command: "SELECT", oid: 0, fields: [] };
        }

        // Simulate DELETE
        if (sql.includes("DELETE FROM kvdb_schema_")) {
          return { rows: [], rowCount: 1, command: "DELETE", oid: 0, fields: [] };
        }

        return { rows: [], rowCount: 0, command: "OK", oid: 0, fields: [] };
      }),
      end: vi.fn(async () => {}),
    } as unknown as Pool;
  });

  it("generates correct DDL for integer PK and multi-type secondary keys", async () => {
    const driver = new PostgresDriver(mockPool, "kvdb_kv");


    const schema: MultiKeySchema = {
      primaryKey: { name: "blockNumber", type: "integer" },
      keys: {
        hash: { type: "string", index: { unique: true } },
        gasUsed: { type: "number" },
        isSuccess: { type: "boolean", default: true },
        meta: { type: "json", nullable: true },
      },
      indexes: [
        { name: "block_hash_idx", keys: ["blockNumber", "hash"] },
      ],
    };

    const table = (await driver.openSchemaTable!("blocks", schema)) as SchemaTableDriver;
    expect(table).toBeDefined();

    // Check table creation query
    const createTableQuery = executedQueries.find((q) => q.sql.includes("CREATE TABLE IF NOT EXISTS kvdb_schema_blocks_"));
    expect(createTableQuery).toBeDefined();
    expect(createTableQuery!.sql).toContain('"blockNumber" BIGINT PRIMARY KEY');
    expect(createTableQuery!.sql).toContain('"hash" TEXT');
    expect(createTableQuery!.sql).toContain('"gasUsed" DOUBLE PRECISION');
    expect(createTableQuery!.sql).toContain('"isSuccess" BOOLEAN');
    expect(createTableQuery!.sql).toContain('"meta" JSONB');

    // Check index creation queries
    expect(executedQueries.some((q) => q.sql.includes('CREATE UNIQUE INDEX IF NOT EXISTS "kvdb_schema_blocks_') && q.sql.includes('"hash"'))).toBe(true);
    expect(executedQueries.some((q) => q.sql.includes('CREATE INDEX IF NOT EXISTS "block_hash_idx"'))).toBe(true);
  });

  it("binds parameters correctly on setRecord with integer PK", async () => {
    const driver = new PostgresDriver(mockPool, "kvdb_kv");


    const schema: MultiKeySchema = {
      primaryKey: { name: "blockNumber", type: "integer" },
      keys: {
        hash: { type: "string" },
        gas: { type: "number" },
      },
    };

    const table = (await driver.openSchemaTable!("blocks", schema)) as SchemaTableDriver;
    executedQueries = [];

    await table.setRecord(1001, JSON.stringify({ miner: "0xabc" }), { hash: "0xhash1", gas: 50000 });

    const insertQuery = executedQueries.find((q) => q.sql.includes("INSERT INTO kvdb_schema_blocks_"));
    expect(insertQuery).toBeDefined();
    expect(insertQuery!.sql).toContain('ON CONFLICT ("blockNumber") DO UPDATE SET');
    expect(insertQuery!.params).toEqual([
      1001,
      "0xhash1",
      50000,
      JSON.stringify({ miner: "0xabc" }),
      null, // expires_at
      expect.any(Number), // created_at
      expect.any(Number), // updated_at
    ]);
  });

  it("fetches and parses record in getRecord and getRecordByKey", async () => {
    const driver = new PostgresDriver(mockPool, "kvdb_kv");


    const schema: MultiKeySchema = {
      primaryKey: { name: "id", type: "integer" },
      keys: {
        code: { type: "string", index: { unique: true } },
        active: { type: "boolean" },
        payload: { type: "json" },
      },
    };

    const table = (await driver.openSchemaTable!("items", schema)) as SchemaTableDriver;

    // Mock DB row
    mockRows.data = [
      {
        id: "42", // PG BIGINT might return as string
        code: "ITEM-42",
        active: true,
        payload: JSON.stringify({ color: "blue" }),
        value: JSON.stringify({ name: "Widget" }),
        expires_at: null,
      },
    ];

    // Read by PK
    const rec = await table.getRecord(42);
    expect(rec).toBeDefined();
    expect(rec?.key).toBe(42);
    expect(rec?.columns.code).toBe("ITEM-42");
    expect(rec?.columns.active).toBe(true);
    expect(rec?.columns.payload).toEqual({ color: "blue" });
    expect(JSON.parse(rec!.value)).toEqual({ name: "Widget" });

    // Read by secondary key
    const byKey = await table.getRecordByKey!("code", "ITEM-42");
    expect(byKey).toBeDefined();
    expect(byKey?.key).toBe(42);
    expect(byKey?.columns.code).toBe("ITEM-42");
  });

  it("dynamically adds key via addKey and issues ALTER TABLE DDL", async () => {
    const driver = new PostgresDriver(mockPool, "kvdb_kv");


    const schema: MultiKeySchema = {
      primaryKey: { name: "id", type: "string" },
      keys: {
        name: { type: "string" },
      },
    };

    const table = (await driver.openSchemaTable!("users", schema)) as SchemaTableDriver;
    executedQueries = [];

    await table.addKey!("status", { type: "string", index: true });

    const alterQuery = executedQueries.find((q) => q.sql.includes("ALTER TABLE") && q.sql.includes("ADD COLUMN IF NOT EXISTS"));
    expect(alterQuery).toBeDefined();
    expect(alterQuery!.sql).toContain('"status" TEXT');

    const indexQuery = executedQueries.find((q) => q.sql.includes('CREATE INDEX IF NOT EXISTS "kvdb_schema_users_') && q.sql.includes('"status"'));
    expect(indexQuery).toBeDefined();

    const registryUpdate = executedQueries.find((q) => q.sql.includes("UPDATE kvdb_schema_registry SET schema_json"));
    expect(registryUpdate).toBeDefined();
  });

  it("dynamically adds composite index via addIndex", async () => {
    const driver = new PostgresDriver(mockPool, "kvdb_kv");


    const schema: MultiKeySchema = {
      primaryKey: { name: "id", type: "integer" },
      keys: {
        cat: { type: "string" },
        views: { type: "integer" },
      },
    };

    const table = (await driver.openSchemaTable!("posts", schema)) as SchemaTableDriver;
    executedQueries = [];

    await table.addIndex!({
      name: "cat_views_composite",
      keys: ["cat", "views"],
    });

    const indexQuery = executedQueries.find((q) => q.sql.includes('CREATE INDEX IF NOT EXISTS "cat_views_composite"'));
    expect(indexQuery).toBeDefined();
    expect(indexQuery!.sql).toContain('("cat", "views")');
  });
});
