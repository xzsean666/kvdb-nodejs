# ARCHITECTURE.md — KVDB SDK 系统架构总述与技术规格

> 本文件是系统架构与模块契约的统一事实来源（Source of Truth）。
> 详尽 API 与行为规格见 `docs/SPEC.md`，构建与运行指南见 `docs/BUILD.md`，架构决策记录见 `docs/AI/DECISIONS.md`。

---

## 1. 架构总览

KVDB SDK 采用分层与双契约设计：
- 上层对开发者暴露极简且类型安全的门面 API（`KVDB`、`Table`、`Cache`、`WriteBatcher`、TC39 装饰器）；
- 下层将纯键值能力（`KVStore`）与高级查询/物理多键能力（`Driver`、`SchemaTableDriver`）严格隔离；
- 通过统一 AST 实现类 Mongo 风格查询到多数据库原生表达式的精准下降。

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                            Public Facade API                                │
│   KVDB  │  Table<Value, Keys>  │  Cache  │  @Cacheable  │  WriteBatcher     │
└──────────────┬───────────────────────────────────────────────┬──────────────┘
               │                                               │
┌──────────────▼──────────────┐                 ┌──────────────▼──────────────┐
│        Rich Driver Layer    │                 │     Minimum KVStore Layer   │
│   (Query, Multi-Key Schema, │                 │ (Get/Set/Del/TTL/Iterator,  │
│    DDL, Secondary Indexing, │                 │  Multi-tier Cache Stores)   │
│    Auto-Batch, Atomic Update)                 │                             │
└──────────────┬──────────────┘                 └──────────────┬──────────────┘
               │                                               │
┌──────────────▼───────────────────────────────────────────────▼──────────────┐
│                            Database Drivers                                 │
│          better-sqlite3    │    pg (PostgreSQL)    │    mongodb             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. 模块结构与认知边界 (Cognitive Directory Map)

模块严格遵循**认知驱动拆分**（AI 能否孤立理解），各层职责与输入输出高度内聚：

```text
src/
├── index.ts                 # 唯一公开入口：导出 KVDB / Table / Cache / 装饰器 / Batcher / 公开类型
│
├── core/                    # 核心门面与业务逻辑（无具体数据库原生驱动调用）
│   ├── kvdb.ts              # KVDB 主实例：管理驱动生命周期、Table 单例缓存、TTL 清理
│   ├── table.ts             # Table 门面：CRUD、点查、多键检索、批处理打通、RYW 读己之写拦截
│   ├── table-schema.ts      # 物理列/多键定义、类型检查、动态演进校验、保留字保护
│   ├── batcher.ts           # WriteBatcher 微批聚合引擎：同 Key 折叠、操作保序、主键排序防死锁
│   ├── key.ts               # 前缀、命名空间与用户 key 的组合与解析
│   ├── serializer.ts        # Canonical JSON 稳定键排序序列化与反序列化（GC 优化）
│   ├── errors.ts            # 分级、可判别的错误类型体系（KvdbError 及其子类）
│   ├── expiry.ts            # TTL 计算与相对/绝对时间换算助手
│   └── auto-index.ts        # 查询模式分析器与自动索引建议引擎（容量上限与防抖保护）
│
├── drivers/                 # 底层驱动适配层
│   ├── types.ts             # Driver, DriverCapabilities, SchemaTableDriver 核心契约
│   ├── sqlite/              # SQLite 实现（基于 better-sqlite3，Prepared Statement 缓存与立即事务）
│   ├── postgres/            # PostgreSQL 实现（基于 pg，行锁升序防死锁、Keyset 分页拉取）
│   └── mongodb/             # MongoDB 实现（基于 mongodb 驱动，CAS 原子更新与 bulkWrite）
│
├── query/                   # 统一查询编译器
│   ├── ast.ts               # 跨后端统一抽象语法树节点定义（QueryNode）
│   ├── parser.ts            # 类 Mongo 过滤语法到 AST 的解析器（白名单转义与原型链防御）
│   ├── compiler.ts          # AST 到底层原生查询的下降编译器基类/接口
│   └── paths.ts             # JSON 路径与列名引用提取助手
│
├── cache/                   # 独立 Cache 子系统
│   ├── cache.ts             # Cache 门面：分层存储查找、SWR wrap()、并发未命中合并
│   ├── types.ts             # KVStore 最小公约契约
│   └── stores/              # 各层 Store 实现（MemoryStore, SqliteStore 等）
│
├── decorators/              # TC39 标准装饰器（TypeScript 5.x 原生）
│   ├── cacheable.ts         # @Cacheable / @CacheClear 装饰器工厂
│   └── cache-key.ts         # 稳定参数哈希与 Cache Key 构造逻辑
│
├── plugins/                 # 插件与生命周期钩子系统
│   ├── types.ts             # Hook 签名与插件上下文定义
│   └── runtime.ts           # 读写查生命周期的洋葱模型运行时（零开销快速路径）
│
└── types/                   # 全局通用类型定义（JsonValue, MaybePromise 等）
```

