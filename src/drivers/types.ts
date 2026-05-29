// Driver contract — the richer, queryable storage layer (docs/ARCHITECTURE.md KD-1, KD-6).
//
// A Driver extends KVStore with JSON query, prefix scan, indexing, a native
// escape hatch, and capability flags. The core selects native vs fallback
// behavior by reading `capabilities` — it never assumes a relational model
// (that is how MongoDB opts out of pooling/transactions).

import type { MaybePromise } from "../types/json.js";
import type { KVStore, KVEntry } from "../cache/types.js";
import type { QueryNode, FindOptions } from "../query/ast.js";

export type ProviderName = "sqlite" | "postgres" | "mongodb";

/**
 * What a backend can do. The core reads these to decide whether to delegate to
 * a native feature or emulate it. Add new flags here as capabilities evolve;
 * existing backends just declare the new flag false (API stays stable).
 */
export interface DriverCapabilities {
  /** Backend expires keys itself (e.g. Mongo TTL index) vs SDK wraps expiry. */
  nativeTtl: boolean;
  /** Which JSON-query dialect the backend's visitor targets. */
  jsonQuery: "sqlite-json" | "pg-jsonb" | "mongo" | "none";
  /** Backend manages its own connection pool (MongoDB) — core must not pool it. */
  managesOwnPool: boolean;
  supportsTransactions: boolean;
  /** Backend can scan keys by prefix natively (vs core iterating). */
  supportsPrefixScan: boolean;
}

/**
 * Defers connection creation until `connect()` (modeled on Prisma driver
 * adapter factories). One factory per configured KVDB instance.
 */
export interface DriverFactory {
  readonly provider: ProviderName;
  readonly capabilities: DriverCapabilities;
  connect(): Promise<Driver>;
}

/**
 * A connected backend. Extends KVStore (get/set/delete/...) with the queryable
 * surface. All keys passed here are already physical (prefix+namespace applied
 * by core/key.ts) — drivers do no key rewriting.
 */
export interface Driver extends KVStore {
  readonly provider: ProviderName;
  readonly capabilities: DriverCapabilities;

  getByPrefix(prefix: string): MaybePromise<KVEntry[]>;
  deleteByPrefix(prefix: string): MaybePromise<number>;

  /** Execute a compiled query AST against stored JSON values. */
  find(where: QueryNode, options?: FindOptions): MaybePromise<KVEntry[]>;

  /** Ensure an index exists for a JSON path (expression/GIN index). No-op allowed. */
  ensureIndex(jsonPath: string): MaybePromise<void>;

  /** Delete all currently-expired entries; returns how many were removed. */
  purgeExpired(): MaybePromise<number>;

  /** Native handle escape hatch (better-sqlite3 Database, pg Pool, Mongo Db). */
  raw(): unknown;

  close(): Promise<void>;
}
