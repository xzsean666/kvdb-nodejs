// 03 — TTL (time-to-live) and expiry.
//
// Run:  pnpm example examples/03-ttl.ts
//
// Entries can expire. Expired entries read as missing immediately (lazy expiry);
// purgeExpired() reclaims their storage, and ttlCleanupIntervalMs runs that
// purge periodically in the background.

import { KVDB } from "kvdb-sdk";

const db = new KVDB({
  driver: "sqlite",
  // Sweep expired rows every 5 minutes (the timer is unref'd, so it never keeps
  // the process alive, and is cleared on close()).
  ttlCleanupIntervalMs: 5 * 60_000,
});

const sessions = db.table<{ userId: string }>("sessions");

// Expires 150ms from now.
await sessions.set("s1", { userId: "u1" }, { ttlMs: 150 });
console.log("immediately:", await sessions.get("s1")); // { userId: 'u1' }

await new Promise((r) => setTimeout(r, 250));
console.log("after 250ms:", await sessions.get("s1")); // undefined (expired)

// A long TTL stays put.
await sessions.set("s2", { userId: "u2" }, { ttlMs: 60_000 });
console.log("long-lived:", await sessions.get("s2")); // { userId: 'u2' }

// Manually reclaim expired rows across the backend.
await sessions.set("dead", { userId: "x" }, { ttlMs: -1 }); // already expired
const purged = await db.purgeExpired();
console.log("purged expired rows:", purged);

await db.close();
