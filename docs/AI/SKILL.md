---
name: kvdb-sdk
description: "面向 Node.js 的高性能、多驱动、可扩展 KV 数据库 SDK (SQLite, PostgreSQL, MongoDB, Redis, MySQL)。支持统一 KV 接口、物理动态多键 (Multi-Key) 二级索引与极速点查、JSON 复杂查询、多级缓存、可靠任务队列、分布式锁、滑动窗口限流、原子数值增减、幂等守护、分布式 Cron 调度、逻辑软删除与恢复、跨实例 Pub/Sub 与 Key 监听、大对象分块存取及运行时链路可观测指标。"
---

# kvdb-sdk AI Skill & Integration Guide

> 本文档专供 AI 编程助手与开发者查阅，系统化涵盖 `kvdb-sdk` 的架构定位、核心 API 签名、**Multi-Key 动态多键与物理索引性能优化**、实战代码用例以及生产环境避坑指南。

---

## 1. 模块定位与核心能力

- **模块定位**：面向 Node.js (>=22/24/26) 的企业级、高性能、多后端、可扩展 KV Database SDK。提供统一的 KV 访问门面、原生物理多键（Multi-Key）二级索引、JSON 语法查询引擎、独立分层缓存（Cache）、原子更新（`update`）、批量写聚合缓冲引擎（`WriteBatcher`）、基于持久化表的可靠任务队列（`Queue`）、分布式互斥锁（`withLock`）、滑动窗口限流器（`RateLimiter`）、原子数值增减（`increment`）、接口幂等守护器（`idempotent`）、标准生态适配（`Keyv`）、逻辑软删除与恢复（`restore`）、跨实例 Pub/Sub 与 Key 变更监听（`table.watch`）、大对象分块存取（`BlobStorage`）以及链路指标可观测性（`getMetrics`）。
- **源码根路径**：`/ssd0/git/kvdb-nodejs`
- **托管账号**：`xzsean666`
- **Git 远程仓库**：`https://github.com/xzsean666/kvdb-nodejs.git`
- **依赖声明规范 (Git + Commit Hash)**：
  业务项目接入时按规范使用 Git 配合目标 Commit Hash 锁定依赖。**不固定写死单一旧 Hash**，接入或更新时由 AI / 开发者通过 `git -C /ssd0/git/kvdb-nodejs rev-parse HEAD` 获取当前最新 Commit Hash，或在开发阶段临时使用 `#main` 分支：
  ```json
  {
    "dependencies": {
      "kvdb-sdk": "git+https://github.com/xzsean666/kvdb-nodejs.git#<COMMIT_HASH>"
    }
  }
  ```
- **核心能力矩阵**：
  - **多后端统一抽象**：原生支持 `sqlite` (better-sqlite3，包括 `:memory:` 纯内存秒级模式与文件持久化)、`postgresql` (pg)、`mongodb` (mongodb)、`redis` (ioredis)、`mysql` (mysql2)，应用层代码 100% 无缝切换，无任何单一数据库硬编码绑定。
  - **动态多键（Multi-Key）物理索引**：突破传统 KV 仅支持主键点查的限制，将高频检索字段直接映射为物理列或顶层字段，挂载底层 B-Tree 物理索引，实现 O(1) 极速点查与高性能范围过滤。
  - **分布式互斥锁与限流器**：内置基于行锁/CAS/Redis的跨实例分布式锁（`db.withLock` / `db.acquireLock`）与滑动窗口限流器（`db.rateLimiter`），支持长任务心跳自动续期。
  - **接口幂等守护与分布式 Cron**：提供 `db.idempotent()` 状态机防止支付与 Webhook 重复处理；扩展 `queue.schedule()` 支持标准 5 段 Cron 跨集群多节点 Exactly-Once 执行。
  - **逻辑软删除与数据恢复 (Soft Delete & Restore)**：开箱支持 `softDelete: true`，删除操作自动打标，查询默认自动剔除，支持随时 `restore` 恢复与 `hardDelete` 物理抹除。
  - **变更监听与跨进程事件广播 (Pub/Sub & Key Watching)**：提供 `table.watch("key", handler)` 监听行级读写删变动，支持跨微服务节点广播与进程内极速分发。
  - **大对象分块流式存取 (Chunked Blob Storage)**：提供 `putBlob` / `getBlob`，自动将超大图片、二进制文件、大型 JSON 按 256KB 自动切片存储，规避 Mongo 16MB 或 MySQL packet 尺寸限制。
  - **链路指标与运行时可观测性 (Metrics & Observability)**：内置 `db.getMetrics()` 与实时事件 Hook，开箱提供读写吞吐、缓存命中率（Hit/Miss Ratio）、P95/P99 延迟分位数统计。
  - **微批聚合写入（Auto-Batch Coalescing）**：内置 `WriteBatcher`，将高频离散 `set`/`delete` 自动汇聚为参数化 Multi-Row 单条 SQL，并按主键字典序排序，彻底杜绝 PostgreSQL 交叉行锁死锁。
  - **严格并发安全性**：提供悲观锁/乐观锁保障的原子读-改-写（`table.update` / `table.updateRecord`）与原生数值增减（`table.increment` / `table.decrement`）。
  - **多级独立缓存与装饰器**：集成内存 LRU + Redis 外部缓存，防击穿（SingleFlight）、防雪崩（Jitter TTL）、SWR（Stale-While-Revalidate）与 `@Cacheable` 装饰器。
  - **可靠任务队列**：内置持久化 At-Least-Once 队列（`Queue` / `Worker`），支持延迟任务、指数退避重试与并发受控消费。
  - **Keyv / Web 框架生态适配**：暴露 `table.asKeyv()`，零胶水接入 Apollo、Unstorage、Cache-Manager 等。

