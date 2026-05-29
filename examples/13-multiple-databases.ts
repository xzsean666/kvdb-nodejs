// 13 — Multiple independent KVDB instances.
//
// Run:  pnpm example examples/13-multiple-databases.ts
//
// Each KVDB owns its own connection, cache, and config — db1 and db2 coexist
// without interfering. A common pattern: a durable primary store plus a fast
// ephemeral store, or two different backends side by side.

import { KVDB } from "kvdb-sdk";

// A durable file-backed store...
const primary = new KVDB({ driver: "sqlite", url: "/tmp/kvdb-primary.sqlite" });
// ...and a separate in-memory scratch store with its own cache.
const scratch = new KVDB({ driver: "sqlite", cache: { driver: "memory" } });

const orders = primary.table<{ total: number }>("orders");
const temp = scratch.table<{ step: number }>("wizard");

await orders.set("o1", { total: 99 });
await temp.set("session", { step: 2 });

console.log("primary order:", await orders.get("o1"));
console.log("scratch session:", await temp.get("session"));

// They are fully independent: same namespace + key, different instances.
await primary.table<string>("ns").set("k", "from-primary");
await scratch.table<string>("ns").set("k", "from-scratch");
console.log("primary ns:k =", await primary.table<string>("ns").get("k"));
console.log("scratch ns:k =", await scratch.table<string>("ns").get("k"));

await primary.close();
await scratch.close();
