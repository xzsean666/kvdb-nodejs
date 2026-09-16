// 18 — Real-World Scenario: E-Commerce Order System.
//
// Run:  pnpm example examples/18-ecommerce-orders.ts
//
// Demonstrates an enterprise pattern:
// - Integer primary key (orderId)
// - Secondary physical columns (customerId, status, totalAmount, isPaid, metadata)
// - Composite indexes for multi-field filtering
// - Atomic partial updates (state transitions, payment confirmation)
// - Point lookup vs. full record lookup (get vs getRecord)
// - Pagination and complex range querying with native index acceleration

import { KVDB, type MultiKeySchema } from "kvdb-sdk";

const db = new KVDB({ driver: "sqlite" }); // in-memory SQLite for instant execution

interface OrderPayload {
  items: Array<{ sku: string; title: string; qty: number; unitPrice: number }>;
  shippingAddress: { city: string; country: string };
  notes?: string;
}

type OrderColumns = {
  customerId: string;
  status: string;
  totalAmount: number;
  isPaid: boolean;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
};

// 1. Declare multi-key schema with indexes
const orderSchema: MultiKeySchema = {
  primaryKey: { name: "orderId", type: "integer" },
  keys: {
    customerId: { type: "string", index: true },
    status: { type: "string", index: true },
    totalAmount: { type: "number", index: true },
    isPaid: { type: "boolean", default: false },
    metadata: { type: "json", nullable: true },
  },
  indexes: [
    // Composite index for customer order history filtered by status
    { name: "cust_status_idx", keys: ["customerId", "status"] },
  ],
};

const orders = db.table<OrderPayload, OrderColumns>("orders", { schema: orderSchema });

console.log("▶ Creating orders with physical search keys...");
await orders.set(10001, {
  items: [
    { sku: "SKU-KB", title: "Mechanical Keyboard", qty: 1, unitPrice: 120 },
    { sku: "SKU-MS", title: "Wireless Mouse", qty: 1, unitPrice: 60 },
  ],
  shippingAddress: { city: "San Francisco", country: "US" },
}, {
  keys: {
    customerId: "cust_alice",
    status: "pending",
    totalAmount: 180,
    isPaid: false,
    metadata: { source: "web", campaign: "spring_sale" },
  },
});

await orders.set(10002, {
  items: [
    { sku: "SKU-MN", title: "4K Monitor", qty: 2, unitPrice: 400 },
  ],
  shippingAddress: { city: "New York", country: "US" },
}, {
  keys: {
    customerId: "cust_bob",
    status: "paid",
    totalAmount: 800,
    isPaid: true,
  },
});

await orders.set(10003, {
  items: [
    { sku: "SKU-USB", title: "USB-C Hub", qty: 1, unitPrice: 45 },
  ],
  shippingAddress: { city: "Seattle", country: "US" },
}, {
  keys: {
    customerId: "cust_alice",
    status: "paid",
    totalAmount: 45,
    isPaid: true,
  },
});

// 2. get() vs getRecord()
console.log("\n▶ Point lookup: get(10001) vs getRecord(10001):");

// get() returns ONLY the business payload (clean JSON)
const orderPayload = await orders.get(10001);
console.log("get() Payload items count:", orderPayload?.items.length);

// getRecord() returns the full physical database row (PK + physical columns + payload)
const orderRow = await orders.getRecord(10001);
console.log("getRecord() Full Row:", {
  orderId: orderRow?.key,
  customer: orderRow?.columns.customerId,
  status: orderRow?.columns.status,
  total: orderRow?.columns.totalAmount,
  isPaid: orderRow?.columns.isPaid,
  itemsCount: orderRow?.value.items.length,
});

// 3. Fast O(1) point lookup by indexed secondary key
console.log("\n▶ Fast secondary key lookup (getBy customerId):");
const aliceFirstOrder = await orders.getBy("customerId", "cust_alice");
console.log(`Found Alice's order #${aliceFirstOrder?.key}, Total: $${aliceFirstOrder?.columns.totalAmount}`);

// 4. Atomic partial update (payment confirmation & status change)
console.log("\n▶ Atomic partial update on order #10001 (customer paid):");
await orders.update(10001, (current) => ({
  ...current,
  notes: "Paid via Apple Pay at checkout",
}));
const updatedRow = await orders.getRecord(10001);
console.log("Updated order notes:", updatedRow?.value.notes);

// 5. Index-accelerated queries with filter, sorting, and pagination
console.log("\n▶ Querying paid orders over $50 sorted by totalAmount desc:");
const queryResults = await orders.find({
  where: {
    status: "paid",
    totalAmount: { $gte: 50 },
  },
  sort: [{ path: "totalAmount", direction: "desc" }],
  limit: 10,
});

for (const order of queryResults) {
  console.log(` - Order #${order.key}: Shipping to ${order.value.shippingAddress.city}`);
}

// 6. Querying full records with findRecords
console.log("\n▶ findRecords for customer 'cust_alice':");
const aliceRecords = await orders.findRecords({
  where: { customerId: "cust_alice" },
  sort: [{ path: "totalAmount", direction: "desc" }],
});

for (const rec of aliceRecords) {
  console.log(` - Order #${rec.key}: Status = ${rec.columns.status}, Amount = $${rec.columns.totalAmount}`);
}

await db.close();
console.log("\n✓ E-Commerce Order System example finished successfully!");