---

## 2. 导出清单与核心 API (API Reference)

### 2.1 顶级入口与核心类
```typescript
import {
  KVDB,                 // 主数据库实例管理类
  Table,                // 数据表 / 集合操作对象
  Cache,                // 独立多级缓存系统
  MemoryStore,          // 内存 LRU 缓存 Store
  RedisStore,           // Redis 分布式缓存 Store
  SqliteCacheStore,     // SQLite 缓存 Store
  Queue, Worker,        // 可靠任务队列与执行器
  WriteBatcher,         // 微批聚合写引擎
  Cacheable, CacheClear,// TC39 标准装饰器缓存
  LockManager,          // 分布式互斥锁管理器
  RateLimiter,          // 滑动窗口限流器
  IdempotencyManager,   // 接口与任务幂等性管理器
  createKeyvAdapter,    // Keyv / Unstorage 标准适配器工厂
  parseCronExpression,  // 标准 5 段 Cron 表达式解析器
  getNextCronTime,      // 下次 Cron 触发时间计算器
  PubSubManager,        // 跨进程/跨实例 Pub/Sub 事件管理器
  BlobStorage,          // 大对象分块存取管理器 (256KB Chunks)
  MetricsCollector,     // 运行时链路指标与延迟分析器
  KvdbError,            // 核心错误类基类
  KvdbLockError,        // 分布式锁异常
  KvdbRateLimitError,   // 限流阻断异常
  KvdbIdempotencyError, // 幂等冲突与超时异常
} from "kvdb-sdk";
```

### 2.2 `KVDB` 配置项与操作方法
```typescript
const db = new KVDB({
  driver: "sqlite" | "postgresql" | "mongodb" | "redis" | "mysql",
  url?: string,                     // 连接串 (如 postgresql://..., mongodb://...) 或 SQLite 路径 (默认 ":memory:")
  tablePrefix?: string,             // 物理表/键统一前缀 (默认 "")
  table?: string,                   // 默认主表物理名 (默认 "kvdb_kv")
  indexes?: string[],               // 普通 KV 表初始化时预建的 JSON 路径索引 (如 ["profile.age", "status"])
  autoIndex?: boolean | { threshold: number }, // 查询统计驱动的自动创建索引 (默认 false，开启时阈值默认 25)
  autoBatch?: boolean | AutoBatchOptions,      // 全局微批写入配置 (默认开启，debounce 20ms，最大 50 条)
  cache?: CacheOptions | Cache,     // 绑定的共享缓存实例
  plugins?: Plugin[],               // 全局生命周期钩子插件
  ttlCleanupIntervalMs?: number,    // 后台清理过期 Key 的定时间隔 (unref 定时器)
  pool?: Record<string, unknown>,   // 透传给底层数据库连接池的配置 (max, timeout, ssl 等)
  gracefulShutdown?: boolean,       // 是否监听 SIGINT/SIGTERM 自动 flush 批处理并关闭连接 (默认 false)
});

// 顶级扩展方法
await db.withLock(key, async (lock) => { ... }, options?: LockOptions);
const lock = await db.acquireLock(key, options?: LockOptions);
const limiter = db.rateLimiter(options: RateLimiterOptions);
await db.idempotent(key, async () => { ... }, options?: IdempotentOptions);
const ps = db.pubsub(options?: PubSubOptions);
const metrics = db.getMetrics();
db.resetMetrics();
```

