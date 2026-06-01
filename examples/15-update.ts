// 15 — Partial update: change a field without rewriting the whole value.
//
// Run:  pnpm example examples/15-update.ts
//
// `update` is an ATOMIC read-modify-write: the merge runs inside the driver's
// transaction with the row locked (PG `SELECT … FOR UPDATE`, SQLite `BEGIN
// IMMEDIATE`, Mongo compare-and-swap), so concurrent updates to the same key
// serialize instead of clobbering each other — identical behaviour on every
// backend. Pass an object to shallow-merge top-level fields, or a function for
// nested/computed edits. The existing TTL is preserved unless you override it,
// and updating a missing key throws (use `set` to create).

import { KVDB, KvdbError } from "kvdb-sdk";

interface User {
  name: string;
  age: number;
  profile: { city: string; verified?: boolean };
  status?: string;
}

const db = new KVDB({ driver: "sqlite" }); // in-memory
const users = db.table<User>("users");

await users.set("u1", { name: "Ann", age: 20, profile: { city: "Paris" } });

// Object patch: shallow-merge a single top-level field. Other fields untouched.
await users.update("u1", { age: 21 });
console.log("after age bump:", await users.get("u1"));
// { name: "Ann", age: 21, profile: { city: "Paris" } }

// Function patch: edit a nested object by spreading the current value.
await users.update("u1", (u) => ({
  ...u,
  profile: { ...u.profile, verified: true },
}));
console.log("after nested edit:", await users.get("u1"));
// profile.city is preserved, profile.verified added

// update returns the value it wrote.
const written = await users.update("u1", { status: "active" });
console.log("returned value:", written);

// Setting a field to `undefined` in an object patch drops it (JSON semantics).
await users.update("u1", { status: undefined });
console.log("after dropping status:", await users.get("u1")); // no `status` key

// Updating a missing key throws — update never silently creates.
try {
  await users.update("ghost", { age: 1 });
} catch (error) {
  console.log(
    "missing key:",
    error instanceof KvdbError ? `${error.code}: ${error.message}` : error,
  );
}

// TTL is preserved across updates unless you pass one explicitly.
await users.set("temp", { name: "Tmp", age: 0, profile: { city: "—" } }, { ttlMs: 60_000 });
await users.update("temp", { age: 1 }); // still expires ~60s from the original set
console.log("ttl preserved, value:", await users.get("temp"));

await db.close();
