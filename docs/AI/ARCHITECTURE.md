# ARCHITECTURE.md — KVDB SDK 架构总述与模块规格

> 本文件是 AI 在理解与维护 KVDB SDK 系统架构时的统一事实来源。
> 详尽 API 规范见 `docs/SPEC.md`，构建运行指南见 `docs/BUILD.md`。

---

## 1. 架构总览

KVDB SDK 采用分层与双契约设计：上层对开发者暴露极简且类型安全的门面 API（`KVDB`、`Table`、`Cache`、TC39 装饰器）；下层将纯键值能力与高级查询能力严格隔离，并通过统一 AST 实现多后端查询的精准下降。

```text
┌─────────────────────────────────────────────────────────────┐
│                    Public Facade API                        │
│   KVDB  |  Table<Value, Columns>  |  Cache  |  @Cacheable   │
└──────────────┬───────────────────────────────┬──────────────┘
               │                               │
┌──────────────▼──────────────┐ ┌──────────────▼──────────────┐
│        Rich Driver Layer    │ │     Minimum KVStore Layer   │
│   (Query, Prefix, Columns,  │ │ (Get/Set/Del/TTL/Iterator,  │
│    Registry, DDL, Indexing) │ │  Multi-tier Cache Stores)   │
└──────────────┬──────────────┘ └──────────────┬──────────────┘
               │                               │
┌──────────────▼───────────────────────────────▼──────────────┐
│                    Database Drivers                         │
│     better-sqlite3  │  pg (PostgreSQL)  │  mongodb          │
└─────────────────────────────────────────────────────────────┘
```

---

## 2. 模块结构与认知边界 (Cognitive Directory Map)

模块严格遵循“单个文件/目录可孤立理解”的原则拆分：

```text
src/
├── index.ts                 # 唯一公开入口：导出 KVDB / Cache / 装饰器 / 公开类型
│
├── core/                    # 核心门面与业务逻辑（无具体数据库原生调用）
│   ├── kvdb.ts              # KVDB 主实例：管理驱动生命周期、Table 句柄创建、TTL 定时任务
│   ├── table.ts             # Table 句柄：数据读写、查询、缓存打通、完整 Row 装配
│   ├── table-schema.ts      # 物理列定义、类型检查、Schema 合法性校验
│   ├── key.ts               # 前缀、命名空间与用户 key 的组合与解析
│   ├── serializer.ts        # Canonical JSON 稳定序列化与反序列化
│   ├── errors.ts            # 分级、可判别的错误类型（KvdbError 及其子类）
│   ├── expiry.ts            # TTL 计算与相对时间/绝对时间换算助手
│   └── auto-index.ts        # 查询模式分析器与自动索引建议引擎
│
├── drivers/                 # 底层驱动适配层
│   ├── types.ts             # Driver, DriverCapabilities, SchemaTableDriver 核心契约
│   ├── sqlite/              # SQLite 实现（基于 better-sqlite3 与 SQLite Dialect）
│   ├── postgres/            # PostgreSQL 实现（基于 pg 与 PG Dialect）
│   └── mongodb/             # MongoDB 实现（基于 mongodb 驱动与 Mongo Compiler）
│
├── query/                   # 统一查询编译器
│   ├── ast.ts               # 跨后端统一抽象语法树节点定义
│   ├── parser.ts            # 类 Mongo 过滤语法到 AST 的解析器
│   ├── compiler.ts          # AST 到底层原生查询的下降编译器基类/接口
│   └── paths.ts             # JSON 路径与列名引用提取助手
│
├── cache/                   # 独立 Cache 子系统
│   ├── cache.ts             # Cache 门面：分层存储查找、SWR wrap() 引擎
│   ├── types.ts             # KVStore 最小公约契约
│   └── stores/              # 各层 Store 实现（MemoryStore, SqliteStore 等）
│
├── decorators/              # TC39 标准装饰器
│   ├── cacheable.ts         # @Cacheable / @CacheClear 装饰器工厂
│   └── cache-key.ts         # 稳定参数哈希与 Cache Key 构造逻辑
│
├── plugins/                 # 插件与钩子系统
│   ├── types.ts             # Hook 签名与插件上下文定义
│   └── runtime.ts           # 读写查操作的洋葱模型运行时
│
└── types/                   # 全局通用类型定义（如 JsonValue, MaybePromise）
```

---

## 3. 核心契约与接口

