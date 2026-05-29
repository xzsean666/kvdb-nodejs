# kvdb-sdk examples

Runnable, self-contained examples covering the whole API surface. Each file is
heavily commented and imports the package exactly as a real consumer would
(`import { KVDB } from "kvdb-sdk"`).

## Running

Examples are TypeScript and run via [`tsx`](https://github.com/privatenumber/tsx)
(installed as a dev dependency). Build once so the package entry exists, then run
any example:

```bash
pnpm build                                  # build dist/ (the kvdb-sdk entry)
pnpm example examples/01-quickstart.ts      # run one
pnpm examples                               # run them all, each in its own process
```

> Why `tsx` and not bare `node`? The decorator examples use TC39 decorators,
> which need a transform that Node's type-stripping doesn't do. `tsx` handles
> decorators and TS imports uniformly.

## The examples

| File | Shows |
|---|---|
| `01-quickstart.ts` | open a db, set/get/exists/delete, `undefined`-is-delete |
| `02-json-query.ts` | `find` with `$gt/$or/$in/$exists/$ne`, sort, limit |
| `03-ttl.ts` | per-entry TTL, lazy expiry, `purgeExpired`, background cleanup |
| `04-batch.ts` | `setMany` / `getMany` / `deleteMany` |
| `05-prefix-scan.ts` | `getByPrefix` / `deleteByPrefix`, key grouping |
| `06-namespaces.ts` | namespace isolation, scoped `find`/`clear`, `tablePrefix` |
| `07-postgresql.ts` | the PostgreSQL backend + `raw()` escape hatch (real connection) |
| `08-indexes-and-performance.ts` | `indexes` option, `ensureIndex`, `autoIndex` |
| `09-point-read-cache.ts` | attach a point-read cache to a Table |
| `10-decorator-cache.ts` | `@Cacheable` / `@CacheClear` method decorators |
| `11-tiered-cache.ts` | standalone tiered `Cache` + `wrap()` |
| `12-plugins-hooks.ts` | plugins and lifecycle hooks (audit/rewrite) |
| `13-multiple-databases.ts` | multiple independent KVDB instances |
| `14-error-handling.ts` | typed errors (`KvdbConfigError`, `KvdbQueryError`, …) |

## PostgreSQL examples

`07` and `08` use PostgreSQL when a connection string is available, and fall
back / skip otherwise. Provide one via the environment or a repo-root
`.env.test`:

```bash
PG_DATABASE_URL=postgres://user:pass@host:5432/db pnpm example examples/07-postgresql.ts
```
