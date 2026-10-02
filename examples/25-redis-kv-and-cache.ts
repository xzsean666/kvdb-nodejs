/**
 * 25-redis-kv-and-cache.ts
 *
 * Demonstrates KVDB SDK with the Redis driver and standalone Redis Cache store:
 * 1. Initializing KVDB with the Redis driver
 * 2. High-performance KV CRUD and Batch operations
 * 3. AST-based JSON filtering and sorting in Redis
 * 4. Optimistic concurrency with atomic Lua CAS update
 * 5. Standalone Redis Cache subsystem with SWR & Stampede Collapse
 */

import { KVDB, Cache, RedisStore } from "../src/index.js";

const REDIS_URL = process.env.REDIS_URL ?? process.env.KVDB_TEST_REDIS_URL ?? "redis://127.0.0.1:6380";

async function main() {
  const db = new KVDB({
    driver: "redis",
    url: REDIS_URL,
    tablePrefix: "app_demo",
  });

  try {
    await db.connect();
  } catch (err) {
    console.log("Redis instance not reachable at", REDIS_URL, "Skipping example.");
    return;
  }

  console.log("=== 1. Initializing KVDB with Redis Driver ===");
  const users = db.table("users");
  await users.clear();

  console.log("\n=== 2. High-Performance KV CRUD & Batch Operations ===");
  await users.setMany([
    { key: "u:1", value: { name: "Alice", role: "admin", points: 150 } },
    { key: "u:2", value: { name: "Bob", role: "member", points: 80 } },
    { key: "u:3", value: { name: "Charlie", role: "member", points: 220 } },
  ]);

  const batch = await users.getMany(["u:1", "u:2", "u:3"]);
  console.log("Retrieved users via batch getMany:");
  for (const u of batch) {
    console.log(` - ${(u as any)?.name} (role: ${(u as any)?.role}, points: ${(u as any)?.points})`);
  }

  console.log("\n=== 3. AST-based JSON Filtering and Sorting in Redis ===");
  const topMembers = await users.find({
    where: { role: "member", points: { $gte: 80 } },
    sort: [{ path: "points", direction: "desc" }],
  });
  console.log("Top members with >= 80 points (sorted desc):");
  for (const m of topMembers) {
    console.log(` - [${m.key}] ${(m.value as any).name} (Points: ${(m.value as any).points})`);
  }

  console.log("\n=== 4. Optimistic Concurrency with Atomic Lua CAS Update ===");
  await users.set("global:counter", { count: 0 });

  // Fire 10 concurrent increments to verify atomic CAS serialization
  await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      users.update<{ count: number }>("global:counter", (current) => {
        return { count: (current?.count ?? 0) + 1 };
      }),
    ),
  );

  const counter = await users.get<{ count: number }>("global:counter");
  console.log(`Counter value after 10 concurrent CAS increments: ${counter?.count} (Expected: 10)`);

  console.log("\n=== 5. Standalone Redis Cache with SWR & Stampede Collapse ===");
  const cache = new Cache({
    stores: [
      new RedisStore({
        url: REDIS_URL,
        keyPrefix: "demo_cache:",
      }),
    ],
  });
  await cache.clear();

  let dbQueriesExecuted = 0;
  const fetchMarketPrice = async () => {
    dbQueriesExecuted++;
    return { symbol: "BTC-USDT", price: 92450.0 };
  };

  // 10 concurrent requests arrive for cold cache -> collapsed into 1 DB execution
  const prices = await Promise.all(
    Array.from({ length: 10 }, () =>
      cache.wrap("market:btc", fetchMarketPrice, { ttlMs: 10000 }),
    ),
  );

  console.log(`10 concurrent wrap() requests completed.`);
  console.log(`Actual fetch executions triggered: ${dbQueriesExecuted} (Zero Cache Stampede!)`);
  console.log(`Returned price:`, prices[0]);

  // Clean up
  await users.clear();
  await cache.clear();
  await cache.close();
  await db.close();

  console.log("\n✓ Redis KV & Cache demo finished successfully!");
  process.exit(0);
}

main().catch((err) => {
  console.error("Redis demo error:", err);
  process.exit(1);
});