### 2.3 `Table` 核心操作方法
```typescript
interface Table<Value = any, Columns extends Record<string, unknown> = Record<string, unknown>> {
  // --- 写入与更新 ---
  set(key: string | number, value: Value, options?: { keys?: Columns; ttlMs?: number }): Promise<void>;
  set(item: { keys: Columns & { [pk: string]: string | number }; value: Value; ttlMs?: number }): Promise<void>;
  setMany(items: Array<{ key: string | number; value: Value; keys?: Columns; ttlMs?: number }>): Promise<void>;
  update(key: string | number, updater: (prev: Value | undefined) => Value, options?: UpdateOptions): Promise<Value>;
  updateRecord(key: string | number, updater: (prev: PhysicalRecord<Columns, Value> | undefined) => PhysicalRecord<Columns, Value>): Promise<PhysicalRecord<Columns, Value>>;
  increment(key: string | number, amount?: number, options?: { path?: string; ttlMs?: number; default?: number }): Promise<number>;
  decrement(key: string | number, amount?: number, options?: { path?: string; ttlMs?: number; default?: number }): Promise<number>;

  // --- 读取与点查 ---
  get(key: string | number, options?: { includeDeleted?: boolean }): Promise<Value | undefined>;
  getRecord(key: string | number): Promise<PhysicalRecord<Columns, Value> | undefined>;
  getBy(keyName: keyof Columns | string, keyValue: unknown): Promise<PhysicalRecord<Columns, Value> | undefined>; // 【核心】O(1) 物理二级键点查
  getMany(keys: (string | number)[]): Promise<(Value | undefined)[]>;
  getByPrefix(prefix: string): Promise<Array<{ key: string; value: Value }>>;
  exists(key: string | number): Promise<boolean>;
  count(query?: FindQuery): Promise<number>;

  // --- 删除、软删除与恢复 ---
  delete(key: string | number, options?: { hard?: boolean }): Promise<boolean>;
  hardDelete(key: string | number): Promise<boolean>;
  restore(key: string | number): Promise<boolean>;
  isDeleted(key: string | number): Promise<boolean>;
  deleteMany(keys: (string | number)[]): Promise<number>;
  deleteByPrefix(prefix: string): Promise<number>;
  clear(): Promise<void>;

  // --- 条件检索与事件监听 ---
  find(query?: FindQuery): Promise<Array<{ key: string; value: Value }>>;
  findRecords(query?: FindQuery): Promise<Array<PhysicalRecord<Columns, Value>>>;
  watch(key: string, handler: (event: TableWatchEvent<Value>) => void): Promise<Subscription>;

  // --- 大对象分块存取 (Chunked Blobs) ---
  putBlob(key: string, data: Buffer | Uint8Array | string, options?: BlobOptions): Promise<BlobMeta>;
  getBlob(key: string): Promise<Buffer | undefined>;
  getBlobMeta(key: string): Promise<BlobMeta | undefined>;
  deleteBlob(key: string): Promise<boolean>;

  // --- 物理索引、Schema 演进与生态适配 ---
  ensureIndex(jsonPath: string): Promise<void>;                   // 普通 KV 表 JSON 路径建索引
  addKey(name: string, definition: KeyDefinition): Promise<void>; // 【核心】动态扩展物理二级键
  addIndex(definition: MultiKeyIndexDefinition): Promise<void>;   // 【核心】动态扩展物理复合索引
  flush(): Promise<void>;                                         // 手动强制排空微批写入缓冲区
  asKeyv(): KeyvStoreAdapter<Value>;                              // 【核心】导出标准 Keyv 存储适配器
}
```

---

## 3. 动态多键（Multi-Key）物理索引深度剖析与性能优化

> [!IMPORTANT]
> **为什么要使用 Multi-Key？**  
> 在标准 KV 模式下，整条数据序列化为单个 JSON 存储在 `value` 字段中。如果业务经常需要根据非主键字段（如 `hash`, `symbol`, `status`, `userId`）进行查询，若直接用 `find()` 针对 JSON 字段检索，即便建立了 JSON 表达式索引，仍然面临**写放大、无法利用覆盖索引、反序列化开销大**等缺陷；未建索引时更是会退化为灾难性的**全表扫描**。  
> **Multi-Key 架构将频繁检索、过滤、排序的二级键映射为数据库原生的物理列（Physical Columns）**，并挂载 B-Tree / Unique 物理索引，使 KV 数据库获得与关系型数据库完全一致的原生查询性能与 O(1) 二级点查能力！

### 3.1 MultiKeySchema 契约声明规范
通过 `db.table<Value, Keys>(name, { schema })` 声明物理多键表：

```typescript
import { KVDB, type MultiKeySchema } from "kvdb-sdk";

// 1. 定义数据 Value 与二级键 Keys 类型
interface TokenData {
  name: string;
  decimals: number;
  metadata?: Record<string, unknown>;
}

type TokenKeys = {
  symbol: string;
  chainId: string;
  address: string;
  status?: string;
  holderCount?: number;
};

// 2. 声明 Multi-Key Schema
const schema: MultiKeySchema<TokenKeys> = {
  // 可选：指定物理主键（默认 name: "key", type: "string"；支持 integer 自增/主键）
  primaryKey: { name: "address", type: "string" },

  // 可选：是否自动创建并维护 created_at 与 updated_at 物理列（默认 true）
  // 设为 false 可构建极简表（Lean Schema），并允许在 keys 中自定义专属的 created_at 字段
  timestamps: true,

  // 二级键（物理列）定义：映射到底层真实的物理字段
  keys: {
    symbol: {
      type: "string",
      index: true, // 自动为此列创建底层原生 B-Tree 物理索引
    },
    chainId: {
      type: "string",
      index: true,
    },
    status: {
      type: "string",
      nullable: true,
      default: "active",
      index: true,
    },
    holderCount: {
      type: "integer",
      default: 0,
    },
  },

  // 表级复合物理索引（多列联合索引，极大加速多条件联合查询）
  indexes: [
    {
      name: "idx_chain_symbol",
      keys: ["chainId", "symbol"],
      unique: true, // 支持唯一约束
    },
    {
      name: "idx_chain_status_holders",
      keys: ["chainId", "status", "holderCount"],
    },
  ],
};

const tokens = db.table<TokenData, TokenKeys>("tokens", { schema });
```

