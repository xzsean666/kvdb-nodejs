import { describe, it, expect, vi } from "vitest";
import { KVDB } from "../../src/core/kvdb.js";
import { Cache } from "../../src/cache/cache.js";
import { AutoIndexManager } from "../../src/core/auto-index.js";
import { parsePath, parseColumnField, parseWhere, parseFindOptions } from "../../src/query/parser.js";
import {
  validateTableSchema,
  evolveSchemaAddKey,
} from "../../src/core/table-schema.js";
import {
  KvdbQueryError,
  KvdbSchemaError,
} from "../../src/core/errors.js";
import type { Plugin } from "../../src/plugins/types.js";
import { SqliteCacheStore } from "../../src/cache/stores/sqlite-store.js";
import { PostgresDriver } from "../../src/drivers/postgres/postgres-driver.js";
import { MongoDriver } from "../../src/drivers/mongodb/mongodb-driver.js";
import type { Pool, QueryResult } from "pg";
import type { Db, Collection, MongoClient } from "mongodb";

describe("Comprehensive Audit: Security, Performance & Soundness", () => {
  describe("1. Security: SQL Keyword Columns & ANSI Quoting", () => {
    it("handles SQL reserved keywords as column names in SQLite schema table", async () => {
      const db = new KVDB({ driver: "sqlite", url: ":memory:" });
      const orders = db.table("orders", {
        schema: {
          primaryKey: { name: "order", type: "integer" },
          keys: {
            group: { type: "string" },
            user: { type: "string", index: true },
            select: { type: "number" },
            from: { type: "boolean", default: false },
          },
          indexes: [
            { name: "order_group_idx", keys: ["group", "user"] },
          ],
        },
      });

      await orders.set(1001, { desc: "Order 1" }, {
        keys: {
          group: "VIP",
          user: "alice",
          select: 42,
          from: true,
        },
      });

      const rec = await orders.getRecord(1001);
      expect(rec).toBeDefined();
      expect(rec?.key).toBe(1001);
      expect(rec?.columns.group).toBe("VIP");
      expect(rec?.columns.user).toBe("alice");
      expect(rec?.columns.select).toBe(42);
      expect(rec?.columns.from).toBe(true);

      const byUser = await orders.getBy("user", "alice");
      expect(byUser).toBeDefined();
      expect(byUser?.key).toBe(1001);

      await db.close();
    });
  });

  describe("2. Security: Reserved Word & Prototype Pollution Prevention", () => {
    it("rejects prototype pollution keys (__proto__, prototype, constructor)", () => {
      expect(() => {
        validateTableSchema({
          primaryKey: { name: "id", type: "string" },
          keys: JSON.parse('{"__proto__": {"type": "string"}}'),
        });
      }).toThrow(KvdbSchemaError);

      expect(() => {
        validateTableSchema({
          primaryKey: { name: "id", type: "string" },
          keys: {
            constructor: { type: "string" },
          } as any,
        });
      }).toThrow(KvdbSchemaError);
    });

    it("rejects reserved internal keys in a case-insensitive manner", () => {
      expect(() => {
        validateTableSchema({
          primaryKey: { name: "id", type: "string" },
          keys: {
            VALUE: { type: "string" },
          },
        });
      }).toThrow(KvdbSchemaError);

      expect(() => {
        validateTableSchema({
          primaryKey: { name: "id", type: "string" },
          keys: {
            Expires_At: { type: "number" },
          },
        });
      }).toThrow(KvdbSchemaError);

      expect(() => {
        validateTableSchema({
          primaryKey: { name: "_id", type: "string" },
          keys: {},
        });
      }).toThrow(KvdbSchemaError);
    });
  });

  describe("3. Security: Query Path Parser Injection Protection", () => {
    it("rejects injection attempts in JSON path segments", () => {
      expect(() => parsePath("user.name; DROP TABLE kvdb_kv;--")).toThrow(KvdbQueryError);
      expect(() => parsePath("items[0].id\" OR 1=1")).toThrow(KvdbQueryError);
      expect(() => parsePath("valid_path.sub-field$123")).not.toThrow();
    });

    it("rejects invalid characters in parseColumnField", () => {
      expect(() => parseColumnField("user;DROP TABLE--", 1)).toThrow(KvdbQueryError);
      expect(() => parseColumnField("col name with spaces", 1)).toThrow(KvdbQueryError);
      expect(() => parseColumnField("valid_column_name", 1)).not.toThrow();
    });
  });

  describe("4. Security & Evolution Safety: Non-Nullable Evolution Requires Default", () => {
    it("rejects adding a nullable: false column without a default value", () => {
      const schema = {
        primaryKey: { name: "id", type: "string" as const },
        keys: {
          name: { type: "string" as const },
        },
      };

      expect(() => {
        evolveSchemaAddKey(schema, "requiredField", {
          type: "string",
          nullable: false,
        });
      }).toThrow(KvdbSchemaError);

      expect(() => {
        evolveSchemaAddKey(schema, "requiredFieldWithDefault", {
          type: "string",
          nullable: false,
          default: "active",
        });
      }).not.toThrow();
    });
  });

  describe("5. Logic Parity: Table.update on Schema Tables", () => {
    it("performs atomic read-modify-write on schema tables and syncs cache", async () => {
      const db = new KVDB({
        driver: "sqlite",
        url: ":memory:",
        cache: { driver: "memory" },
      });

      const users = db.table<{ name: string; score: number }>("users", {
        schema: {
          primaryKey: { name: "id", type: "string" },
          keys: {
            role: { type: "string", index: true },
          },
        },
      });

      await users.set("u1", { name: "Alice", score: 10 }, {
        keys: { role: "admin" },
      });

      // Partial object update
      const updated = await users.update("u1", { score: 15 });
      expect(updated).toEqual({ name: "Alice", score: 15 });

      // Point get should read updated value from cache / table
      const fetched = await users.get("u1");
      expect(fetched).toEqual({ name: "Alice", score: 15 });

      // Physical record columns should be preserved
      const rec = await users.getRecord("u1");
      expect(rec?.columns.role).toBe("admin");

      // Function patch update
      await users.update("u1", (cur) => ({ ...cur, score: cur.score + 5 }));
      const finalVal = await users.get("u1");
      expect(finalVal?.score).toBe(20);

      await db.close();
    });
  });

  describe("6. Logic Parity: Batch Operations on Schema Tables", () => {
    it("supports getMany, setMany, and deleteMany on schema tables", async () => {
      const db = new KVDB({ driver: "sqlite", url: ":memory:" });
      const products = db.table<{ title: string; price: number }>("products", {
        schema: {
          primaryKey: { name: "sku", type: "string" },
          keys: {
            category: { type: "string" },
          },
        },
      });

      await products.setMany([
        { key: "p1", value: { title: "Book", price: 20 }, keys: { category: "media" } },
        { key: "p2", value: { title: "Pen", price: 5 }, keys: { category: "office" } },
        { key: "p3", value: { title: "Laptop", price: 999 }, keys: { category: "tech" } },
      ]);

      const items = await products.getMany(["p1", "p2", "nonexistent"]);
      expect(items[0]?.title).toBe("Book");
      expect(items[1]?.title).toBe("Pen");
      expect(items[2]).toBeUndefined();

      const deletedCount = await products.deleteMany(["p1", "p3"]);
      expect(deletedCount).toBe(2);

      const remaining = await products.getMany(["p1", "p2", "p3"]);
      expect(remaining[0]).toBeUndefined();
      expect(remaining[1]?.title).toBe("Pen");
      expect(remaining[2]).toBeUndefined();

      await db.close();
    });
  });

  describe("7. Logic Parity: Hook Integration on Schema Tables", () => {
    it("fires beforeRead, afterRead, beforeWrite, and afterWrite on schema tables", async () => {
      const events: string[] = [];
      const testPlugin: Plugin = {
        name: "audit-test-plugin",
        setup(context) {
          context.on("beforeWrite", (ctx) => {
            events.push(`beforeWrite:${ctx.key}`);
            return ctx;
          });
          context.on("afterWrite", (ctx) => {
            events.push(`afterWrite:${ctx.key}`);
            return ctx;
          });
          context.on("beforeRead", (ctx) => {
            events.push(`beforeRead:${ctx.key}`);
            return ctx;
          });
          context.on("afterRead", (ctx) => {
            events.push(`afterRead:${ctx.key}`);
            return ctx;
          });
        },
      };

      const db = new KVDB({
        driver: "sqlite",
        url: ":memory:",
        plugins: [testPlugin],
      });

      const users = db.table<{ name: string }>("users", {
        schema: {
          primaryKey: { name: "id", type: "string" },
          keys: { email: { type: "string" } },
        },
      });

      await users.set("u1", { name: "Bob" }, { keys: { email: "bob@example.com" } });
      await users.get("u1");

      expect(events).toEqual([
        "beforeWrite:u1",
        "afterWrite:u1",
        "beforeRead:u1",
        "afterRead:u1",
      ]);

      await db.close();
    });
  });

  describe("8. Performance: Cache Stampede (Thundering Herd) Prevention", () => {
    it("collapses concurrent cache misses into a single underlying fetch", async () => {
      const cache = new Cache({ driver: "memory" });
      let fetchCount = 0;

      const slowFetch = vi.fn(async () => {
        fetchCount++;
        await new Promise((r) => setTimeout(r, 20));
        return { data: "expensive-result", timestamp: Date.now() };
      });

      // Fire 10 concurrent wrap requests for the same uncached key
      const results = await Promise.all([
        cache.wrap("heavy-key", slowFetch),
        cache.wrap("heavy-key", slowFetch),
        cache.wrap("heavy-key", slowFetch),
        cache.wrap("heavy-key", slowFetch),
        cache.wrap("heavy-key", slowFetch),
        cache.wrap("heavy-key", slowFetch),
        cache.wrap("heavy-key", slowFetch),
        cache.wrap("heavy-key", slowFetch),
        cache.wrap("heavy-key", slowFetch),
        cache.wrap("heavy-key", slowFetch),
      ]);

      // All 10 callers should receive identical results
      expect(results).toHaveLength(10);
      for (const res of results) {
        expect(res.data).toBe("expensive-result");
      }

      // The compute function should only have been called ONCE
      expect(fetchCount).toBe(1);
      expect(slowFetch).toHaveBeenCalledTimes(1);

      // Subsequent call hits cache directly
      const cachedHit = await cache.wrap("heavy-key", slowFetch);
      expect(cachedHit.data).toBe("expensive-result");
      expect(fetchCount).toBe(1);
    });
  });

  describe("9. Performance: AutoIndexManager Memory Capping", () => {
    it("evicts oldest tracked paths when exceeding maxTracked capacity", () => {
      const manager = new AutoIndexManager(5, 10); // threshold 5, maxTracked 10

      // Record 15 distinct paths (each queried once)
      for (let i = 1; i <= 15; i++) {
        manager.record([`path_${i}`]);
      }

      // Record path_1 4 more times: since it was one of the first 5, it should have been evicted
      // and thus start counting from scratch (total count will be 4, not reaching threshold 5)
      const toIndex = manager.record(["path_1", "path_1", "path_1", "path_1"]);
      expect(toIndex).toEqual([]);

      // But path_15 was recently added (not evicted). 4 more queries reaches threshold 5
      const toIndex15 = manager.record(["path_15", "path_15", "path_15", "path_15"]);
      expect(toIndex15).toEqual(["path_15"]);
    });
  });

  describe("10. Soundness: Cache Fill-on-Read Preserves Remaining TTL", () => {
    it("backfills cache with remaining TTL so cached entries expire alongside DB rows", async () => {
      const cache = new Cache({ driver: "memory" });
      const db = new KVDB({
        driver: "sqlite",
        url: ":memory:",
        cache,
      });

      const items = db.table<{ name: string }>("ttl_items");

      // Write with 80ms TTL
      await items.set("k1", { name: "Temp" }, { ttlMs: 80 });

      // First read: reads from DB, backfills cache with remaining TTL (~80ms)
      const firstGet = await items.get("k1");
      expect(firstGet).toEqual({ name: "Temp" });

      // Check that cache has it
      const cachedKey = "ttl_items:k1";
      expect(await cache.get(cachedKey)).toEqual({ name: "Temp" });

      // Wait 120ms for both DB and cache to expire
      await new Promise((r) => setTimeout(r, 120));

      // Second read: should be undefined (cache must not return stale expired value)
      const secondGet = await items.get("k1");
      expect(secondGet).toBeUndefined();
      expect(await cache.get(cachedKey)).toBeUndefined();

      await db.close();
    });
  });

  describe("11. Performance: Schema Table Batch setMany/deleteMany and Cache Sync", () => {
    it("executes batch operations atomically and syncs cache", async () => {
      const db = new KVDB({
        driver: "sqlite",
        url: ":memory:",
        cache: { driver: "memory" },
      });

      const metrics = db.table<{ value: number }>("metrics", {
        schema: {
          primaryKey: { name: "id", type: "integer" },
          keys: {
            host: { type: "string", index: true },
          },
        },
      });

      // Batch set 50 items
      const batch = Array.from({ length: 50 }, (_, i) => ({
        key: i + 1,
        value: { value: i * 10 },
        keys: { host: `server-${i % 5}` },
      }));

      await metrics.setMany(batch);

      // Verify all items are accessible
      const fetched = await metrics.getMany([1, 25, 50]);
      expect(fetched[0]).toEqual({ value: 0 });
      expect(fetched[1]).toEqual({ value: 240 });
      expect(fetched[2]).toEqual({ value: 490 });

      // Verify batch delete
      const deleted = await metrics.deleteMany([1, 25]);
      expect(deleted).toBe(2);

      const afterDelete = await metrics.getMany([1, 25, 50]);
      expect(afterDelete[0]).toBeUndefined();
      expect(afterDelete[1]).toBeUndefined();
      expect(afterDelete[2]).toEqual({ value: 490 });

      await db.close();
    });
  });

  describe("12. Soundness: AutoIndexManager Namespace Scoping", () => {
    it("scopes autoIndex counts per namespace so different tables do not collide", async () => {
      const db = new KVDB({
        driver: "sqlite",
        url: ":memory:",
        autoIndex: { threshold: 3 },
      });

      const users = db.table("users");
      const orders = db.table("orders");

      // Query "status" on users 2 times (under threshold 3)
      await users.find({ where: { status: "active" } });
      await users.find({ where: { status: "active" } });

      // Query "status" on orders 2 times (under threshold 3)
      await orders.find({ where: { status: "pending" } });
      await orders.find({ where: { status: "pending" } });

      // If counts were un-scoped, total "status" count would be 4 (> threshold 3).
      // Because counts are scoped (users::status and orders::status each have count 2),
      // neither has triggered ensureIndex yet.
      const sqliteDb = (await db.raw()) as any;
      const indexesUsers = sqliteDb
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE '%status%'")
        .all();
      expect(indexesUsers).toHaveLength(0);

      // One more query on users triggers its threshold 3
      await users.find({ where: { status: "active" } });

      const indexesAfter = sqliteDb
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE '%status%'")
        .all();
      expect(indexesAfter.length).toBeGreaterThanOrEqual(1);

      await db.close();
    });
  });

  describe("13. Security: Prototype Pollution Prevention in table.update & parseWhere", () => {
    it("strips __proto__, constructor, and prototype from table.update patch objects", async () => {
      const db = new KVDB({ driver: "sqlite", url: ":memory:" });
      const users = db.table<{ name: string; age: number }>("users");

      await users.set("alice", { name: "Alice", age: 30 });

      // Craft malicious patch with dangerous properties
      const maliciousPatch = JSON.parse(
        '{"name": "Alice Cooper", "__proto__": {"polluted": true}, "constructor": {"evil": true}, "prototype": {"hacked": true}}'
      );

      const updated = await users.update("alice", maliciousPatch);
      expect(updated.name).toBe("Alice Cooper");
      expect(updated.age).toBe(30);

      // Verify Object.prototype is not polluted
      expect((Object.prototype as any).polluted).toBeUndefined();
      expect((Object.prototype as any).evil).toBeUndefined();
      expect((Object.prototype as any).hacked).toBeUndefined();
      expect((updated as any).polluted).toBeUndefined();
      expect((updated as any).evil).toBeUndefined();
      expect((updated as any).hacked).toBeUndefined();

      // Read back from DB and verify clean record
      const stored = await users.get("alice");
      expect(stored?.name).toBe("Alice Cooper");
      expect((stored as any)?.polluted).toBeUndefined();
      expect((stored as any)?.evil).toBeUndefined();
      expect((stored as any)?.hacked).toBeUndefined();

      await db.close();
    });

    it("rejects prototype pollution keys in parseWhere", () => {
      expect(() => {
        parseWhere(JSON.parse('{"__proto__": "attack"}'));
      }).toThrow(KvdbQueryError);

      expect(() => {
        parseWhere({ constructor: "attack" } as any);
      }).toThrow(KvdbQueryError);

      expect(() => {
        parseWhere({ prototype: "attack" } as any);
      }).toThrow(KvdbQueryError);
    });
  });

  describe("14. Security: Pagination Limit and Offset Soundness", () => {
    it("rejects negative or non-integer limit and offset in parseFindOptions", () => {
      expect(() => {
        parseFindOptions({ limit: -1 });
      }).toThrow(KvdbQueryError);

      expect(() => {
        parseFindOptions({ limit: 1.5 });
      }).toThrow(KvdbQueryError);

      expect(() => {
        parseFindOptions({ limit: NaN });
      }).toThrow(KvdbQueryError);

      expect(() => {
        parseFindOptions({ offset: -10 });
      }).toThrow(KvdbQueryError);

      expect(() => {
        parseFindOptions({ offset: Infinity });
      }).toThrow(KvdbQueryError);
    });

    it("accepts valid non-negative integer limit and offset", () => {
      const opts = parseFindOptions({ limit: 50, offset: 100 });
      expect(opts.limit).toBe(50);
      expect(opts.offset).toBe(100);
    });
  });

  describe("15. Security: AutoIndexManager maxIndexed Bound", () => {
    it("respects maxIndexed limit to prevent unbounded memory growth and DDL storms", () => {
      // AutoIndexManager(threshold, maxTracked, maxIndexed)
      const manager = new AutoIndexManager(2, 100, 3);

      // First query records paths
      const first = manager.record(["p1", "p2", "p3", "p4"]);
      expect(first).toEqual([]);

      // Second query reaches threshold 2 for all 4 paths, but maxIndexed is 3
      const second = manager.record(["p1", "p2", "p3", "p4"]);
      expect(second).toEqual(["p1", "p2", "p3"]);

      // Subsequent query on p4 should still be ignored because maxIndexed (3) was reached
      const third = manager.record(["p4"]);
      expect(third).toEqual([]);
    });
  });

  describe("16. Performance: SqliteCacheStore Identifier Quoting & Prepared Transactions", () => {
    it("handles SQL keyword table names and properly executes setMany and deleteMany", () => {
      const store = new SqliteCacheStore({
        file: ":memory:",
        table: "order", // SQL reserved keyword
      });

      const entries = [
        { key: "k1", value: "v1", ttlMs: 60000 },
        { key: "k2", value: "v2", ttlMs: 60000 },
        { key: "k3", value: "v3", ttlMs: 60000 },
      ];

      store.setMany(entries);

      expect(store.get("k1")?.value).toBe("v1");
      expect(store.get("k2")?.value).toBe("v2");
      expect(store.get("k3")?.value).toBe("v3");

      // Verify deleteMany with cached transaction
      const deleted = store.deleteMany(["k1", "k3"]);
      expect(deleted).toBe(2);
      expect(store.get("k1")).toBeUndefined();
      expect(store.get("k2")?.value).toBe("v2");
      expect(store.get("k3")).toBeUndefined();

      store.close();
    });
  });

  describe("17. Performance: Table Hook Zero-Cost Fast-Path", () => {
    it("executes CRUD without hook execution overhead when no plugins are registered", async () => {
      const db = new KVDB({ driver: "sqlite", url: ":memory:" });
      const table = db.table("test");

      // Spy on hook runtime has()
      const hasSpy = vi.spyOn((table as any).deps.hooks, "has");

      await table.set("key1", { count: 1 });
      const val = await table.get("key1");
      expect(val).toEqual({ count: 1 });

      await table.update("key1", { count: 2 });
      await table.delete("key1");

      // has() was checked
      expect(hasSpy).toHaveBeenCalled();
      // Since no plugins registered, has() returned false
      expect((table as any).deps.hooks.has("beforeWrite")).toBe(false);

      await db.close();
    });
  });

  describe("18. Performance: PostgreSQL & MongoDB Schema Table Batch Operations", () => {
    it("PostgresSchemaTable.setRecords and deleteRecords execute batch SQL operations", async () => {
      const executedQueries: Array<{ sql: string; params?: unknown[] }> = [];
      const mockClient = {
        query: vi.fn(async (sql: string, params?: unknown[]): Promise<QueryResult> => {
          executedQueries.push({ sql: sql.trim(), params });
          if (sql.includes("SELECT schema_json FROM kvdb_schema_registry")) {
            return { rows: [], rowCount: 0, command: "SELECT", oid: 0, fields: [] };
          }
          if (sql.includes("DELETE FROM") || sql.includes("INSERT INTO")) {
            return { rows: [], rowCount: params?.length ?? 1, command: "OK", oid: 0, fields: [] };
          }
          return { rows: [], rowCount: 0, command: "OK", oid: 0, fields: [] };
        }),
        release: vi.fn(),
      };
      const mockPool = {
        query: mockClient.query,
        connect: vi.fn(async () => mockClient),
        end: vi.fn(async () => {}),
      } as unknown as Pool;

      const driver = new PostgresDriver(mockPool, "kvdb_kv");
      const schema = {
        primaryKey: { name: "id", type: "string" as const },
        keys: {
          tag: { type: "string" as const },
        },
      };
      const schemaTable = await driver.openSchemaTable!("items", schema);

      const records = [
        { key: "item-1", value: JSON.stringify({ name: "First" }), columns: { tag: "alpha" } },
        { key: "item-2", value: JSON.stringify({ name: "Second" }), columns: { tag: "beta" } },
      ];

      await schemaTable!.setRecords!(records);

      // Verify batch insert was executed with single SQL and multi-row placeholders
      const insertQuery = executedQueries.find((q) => q.sql.includes('INSERT INTO "kvdb_schema_items_'));
      expect(insertQuery).toBeDefined();
      expect(insertQuery?.sql).toContain("ON CONFLICT");
      expect(insertQuery?.sql).toContain("DO UPDATE SET");
      // 2 records * 6 parameters per record (id, tag, value, expires_at, created_at, updated_at)
      expect(insertQuery?.params).toHaveLength(12);

      // Verify batch delete was executed with single ANY($1) SQL
      await schemaTable!.deleteRecords!(["item-1", "item-2"]);
      const deleteQuery = executedQueries.find((q) => q.sql.includes('DELETE FROM "kvdb_schema_items_'));
      expect(deleteQuery).toBeDefined();
      expect(deleteQuery?.sql).toContain('WHERE "id" = ANY($1)');
      expect(deleteQuery?.params).toEqual([["item-1", "item-2"]]);
    });

    it("MongoSchemaTable.setRecords and deleteRecords execute bulkWrite and deleteMany", async () => {
      const mockItemsCollection = {
        bulkWrite: vi.fn(async (_ops: any[]) => ({ ok: 1 })),
        deleteMany: vi.fn(async (_filter: any) => ({ deletedCount: 2 })),
        createIndex: vi.fn(async () => "ok"),
      };
      const mockRegistryCollection = {
        findOne: vi.fn(async () => null),
        updateOne: vi.fn(async () => ({ matchedCount: 1 })),
        createIndex: vi.fn(async () => "ok"),
      };

      const mockDb = {
        collection: vi.fn((name: string) => {
          if (name === "kvdb_schema_registry") return mockRegistryCollection;
          return mockItemsCollection;
        }),
      } as unknown as Db;

      const mockClient = {
        close: vi.fn(async () => {}),
      } as unknown as MongoClient;

      const driver = new MongoDriver(mockClient, mockDb, mockItemsCollection as any);
      const schema = {
        primaryKey: { name: "id", type: "string" as const },
        keys: {
          tag: { type: "string" as const },
        },
      };
      const schemaTable = await driver.openSchemaTable!("items", schema);

      const records = [
        { key: "item-1", value: JSON.stringify({ name: "First" }), columns: { tag: "alpha" } },
        { key: "item-2", value: JSON.stringify({ name: "Second" }), columns: { tag: "beta" } },
      ];

      await schemaTable!.setRecords!(records);
      expect(mockItemsCollection.bulkWrite).toHaveBeenCalledTimes(1);
      const ops = mockItemsCollection.bulkWrite.mock.calls[0]![0];
      expect(ops).toHaveLength(2);
      expect(ops[0].updateOne.filter).toEqual({ _id: "item-1" });
      expect(ops[0].updateOne.upsert).toBe(true);

      await schemaTable!.deleteRecords!(["item-1", "item-2"]);
      expect(mockItemsCollection.deleteMany).toHaveBeenCalledWith({
        _id: { $in: ["item-1", "item-2"] },
      });
    });
  });
});

