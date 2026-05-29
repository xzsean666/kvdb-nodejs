// kvdb-sdk — public entry point.
//
// Exports grow as modules land (see docs/nextsession.md backlog). Keeping this
// file as the single public surface is a deliberate "clear entry point"
// decision (AGENTS.md §2.8, docs/ARCHITECTURE.md).

// Core — the main entry objects (docs/SPEC.md §2-6).
export { KVDB } from "./core/kvdb.js";
export type { KVDBOptions, KVDBDriverName, TableOptions } from "./core/kvdb.js";
export { Table } from "./core/table.js";
export type { FindQuery, SetOptions } from "./core/table.js";

// Driver contracts and the SQLite driver (for custom drivers / direct use).
export type {
  Driver,
  DriverFactory,
  DriverCapabilities,
  ProviderName,
} from "./drivers/types.js";
export {
  SqliteDriverFactory,
} from "./drivers/sqlite/sqlite-driver.js";
export type { SqliteDriverOptions } from "./drivers/sqlite/sqlite-driver.js";
export { PostgresDriverFactory } from "./drivers/postgres/postgres-driver.js";
export type { PostgresDriverOptions } from "./drivers/postgres/postgres-driver.js";
export { MongoDriverFactory } from "./drivers/mongodb/mongodb-driver.js";
export type { MongoDriverOptions } from "./drivers/mongodb/mongodb-driver.js";

// Query AST (for advanced/custom backends).
export type {
  QueryNode,
  FieldPath,
  CompareOp,
  FindOptions,
  SortSpec,
} from "./query/ast.js";

// Cache subsystem — usable standalone (docs/SPEC.md §8).
export { Cache } from "./cache/cache.js";
export type { CacheOptions, CacheStoreSpec, WrapOptions } from "./cache/cache.js";
export { MemoryStore } from "./cache/stores/memory-store.js";
export type { MemoryStoreOptions } from "./cache/stores/memory-store.js";
export { SqliteCacheStore } from "./cache/stores/sqlite-store.js";
export type { SqliteStoreOptions } from "./cache/stores/sqlite-store.js";
export type { KVStore, RawEntry, KVEntry } from "./cache/types.js";

// Decorator caching (docs/SPEC.md §9). Requires TC39 standard decorators.
export {
  Cacheable,
  CacheClear,
  setDefaultCache,
  clearDefaultCache,
} from "./decorators/cacheable.js";
export type { CacheableOptions, CacheClearOptions } from "./decorators/cacheable.js";
export type { CacheableKey, CacheKeyBuilder } from "./decorators/cache-key.js";

// Plugin / hook system (docs/ARCHITECTURE.md §5.5).
export { HookRuntime } from "./plugins/runtime.js";
export type {
  Plugin,
  PluginContext,
  HookName,
  HookFn,
  HookPayloads,
  WritePayload,
  ReadPayload,
  QueryPayload,
} from "./plugins/types.js";

// Errors.
export {
  KvdbError,
  KvdbConnectionError,
  KvdbQueryError,
  KvdbSerializationError,
  KvdbUnsupportedError,
  KvdbConfigError,
} from "./core/errors.js";
export type { KvdbErrorCode } from "./core/errors.js";

// Shared value types.
export type { JsonValue, JsonObject, JsonPrimitive, MaybePromise } from "./types/json.js";