### 3.2 支持的数据类型与属性
| 类型 (`type`) | 映射说明 (SQLite / Postgres / Mongo) | 适用场景 |
|---|---|---|
| `"string"` | `TEXT` / `VARCHAR` / `String` | 地址、哈希、枚举、标识符 |
| `"integer"` | `INTEGER` / `BIGINT` / `Long` | 区块号、时间戳、计数器、版本号 |
| `"number"` | `REAL` / `DOUBLE PRECISION` / `Double` | 金额浮点数、比率、权重 |
| `"boolean"` | `INTEGER(0/1)` / `BOOLEAN` / `Boolean`| 状态开关、标记位 |
| `"json"` | `TEXT(JSON)` / `JSONB` / `Object` | 结构化子对象物理列 |

- **列属性定义**：
  - `nullable?: boolean`：是否允许为 `null`（默认 `true`）。
  - `default?: unknown`：默认值。
  - `index?: boolean | { name?: string; unique?: boolean }`：单列原生索引配置。
- **表级配置项**：
  - `timestamps?: boolean`：是否自动维护 `created_at` 与 `updated_at`。默认为 `true`。若设置为 `false`：
    - 底层建表时省去系统级时间戳列，提升写入性能与降低存储冗余（极简精简表）。
    - 解除 `created_at` 和 `updated_at` 的保留字锁定，允许业务在 `keys` 中定义自己的时间戳列（如自定义整型 Unix timestamp）。

### 3.3 写入与高性能点查对比

#### 1. 写入时携带二级键
```typescript
// 显式主键写入
await tokens.set("0x1111", { name: "Ethereum", decimals: 18 }, {
  keys: {
    symbol: "ETH",
    chainId: "ethereum",
    status: "active",
    holderCount: 5000000,
  },
});

// 或合一写入（当 keys 中包含声明的主键名时）
await tokens.set({
  keys: {
    address: "0x2222",
    symbol: "USDC",
    chainId: "ethereum",
    status: "active",
    holderCount: 2000000,
  },
  value: { name: "USD Coin", decimals: 6 },
  ttlMs: 86400_000, // 支持 TTL
});
```

#### 2. 原生物理点查对比 (`getBy` vs `find`)
```typescript
// 【性能极致】直接通过物理二级索引进行 O(1) 点查：
// 底层在 Postgres 下生成: SELECT * FROM "tokens" WHERE "symbol" = $1 LIMIT 1
// 耗时直接降到亚毫秒级，且返回完整 PhysicalRecord (包含主键、所有物理列与 value)
const record = await tokens.getBy("symbol", "ETH");
console.log(record?.key);            // "0x1111" (主键)
console.log(record?.columns.chainId);// "ethereum" (物理二级列)
console.log(record?.value);          // { name: "Ethereum", decimals: 18 }

// 【复合物理查询】多物理列联合过滤与排序：
// 自动命中 idx_chain_status_holders 复合物理索引，无需全表扫描与运行时 JSON 提取！
const activeEthTokens = await tokens.find({
  where: {
    chainId: "ethereum",
    status: "active",
    holderCount: { $gte: 10000 },
  },
  sort: [{ path: "holderCount", direction: "desc" }],
  limit: 20,
});
```

### 3.4 运行时零停机动态加键与索引演进 (Zero-Downtime Evolution)
生产环境中表结构变更往往不能停机。`kvdb-sdk` 支持在应用运行期动态扩列并创建索引：

```typescript
// 1. 动态增加物理列并自动建索引
// 底层自动执行: ALTER TABLE "tokens" ADD COLUMN "isL2" INTEGER DEFAULT 0;
// 并自动执行: CREATE INDEX "tokens_isL2_idx" ON "tokens" ("isL2");
await tokens.addKey("isL2", {
  type: "boolean",
  default: false, // ⚠️ 重要：已有数据的表增加非空键时必须提供 default
  index: true,
});

// 2. 动态创建复合物理索引
await tokens.addIndex({
  name: "idx_l2_status",
  keys: ["isL2", "status"],
  unique: false,
});
```
- **幂等安全**：所有 DDL 操作均采用幂等机制（如 `IF NOT EXISTS` 与元数据检测），重复执行不会抛出异常。

