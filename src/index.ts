// kvdb-sdk — public entry point.
//
// Exports grow as modules land (see docs/AI/TASK_INDEX.md backlog). Keeping this
// file as the single public surface is a deliberate "clear entry point"
// decision (AGENTS.md §2.8, docs/ARCHITECTURE.md).

// Core — the main entry objects (docs/SPEC.md §2-6).
export { KVDB } from "./core/kvdb.js";
export type { KVDBOptions, KVDBDriverName, TableOptions, AlterTableOptions } from "./core/kvdb.js";

export { Table } from "./core/table.js";
export type { FindQuery, SetOptions, UpdateOptions, QueryCacheOptions } from "./core/table.js";

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
export { RedisDriverFactory, RedisDriver } from "./drivers/redis/redis-driver.js";
export type { RedisDriverOptions } from "./drivers/redis/redis-driver.js";
export { MysqlDriverFactory, MysqlDriver } from "./drivers/mysql/mysql-driver.js";
export type { MysqlDriverOptions } from "./drivers/mysql/mysql-driver.js";

// Auto-index manager (used internally; exported for custom integrations).
export { AutoIndexManager } from "./core/auto-index.js";

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
export { RedisStore } from "./cache/stores/redis-store.js";
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
  KvdbSchemaError,
  KvdbMigrationError,
  KvdbQueueError,
  KvdbLockError,
  KvdbRateLimitError,
  KvdbIdempotencyError,
} from "./core/errors.js";
export type { KvdbErrorCode } from "./core/errors.js";

// Shared value and schema types.
export type { JsonValue, JsonObject, JsonPrimitive, MaybePromise } from "./types/json.js";
export type {
  KeyType,
  PrimaryKeyType,
  PhysicalColumnType,
  KeyDefinition,
  ColumnDefinition,
  KeyIndexOptions,
  ColumnIndexOptions,
  PrimaryKeyDefinition,
  TableIndexDefinition,
  MultiKeyIndexDefinition,
  MultiKeySchema,
  TableSchema,
  PhysicalRecord,
  InferKeyType,
  InferPrimaryKeyType,
  InferKeysRecord,
  NormalizedSchema,
} from "./core/table-schema.js";
export {
  normalizeTableSchema,
  validateMultiKeySchema,
  validateTableSchema,
  validateKeyValues,
  validateColumnValues,
  schemasEqual,
  evolveSchemaAddKey,
  evolveSchemaAddIndex,
} from "./core/table-schema.js";

// Micro-batch write & coalescing engine (docs/SPEC.md §13).
export {
  WriteBatcher,
  compareKeysDeterministic,
  sanitizeSecondaryKeys,
  DEFAULT_AUTOBATCH_OPTIONS,
  resolveAutoBatchOptions,
} from "./core/batcher.js";
export type {
  AutoBatchOptions,
  BatchSetItem,
  BatchFlushPayload,
  BatchFlushResult,
  FlushHandler,
} from "./core/batcher.js";

// Reliable Queue Subsystem (TASK-028-QUEUE).
export { Queue, QUEUE_TABLE_SCHEMA } from "./queue/queue.js";
export type { QueueColumns } from "./queue/queue.js";
export { Worker } from "./queue/worker.js";
export type { WorkerEvents } from "./queue/worker.js";
export type {
  Job,
  JobState,
  JobOptions,
  JobData,
  QueueOptions,
  WorkerOptions,
  QueueStats,
  BackoffOptions,
  JobProcessor,
} from "./queue/types.js";

// Distributed Lock & Mutex (docs/SPEC.md §17)
export { LockManager } from "./lock/lock.js";
export type { LockOptions, LockHandle, LockRecord } from "./lock/types.js";

// Rate Limiter (docs/SPEC.md §19)
export { RateLimiter } from "./limiter/rate-limiter.js";
export type { RateLimiterOptions, RateLimitResult } from "./limiter/types.js";

// Idempotency (docs/SPEC.md §20)
export { IdempotencyManager } from "./idempotency/idempotent.js";
export type { IdempotentOptions, IdempotencyRecord, IdempotencyStatus } from "./idempotency/types.js";

// Distributed Cron & Schedule (docs/SPEC.md §21)
export { parseCronExpression, getNextCronTime } from "./schedule/cron-parser.js";
export type { ScheduledJob, ScheduleOptions, CronOrInterval } from "./schedule/types.js";

// Keyv Ecosystem Adapter (docs/SPEC.md §22)
export { createKeyvAdapter } from "./adapters/keyv.js";
export type { KeyvStoreAdapter } from "./adapters/keyv.js";



