# ARCHITECTURE.md — KVDB SDK 系统架构(Step 1 产出)

> 本文件是 Step 1 的强制产出:**只描述架构,不含实现代码**。
> 所有签名均为"契约示意",用于界定模块边界与数据流,真正实现见 Step 4。

---

## 1. 设计目标与约束回顾

| 目标 | 架构含义 |
|---|---|
| 极简 API | 三层对象:`KVDB` → `Table` → CRUD/Query,用户只面对少量方法 |
| 多数据库支持 | 后端走 **Driver 适配器**,核心不感知具体数据库 |
| 高性能读写 | 同步 SQLite(better-sqlite3)、批量优化、自动索引、低延迟内存缓存 |
| JSON 存储与查询 | 值统一存为 **canonical text JSON**;查询走 **统一 IR/AST → 每后端下降** |
| 内置 Cache 系统 | Cache 为**独立模块**,可单用也可集成进 KVDB |
| 装饰器缓存 | TC39 装饰器,委托给 Cache 的 `wrap()` 引擎 |
| 易扩展易升级 | Plugin / Hook / Middleware + 能力标志,API 长期稳定 |
| 完整 TS 支持 | 值形状用 phantom 类型携带,`InferValue` 推导 |

---

## 2. 关键设计决策(Key Design Decisions)

> 这些决策是架构的"宪法",修改需在 `nextsession.md` 记录理由。调研依据见 `docs/EXTERNAL-DOCS.md`。

### KD-1. 双层契约分离:`KVStore` 与 `Driver` 不合并
- **最低层 `KVStore`**:Map 超集 + TTL,只有 `get/set/delete/has/clear/*Many/iterator`。用于 Cache 后端,也是 KV 语义的最小公约(借鉴 **keyv**)。
- **富层 `Driver`**:在 KVStore 之上加 **JSON 查询、prefix、索引、能力标志**(借鉴 **Prisma driver adapter**)。
- **理由**:把"简单 KV 缓存"和"可查询数据存储"两个职责彻底分开,避免最低公分母陷阱;Cache 不必背负查询能力,Driver 不必背负缓存策略。

### KD-2. 查询用统一 IR/AST,每后端用 visitor 下降
- 用户写 Mongo 风格查询文档 → `parser` 产出后端无关的 **AST** → 每后端 `compiler` 把 AST 下降为原生查询(SQLite `json_extract`/`->>`,PostgreSQL `jsonb`/`@>`,MongoDB 原生)。
- **理由**:避免每个驱动各写一套查询翻译;避免 SQL 字符串往返;新增后端只需实现一个 visitor。

### KD-3. 值的规范形态 = text JSON(canonical JSON)
- 写入时统一序列化为文本 JSON,由各后端自行 ingest;**不**把 Postgres 的二进制 jsonb 运到 SQLite。
- **理由**:跨后端可移植、序列化逻辑集中在一层(per-backend codec)。

### KD-4. Cache 用分层 stores 模型
- `Cache({ stores: [memory, sqliteMemory, sqliteFile] })`,写入各层、读取从最高优先级命中(借鉴 **cache-manager v7**)。
- 提供 `wrap(key, fn, { ttl, refreshThreshold })`,支持 stale-while-revalidate。
- **理由**:装饰器、查询缓存、热数据缓存全部复用同一引擎。

### KD-5. TC39 标准装饰器(TS 5.x 原生)
- 不用 legacy `experimentalDecorators`(签名不兼容,正在淘汰)。
- key 默认 = `构造函数名 + 方法名 + stableSerialize(args)`,提供 `CacheKeyBuilder` 覆盖与 `CacheableKey` 逃生接口。

### KD-6. 永不自己实现连接池;能力标志允许后端退出关系型假设
- 池属于底层 driver,透传其配置。MongoDB 用连接串内部池,可声明 `managesOwnPool: true`。
- 能力标志(`nativeTtl` / `jsonQuery` / `supportsTransactions` …)让核心据此选择委托原生还是 fallback 模拟。

