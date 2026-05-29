// 01 — Quickstart: open a database, write, read, delete.
//
// Run:  pnpm example examples/01-quickstart.ts
//
// KVDB connects lazily — the first operation opens the backend, so there is no
// connect() to await. SQLite with no `url` is an in-memory database, perfect
// for trying things out.

import { KVDB } from "kvdb-sdk";

const db = new KVDB({ driver: "sqlite" }); // in-memory

// A Table is a namespace. Type its values with the generic parameter.
interface User {
  name: string;
  email: string;
}
const users = db.table<User>("users");

await users.set("u1", { name: "Ann", email: "ann@example.com" });

console.log("get:", await users.get("u1"));
console.log("exists:", await users.exists("u1"));

await users.set("u1", { name: "Ann", email: "ann@new.com" }); // overwrite
console.log("after overwrite:", await users.get("u1"));

console.log("delete:", await users.delete("u1")); // true
console.log("delete again:", await users.delete("u1")); // false
console.log("get after delete:", await users.get("u1")); // undefined

// Setting `undefined` is a delete (KD-7).
await users.set("u2", { name: "Bo", email: "bo@example.com" });
await users.set("u2", undefined as never);
console.log("undefined-is-delete:", await users.exists("u2")); // false

await db.close();
