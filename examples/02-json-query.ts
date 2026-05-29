// 02 — JSON queries (Mongo-style `find`).
//
// Run:  pnpm example examples/02-json-query.ts
//
// Values are JSON; `find` filters on nested paths with comparison, logical, and
// existence operators, plus sort / limit / offset. The exact same query
// semantics hold on SQLite, PostgreSQL, and MongoDB.

import { KVDB } from "kvdb-sdk";

interface Account {
  name: string;
  profile: { age: number };
  status: string;
  vip?: boolean;
}

const db = new KVDB({ driver: "sqlite" });
const accounts = db.table<Account>("accounts");

await accounts.setMany([
  { key: "u1", value: { name: "Ann", profile: { age: 30 }, status: "active", vip: true } },
  { key: "u2", value: { name: "Bob", profile: { age: 17 }, status: "active", vip: false } },
  { key: "u3", value: { name: "Cid", profile: { age: 40 }, status: "gone" } },
]);

const show = (label: string, rows: { key: string }[]) =>
  console.log(label, rows.map((r) => r.key).sort());

// Comparison on a nested numeric path.
show("age > 18:", await accounts.find({ where: { "profile.age": { $gt: 18 } } }));

// Implicit AND of multiple conditions.
show(
  "active AND age >= 18:",
  await accounts.find({ where: { status: "active", "profile.age": { $gte: 18 } } }),
);

// $or.
show(
  "gone OR minor:",
  await accounts.find({ where: { $or: [{ status: "gone" }, { "profile.age": { $lt: 18 } }] } }),
);

// $in / $nin.
show("name in {Ann,Cid}:", await accounts.find({ where: { name: { $in: ["Ann", "Cid"] } } }));

// $exists distinguishes a missing field from a present one (u3 has no `vip`).
show("has vip field:", await accounts.find({ where: { vip: { $exists: true } } }));

// $ne also matches documents where the field is absent (Mongo semantics).
show("vip != true:", await accounts.find({ where: { vip: { $ne: true } } }));

// Sort + pagination.
const page = await accounts.find({
  sort: [{ path: "profile.age", direction: "desc" }],
  limit: 2,
});
console.log(
  "top 2 oldest:",
  page.map((r) => `${r.value.name}(${r.value.profile.age})`),
);

await db.close();
