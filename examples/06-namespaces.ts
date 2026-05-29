// 06 — Namespaces and tablePrefix (isolation).
//
// Run:  pnpm example examples/06-namespaces.ts
//
// Every db.table(name) is an isolated namespace: the same user key in two
// namespaces is two different entries. find() and clear() are scoped to their
// namespace — they never see or touch another's data. tablePrefix adds a second
// partition layer (handy for multi-tenant or multi-env on one physical table).

import { KVDB } from "kvdb-sdk";

const db = new KVDB({ driver: "sqlite" });

const users = db.table<number>("users");
const cache = db.table<number>("cache");

// Same key "x" in two namespaces — independent values.
await users.set("x", 1);
await cache.set("x", 2);
console.log("users:x =", await users.get("x")); // 1
console.log("cache:x =", await cache.get("x")); // 2

// find() only sees its own namespace.
await users.set("y", 10);
console.log(
  "users find all:",
  (await users.find({})).map((r) => r.key).sort(),
); // ['x','y'] — never cache's keys

// clear() wipes one namespace only.
await users.clear();
console.log("users after clear:", (await users.find({})).length); // 0
console.log("cache survives clear:", await cache.get("x")); // 2

// tablePrefix: a second isolation dimension. Two KVDBs over the same SQLite
// file/table stay separated by prefix (here we use one in-memory db to show the
// API; in practice each tenant/env gets its own prefix).
const tenantA = new KVDB({ driver: "sqlite", url: "/tmp/kvdb-ns-demo.sqlite", tablePrefix: "A_" });
const tenantB = new KVDB({ driver: "sqlite", url: "/tmp/kvdb-ns-demo.sqlite", tablePrefix: "B_" });
await tenantA.table<string>("settings").set("theme", "dark");
await tenantB.table<string>("settings").set("theme", "light");
console.log("tenant A theme:", await tenantA.table<string>("settings").get("theme")); // dark
console.log("tenant B theme:", await tenantB.table<string>("settings").get("theme")); // light

await db.close();
await tenantA.close();
await tenantB.close();
