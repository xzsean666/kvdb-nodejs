// 04 — Batch operations.
//
// Run:  pnpm example examples/04-batch.ts
//
// setMany / getMany / deleteMany amortize round-trips. getMany preserves input
// order and returns undefined for missing keys; setMany is transactional on
// backends that support it.

import { KVDB } from "kvdb-sdk";

const db = new KVDB({ driver: "sqlite" });
const counters = db.table<number>("counters");

// Write many at once (optionally with per-item TTL).
await counters.setMany([
  { key: "a", value: 1 },
  { key: "b", value: 2 },
  { key: "c", value: 3, ttlMs: 60_000 },
]);

// Read many — order matches the request; "missing" comes back undefined.
const got = await counters.getMany(["a", "missing", "c"]);
console.log("getMany:", got); // [1, undefined, 3]

// Delete many — returns how many actually existed.
const deleted = await counters.deleteMany(["a", "b", "ghost"]);
console.log("deleteMany count:", deleted); // 2

console.log("remaining c:", await counters.get("c")); // 3

await db.close();
