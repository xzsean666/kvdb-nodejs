// Driver contract — the richer, queryable storage layer (docs/ARCHITECTURE.md KD-1, KD-6).
//
// A Driver extends KVStore with JSON query, prefix scan, indexing, a native
// escape hatch, and capability flags. The core selects native vs fallback
// behavior by reading `capabilities` — it never assumes a relational model
// (that is how MongoDB opts out of pooling/transactions).

import type { MaybePromise } from "../types/json.js";
import type { KVStore, KVEntry, RawEntry } from "../cache/types.js";
import type { QueryNode, FindOptions } from "../query/ast.js";
import type { TableSchema, PhysicalRecord } from "../core/table-schema.js";
import type { JsonValue } from "../types/json.js";

export interface SchemaTableDriver<Value = JsonValue, Columns extends Record<string, unknown> = Record<string, unknown>> {
  readonly schema: TableSchema<Columns>;
  setRecord(key: string, value: string, columns: Record<string, unknown>, ttlMs?: number): MaybePromise<void>;
  getRecord(key: string): MaybePromise<{ key: string; value: string; columns: Record<string, unknown>; expiresAt?: number } | undefined>;
  delete(key: string): MaybePromise<boolean>;
  clear(): MaybePromise<void>;
  find(where: QueryNode, options?: FindOptions): MaybePromise<Array<{ key: string; value: string; columns: Record<string, unknown> }>>;
}

export type ProviderName = "sqlite" | "postgres" | "mongodb";

/** The value+TTL an atomic update writes back (see {@link Driver.update}). */
export interface UpdateResult {
  /** Canonical JSON text to store. */
  value: string;
  /** Relative TTL in ms, or undefined for no expiry. */
  ttlMs?: number;
}

/**
 * Computes the new entry from the current one during an atomic update. Receives
 * the live entry (undefined if the key is missing or expired) and returns what
 * to write. It is synchronous and pure (the SDK's merge + serialize), and may
 * throw to abort the update — the driver leaves the row untouched on throw.
 */
export type UpdateMutator = (current: RawEntry | undefined) => UpdateResult;

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

  /**
   * Execute a compiled query AST against stored JSON values. `keyPrefix`, when
   * given, scopes the scan to keys starting with it — this is how the core
   * confines a `find` to its namespace (without it, find would match the whole
   * physical table across every namespace).
   */
  find(where: QueryNode, options?: FindOptions, keyPrefix?: string): MaybePromise<KVEntry[]>;

  /** Ensure an index exists for a JSON path (expression/GIN index). No-op allowed. */
  ensureIndex(jsonPath: string): MaybePromise<void>;

  /**
   * Atomically read-modify-write one key: read the current entry, hand it to
   * `mutate`, and store what it returns — as a single unit with the row locked,
   * so concurrent updates to the same key serialize instead of clobbering each
   * other. `mutate` may throw to abort (e.g. on a missing key), leaving the row
   * unchanged. Optional: the core falls back to a (non-atomic) get+set when a
   * driver does not implement it.
   */
  update?(key: string, mutate: UpdateMutator): MaybePromise<void>;

  /** Delete all currently-expired entries; returns how many were removed. */
  purgeExpired(): MaybePromise<number>;

  openSchemaTable?<Columns extends Record<string, unknown>>(name: string, schema?: TableSchema<Columns>): MaybePromise<SchemaTableDriver<JsonValue, Columns> | undefined>;

  /** Native handle escape hatch (better-sqlite3 Database, pg Pool, Mongo Db). */
  raw(): unknown;

  close(): Promise<void>;
}