### KD-7. 约定:`undefined` 不存储
- `set(key, undefined)` 等价于 `delete`;cache miss 返回 `undefined`(对齐 lru-cache / cache-manager v7 约定)。

### KD-8. 最高价值实践:跨后端合规测试套件(不 mock DB)
- 一套适配器合规测试,**每个后端都必须跑通真实数据库**。这是防止抽象泄漏的核心手段。

---

## 3. 模块分解(认知驱动拆分)

> 拆分依据:**每个目录/文件能否被 AI 孤立理解**。每个模块标注 职责 / 输入 / 输出 / 依赖。

```text
src/
  index.ts                 # 唯一公开入口:导出 KVDB / Cache / 装饰器 / 公开类型

  core/                    # 用户面对的对象层(不感知具体数据库)
    kvdb.ts                # KVDB 实例:连接、driver 管理、prefix、cache 配置
    table.ts               # Table/Namespace 实例:CRUD + Query 的门面
    serializer.ts          # canonical JSON text 编解码(KD-3)
    key.ts                 # prefix / namespace key 解析(集中在此一层)
    errors.ts              # 错误类型(显式、可判别)

  drivers/                 # 富层 Driver 契约 + 各后端实现
    types.ts               # Driver / DriverFactory / Capabilities 契约(KD-1, KD-6)
    sqlite/                # better-sqlite3 实现(+ node:sqlite 版本门控适配)
    postgres/              # pg / jsonb 实现
    mongodb/               # mongodb 原生实现

  query/                   # 统一查询编译器(KD-2)
    ast.ts                 # 查询 IR/AST 节点类型(后端无关)
    parser.ts              # Mongo 风格查询文档 -> AST
    compiler.ts            # AST -> 后端原生(visitor 接口)
    operators.ts           # 操作符表($eq/$gt/$in/$exists/…)

  cache/                   # 独立 Cache 子系统(KD-4)
    cache.ts               # Cache 门面:分层 stores、wrap()
    types.ts               # KVStore 契约(最低层,KD-1)
    stores/
      memory-store.ts      # lru-cache v11
      sqlite-memory-store.ts
      sqlite-file-store.ts

  decorators/              # 装饰器缓存(KD-5)
    cacheable.ts           # @Cacheable —— 委托 cache.wrap()
    cache-clear.ts         # @CacheClear
    cache-key.ts           # 参数 -> 稳定 key 生成

  plugins/                 # 扩展系统
    types.ts               # Plugin / Hook / Middleware 契约
    runtime.ts             # 生命周期钩子的注册与触发

  types/
    index.ts               # 公开类型 + 推导工具(InferValue 等)

test/
  compliance/              # 跨后端合规套件(KD-8),对真实 DB 运行
```

### 模块定义表

| 模块 | 职责(一件事) | 输入 | 输出 | 依赖 |
|---|---|---|---|---|
| `core/kvdb.ts` | 管理一个数据库实例的生命周期与配置 | `KVDBOptions` | `KVDB` 实例,可生成 `Table` | `drivers/types`, `cache/cache`, `core/key` |
| `core/table.ts` | 在某 namespace 下提供 CRUD/Query 门面 | namespace 名 | CRUD/Query 方法 | `drivers/types`, `query/*`, `core/serializer` |
| `core/serializer.ts` | 值 ↔ canonical text JSON | 任意 JSON 值 | 字符串 / 还原值 | 无 |
| `drivers/types.ts` | 定义 Driver 契约与能力标志 | — | 类型 | 无 |
| `drivers/<backend>` | 把契约落到具体数据库 | SQL/驱动调用 | 行/文档 | 对应 npm 驱动 |
| `query/parser.ts` | 查询文档 → AST | 查询对象 | AST | `query/ast` |
| `query/compiler.ts` | AST → 后端查询 | AST + 后端 visitor | 原生查询/参数 | `query/ast`, `query/operators` |
| `cache/cache.ts` | 分层缓存 + wrap | `CacheOptions` | get/set/wrap | `cache/types`, `cache/stores/*` |
| `cache/stores/*` | 单一存储后端实现 KVStore | KVStore 调用 | 值 | lru-cache / better-sqlite3 |
| `decorators/cacheable.ts` | 缓存方法结果 | 装饰器选项 | 包装后的方法 | `cache/cache`, `decorators/cache-key` |
| `plugins/runtime.ts` | 注册/触发生命周期钩子 | Plugin | 钩子调用 | `plugins/types` |

