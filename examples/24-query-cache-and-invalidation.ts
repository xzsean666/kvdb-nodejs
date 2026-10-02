// 24-query-cache-and-invalidation.ts — Transparent Query Caching & Automatic Write Invalidation
//
// Demonstrates:
// 1. Enabling Query Cache on Table with configurable TTL.
// 2. Deterministic AST query fingerprinting (order-independent cache hits).
// 3. Automatic Write Invalidation (zero stale reads on set/update/delete/batch writes).
//
// Run:  pnpm example 24-query-cache-and-invalidation.ts

import { KVDB } from "../src/index.js";

interface Article {
  title: string;
  category: string;
  likes: number;
  published: boolean;
}

async function main() {
  console.log("=== 1. Initializing KVDB with Query Cache Enabled ===");
  const db = new KVDB({ driver: "sqlite", url: ":memory:" });

  const articles = db.table<Article>("articles", {
    queryCache: { enabled: true, ttlMs: 60_000 },
  });

  // Seed sample dataset
  await articles.setMany([
    { key: "art-1", value: { title: "TypeScript 5.8 Best Practices", category: "tech", likes: 120, published: true } },
    { key: "art-2", value: { title: "Modern Database Engineering", category: "tech", likes: 350, published: true } },
    { key: "art-3", value: { title: "Drafting Architecture Specs", category: "design", likes: 80, published: false } },
    { key: "art-4", value: { title: "Distributed Consensus in Practice", category: "tech", likes: 500, published: true } },
  ]);

  console.log("\n=== 2. First Query (Cache Miss -> DB Fetch & Cache Population) ===");
  const start1 = performance.now();
  const queryA = { where: { category: "tech", likes: { $gte: 200 } } };
  const res1 = await articles.find(queryA);
  const time1 = (performance.now() - start1).toFixed(3);
  console.log(`Query 1 executed in ${time1}ms, found ${res1.length} articles:`);
  for (const item of res1) {
    console.log(` - [${item.key}] ${item.value.title} (Likes: ${item.value.likes})`);
  }

  console.log("\n=== 3. Repeated Query (Cache Hit -> In-Memory Return) ===");
  const start2 = performance.now();
  const res2 = await articles.find(queryA);
  const time2 = (performance.now() - start2).toFixed(3);
  console.log(`Query 2 executed in ${time2}ms (Cache Hit!): found ${res2.length} articles`);

  console.log("\n=== 4. Equivalent Query with Shuffled Keys (Deterministic Fingerprint Hit) ===");
  // Same query logic with reversed object keys: { likes: ..., category: ... }
  const queryB = { where: { likes: { $gte: 200 }, category: "tech" } };
  const start3 = performance.now();
  const res3 = await articles.find(queryB);
  const time3 = (performance.now() - start3).toFixed(3);
  console.log(`Query 3 (reversed keys) executed in ${time3}ms (Cache Hit!): found ${res3.length} articles`);

  console.log("\n=== 5. Write Mutation (Triggering Automatic Invalidation) ===");
  console.log("Publishing a new article 'art-5' with 600 likes in 'tech' category...");
  await articles.set("art-5", {
    title: "Zero-Dependency Reliable Task Queues",
    category: "tech",
    likes: 600,
    published: true,
  });

  console.log("\n=== 6. Query After Invalidation (Fresh Results with No Stale Reads) ===");
  const start4 = performance.now();
  const res4 = await articles.find(queryA);
  const time4 = (performance.now() - start4).toFixed(3);
  console.log(`Query 4 executed in ${time4}ms (Fresh DB Hit): found ${res4.length} articles:`);
  for (const item of res4) {
    console.log(` - [${item.key}] ${item.value.title} (Likes: ${item.value.likes})`);
  }

  await db.close();
  console.log("\n✓ Query Cache & Write Invalidation demo finished successfully!");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