### 3.5 写入合并与 Multi-Row 批量写聚合优化
- **Multi-Key 增量浅合并**：当同一微批窗口（20ms）内对同一主键发生多次写入且携带不同二级键时，`WriteBatcher` 自动进行增量合并（`{ ...existing.keys, ...newItem.keys }`），确保部分更新不会丢失已有二级索引列。
- **参数化 Multi-Row 聚合与防死锁**：当一次性插入成百上千条记录时，SDK 不会逐条执行，而是自动拼装为单条 `INSERT INTO ... VALUES (...), (...) ON CONFLICT DO UPDATE`。下发前自动按主键进行严格的字典序排序，彻底规避高并发并发写场景下的行级死锁（Deadlock Prevention）。

---

## 4. 普通 KV 表的 JSON 路径索引 (JSON Path Indexing)

若不想使用物理 Schema 表，仅需在传统 KV 表的 JSON 字段上建立索引，SDK 提供了三种轻量级途径：

1. **实例初始化声明**：
   ```typescript
   const db = new KVDB({
     driver: "sqlite",
     indexes: ["profile.age", "status"], // 初始化建表时自动为 JSON 路径创建函数索引
   });
   ```
2. **运行时显式调用**：
   ```typescript
   await table.ensureIndex("profile.city");
   ```
3. **自适应自动索引 (`autoIndex`)**：
   ```typescript
   const db = new KVDB({
     driver: "postgresql",
     url: process.env.DATABASE_URL,
     autoIndex: { threshold: 30 }, // 某 JSON 路径查询频次达到 30 次后，自动在后台异步创建索引
   });
   ```

> **选型建议**：
> - 字段量固定、查询频繁、写入并发高、需要 O(1) 二级点查 -> **首选 Multi-Key 物理表**（性能与扩展性最佳）。
> - 字段动态任意、结构松散、偶发查询 -> **使用普通 KV 表 + JSON 索引 / autoIndex**。

---

## 5. 快速上手完整用例 (Quickstart)

以下是一个涵盖 **Multi-Key 物理索引定义、写入、点查、动态演进与范围查询** 的完整可运行示例：

```typescript
import { KVDB, type MultiKeySchema } from "kvdb-sdk";

async function main() {
  // 1. 初始化数据库连接 (此处以 SQLite 为例，换为 postgresql / mongodb 参数完全一致)
  const db = new KVDB({
    driver: "sqlite",
    url: "./app_data.sqlite", // 或 ":memory:"
    gracefulShutdown: true,   // 进程退出时自动刷新未落盘缓冲
  });

  // 2. 声明业务数据类型与 Multi-Key 结构
  interface UserProfile {
    bio: string;
    avatarUrl: string;
  }

  type UserSecondaryKeys = {
    username: string;
    email: string;
    role: string;
    score: number;
    isVip?: boolean;
  };

  const userSchema: MultiKeySchema<UserSecondaryKeys> = {
    primaryKey: { name: "userId", type: "string" },
    keys: {
      username: { type: "string", index: { unique: true } }, // 唯一物理索引
      email: { type: "string", index: { unique: true } },    // 唯一物理索引
      role: { type: "string", index: true },                 // 普通物理索引
      score: { type: "integer", default: 0 },
    },
    indexes: [
      { name: "idx_role_score", keys: ["role", "score"] },  // 复合物理索引
    ],
  };

  const users = db.table<UserProfile, UserSecondaryKeys>("users", { schema: userSchema });

  // 3. 写入带有物理二级键的记录
  await users.set("u_1001", { bio: "Web3 Developer", avatarUrl: "https://avatar/1" }, {
    keys: {
      username: "alice_crypto",
      email: "alice@example.com",
      role: "developer",
      score: 95,
    },
  });

  await users.set("u_1002", { bio: "Security Auditor", avatarUrl: "https://avatar/2" }, {
    keys: {
      username: "bob_sec",
      email: "bob@example.com",
      role: "auditor",
      score: 88,
    },
  });

  // 4. 高性能 O(1) 二级物理键点查 (命中 username 唯一物理索引)
  const alice = await users.getBy("username", "alice_crypto");
  console.log("Found Alice by username:", {
    userId: alice?.key,
    role: alice?.columns.role,
    bio: alice?.value.bio,
  });

  // 5. 零停机动态表结构演进：追加 isVip 键并建立索引
  await users.addKey("isVip", {
    type: "boolean",
    default: false,
    index: true,
  });

  // 6. 原子读-改-写 (CAS / 锁机制保护)
  await users.update("u_1001", (prev) => ({
    ...prev!,
    bio: "Senior Web3 Developer & Security Researcher",
  }));

  // 7. 多键复合条件与范围查询 (完全走物理列索引优化)
  const topDevelopers = await users.find({
    where: {
      role: "developer",
      score: { $gte: 90 },
    },
    sort: [{ path: "score", direction: "desc" }],
    limit: 10,
  });
  console.log("Top Developers count:", topDevelopers.length);

  // 8. 清理并退出
  await db.close();
}

main().catch(console.error);
```

---

## 6. 高级子系统协同 (Advanced Subsystems)

