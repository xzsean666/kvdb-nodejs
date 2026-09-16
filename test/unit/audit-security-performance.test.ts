import { describe, it, expect, vi } from "vitest";
import { KVDB } from "../../src/core/kvdb.js";
import { Cache } from "../../src/cache/cache.js";
import { AutoIndexManager } from "../../src/core/auto-index.js";
import { parsePath, parseColumnField } from "../../src/query/parser.js";
import {
  validateTableSchema,
  evolveSchemaAddKey,
} from "../../src/core/table-schema.js";
import {
  KvdbQueryError,
  KvdbSchemaError,
} from "../../src/core/errors.js";
import type { Plugin } from "../../src/plugins/types.js";

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
});