### 核心模块职责表

| 模块 | 职责 (一件事) | 输入 | 输出 | 关键依赖 |
|---|---|---|---|---|
| `core/kvdb.ts` | 数据库实例生命周期、Table 单例缓存复用、全局资源优雅停机 | `KVDBOptions` | `KVDB` 实例 | `drivers/types`, `cache/cache`, `core/table` |
| `core/table.ts` | 表命名空间 CRUD、点查、多键检索、微批写入排空、RYW 拦截 | key, value, query | CRUD 操作结果 | `drivers/types`, `core/batcher`, `query/*` |
| `core/batcher.ts` | 内存微批合并、同 Key 覆盖写/写删抵消、主键升序排序防死锁 | 写入/删除请求 | 聚合后统一批次 | `core/table-schema` |
| `core/table-schema.ts`| 动态多键契约、列类型约束、联合索引元数据校验 | `MultiKeySchema` | 校验后元数据 | `core/errors` |
| `core/serializer.ts` | 值 ↔ Canonical Text JSON，消除歧义并减轻 GC 堆分配 | 任意 JSON 值 | 规范字符串 / 反序列化对象 | 无 |
| `drivers/types.ts` | 定义 Driver / SchemaTableDriver / Capabilities 契约 | — | 接口与类型声明 | `cache/types`, `query/ast` |
| `query/parser.ts` | 声明式 Mongo 查询对象 → 后端无关的 AST | 查询文档 | `QueryNode` AST | `query/ast` |
| `cache/cache.ts` | 多层缓存透明穿透、SWR 异步续期、并发防击穿合并 | `CacheOptions` | `Cache` 门面实例 | `cache/types`, `cache/stores/*` |
| `decorators/cacheable.ts`| 声明式方法级缓存（TC39 标准） | 缓存配置 | 包装后方法 | `cache/cache`, `decorators/cache-key` |
| `plugins/runtime.ts` | 拦截读写查生命周期钩子（洋葱模型） | Hook 定义 | 拦截执行管线 | `plugins/types` |

---

## 3. 核心契约与接口

### 3.1 `KVStore` (最低层契约，`src/cache/types.ts`)
```ts
export interface KVStore {
  get(key: string): MaybePromise<RawEntry | undefined>;
  set(key: string, value: RawEntry, ttlMs?: number): MaybePromise<void>;
  delete(key: string): MaybePromise<boolean>;
  has(key: string): MaybePromise<boolean>;
  clear(): MaybePromise<void>;
  getMany?(keys: string[]): MaybePromise<(RawEntry | undefined)[]>;
  setMany?(entries: KVEntry[]): MaybePromise<void>;
  deleteMany?(keys: string[]): MaybePromise<number>;
  iterator?(prefix?: string): AsyncIterable<[string, RawEntry]>;
}
```

### 3.2 `Driver` (富层持久化驱动契约，`src/drivers/types.ts`)
```ts
export interface Driver extends KVStore {
  readonly provider: "sqlite" | "postgres" | "mongodb";
  readonly capabilities: DriverCapabilities;

  getByPrefix(prefix: string): MaybePromise<KVEntry[]>;
  deleteByPrefix(prefix: string): MaybePromise<number>;
  find(where: QueryNode, options?: FindOptions, keyPrefix?: string): MaybePromise<KVEntry[]>;
  ensureIndex(jsonPath: string): MaybePromise<void>;
  update?(key: string, mutate: UpdateMutator): MaybePromise<void>;
  purgeExpired(): MaybePromise<number>;
  openSchemaTable?<Columns extends Record<string, unknown>>(
    name: string,
    schema?: TableSchema<Columns> | MultiKeySchema<Columns>,
  ): MaybePromise<SchemaTableDriver<JsonValue, Columns> | undefined>;
  raw(): unknown;
  close(): Promise<void>;
}
```

