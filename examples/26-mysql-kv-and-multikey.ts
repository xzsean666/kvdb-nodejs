/**
 * 26-mysql-kv-and-multikey.ts
 *
 * Demonstrates KVDB SDK with the MySQL / MariaDB driver:
 * 1. Initializing KVDB with MySQL driver
 * 2. High-performance KV CRUD and Batch operations
 * 3. Dynamic Multi-Key Schema Tables with secondary keys and physical indexing
 * 4. AST-based querying with compound sorting across relational columns & JSON
 * 5. Strict ACID row-level locking (SELECT ... FOR UPDATE) for concurrent updates
 */

import { KVDB } from "../src/index.js";

const MYSQL_URL =
  process.env.MYSQL_URL ??
  process.env.KVDB_TEST_MYSQL_URL ??
  "mysql://root:kvdb_test@127.0.0.1:3307/kvdb_test";

async function main() {
  const db = new KVDB({
    driver: "mysql",
    url: MYSQL_URL,
    table: "demo_mysql_kv",
  });

  try {
    await db.connect();
  } catch (err) {
    console.log("MySQL/MariaDB instance not reachable at", MYSQL_URL, "Skipping example.");
    return;
  }

  console.log("=== 1. Initializing KVDB with MySQL Driver ===");
  const kv = db.table("settings");
  await kv.clear();

  console.log("\n=== 2. High-Performance KV CRUD & Batch Operations ===");
  await kv.setMany([
    { key: "site:title", value: "KVDB Enterprise Hub" },
    { key: "site:maintenance", value: false },
    { key: "site:max_concurrency", value: 1000 },
  ]);

  const title = await kv.get("site:title");
  console.log("Retrieved site:title ->", title);

  console.log("\n=== 3. Dynamic Multi-Key Schema Table with Physical Indexing ===");
  const orders = db.table<{ item: string; priority: number }>("orders", {
    schema: {
      primaryKey: { name: "orderId", type: "integer" },
      keys: {
        customerId: { type: "string", index: true },
        amount: { type: "number" },
        status: { type: "string" },
      },
      indexes: [
        { name: "idx_orders_customer_amount", keys: ["customerId", "amount"] },
      ],
    },
  });

  await orders.clear();

  await orders.set(10001, { item: "MacBook Pro", priority: 1 }, {
    keys: { customerId: "cust_apple", amount: 2499, status: "completed" },
  });
  await orders.set(10002, { item: "Magic Mouse", priority: 3 }, {
    keys: { customerId: "cust_apple", amount: 99, status: "completed" },
  });
  await orders.set(10003, { item: "Studio Display", priority: 2 }, {
    keys: { customerId: "cust_apple", amount: 1599, status: "pending" },
  });
  await orders.set(10004, { item: "ThinkPad X1", priority: 1 }, {
    keys: { customerId: "cust_lenovo", amount: 1899, status: "completed" },
  });

  console.log("\n=== 4. AST-based Querying & Compound Sorting ===");
  const appleCompleted = await orders.findRecords({
    where: { customerId: "cust_apple", status: "completed" },
    sort: [{ path: "amount", direction: "desc" }],
  });

  console.log("Apple completed orders sorted by amount descending:");
  for (const o of appleCompleted) {
    console.log(` - Order #${o.key}: ${o.value.item} (Amount: $${o.columns.amount})`);
  }

  console.log("\n=== 5. Row-level Lock Atomic Concurrency (SELECT ... FOR UPDATE) ===");
  const inventory = db.table("inventory");
  await inventory.set("stock:item_42", { remaining: 50 });

  const tasks = Array.from({ length: 15 }, (_, i) =>
    inventory.update<{ remaining: number }>("stock:item_42", (curr) => ({
      remaining: (curr?.remaining ?? 0) - 1,
    })),
  );
  await Promise.all(tasks);

  const stock = await inventory.get<{ remaining: number }>("stock:item_42");
  console.log("Remaining stock after 15 concurrent decrements:", stock?.remaining);

  await db.dropTable("orders");
  await db.close();
  console.log("\n=== MySQL Driver Demo Completed Successfully ===");
}

main().catch(console.error);