### 6.1 独立分层缓存 (`Cache`) 与防击穿
```typescript
import { Cache, MemoryStore, RedisStore } from "kvdb-sdk";

// 构建 L1 (内存) + L2 (Redis) 分层缓存
const cache = new Cache({
  stores: [
    new MemoryStore({ max: 5000, ttlMs: 60_000 }),
    new RedisStore({ redis: "redis://127.0.0.1:6379" }),
  ],
});

// 使用 wrap 防击穿 (SingleFlight) 模式获取数据
const user = await cache.wrap("user:1001", async () => {
  return await fetchUserFromRemote("1001");
}, 300_000);
```

### 6.2 可靠持久化任务队列 (`Queue` & `Worker`)
```typescript
// 创建基于数据库底层持久化表的任务队列 (At-Least-Once 保障)
const taskQueue = db.queue<{ orderId: string; amount: number }>("order_tasks");

// 入队任务 (支持延迟执行与退避参数)
await taskQueue.add("process_order", { orderId: "ord_998", amount: 199.9 }, {
  delayMs: 5000,
  attempts: 3,
  backoff: { type: "exponential", delayMs: 1000 },
});

// 启动 Worker 进行并发消费
const worker = db.worker("order_tasks", async (job) => {
  console.log(`Processing Job ${job.id}:`, job.data);
  // 执行业务逻辑...
}, { concurrency: 5 });
```

---

## 7. 全数据库通用的高频高价值功能模块实战 (Universal Extensions)

> [!TIP]
> **多数据库通用基准**：以下所有功能模块均原生支持 SQLite（含 `:memory:` 纯内存秒级模式与文件存储）、PostgreSQL、MySQL、MongoDB、Redis 全量驱动，无需安装额外中间件，开箱即用。

### 7.1 分布式互斥锁 (Distributed Lock & Mutex)
用于跨进程防重复跑、临界区互斥、库存防超卖：
```typescript
// 1. 作用域包装器：自动加锁、自动心跳续期（Auto-Heartbeat）、执行完毕自动释放
const result = await db.withLock("lock:order:1001", async (lockHandle) => {
  // 临界区业务操作
  return await processOrder(1001);
}, {
  ttlMs: 10_000,         // 锁租约时间（默认 10s）
  waitTimeoutMs: 5_000,   // 获取锁最大等待超时（默认 5s，0 表示非阻塞 try-lock）
  retryIntervalMs: 100,   // 重试轮询间隔（默认 100ms）
  autoHeartbeat: true,    // 是否在持锁期间自动后台续期（默认 true）
});

// 2. 手动加锁与释放
const lock = await db.acquireLock("lock:cron:sync", { ttlMs: 15_000 });
if (lock) {
  try {
    await runSync();
  } finally {
    await lock.release();
  }
}
```

### 7.2 高频原子数值计算 (Atomic Increment & Decrement)
避免全量 JSON 反序列化与事务锁竞争，直接原子操作数字或深层属性：
```typescript
const table = db.table("metrics");

// 标量累加（若不存在则从 default 默认值开始）
const views = await table.increment("article:101", 1, { default: 0 });
const points = await table.decrement("user:101", 5);

// 嵌套 JSON 字段原子计算
await table.increment("user:101", 10, { path: "stats.likes" });
```

### 7.3 高性能滑动窗口限流器 (RateLimiter)
API 防刷、登录暴破防御、大模型 Token 限频（基于 99.9% 精度双窗口滑动加权算法）：
```typescript
const limiter = db.rateLimiter({
  windowMs: 60_000, // 1 分钟滑动窗口
  limit: 100,       // 允许 100 次
});

const res = await limiter.consume(clientIp, 1);
// res: { allowed: true, remaining: 99, resetMs: 58200, current: 1, limit: 100 }
if (!res.allowed) {
  throw new KvdbRateLimitError("Too Many Requests");
}

// 检查当前状态而不消耗配额
const status = await limiter.check(clientIp);

// 重置限流状态
await limiter.reset(clientIp);
```

### 7.4 接口与任务幂等性守护 (Idempotency Guard)
解决支付回调、第三方 Webhook、表单重复点击导致的重复扣款或重复处理：
```typescript
// 状态机驱动（PENDING -> RESOLVED / REJECTED）
// 并发相同 Key 请求自动等待首个任务执行并返回结果；成功后在 ttlMs 内直接返回缓存结果
const result = await db.idempotent(`pay:order:${orderId}`, async () => {
  return await chargePayment(orderId);
}, {
  ttlMs: 86400_000,   // 成功结果缓存 24 小时
  timeoutMs: 10_000,  // 并发请求等待超时
});
```

### 7.5 分布式 Cron 定时任务调度 (Queue.schedule)
标准 5 段 Cron 表达式解析，原生保证集群多节点 Exactly-Once 触发与自动重试：
```typescript
const queue = db.queue("reports");

// 注册标准 Cron 分布式调度任务（集群内仅有一台机器执行，失败自动退避重试）
await queue.schedule("daily-sync", "0 0 * * *", { type: "daily" });
await queue.schedule("pulse", "*/5 * * * *", { ping: true });

// 亦支持简单时间间隔
await queue.schedule("heartbeat", { everyMs: 30_000 }, { ping: true });

// 列出所有调度与取消调度
const schedules = await queue.listScheduled();
await queue.unschedule("daily-sync");
```