### 3.3 `SchemaTableDriver` (物理多键表契约，`src/drivers/types.ts`)
```ts
export interface SchemaTableDriver<Value = JsonValue, Columns extends Record<string, unknown> = Record<string, unknown>> {
  schema: TableSchema<Columns>;
  setRecord(key: string | number, value: string, columns: Record<string, unknown>, ttlMs?: number): MaybePromise<void>;
  getRecord(key: string | number): MaybePromise<{ key: string | number; value: string; columns: Record<string, unknown>; expiresAt?: number } | undefined>;
  getRecordByKey?(keyName: string, keyValue: unknown): MaybePromise<{ key: string | number; value: string; columns: Record<string, unknown>; expiresAt?: number } | undefined>;
  updateRecord?(
    key: string | number,
    mutate: (current: { key: string | number; value: string; columns: Record<string, unknown>; expiresAt?: number } | undefined) => UpdateResult,
  ): MaybePromise<void>;
  delete(key: string | number): MaybePromise<boolean>;
  clear(): MaybePromise<void>;
  find(where: QueryNode, options?: FindOptions): MaybePromise<Array<{ key: string | number; value: string; columns: Record<string, unknown> }>>;
  setRecords?(items: Array<{ key: string | number; value: string; columns: Record<string, unknown>; ttlMs?: number }>): MaybePromise<void>;
  deleteRecords?(keys: (string | number)[]): MaybePromise<number>;
  addKey?(name: string, definition: KeyDefinition): MaybePromise<void>;
  addIndex?(definition: TableIndexDefinition | MultiKeyIndexDefinition): MaybePromise<void>;
}
```

---

## 4. 关键数据流 (Data Flows)

### 4.1 普通 KV 写入与读取
1. **写入 (`set`)**：
   - 触发插件 `beforeWrite` 钩子。
   - `core/serializer.ts` 将值规范化为 Canonical Text JSON。
   - `core/key.ts` 组装物理 key（`<tablePrefix><namespace>:<userKey>`）。
   - Auto Batch 缓冲或直接写入驱动；若配置了关联 Cache，同步失效/更新缓存。
   - 触发 `afterWrite` 钩子。
2. **读取 (`get`)**：
   - Auto Batch 内存直通检查（In-Memory Fast-Path，0-RTT 命中最新写入）。
   - 优先查关联 Cache（如有），命中则直接返回。
   - 穿透查底座 Driver，若过期则返回 `undefined` 并异步清理；有效则反序列化并回填 Cache。

### 4.2 动态多键（Multi-Key）物理表数据流
1. **表初始化/打开**：
   - 声明 `MultiKeySchema`（主键名/类型、二级检索键、联合索引）。
   - 驱动校验 `kvdb_schema_registry` 表：不存在则执行 DDL 创建物理表与 B-Tree 索引；已存在则严格校验一致性。
2. **多键写入与点查 (`set` / `getBy`)**：
   - 物理检索列作为首选数据库列直接持久化；业务复杂对象作为 `value` JSON 载荷存储。
   - `getBy(keyName, val)` 直接命中物理 B-Tree 索引，复杂度为 $O(1) \sim O(\log N)$，完全避免深层 JSON 扫描。
3. **动态加键 (`addKey`)**：
   - 运行时调用 `table.addKey("status", { type: "string", index: true })`。
   - 驱动执行安全的 DDL 演进（如 `ALTER TABLE ADD COLUMN`）并幂等建立索引，无缝兼容存量记录。

### 4.3 统一 JSON 查询编译流
```text
Table.find({ where: { status: "active", "profile.age": { $gt: 18 } } })
  → query/parser:   白名单校验、操作符语法检查 → 生成统一 QueryNode AST
  → (可选) cache:    以 AST 稳定哈希为 key 查 Query Cache
  → query/compiler: AST + 目标数据库 Visitor → 原生表达式
        ├─ SQLite:      "status" = ? AND json_extract("value", '$.profile.age') > ?
        ├─ PostgreSQL:  "status" = $1 AND ((value->>'profile')::jsonb->>'age')::numeric > $2
        └─ MongoDB:     { status: "active", "profile.age": { $gt: 18 } }
  → Driver 执行 → 行/文档流
  → core/serializer: 反序列化并组装返回
```

### 4.4 Auto Batch 微批合并与写聚合流水线
```text
高频并发调用 table.set() / table.delete()
  │
  ├─ 内存折叠 (coalesce: true)
  │    ├─ 同 Key 覆盖写与写删抵消
  │    └─ Multi-Key 增量浅合并 ({ ...oldKeys, ...newKeys })
  │
  ├─ 读己之写保障 (RYW)
  │    ├─ table.get(k): 内存直通读取 pending 与 inFlightSnapshot (0-RTT)
  │    └─ table.find(): 触发并发 Flush 屏障确保数据落盘后查询
  │
  └─ 触发落盘 (达到 maxBatchSize 或 maxWaitMs 超时)
       ├─ 主键严格确定性排序 (消除 Postgres/SQLite 交叉行锁死锁)
       ├─ 批量执行 (SQLite 事务批插入 / PG UNNEST 聚合 / Mongo bulkWrite)
       └─ Sequence/Generation 屏障唤醒所有等待者并透传异常
```

---

## 5. 并发、事务与死锁防护模型

1. **SQLite 驱动**：
   - 开启 `WAL` 模式（Write-Ahead Logging），读写互不阻塞。
   - 写入与更新采用 `BEGIN IMMEDIATE` 事务，防止从延迟读取升级到写入事务时发生 `SQLITE_BUSY` 冲突。
   - 热点 CRUD 与二级键点查采用 Prepared Statement 预编译语句缓存，DDL 扩展时安全失效。
