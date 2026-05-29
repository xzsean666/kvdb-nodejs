// 07 — PostgreSQL backend (real connection).
//
// Run:  PG_DATABASE_URL=postgres://user:pass@host:5432/db pnpm example examples/07-postgresql.ts
//   or: put PG_DATABASE_URL in .env.test at the repo root (it is auto-loaded below).
//
// The only thing that changes versus SQLite is the KVDB config — the Table API
// is identical. Connection pooling is delegated to node-postgres (pg).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { KVDB } from "kvdb-sdk";

// Tiny .env.test loader so the example runs with the repo's test credentials.
function pgUrl(): string | undefined {
  if (process.env.PG_DATABASE_URL) return process.env.PG_DATABASE_URL;
  try {
    const envPath = resolve(dirname(fileURLToPath(import.meta.url)), "../.env.test");
    const line = readFileSync(envPath, "utf8")
      .split(/\r?\n/)
      .find((l) => l.startsWith("PG_DATABASE_URL="));
    return line?.slice("PG_DATABASE_URL=".length).trim();
  } catch {
    return undefined;
  }
}

const url = pgUrl();
if (!url) {
  console.log("Set PG_DATABASE_URL (or .env.test) to run this example. Skipping.");
  process.exit(0);
}

const db = new KVDB({
  driver: "postgresql",
  url,
  table: "kvdb_example", // physical table; created if absent
});

interface Product {
  name: string;
  price: number;
  tags: string[];
}
const products = db.table<Product>("products");

await products.clear(); // start clean for a repeatable demo
await products.setMany([
  { key: "p1", value: { name: "Keyboard", price: 80, tags: ["input"] } },
  { key: "p2", value: { name: "Monitor", price: 300, tags: ["display"] } },
  { key: "p3", value: { name: "Mouse", price: 40, tags: ["input"] } },
]);

console.log("p2:", await products.get("p2"));

const affordable = await products.find({
  where: { price: { $lte: 100 } },
  sort: [{ path: "price", direction: "asc" }],
});
console.log(
  "<= $100:",
  affordable.map((r) => `${r.value.name} ($${r.value.price})`),
);

// Escape hatch: the native pg Pool, e.g. for a query the SDK doesn't model.
const pool = (await db.raw()) as import("pg").Pool;
const { rows } = await pool.query("SELECT count(*)::int AS n FROM kvdb_example");
console.log("physical row count:", rows[0].n);

await products.clear();
await db.close();