### 7.6 Keyv / Web 框架生态标准适配 (table.asKeyv)
使任何数据库后端的 KVDB 数据表无缝兼容 Node.js 社区生态（Apollo Server, Unstorage, Cache-Manager 等）：
```typescript
const table = db.table("sessions");
const keyvStore = table.asKeyv();

// 符合 Keyv Storage Adapter 标准规范: get, set, delete, clear, has, iterator
await keyvStore.set("session_101", { user: "Alice" }, 3600_000);
const session = await keyvStore.get("session_101");
```

### 7.7 逻辑软删除与数据恢复 (Soft Delete & Restore)
在很多生产业务中，误删防范、历史审计与逻辑标记删除是刚需。通过在表初始化时开启 `softDelete: true`，即可在所有底层数据库（SQLite / PG / Mongo / MySQL / Redis）上实现标准软删除：
```typescript
const users = db.table<{ id: string; name: string }>("users", {
  softDelete: true, // 开启逻辑软删除支持
});

await users.set("u1", { id: "u1", name: "Alice" });

// 1. 逻辑软删除 (自动标记 _deletedAt 时间戳)
await users.delete("u1");

// 2. 常规读取与查询自动过滤已删除项
const user = await users.get("u1");          // undefined
const exists = await users.exists("u1");      // false
const list = await users.find();             // []
const count = await users.count();           // 0

// 3. 状态检查与带软删除穿透查询
const isDel = await users.isDeleted("u1");   // true
const raw = await users.get("u1", { includeDeleted: true }); // { id: "u1", name: "Alice", _deletedAt: 1730000000000 }
const all = await users.find({ includeDeleted: true });       // 包含已删除记录

// 4. 数据一键恢复
await users.restore("u1");
const restored = await users.get("u1");      // { id: "u1", name: "Alice" }

// 5. 物理彻底抹除 (Bypassing soft delete)
await users.hardDelete("u1");
```

### 7.8 跨进程变更监听与事件广播 (Pub/Sub & Key Watching)
提供轻量高效的微服务节点通信与数据变动实时监听：
```typescript
// 1. 数据表行级变动监听 (Table Watch)
const orders = db.table("orders");

// 监听特定 Key 的变更（set 或 delete）
const subKey = await orders.watch("order:1001", (evt) => {
  console.log(`Order updated: key=${evt.key}, type=${evt.type}, value=`, evt.value);
});

// 监听全表任何 Key 的变动
const subAll = await orders.watch("*", (evt) => {
  console.log(`Global table change: ${evt.type} on ${evt.key}`);
});

await orders.set("order:1001", { status: "shipped" }); // 触发上述监听
await subKey.unsubscribe();

// 2. 跨微服务/跨实例 Pub/Sub 事件总线
const ps = db.pubsub();

const subAlerts = await ps.subscribe("system:alerts", (payload, msg) => {
  console.log(`Received alert: ${payload} at ${msg.timestamp}`);
});

// 支持进程内毫秒级极速分发 + 跨实例持久化事件轮询
await ps.publish("system:alerts", { level: "warning", message: "CPU > 85%" });
await subAlerts.unsubscribe();
```

### 7.9 大对象分块流式存取 (Chunked Blob Storage)
MongoDB 单文档限制 16MB、MySQL 单包大小受制于 `max_allowed_packet`、SQLite 大字段影响 B-Tree 叶子节点性能。通过 `putBlob` / `getBlob` 将超大文件、高分辨率图片或超大 JSON 自动切片存储：
```typescript
const assets = db.table("assets");

// 1. 自动分块写入 (默认 256KB/Chunk，可自定义)
const largeBuffer = fs.readFileSync("./report.pdf");
const meta = await assets.putBlob("reports/2026-q1.pdf", largeBuffer, {
  chunkSize: 256 * 1024,                  // 256KB
  contentType: "application/pdf",
  ttlMs: 7 * 86400_000,                  // 支持为大对象设置过期 TTL
});
// meta: { key: "reports/2026-q1.pdf", size: 1048576, chunkSize: 262144, totalChunks: 4, createdAt: ... }

// 2. 极速元数据读取 (无需加载整包二进制)
const blobMeta = await assets.getBlobMeta("reports/2026-q1.pdf");

// 3. 读取并自动重组为完整 Buffer
const fileBuffer = await assets.getBlob("reports/2026-q1.pdf"); // Buffer

// 4. 一键完整清理所有分块及元数据
await assets.deleteBlob("reports/2026-q1.pdf");
```

