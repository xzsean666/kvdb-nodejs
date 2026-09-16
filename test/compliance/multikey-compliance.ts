// Reusable multi-key driver compliance suite (docs/ARCHITECTURE.md KD-8).
//
// Tests physical schema tables, dynamic key evolution, composite indexing,
// secondary key lookups, and multi-key querying against REAL database instances.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Driver, SchemaTableDriver } from "../../src/drivers/types.js";
import type { MultiKeySchema } from "../../src/core/table-schema.js";
import { parseSchemaWhere, parseFindOptions } from "../../src/query/parser.js";
import { serialize } from "../../src/core/serializer.js";

type MakeDriver = () => Promise<Driver>;

export function describeMultiKeyCompliance(label: string, makeDriver: MakeDriver): void {
  describe(`Multi-Key Driver Compliance: ${label}`, () => {
    let driver: Driver;

    beforeEach(async () => {
      driver = await makeDriver();
      await driver.clear();
    });

    afterEach(async () => {
      await driver.clear();
      await driver.close();
    });

    it("coexists cleanly with standard KV operations", async () => {
      // 1. Standard KV operations
      await driver.set("global:config", serialize({ theme: "dark" }));
      expect(await driver.has("global:config")).toBe(true);

      // 2. Multi-key physical table
      const schema: MultiKeySchema = {
        primaryKey: { name: "id", type: "string" },
        keys: {
          tag: { type: "string" },
        },
      };

      const table = (await driver.openSchemaTable!("coexist_tbl", schema)) as SchemaTableDriver;
      expect(table).toBeDefined();

      await table.setRecord("item1", serialize({ name: "Widget" }), { tag: "tools" });
      const record = await table.getRecord("item1");
      expect(record).toBeDefined();
      expect(record!.columns.tag).toBe("tools");

      // 3. Standard KV key remains unaffected
      const kvEntry = await driver.get("global:config");
      expect(kvEntry?.value).toBe('{"theme":"dark"}');
    });

    it("supports integer primary keys and multiple data types", async () => {
      const schema: MultiKeySchema = {
        primaryKey: { name: "blockNumber", type: "integer" },
        keys: {
          hash: { type: "string", index: { unique: true } },
          gasUsed: { type: "number" },
          isSuccess: { type: "boolean", default: true },
          meta: { type: "json", nullable: true },
        },
      };

      const table = (await driver.openSchemaTable!("blocks_compliance", schema)) as SchemaTableDriver;

      await table.setRecord(
        1001,
        serialize({ extraData: "test" }),
        {
          hash: "0xhash1001",
          gasUsed: 21000.5,
          isSuccess: true,
          meta: { client: "geth", priority: 1 },
        },
      );

      await table.setRecord(
        1002,
        serialize({ extraData: "empty" }),
        {
          hash: "0xhash1002",
          gasUsed: 42000,
          isSuccess: false,
          meta: null,
        },
      );

      // Point lookup by integer PK
      const b1 = await table.getRecord(1001);
      expect(b1).toBeDefined();
      expect(b1!.key).toBe(1001);
      expect(b1!.columns.hash).toBe("0xhash1001");
      expect(b1!.columns.gasUsed).toBe(21000.5);
      expect(b1!.columns.isSuccess).toBe(true);
      expect(b1!.columns.meta).toEqual({ client: "geth", priority: 1 });

      const b2 = await table.getRecord(1002);
      expect(b2?.columns.isSuccess).toBe(false);
      expect(b2?.columns.meta).toBeNull();
    });

    it("supports fast O(1) point lookup via getRecordByKey", async () => {
      const schema: MultiKeySchema = {
        primaryKey: { name: "id", type: "integer" },
        keys: {
          email: { type: "string", index: { unique: true } },
          role: { type: "string" },
        },
      };

      const table = (await driver.openSchemaTable!("users_lookup", schema)) as SchemaTableDriver;

      await table.setRecord(1, serialize({ name: "Alice" }), { email: "alice@example.com", role: "admin" });
      await table.setRecord(2, serialize({ name: "Bob" }), { email: "bob@example.com", role: "user" });

      const found = await table.getRecordByKey!("email", "alice@example.com");
      expect(found).toBeDefined();
      expect(found!.key).toBe(1);
      expect(found!.columns.email).toBe("alice@example.com");
      expect(JSON.parse(found!.value)).toEqual({ name: "Alice" });

      const notFound = await table.getRecordByKey!("email", "nobody@example.com");
      expect(notFound).toBeUndefined();
    });

    it("supports dynamic schema evolution via addKey and addIndex", async () => {
      const schema: MultiKeySchema = {
        primaryKey: { name: "id", type: "integer" },
        keys: {
          title: { type: "string" },
        },
      };

      const table = (await driver.openSchemaTable!("posts_evo", schema)) as SchemaTableDriver;

      // Write before dynamic key
      await table.setRecord(1, serialize({ text: "p1" }), { title: "First" });

      // Dynamically add key with index
      await table.addKey!("status", { type: "string", default: "draft", index: true });

      // Write after dynamic key
      await table.setRecord(2, serialize({ text: "p2" }), { title: "Second", status: "published" });

      // Verify row 1 receives default / null and row 2 receives explicit value
      const rec1 = await table.getRecord(1);
      expect(rec1?.columns.title).toBe("First");
      expect(rec1?.columns.status).toBe("draft");

      const rec2 = await table.getRecord(2);
      expect(rec2?.columns.title).toBe("Second");
      expect(rec2?.columns.status).toBe("published");

      // Verify lookup by newly added key
      const lookup = await table.getRecordByKey!("status", "published");
      expect(lookup?.key).toBe(2);

      // Dynamically add composite index
      await table.addIndex!({
        name: "title_status_comp",
        keys: ["title", "status"],
      });
    });

    it("supports multi-key filtering, compound sorting, and pagination", async () => {
      const schema: MultiKeySchema = {
        primaryKey: { name: "orderId", type: "integer" },
        keys: {
          tenantId: { type: "string", index: true },
          amount: { type: "number" },
          status: { type: "string" },
        },
        indexes: [
          { name: "tenant_amount_idx", keys: ["tenantId", "amount"] },
        ],
      };

      const table = (await driver.openSchemaTable!("orders_query", schema)) as SchemaTableDriver;

      await table.setRecord(101, serialize({ desc: "A" }), { tenantId: "t1", amount: 50, status: "paid" });
      await table.setRecord(102, serialize({ desc: "B" }), { tenantId: "t1", amount: 150, status: "paid" });
      await table.setRecord(103, serialize({ desc: "C" }), { tenantId: "t1", amount: 250, status: "pending" });
      await table.setRecord(104, serialize({ desc: "D" }), { tenantId: "t2", amount: 300, status: "paid" });
      await table.setRecord(105, serialize({ desc: "E" }), { tenantId: "t1", amount: 350, status: "paid" });

      // Filter by tenantId AND amount > 100 AND status = 'paid'
      const whereNode = parseSchemaWhere({
        tenantId: "t1",
        amount: { $gt: 100 },
        status: "paid",
      }, schema);

      const findOpts = parseFindOptions({
        sort: [{ path: "amount", direction: "desc" }],
        limit: 10,
      }, schema);

      const rows = await table.find(whereNode, findOpts);
      expect(rows).toHaveLength(2);
      expect(rows[0]?.key).toBe(105);
      expect(rows[0]?.columns.amount).toBe(350);
      expect(rows[1]?.key).toBe(102);
      expect(rows[1]?.columns.amount).toBe(150);
    });

    it("supports delete and clear on schema tables", async () => {
      const schema: MultiKeySchema = {
        primaryKey: { name: "id", type: "integer" },
        keys: {
          val: { type: "integer" },
        },
      };

      const table = (await driver.openSchemaTable!("cleanup_tbl", schema)) as SchemaTableDriver;

      await table.setRecord(1, serialize("v1"), { val: 10 });
      await table.setRecord(2, serialize("v2"), { val: 20 });

      expect(await table.delete(1)).toBe(true);
      expect(await table.getRecord(1)).toBeUndefined();
      expect(await table.getRecord(2)).toBeDefined();

      await table.clear();
      expect(await table.getRecord(2)).toBeUndefined();
    });
  });
}
