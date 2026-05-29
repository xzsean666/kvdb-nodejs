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
export type { KVStore, RawEntry, KVEntry } from "./cache/types.js";

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