---

## 4. 数据流(Data Flow)

### 4.1 写入路径 `users.set("u1", { profile: { age: 20 } })`
```text
Table.set(key, value)
  → core/key:        解析为带 prefix/namespace 的物理 key
  → core/serializer: value → canonical text JSON
  → plugins/runtime: 触发 beforeWrite 钩子(可改写)
  → Driver.set(physicalKey, jsonText, ttl?)
        ├─ 后端原生 TTL?  → 交给后端(KD-6 能力标志)
        └─ 无原生 TTL?    → 存 { value, expires } 由 SDK 包装
  → plugins/runtime: 触发 afterWrite 钩子
  → (若配置了 cache 且为写穿策略) 失效/更新相关 cache key
```

### 4.2 查询路径 `users.find({ where: { "profile.age": { $gt: 18 } } })`
```text
Table.find(queryDoc)
  → query/parser:   queryDoc → AST
  → (可选) cache:    以 AST 的稳定哈希为 key 查 Query Cache
  → query/compiler: AST + 当前后端 visitor → 原生查询
        ├─ SQLite:   json_extract(value,'$.profile.age') > 18  (+ 表达式索引)
        ├─ Postgres: ((value->>'profile')::jsonb->>'age')::numeric > 18 / jsonb 路径
        └─ MongoDB:  { "profile.age": { $gt: 18 } } 原生
  → Driver 执行 → 行/文档
  → core/serializer: text JSON → 还原值
  → (可选) 写入 Query Cache
  → 返回结果
```

### 4.3 装饰器缓存路径 `@Cacheable() async getUser(id)`
```text
调用 getUser(id)
  → decorators/cache-key: (类名 + 方法名 + stableSerialize([id])) → key
  → cache.wrap(key, () => 原方法(id), { ttl, refreshThreshold })
        ├─ 命中且未过期        → 返回缓存值
        ├─ 命中但低于刷新阈值  → 返回旧值 + 异步刷新(SWR)
        └─ 未命中              → 执行原方法 → 写各层 store → 返回
```

### 4.4 三层对象关系
```text
KVDB 实例  (连接 / driver / prefix / cache 配置)
    │  db.table("users")
    ▼
Table / Namespace 实例  (业务隔离 / 独立缓存策略)
    │
    ▼
CRUD / Query  (set/get/delete/find/getByPrefix/...)
```

---

## 5. 核心契约示意(仅签名,非实现)

> 放在此处是为了**界定边界**。实现时这些会落到 `src/**/types.ts`。

### 5.1 最低层 `KVStore`(Cache 后端 + KV 语义最小公约,KD-1)
```ts
interface KVStore {
  get(key: string): MaybePromise<RawEntry | undefined>;
  set(key: string, value: RawEntry, ttlMs?: number): MaybePromise<void>;
  delete(key: string): MaybePromise<boolean>;
  has(key: string): MaybePromise<boolean>;
  clear(): MaybePromise<void>;
  // 批量(可选,缺失时由核心循环回退)
  getMany?(keys: string[]): MaybePromise<(RawEntry | undefined)[]>;
  setMany?(entries: KVEntry[]): MaybePromise<void>;
  deleteMany?(keys: string[]): MaybePromise<number>;
  iterator?(prefix?: string): AsyncGenerator<[string, RawEntry]>;
}
```

