// 20 — Advanced Caching: Cache Stampede (Thundering Herd) Defense & SWR.
//
// Run:  pnpm example examples/20-cache-stampede-and-swr.ts
//
// In high-traffic systems, two critical caching challenges arise:
// 1. Cache Stampede / Thundering Herd: When a popular key expires or is cold,
//    thousands of concurrent requests query the database at the same instant.
//    KVDB's `Cache.wrap` solves this via In-flight Request Collapsing.
// 2. Stale-While-Revalidate (SWR): Serve immediate responses even when data is
//    about to expire, refreshing the cache asynchronously in the background.

import { Cache } from "kvdb-sdk";

// =========================================================================
// Part 1: Cache Stampede (Thundering Herd) Defense
// =========================================================================
console.log("=== Part 1: Cache Stampede Defense ===");

const cache = new Cache({ driver: "memory" });
let databaseQueryCount = 0;

// An expensive computation or database query that takes 100ms
async function fetchExpensiveFinancialReport(reportId: string): Promise<{ id: string; netProfit: number; generatedAt: number }> {
  databaseQueryCount++;
  console.log(`  [DB Hit] Executing heavy SQL aggregation for report ${reportId}...`);
  await new Promise((resolve) => setTimeout(resolve, 100)); // simulate slow I/O
  return {
    id: reportId,
    netProfit: 1_250_000,
    generatedAt: Date.now(),
  };
}

console.log("Simulating 30 concurrent user requests arriving at the exact same millisecond for an uncached key...");

// 30 concurrent callers all request the same report at once
const requests = Array.from({ length: 30 }, (_, index) =>
  cache.wrap("report:2026-Q1", () => fetchExpensiveFinancialReport("2026-Q1"), { ttlMs: 10_000 }).then((res) => ({
    caller: index + 1,
    profit: res.netProfit,
  })),
);

const results = await Promise.all(requests);

console.log(`All ${results.length} concurrent requests finished.`);
console.log(`Total database queries executed: ${databaseQueryCount}`);

if (databaseQueryCount === 1) {
  console.log("✓ Success! All 30 concurrent requests collapsed into exactly 1 database call.");
} else {
  console.error(`✗ Thundering herd detected: executed ${databaseQueryCount} times.`);
}

// =========================================================================
// Part 2: Stale-While-Revalidate (SWR) with refreshThreshold
// =========================================================================
console.log("\n=== Part 2: Stale-While-Revalidate (SWR) ===");

let stockPriceFetchCount = 0;
async function fetchStockTicker(): Promise<{ symbol: string; price: number; time: string }> {
  stockPriceFetchCount++;
  return {
    symbol: "NVDA",
    price: 135.5 + Math.floor(Math.random() * 10),
    time: new Date().toISOString(),
  };
}

// Wrap with 500ms TTL and 300ms refresh threshold
// When remaining TTL < 300ms, returns current value immediately and refreshes in background!
const tickerKey = "ticker:nvda";
const firstCall = await cache.wrap(tickerKey, fetchStockTicker, { ttlMs: 500, refreshThreshold: 300 });
console.log("1. Initial call (fetched fresh):", firstCall);

// Sleep 250ms (TTL remaining is ~250ms, which is below refreshThreshold of 300ms)
await new Promise((r) => setTimeout(r, 250));

// This call immediately returns the cached value (ultra-low latency),
// while silently triggering a background refresh
console.log("2. Calling while remaining TTL < 300ms (serves stale instantly + triggers SWR):");
const swrCall = await cache.wrap(tickerKey, fetchStockTicker, { ttlMs: 500, refreshThreshold: 300 });
console.log("   Instant result returned to user:", swrCall);

// Allow background refresh event loop to resolve
await new Promise((r) => setTimeout(r, 50));

// Next call sees the refreshed value
const afterRefresh = await cache.get<{ price: number; time: string }>(tickerKey);
console.log("3. Cache after background refresh completed:", afterRefresh);

// =========================================================================
// Part 3: Multi-Tiered Cache (Memory Tier + SQLite File Tier)
// =========================================================================
console.log("\n=== Part 3: Tiered Multi-Store Cache ===");

const tieredCache = new Cache({
  stores: [
    "memory", // Tier 0: ultra-fast in-memory L1
    "sqlite-memory", // Tier 1: SQLite L2
  ],
});

await tieredCache.set("app:config", { theme: "dark", lang: "en" });
const cfg = await tieredCache.get("app:config");
console.log("Tiered cache get:", cfg);

console.log("\n✓ Cache Stampede & SWR example finished successfully!");