### 7.10 运行时链路指标与延迟分析 (Observability & Metrics)
无需安装庞大第三方 APM 插件，开箱即用获取核心健康度与操作性能指标，轻松对接 Prometheus 或 Grafana：
```typescript
// 1. 获取全局运行指标快照
const metrics = db.getMetrics();
console.log({
  reads: metrics.reads,                     // 总读取次数
  writes: metrics.writes,                   // 总写入次数
  deletes: metrics.deletes,                 // 总删除次数
  cacheHits: metrics.cacheHits,             // 缓存命中次数
  cacheMisses: metrics.cacheMisses,         // 缓存未命中次数
  cacheHitRatio: metrics.cacheHitRatio,     // 命中率 (0.0000 ~ 1.0000)
  uptimeSeconds: metrics.uptimeSeconds,     // 运行秒数
  latency: {
    avgMs: metrics.latency.avgMs,           // 平均延迟毫秒
    p95Ms: metrics.latency.p95Ms,           // P95 延迟分位数
    p99Ms: metrics.latency.p99Ms,           // P99 延迟分位数
    maxMs: metrics.latency.maxMs,           // 最大耗时
  },
});

// 2. 实时链路性能钩子 (可向 OpenTelemetry / StatsD 投递)
const unhook = db.metrics.onMetric((evt) => {
  // evt: { type: "read"|"write"|"delete"|"lock", durationMs: 0.8, success: true, key: "user:10" }
  otelHistogram.record(evt.durationMs, { type: evt.type });
});

// 3. 指标重置 (例如定时 1 分钟周期清零重新采样)
db.resetMetrics();
```

---

## 8. 常见陷阱与最佳实践 (Pitfalls & Best Practices)

### 1. 【性能陷阱】切忌在普通 KV 表中用 `find` 做无索引属性过滤
- **错误姿势**：在普通 KV 表上直接执行 `table.find({ where: { status: "pending" } })`，底层会遍历全表解析 JSON 字符串，十万级数据即可导致数据库 CPU 100% 阻塞数秒。
- **正确姿势**：若该字段查询频繁，**务必在表定义中使用 `MultiKeySchema` 并声明 `index: true`**，或至少在普通表上调用 `table.ensureIndex("status")`。

### 2. 【演化陷阱】动态添加非空列未指定 `default` 导致 DDL 崩溃
- **错误姿势**：对已有数据的表执行 `table.addKey("status", { type: "string", nullable: false })`。底层执行 `ALTER TABLE ADD COLUMN NOT NULL` 会因已有行无数据而导致数据库抛出错误。
- **正确姿势**：增加非空物理列时，**强制显式提供默认值**，如 `table.addKey("status", { type: "string", nullable: false, default: "active", index: true })`。

### 3. 【命名陷阱】系统保留字段与严格 Schema 校验
- **核心保留字段（任何情况均禁止使用）**：
  `value`、`expires_at`、`_id`、`__proto__`、`constructor`、`prototype`。
- **时间戳字段（默认保留）**：
  在默认 `timestamps: true` 模式下，`created_at` 与 `updated_at` 由 SDK 内部维护，禁止用作自定义二级键名。若业务需要定义专属的 `created_at`/`updated_at`，**必须在 Schema 中显式指定 `timestamps: false`**。
- **严格校验机制**：SDK 具备严格的 Schema 校验（不会静默吞错），一旦发现非法列名或保留字，会在表初始化或操作时直接抛出 `KvdbSchemaError` 并附带明确修复指引。

### 4. 【并发陷阱】外部直接读取与微批聚合时钟差
- **机制**：SDK 默认开启 `autoBatch` 微批处理（默认等待时间 20ms）。在执行 `table.set()` 后，数据会先进入内存聚合队列，待窗口排空或达到 50 条时由参数化 Multi-Row SQL 一并落盘。
- **建议**：通过 SDK 自身 API 读取会自动合并内存中的最新值；但如果业务有立即使用外部原生 SQL 工具或第三方法访问数据库的强一致需求，可在写入后调用 `await table.flush()` 强制立即刷盘。

### 5. 【生命周期】应用关闭时务必调用 `db.close()`
- **原因**：`autoBatch` 引擎与定时清理任务使用了 Node.js 定时器。若在服务停机时未调用 `await db.close()`，可能会导致最后批次的数据未完全落盘或连接未释放。
- **建议**：在初始化时配置 `gracefulShutdown: true`，或在进程退出监听（`SIGTERM` / `SIGINT`）中执行 `await db.close()`。

---

## 9. 本地维护与热修复指引 (Hotfix SOP)

如在业务项目中接入 `kvdb-sdk` 并发现需要修复 Bug 或扩展新能力：
1. 进入 SDK 源码目录：`cd /ssd0/git/kvdb-nodejs`
2. 确保切换至正确 GitHub 账号：`gh auth switch --user xzsean666`
3. 执行修改并运行单元测试与构建：`pnpm test && pnpm build`
4. 提交并推送到远端：
   ```bash
   git add .
   git commit -m "fix/feat: <修复或功能说明>"
   git push origin main
   ```
5. 获取最新 Commit Hash：`git rev-parse HEAD`
6. 返回业务项目更新依赖：`pnpm add git+https://github.com/xzsean666/kvdb-nodejs.git#<NEW_HASH>`