### 5.2 富层 `Driver` + 能力标志(KD-1, KD-6)
```ts
interface DriverCapabilities {
  nativeTtl: boolean;
  jsonQuery: "sqlite-json" | "pg-jsonb" | "mongo" | "none";
  managesOwnPool: boolean;
  supportsTransactions: boolean;
  supportsPrefixScan: boolean;
}

interface DriverFactory {
  readonly provider: "sqlite" | "postgres" | "mongodb";
  readonly capabilities: DriverCapabilities;
  connect(): Promise<Driver>;          // 延迟建连(借鉴 Prisma factory)
}

interface Driver extends KVStore {
  getByPrefix(prefix: string): MaybePromise<KVEntry[]>;
  deleteByPrefix(prefix: string): MaybePromise<number>;
  find(ast: QueryNode, options?: FindOptions): MaybePromise<KVEntry[]>;
  ensureIndex(jsonPath: string): MaybePromise<void>;
  raw(): unknown;                      // 原生句柄逃生通道(避免最低公分母陷阱)
  close(): Promise<void>;
}
```

### 5.3 查询 AST(后端无关,KD-2)
```ts
type QueryNode =
  | { kind: "and" | "or" | "nor"; children: QueryNode[] }
  | { kind: "not"; child: QueryNode }
  | { kind: "cmp"; op: CompareOp; path: FieldPath; value: Json }
  | { kind: "exists"; path: FieldPath; value: boolean }
  | { kind: "elemMatch"; path: FieldPath; child: QueryNode };

type FieldPath = { segments: (string | { index: number })[] };
type CompareOp = "$eq" | "$ne" | "$gt" | "$gte" | "$lt" | "$lte" | "$in" | "$nin";

interface BackendVisitor {              // 每后端实现一个
  renderPath(path: FieldPath): string;  // a.b.c → '$.a.b.c' / '{a,b,c}'
  renderCompare(op: CompareOp, pathSql: string, value: Json): CompiledFragment;
  coerce(value: Json): unknown;         // 数值比较的类型强转
}
```

### 5.4 Cache 门面(KD-4)
```ts
interface CacheOptions { stores: KVStore[]; defaultTtlMs?: number; }

interface Cache {
  get<V>(key: string): Promise<V | undefined>;
  set<V>(key: string, value: V, ttlMs?: number): Promise<void>;
  delete(key: string): Promise<boolean>;
  clear(): Promise<void>;
  wrap<V>(key: string, fn: () => Promise<V>,
          opts?: { ttlMs?: number; refreshThreshold?: number }): Promise<V>;
}
```

### 5.5 插件 / 钩子(扩展系统)
```ts
type HookName =
  | "beforeWrite" | "afterWrite"
  | "beforeRead"  | "afterRead"
  | "beforeQuery" | "afterQuery";

interface Plugin {
  name: string;
  setup(context: PluginContext): void;   // 注册钩子 / 中间件 / 自定义 driver / cache driver
}
```

---

## 6. 性能策略(映射到模块)

| 目标 | 落点 |
|---|---|
| 高吞吐读写 | SQLite 用同步 better-sqlite3;批量走 `*Many`;重活下放 worker thread |
| 快速 JSON 查询 | AST→原生 + 热路径自动生成表达式索引(`ensureIndex`) |
| 批量优化 | Driver 实现原生批量,缺失时核心回退循环 |
| 低延迟缓存 | lru-cache v11 内存层 + 分层命中 + SWR |
| 自动索引 | 记录高频 JSON path,达到阈值时建表达式/GIN 索引 |

---

## 7. 可扩展性如何保证 API 稳定

- **新增后端**:实现 `DriverFactory` + 一个 `BackendVisitor`,跑通合规套件即可,核心零改动。
- **自定义 Cache 后端**:实现 `KVStore` 即可塞进 `stores: [...]`。
- **行为扩展**:通过 Plugin 注册 Hook/Middleware,不改核心。
- **能力演进**:新能力先加 `capabilities` 标志,旧后端声明不支持即可,API 不破坏。

---

## 8. 下一步

架构已定。Step 2 的 `SPEC.md` / `BUILD.md` 与 Step 3 的 `nextsession.md` 已产出。
进入 Step 4(实现)前需用户批准,建议的实现顺序见 `docs/nextsession.md`。
