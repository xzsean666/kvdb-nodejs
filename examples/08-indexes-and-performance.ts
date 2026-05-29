// 08 — Indexes and query performance.
//
// Run (SQLite):     pnpm example examples/08-indexes-and-performance.ts
// Run (PostgreSQL): PG_DATABASE_URL=... pnpm example examples/08-indexes-and-performance.ts
//
// `find` without an index is a full scan. Three ways to add a JSON index:
//   1. `indexes` at init  — declare paths up front (created on connect).
//   2. `table.ensureIndex` — create one explicitly, any time.
//   3. `autoIndex`         — auto-create a path's index after it is queried N times.
// Point reads (get/has/delete) and prefix scans already use the key primary key.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { KVDB } from "kvdb-sdk";

function pgUrl(): string | undefined {
  if (process.env.PG_DATABASE_URL) return process.env.PG_DATABASE_URL;
  try {
    const p = resolve(dirname(fileURLToPath(import.meta.url)), "../.env.test");
    return readFileSync(p, "utf8")
      .split(/\r?\n/)
      .find((l) => l.startsWith("PG_DATABASE_URL="))
      ?.slice("PG_DATABASE_URL=".length)
      .trim();
  } catch {
    return undefined;
  }
}

const url = pgUrl();
// Default: NO value/JSON index — the key is the primary key, writes stay cheap.
// Opt in by listing paths in `indexes`.
const db = url
  ? new KVDB({ driver: "postgresql", url, table: "kvdb_idx_demo", indexes: ["profile.age"] })
  : new KVDB({ driver: "sqlite", indexes: ["profile.age"] });

console.log("backend:", url ? "postgresql" : "sqlite");

interface Member {
  name: string;
  profile: { age: number };
}
const members = db.table<Member>("members");
await members.clear();

// Seed a few thousand rows so an index actually matters.
const batch = Array.from({ length: 3000 }, (_, i) => ({
  key: `m${i}`,
  value: { name: `member-${i}`, profile: { age: 18 + (i % 60) } },
}));
await members.setMany(batch);

// "profile.age" is indexed (declared in `indexes`), so this range query is
// index-backed rather than a full scan.
const seniors = await members.find({ where: { "profile.age": { $gte: 70 } } });
console.log("age >= 70 count:", seniors.length);

// Add another index on demand.
await members.ensureIndex("name");
const ann = await members.find({ where: { name: "member-1234" } });
console.log("by name:", ann[0]?.key);

// If you let the SDK auto-index, a path gets an index after `threshold` queries:
//   new KVDB({ driver: "sqlite", autoIndex: { threshold: 25 } })
console.log("tip: autoIndex creates an index automatically for hot query paths.");

await members.clear();
await db.close();
