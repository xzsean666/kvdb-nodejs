import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { KVDB } from "../../src/core/kvdb.js";
import { MysqlDialect } from "../../src/drivers/mysql/dialect.js";
import { parsePath } from "../../src/query/parser.js";
import type { TableSchema } from "../../src/core/table-schema.js";

interface TestDoc {
  name: string;
  category: string;
  score: number;
}

interface TestColumns extends Record<string, unknown> {
  category: string;
  score: number;
}

const TEST_SCHEMA: TableSchema<TestColumns> = {
  primaryKey: { name: "id", type: "string" },
  columns: {
    category: { type: "string", index: true },
    score: { type: "integer", index: true },
  },
  keys: {
    category: { type: "string", index: true },
    score: { type: "integer", index: true },
  },
};

describe("TASK-034: Production Hardening Upgrade", () => {
  let db: KVDB;

  beforeEach(() => {
    db = new KVDB({
      driver: "sqlite",
      url: ":memory:",
      tablePrefix: "test_task34_",
    });
  });

  afterEach(async () => {
    await db.close();
  });

  describe("Table.count() native aggregation pushdown", () => {
    it("accurately counts rows on basic KV table", async () => {
      const table = db.table<TestDoc>("items_kv");
      await table.set("k1", { name: "A", category: "c1", score: 10 });
      await table.set("k2", { name: "B", category: "c1", score: 20 });
      await table.set("k3", { name: "C", category: "c2", score: 30 });

      expect(await table.count()).toBe(3);
      expect(await table.count({ where: { category: "c1" } })).toBe(2);
      expect(await table.count({ where: { category: "c2" } })).toBe(1);
      expect(await table.count({ where: { category: "c3" } })).toBe(0);
    });

    it("accurately counts rows on physical Schema table with column pushdown", async () => {
      const table = db.table<TestDoc, TestColumns>("items_schema", {
        schema: TEST_SCHEMA,
      });

      await table.set("id_1", { name: "Item 1", category: "alpha", score: 100 }, {
        keys: { category: "alpha", score: 100 },
      });
      await table.set("id_2", { name: "Item 2", category: "alpha", score: 200 }, {
        keys: { category: "alpha", score: 200 },
      });
      await table.set("id_3", { name: "Item 3", category: "beta", score: 300 }, {
        keys: { category: "beta", score: 300 },
      });

      expect(await table.count()).toBe(3);
      expect(await table.count({ where: { category: "alpha" } })).toBe(2);
      expect(await table.count({ where: { score: { $gte: 200 } } })).toBe(2);
      expect(await table.count({ where: { category: "beta", score: { $gt: 300 } } })).toBe(0);
    });

    it("supports queryCache on count() and invalidates on writes", async () => {
      const cacheDb = new KVDB({
        driver: "sqlite",
        url: ":memory:",
        cache: { driver: "memory" },
      });
      const table = cacheDb.table<TestDoc>("cached_items", {
        queryCache: true,
      });

      await table.set("k1", { name: "A", category: "c1", score: 10 });
      await table.set("k2", { name: "B", category: "c1", score: 20 });

      expect(await table.count({ where: { category: "c1" } })).toBe(2);
      // Repeated query should hit cache
      expect(await table.count({ where: { category: "c1" } })).toBe(2);

      // Mutate table
      await table.set("k3", { name: "C", category: "c1", score: 30 });
      // Invalidation ensures fresh count is reflected
      expect(await table.count({ where: { category: "c1" } })).toBe(3);

      await cacheDb.close();
    });
  });

  describe("Queue.getStats() and batch management", () => {
    it("getStats() runs native count aggregation across job states", async () => {
      const queue = db.queue<{ msg: string }>("task34_q");

      // Push 3 waiting, 1 delayed
      await queue.push({ msg: "Job 1" });
      await queue.push({ msg: "Job 2" });
      await queue.push({ msg: "Job 3" });
      await queue.push({ msg: "Job 4" }, { delayMs: 100_000 });

      const stats = await queue.getStats();
      expect(stats.waiting).toBe(3);
      expect(stats.delayed).toBe(1);
      expect(stats.active).toBe(0);
      expect(stats.completed).toBe(0);
      expect(stats.failed).toBe(0);
      expect(stats.total).toBe(4);

      // Pop one job -> becomes active
      const job = await queue.pop();
      expect(job).toBeDefined();

      const statsAfterPop = await queue.getStats();
      expect(statsAfterPop.waiting).toBe(2);
      expect(statsAfterPop.active).toBe(1);
      expect(statsAfterPop.delayed).toBe(1);
      expect(statsAfterPop.total).toBe(4);
    });

    it("clean() batches deletions without unbounded memory pressure", async () => {
      const queue = db.queue<{ msg: string }>("task34_clean_q");

      const j1 = await queue.push({ msg: "To clean 1" });
      const j2 = await queue.push({ msg: "To clean 2" });

      // Mark as completed
      const t1 = await queue.pop();
      if (t1) await queue.ack(t1.id, t1.lockToken!, { ok: true } as any);
      const t2 = await queue.pop();
      if (t2) await queue.ack(t2.id, t2.lockToken!, { ok: true } as any);

      const cleaned = await queue.clean({ olderThanMs: 0, states: ["completed"], limit: 1 });
      expect(cleaned).toBe(1);

      const remaining = await queue.clean({ olderThanMs: 0, states: ["completed"], limit: 10 });
      expect(remaining).toBe(1);
    });
  });

  describe("MySQL Dialect JSON Path Quoting", () => {
    it("quotes segments containing hyphens with double quotes", () => {
      const dialect = new MysqlDialect("value");
      const pathWithHyphen = parsePath("user-profile.first-name");
      const rendered = dialect.scalarAt(pathWithHyphen);

      expect(rendered).toBe('JSON_UNQUOTE(JSON_EXTRACT(`value`, \'$."user-profile"."first-name"\'))');
    });

    it("leaves standard alphanumeric identifiers unquoted", () => {
      const dialect = new MysqlDialect("value");
      const standardPath = parsePath("profile.age");
      const rendered = dialect.scalarAt(standardPath);

      expect(rendered).toBe("JSON_UNQUOTE(JSON_EXTRACT(`value`, '$.profile.age'))");
    });
  });
});
