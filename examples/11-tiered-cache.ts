// 11 — Standalone tiered Cache (memory -> sqlite) with wrap().
//
// Run:  pnpm example examples/11-tiered-cache.ts
//
// The Cache is usable on its own, independent of any KVDB. Tiers are ordered
// fastest-first: a read returns the first live hit and backfills the faster
// tiers above it; writes go to every tier. wrap() memoizes a function and
// supports stale-while-revalidate via refreshThreshold.

import { Cache } from "kvdb-sdk";

// Tier 0: in-process memory (fastest). Tier 1: an in-memory SQLite store
// (survives across memory eviction; could be a file for cross-process sharing).
const cache = new Cache({
  stores: ["memory", "sqlite-memory"],
  defaultTtlMs: 60_000,
});

// Plain get/set.
await cache.set("greeting", { hello: "world" });
console.log("get:", await cache.get("greeting"));

// wrap(): compute-on-miss, serve-on-hit. The factory runs only when needed.
let computeCount = 0;
const compute = async () => {
  computeCount++;
  return { expensive: true, at: computeCount };
};

const a = await cache.wrap("report", compute); // miss -> computes
const b = await cache.wrap("report", compute); // hit  -> no recompute
console.log("wrap stable:", a, b, "computeCount:", computeCount); // 1

// Tiers in action: clearing simulates eviction from the top tier; the value is
// still served (and the top tier backfilled) from the lower tier.
console.log("still cached:", await cache.get("report"));

await cache.delete("report");
console.log("after delete:", await cache.get("report")); // undefined
