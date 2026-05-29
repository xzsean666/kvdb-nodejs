// 05 — Prefix scan and delete.
//
// Run:  pnpm example examples/05-prefix-scan.ts
//
// Keys are plain strings; using a separator like ":" lets you group related
// keys and scan or delete them as a unit. Prefix matching is literal — "%" and
// "_" in your prefix are treated as characters, not SQL wildcards.

import { KVDB } from "kvdb-sdk";

const db = new KVDB({ driver: "sqlite" });
const kv = db.table<{ title: string }>("content");

await kv.setMany([
  { key: "post:1", value: { title: "Hello" } },
  { key: "post:2", value: { title: "World" } },
  { key: "comment:1", value: { title: "Nice!" } },
]);

// Scan everything under "post:".
const posts = await kv.getByPrefix("post:");
console.log(
  "posts:",
  posts.map((p) => `${p.key} -> ${p.value.title}`),
);

// Delete a whole group; returns the count removed.
console.log("deleted posts:", await kv.deleteByPrefix("post:")); // 2
console.log("posts after delete:", await kv.getByPrefix("post:")); // []
console.log("comments untouched:", await kv.getByPrefix("comment:")); // 1 row

await db.close();
