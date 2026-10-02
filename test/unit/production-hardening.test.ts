import { describe, it, expect, vi } from "vitest";
import { KVDB } from "../../src/core/kvdb.js";
import { Cache } from "../../src/cache/cache.js";
import { serialize, deserialize } from "../../src/core/serializer.js";
import { KvdbSerializationError } from "../../src/core/errors.js";

describe("Production Hardening & Reliability Tests", () => {
  describe("Health Check & Graceful Shutdown", () => {
    it("reports healthy status with latency for in-memory SQLite", async () => {
      const db = new KVDB({ driver: "sqlite", url: ":memory:" });
      const health = await db.healthCheck();
      expect(health.ok).toBe(true);
      expect(health.provider).toBe("sqlite");
      expect(typeof health.latencyMs).toBe("number");
      expect(health.latencyMs).toBeGreaterThanOrEqual(0);
      await db.close();
    });

    it("registers and unregisters shutdown hooks safely", async () => {
      const db = new KVDB({ driver: "sqlite", url: ":memory:", gracefulShutdown: true });
      expect(() => db.unregisterShutdownHooks()).not.toThrow();
      expect(() => db.registerShutdownHooks()).not.toThrow();
      await db.close();
    });
  });

  describe("Table updateRecord() Atomicity", () => {
    it("atomically modifies both value and columns on Schema Table", async () => {
      const db = new KVDB({ driver: "sqlite", url: ":memory:" });
      const tbl = db.table("inventory", {
        schema: {
          primaryKey: { name: "sku", type: "string" },
          columns: {
            stock: { type: "integer", default: 100 },
            status: { type: "string", default: "in_stock" },
          },
        },
      });

      await tbl.set("SKU-100", { name: "Pro Laptop" }, { keys: { stock: 10, status: "in_stock" } });

      const updated = await tbl.updateRecord("SKU-100", (current) => {
        expect(current).toBeDefined();
        expect(current?.columns.stock).toBe(10);
        return {
          value: { name: "Pro Laptop (Reserved)" },
          columns: { stock: 9, status: "in_stock" },
        };
      });

      expect(updated.columns.stock).toBe(9);
      expect((updated.value as any).name).toBe("Pro Laptop (Reserved)");

      const fetched = await tbl.getRecord("SKU-100");
      expect(fetched?.columns.stock).toBe(9);
      expect(fetched?.value).toEqual({ name: "Pro Laptop (Reserved)" });

      await db.close();
    });

    it("aborts and preserves original row when updateRecord mutator throws", async () => {
      const db = new KVDB({ driver: "sqlite", url: ":memory:" });
      const tbl = db.table("balances", {
        schema: {
          primaryKey: { name: "userId", type: "string" },
          columns: { balance: { type: "integer", default: 0 } },
        },
      });

      await tbl.set("u1", { note: "initial" }, { keys: { balance: 50 } });

      await expect(
        tbl.updateRecord("u1", (current) => {
          const bal = Number(current?.columns.balance ?? 0);
          if (bal < 100) {
            throw new Error("Insufficient balance");
          }
          return { columns: { balance: bal - 100 } };
        }),
      ).rejects.toThrow("Insufficient balance");

      const row = await tbl.getRecord("u1");
      expect(row?.columns.balance).toBe(50);
      expect(row?.value).toEqual({ note: "initial" });

      await db.close();
    });
  });

  describe("Cache SingleFlight & Concurrency Protection", () => {
    it("collapses concurrent wrap() requests to a single fetch execution", async () => {
      const cache = new Cache();
      let fetchCount = 0;

      const fetcher = async () => {
        fetchCount++;
        await new Promise((r) => setTimeout(r, 20));
        return { price: 99.9 };
      };

      const results = await Promise.all([
        cache.wrap("btc", fetcher),
        cache.wrap("btc", fetcher),
        cache.wrap("btc", fetcher),
        cache.wrap("btc", fetcher),
        cache.wrap("btc", fetcher),
      ]);

      expect(fetchCount).toBe(1);
      for (const res of results) {
        expect(res).toEqual({ price: 99.9 });
      }

      await cache.close();
    });
  });

  describe("Serializer Security: Max Depth & Prototype Pollution", () => {
    it("guards against deeply nested objects causing stack overflow", () => {
      let deep: any = { val: 1 };
      for (let i = 0; i < 70; i++) {
        deep = { child: deep };
      }

      expect(() => serialize(deep)).toThrow(KvdbSerializationError);
      expect(() => serialize(deep)).toThrow(/Maximum JSON depth/);
    });

    it("strips prototype pollution keys (__proto__, constructor) on deserialize", () => {
      const payload = '{"title":"ok","__proto__":{"polluted":"yes"},"constructor":{"admin":true}}';
      const parsed: any = deserialize(payload);
      expect(parsed.title).toBe("ok");
      expect(parsed.polluted).toBeUndefined();
      expect(({} as any).polluted).toBeUndefined();
    });

    it("skips dangerous prototype keys during canonicalize serialization", () => {
      const obj = { normal: 1, __proto__: { evil: 2 }, constructor: { evil: 3 } };
      const serialized = serialize(obj);
      expect(serialized).toContain('"normal":1');
      expect(serialized).not.toContain('"evil"');
    });
  });
});