### 3.1 `KVStore` (最低层契约，`src/cache/types.ts`)
```ts
export interface KVStore {
  get(key: string): MaybePromise<string | undefined>;
  set(key: string, value: string, ttlMs?: number): MaybePromise<void>;
  delete(key: string): MaybePromise<boolean>;
  has(key: string): MaybePromise<boolean>;
  clear(): MaybePromise<void>;
  getMany?(keys: string[]): MaybePromise<Array<string | undefined>>;
  setMany?(entries: Array<{ key: string; value: string; ttlMs?: number }>): MaybePromise<void>;
  deleteMany?(keys: string[]): MaybePromise<number>;
  iterator?(): AsyncIterable<[string, string]>;
}
```

### 3.2 `Driver` (富层持久化驱动契约，`src/drivers/types.ts`)
```ts
export interface Driver extends KVStore {
  readonly capabilities: DriverCapabilities;
  connect(): MaybePromise<void>;
  close(): MaybePromise<void>;
  find(namespace: string, query: QueryNode, options?: FindOptions): MaybePromise<FindResultEntry[]>;
  update(key: string, mutator: UpdateMutator): MaybePromise<boolean>;
  getSchemaTable?<Columns>(name: string, schema?: TableSchema<Columns>): MaybePromise<SchemaTableDriver<unknown, Columns>>;
  raw?<T = unknown>(): T;
}
```

### 3.3 `SchemaTableDriver` (物理列驱动契约，`src/drivers/types.ts`)
```ts
export interface SchemaTableDriver<Value = JsonValue, Columns = Record<string, unknown>> {
  readonly schema: TableSchema<Columns>;
  setRecord(key: string, value: string, columns: Record<string, unknown>, ttlMs?: number): MaybePromise<void>;
  getRecord(key: string): MaybePromise<{ key: string; value: string; columns: Record<string, unknown>; expiresAt?: number } | undefined>;
  delete(key: string): MaybePromise<boolean>;
  clear(): MaybePromise<void>;
  find(where: QueryNode, options?: FindOptions): MaybePromise<Array<{ key: string; value: string; columns: Record<string, unknown> }>>;
}
```

---

## 4. 关键数据流 (Data Flows)

### 4.1 普通 KV 写入与读取
1. **写入 (`set`)**：
   - 用户入参经过插件钩子 (`beforeSet`)。
   - `core/serializer.ts` 规范序列化为 canonical JSON 字符串。
   - `core/key.ts` 将命名空间拼装为物理 key（`<prefix><namespace>:<key>`）。
   - 写入底座 `Driver`（附带 TTL）。
   - 若配置了关联 `Cache`，写穿/失效缓存。
   - 触发插件钩子 (`afterSet`)。
2. **读取 (`get`)**：
   - 优先查关联 `Cache`（如有），命中则反序列化返回。
   - 未命中则调用 `Driver.get(physicalKey)`。
   - 若值过期则清理并返回 `undefined`；若有效则反序列化并回填 `Cache`。

### 4.2 物理 Schema Table 数据流
1. **表初始化/打开**：
   - 用户调用 `db.table<V, C>("blocks", { schema })`。
   - 驱动检查 Schema Registry（`kvdb_schema_registry` 表/collection）。
   - 若不存在：创建物理表 `kvdb_schema_blocks_<hash>`，创建固定列（`key`, `value`, `expires_at`, `created_at`, `updated_at`）、自定义物理列与索引，保存 registry。
   - 若已存在：比对 schema，不匹配则抛出 `KvdbConfigError`。
   - 后续调用 `db.table("blocks")` 无参数时自动从 registry 读取已保存的 schema。
2. **记录写入 (`setRecord`)**：
   - 检查 columns 字段合法性与必需列校验。
   - 真实列作为独立数据库列写入，其余非列数据序列化为 canonical JSON 存入 `value` 列。
3. **混合查询 (`find`)**：
   - 支持结构化过滤：`where: { columns: { status: "active" }, value: { "profile.age": { $gt: 18 } } }`。
   - Parser 生成带 `sourceKind: "column" | "value"` 的统一 AST。
   - Dialect 根据字段来源生成 SQL 列匹配或 JSON 路径提取（如 SQLite `status = ?` vs `json_extract(value, '$.profile.age') > ?`）。

---

## 5. 错误处理体系

所有错误均派生自 `KvdbError`，具备清晰的分类判断：

```text
KvdbError
├── KvdbConnectionError      # 数据库连接或凭证错误
├── KvdbTimeoutError         # 操作超时
├── KvdbKeyError             # 非法 Key 命名（例如包含未转义冒号）
├── KvdbQueryError           # 查询操作符语法或 AST 错误
├── KvdbSchemaError          # 列类型错误、缺少必填字段、非法 Schema
├── KvdbConfigError          # Schema 不匹配、配置冲突
├── KvdbUnsupportedError     # 底层后端不支持某操作（capabilities 不满足）
└── KvdbTransactionError     # 事务冲突或回滚失败
```
