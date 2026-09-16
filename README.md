# kvdb-sdk

A high-performance, multi-driver, extensible **KV Database SDK** for Node.js:
a unified data interface across SQLite / PostgreSQL / MongoDB, JSON value storage
with JSON-field querying, TTL, prefix scans, batch operations, an independent
cache system, and decorator-based method caching — fully typed.

> **Project docs:** start with [`AGENTS.md`](./AGENTS.md), then
> [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md),
> [`docs/SPEC.md`](./docs/SPEC.md), [`docs/BUILD.md`](./docs/BUILD.md).
> Current status / backlog: [`docs/AI/SESSION_STATE.md`](./docs/AI/SESSION_STATE.md).

## Install

```bash
pnpm add kvdb-sdk
# install only the backends you use (optional peer deps)
pnpm add better-sqlite3   # SQLite
pnpm add pg               # PostgreSQL
pnpm add mongodb          # MongoDB
```

## Quick start

```ts
import { KVDB } from "kvdb-sdk";

const db = new KVDB({ driver: "sqlite", url: "./data.db", tablePrefix: "app_" });
const users = db.table<{ name: string; profile: { age: number } }>("users");

await users.set("u1", { name: "Ann", profile: { age: 20 } }, { ttlMs: 60_000 });
const u = await users.get("u1");
const adults = await users.find({ where: { "profile.age": { $gt: 18 } } });

await db.close();
```

## Dynamic Multi-Keys & Native Physical Indexes

```ts
// Define physical schema with custom primary key and indexed secondary keys
const tokens = db.table("tokens", {
  schema: {
    primaryKey: { name: "address", type: "string" },
    keys: {
      symbol: { type: "string", index: true },
      chainId: { type: "string", index: true },
    },
    indexes: [{ keys: ["chainId", "symbol"] }],
  },
});

// Multi-key write and fast O(1) point lookup via secondary index
await tokens.set({
  keys: { address: "0x123", symbol: "ETH", chainId: "ethereum" },
  value: { name: "Ether", decimals: 18 },
});
const eth = await tokens.getBy("symbol", "ETH");

// Zero-downtime dynamic key extension & B-Tree index creation at runtime
await tokens.addKey("isL2", { type: "boolean", default: false, index: true });
```

## Standalone cache + decorators

```ts
import { Cache, Cacheable, setDefaultCache } from "kvdb-sdk";

const cache = new Cache({ stores: ["memory", "sqlite-memory"] });
setDefaultCache(cache);

class UserService {
  @Cacheable({ ttlMs: 30_000 })
  async getUser(id: string) {
    /* expensive fetch */
    return { id };
  }
}
```

## Status

SQLite is covered by unit tests and a real-database compliance suite. The
PostgreSQL and MongoDB drivers are implemented against the same compliance suite
but have not yet been run against a live database in CI — see
[`docs/AI/SESSION_STATE.md`](./docs/AI/SESSION_STATE.md) for the one-line commands to verify.

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm test:compliance   # set KVDB_TEST_PG_URL / KVDB_TEST_MONGO_URL for PG/Mongo
pnpm build
```

## License

MIT
