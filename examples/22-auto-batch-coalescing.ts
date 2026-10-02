// 22 — Auto Batch & In-Memory Write Coalescing.
//
// Run:  pnpm example examples/22-auto-batch-coalescing.ts
//
// Demonstrates:
// 1. High-throughput micro-batching with automatic debounce window.
// 2. In-memory write coalescing (folding multiple writes to the same key into 1 net-delta write).
// 3. Multi-Key support: incremental merging of secondary indices across concurrent calls.
// 4. In-memory fast path for atomic updates (0 database read RTT).
// 5. Configurable coalesce: true/false and sqlAggregation: true/false.

import { KVDB } from "kvdb-sdk";
import type { MultiKeySchema } from "kvdb-sdk";

// Open in-memory SQLite database
const db = new KVDB({ driver: "sqlite" });

interface UserAccount {
  name: string;
  score: number;
}

interface UserKeys {
  role: string;
  status: string;
}

const userSchema: MultiKeySchema<UserKeys> = {
  primaryKey: { name: "id", type: "string" },
  keys: {
    role: { type: "string", index: true },
    status: { type: "string", index: true },
  },
};

// Create a table with AutoBatch enabled
const users = db.table<UserAccount, UserKeys>("users", {
  schema: userSchema,
  autoBatch: {
    maxBatchSize: 50,       // Flush immediately when reaching 50 writes
    maxWaitMs: 30,          // Debounce delay of 30ms
    coalesce: true,         // Coalesce same-key writes in memory
    sqlAggregation: true,   // Execute batch using multi-row SQL
  },
});

console.log("=== Part 1: High-Concurrency In-Memory Coalescing & Multi-Key Merging ===");
console.log("Triggering 3 rapid writes to the same user 'u_1001' with different secondary keys...");

// Write 1: initial values and role
const p1 = users.set("u_1001", { name: "Alice", score: 10 }, { keys: { role: "developer" } });
// Write 2: updated score
const p2 = users.set("u_1001", { name: "Alice", score: 20 });
// Write 3: added status index column
const p3 = users.set("u_1001", { name: "Alice", score: 50 }, { keys: { status: "active" } });

console.log("Pending items in memory queue before flush:", users.pendingBatchCount); // 1 (coalesced!)

await Promise.all([p1, p2, p3]);
console.log("Pending items in memory queue after flush:", users.pendingBatchCount); // 0

const aliceRecord = await users.getRecord("u_1001");
console.log("\nPersisted Alice Record:");
console.log("Value:", aliceRecord?.value);
console.log("Merged Secondary Keys:", aliceRecord?.keys);

// Point query by secondary keys:
const byRole = await users.getBy("role", "developer");
console.log("Found by role 'developer':", byRole?.key);

const byStatus = await users.getBy("status", "active");
console.log("Found by status 'active':", byStatus?.key);


console.log("\n=== Part 2: Concurrent Updates (Memory Fast-Path & Anti-Lost-Update) ===");
const counterTable = db.table<{ count: number }>("counter_table", {
  autoBatch: { maxBatchSize: 20, maxWaitMs: 30 },
});

await counterTable.set("visits", { count: 0 });

console.log("Firing 20 concurrent table.update() calls on 'visits'...");
await Promise.all(
  Array.from({ length: 20 }, () =>
    counterTable.update("visits", (c) => ({ count: (c?.count ?? 0) + 1 })),
  ),
);

const finalCount = await counterTable.get("visits");
console.log("Final visits counter value:", finalCount?.count); // Exactly 20


console.log("\n=== Part 3: Read-Your-Own-Writes (RYW) Guarantee ===");
// Write to buffer
void users.set("u_1002", { name: "Bob", score: 99 }, { keys: { role: "admin", status: "active" } });
// Immediate read without waiting for timer
const immediateBob = await users.get("u_1002");
console.log("Immediate read via in-memory overlay:", immediateBob);

// Explicit flush before shutdown
await users.flush();
await db.close();

console.log("\n✓ Auto Batch & Write Coalescing example finished successfully!");
