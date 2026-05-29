// 09 — Point-read cache on a Table.
//
// Run:  pnpm example examples/09-point-read-cache.ts
//
// Attaching a cache to a KVDB (or per-table) means get() checks the cache first
// and backfills it on a miss; set()/delete() keep the cache coherent. This cuts
// repeat reads of hot keys without changing your code.

import { KVDB } from "kvdb-sdk";

const db = new KVDB({
  driver: "sqlite",
  cache: { driver: "memory" }, // shared point-read cache for all tables
});

const profiles = db.table<{ name: string }>("profiles");

await profiles.set("u1", { name: "Ann" });

// First read fills the cache; subsequent reads are served from it.
console.log("read 1:", await profiles.get("u1"));
console.log("read 2 (cached):", await profiles.get("u1"));

// A write through the Table refreshes the cache, so reads see fresh data.
await profiles.set("u1", { name: "Ann v2" });
console.log("after write:", await profiles.get("u1")); // { name: 'Ann v2' }

// delete() invalidates the cache too.
await profiles.delete("u1");
console.log("after delete:", await profiles.get("u1")); // undefined

// A table can also override the instance cache with its own policy:
const hot = db.table<number>("hot", { cache: { driver: { driver: "memory", max: 1000 } } });
await hot.set("k", 42);
console.log("per-table cache:", await hot.get("k"));

await db.close();