2. **PostgreSQL 驱动**：
   - **单调升序排序防死锁**：在将多行批次下发给数据库（`setRecords` / `setMany`）前，对待写主键进行严格确定性升序排序，使所有并发事务获取行锁的顺序永远单调一致，数学上彻底根除 `deadlock detected`。
   - **Keyset 游标分块**：`iterator` 采用基于主键索引的 Keyset 分页，杜绝一次性加载整表导致的 Node.js 内存爆炸。
3. **MongoDB 驱动**：
   - 读写改原子更新基于 CAS / 版本比较机制，批量写入采用 `bulkWrite(ordered: false)` 充分压榨连接利用率。

---

## 6. 缓存架构与分层策略

Cache 子系统（`src/cache/`）完全独立于 KVDB，采用分层 Stores 架构：

```text
       ┌────────────────────────────────────────────────────────┐
       │                 Cache.get(key) / wrap(key)             │
       └───────────────────────────┬────────────────────────────┘
                                   │
                                   ▼
┌───────────────────┐    Miss    ┌───────────────────┐    Miss    ┌───────────────────┐
│ L1: MemoryStore   ├───────────►│ L2: SqliteMemory  ├───────────►│ L3: SqliteFile    │
│ (lru-cache v11)   │            │ (:memory:)        │            │ (data.cache.db)   │
└─────────┬─────────┘            └─────────┬─────────┘            └─────────┬─────────┘
          │ Hit                            │ Hit                            │ Hit
          └─────────────────┬──────────────┴────────────────────────────────┘
                            ▼
           反序列化返回，并自动向更高层 Store 回填数据
```

- **并发未命中合并 (In-Flight Miss Collapsing)**：对同一未命中 Key 的并发请求复用同一个在途 Promise，彻底消除缓存击穿与惊群效应（Thundering Herd）。
- **Stale-While-Revalidate (SWR)**：通过 `wrap(key, fn, { ttlMs, refreshThreshold })` 在命中过期边缘数据时先返回旧值，后台异步重新计算并刷新缓存。

---

## 7. 错误处理体系

所有系统抛出错误均派生自 `KvdbError`，提供类型安全的分级判别：

```text
KvdbError
├── KvdbConnectionError      # 数据库连接断开、连接超时或凭证失效
├── KvdbTimeoutError         # 操作超出用户指定的 timeoutMs
├── KvdbKeyError             # 非法 Key 命名（如包含未转义冒号或非法字符）
├── KvdbQueryError           # 查询操作符语法错误、未受支持的操作符
├── KvdbSchemaError          # 列类型不匹配、缺少非空字段默认值、非法多键定义
├── KvdbConfigError          # Schema 冲突、表降级违规、配置互斥
├── KvdbUnsupportedError     # 底层后端不支持某操作（capabilities 不满足）
├── KvdbTransactionError     # 事务冲突、序列化回滚失败
└── KvdbQueueError           # 队列操作错误（锁租约丢失、超限死信等）
```

---

## 8. 架构决策索引 (Architecture Decisions)

所有系统架构宪法与设计决策详见 `docs/AI/DECISIONS.md`，核心包含：
- **基础决策**: KD-1 (双层契约分离), KD-2 (AST 下降), KD-3 (Canonical JSON), KD-4 (分层 Cache), KD-5 (TC39 装饰器), KD-6 (连接池透传与能力标志), KD-7 (`undefined` 语义), KD-8 (真实 DB 合规套件)。
- **物理 Schema 决策**: KD-P1 ~ KD-P7 (物理表隔离、自动恢复、跨后端类型映射、多键与原生索引优先、动态 DDL 演进)。
- **安全与性能加固**: KD-SEC1 ~ KD-SEC2 (ANSI 转义、原型链安全), KD-PERF1 ~ KD-PERF3 (语句预编译缓存、批量契约、GC 优化)。
- **微批与写聚合**: KD-BATCH1 ~ KD-BATCH5 (正交双层配置、确定性主键排序防死锁、RYW 内存直通、保序流水线与屏障锁、Table 单例治理)。

---

## 9. 可扩展性与平滑升级指南

- **添加新后端驱动**: 仅需实现 `Driver` 契约并提供对应的 `AST Visitor`，通过跨驱动合规测试套件（`test/compliance/`）即可无缝接入，核心 Core 零改动。
- **自定义 Cache 存储**: 仅需实现 `KVStore` 契约即可插入分层缓存的任意优先级位置。
- **行为扩展**: 通过洋葱模型 Plugin 注册生命周期钩子（`beforeWrite`, `afterRead` 等），在零改动核心的前提下扩展可观测性、审计日志与加密解密。
