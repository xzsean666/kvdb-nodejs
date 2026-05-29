// 14 — Error handling.
//
// Run:  pnpm example examples/14-error-handling.ts
//
// KVDB throws typed errors so callers can branch on the failure kind. They all
// extend KvdbError; the subclasses cover config, connection, query,
// serialization, and unsupported-feature cases.

import { KVDB, KvdbError, KvdbConfigError, KvdbQueryError } from "kvdb-sdk";

// 1) Config error: PostgreSQL needs a url.
try {
  // @ts-expect-error — intentionally omitting the required url to show the error.
  new KVDB({ driver: "postgresql" }).table("x");
  await new KVDB({ driver: "postgresql" } as never).connect();
} catch (err) {
  console.log("config error:", err instanceof KvdbConfigError, (err as Error).message);
}

// 2) Query error: an operator used incorrectly (e.g. $in without an array).
const db = new KVDB({ driver: "sqlite" });
const t = db.table<{ tag: string }>("t");
await t.set("a", { tag: "x" });
try {
  await t.find({ where: { tag: { $in: "not-an-array" as never } } });
} catch (err) {
  console.log("query error:", err instanceof KvdbQueryError, (err as Error).message);
}

// 3) Catch-all: every SDK error is a KvdbError, so one catch can cover them.
try {
  await t.find({ where: { tag: { $in: 123 as never } } });
} catch (err) {
  console.log("is KvdbError:", err instanceof KvdbError);
}

await db.close();
