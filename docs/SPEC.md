# SPEC.md — KVDB SDK 系统规格(Step 2 产出)

> 本文件定义**对外契约与行为规格**:API 形态、数据模型、语义、边界条件。
> 它是实现(Step 4)的验收标准,也是合规测试套件的依据。
> 注意:以下代码块是**规格示意**,不是实现。

---

## 1. 数据模型

- **Key**:`string`。
- **Value**:任意可 JSON 序列化的值(对象 / 数组 / 标量)。规范存储形态为 **canonical text JSON**。
- **Entry**:`{ key, value, expiresAt?, createdAt?, updatedAt? }`。
- **TTL**:毫秒。`set` 时可指定;到期后 `get` 返回 `undefined`、`exists` 返回 `false`。
- **约定**:`set(key, undefined)` 等价于 `delete(key)`;不存储 `undefined`。

---

## 2. 实例创建

### 2.1 KVDB 实例
```ts
const db = new KVDB({
  driver: "postgresql",        // "sqlite" | "mongodb" | "postgresql"
  url: "postgres://...",       // 连接串(sqlite 用 file 路径)
  tablePrefix: "app_",         // 物理 key/表前缀,默认空
  cache: { driver: "sqlite-memory" }, // 可选,集成缓存
});
```
- 支持多实例并存(`db1` / `db2` 互不影响)。
- 连接为**延迟建立**(首次操作或显式 `db.connect()` 时)。
- `db.close()` 释放连接与资源。

### 2.2 Table / Namespace
```ts
const users = db.table("users");
const cache = db.table("cache");
```
- 业务隔离;可各自配置独立缓存策略:`db.table("users", { cache: {...} })`。
- 物理 key = `tablePrefix + namespace + ":" + key`(具体分隔策略见实现,集中在 `core/key.ts`)。

---

## 3. 基础操作

| 方法 | 签名 | 语义 |
|---|---|---|
| `set` | `set(key, value, opts?: { ttlMs?})` → `Promise<void>` | 写入/覆盖;`undefined` 即删除 |
| `get` | `get<V>(key)` → `Promise<V \| undefined>` | 未命中/过期返回 `undefined` |
| `delete` | `delete(key)` → `Promise<boolean>` | 是否删除了已存在的 key |
| `exists` | `exists(key)` → `Promise<boolean>` | 考虑 TTL |
| `clear` | `clear()` → `Promise<void>` | 清空当前 namespace |

---

## 4. 批量操作

| 方法 | 签名 | 语义 |
|---|---|---|
| `getMany` | `getMany<V>(keys[])` → `Promise<(V \| undefined)[]>` | 顺序对应输入 |
| `setMany` | `setMany(entries: {key,value,ttlMs?}[])` → `Promise<void>` | 原生批量优先,回退循环 |
| `deleteMany` | `deleteMany(keys[])` → `Promise<number>` | 返回删除数 |

---

## 5. Prefix 操作

| 方法 | 签名 | 语义 |
|---|---|---|
| `getByPrefix` | `getByPrefix<V>(prefix)` → `Promise<{key,value}[]>` | 命名空间内前缀扫描 |
| `deleteByPrefix` | `deleteByPrefix(prefix)` → `Promise<number>` | 返回删除数 |

> 后端通过 `capabilities.supportsPrefixScan` 声明能力;不支持的后端由核心用 `iterator` 回退。

---

## 6. JSON 查询

### 6.1 查询文档(Mongo 风格)
```ts
const adults = await users.find({
  where: {
    "profile.age": { $gt: 18 },        // 嵌套路径 + 比较
    status: "active",                  // 等值
    $or: [{ vip: true }, { credits: { $gte: 100 } }],
  },
  limit: 50,
  sort: [{ path: "profile.age", dir: "desc" }],
});
```

### 6.2 支持的操作符(v1)
- 比较:`$eq` `$ne` `$gt` `$gte` `$lt` `$lte` `$in` `$nin`
- 存在:`$exists`
- 逻辑:`$and` `$or` `$nor` `$not`
- 数组:`$elemMatch`(后续 `$all` `$size`)

### 6.3 跨后端语义保证(必须在合规测试中验证)
- **缺失 vs NULL**:`$exists:false` 与 `$ne` 在 SQLite/Postgres 用显式 `IS [NOT] NULL` 翻译,语义对齐 Mongo。
- **数值比较**:JSON 取出的文本在比较前强制类型转换。
- **结果形状**:所有后端返回 `{ key, value }[]`,`value` 已还原为原始 JSON 值。

---

## 7. TTL / 索引 / 过期

- **TTL**:有原生 TTL 的后端(Mongo TTL index 等)委托原生;无的(SQLite/PG)由 SDK 存 `expiresAt` 并在读取时判定 + 后台清理。
- **索引**:`table.ensureIndex("profile.age")` 在对应后端建表达式/GIN 索引;高频 path 可由插件自动建。
- **自动过期**:惰性(读时判定)+ 周期清理,二者结合。

---

## 8. Cache 系统

### 8.1 独立使用
```ts
const cache = new Cache({ driver: "sqlite-memory" });
// 或多层
const cache = new Cache({ stores: ["memory", { driver: "sqlite", file: "./cache.db" }] });

await cache.set("k", v, { ttlMs: 60_000 });
await cache.get("k");        // miss → undefined
await cache.delete("k");
await cache.clear();
```
- 后端:`memory`(lru-cache) / `sqlite-memory` / `sqlite`(file)。
- `wrap(key, fn, { ttlMs, refreshThreshold })`: memoize + stale-while-revalidate，并内置**并发未命中合并保护（In-flight Miss Collapsing）**：对同一冷缓存 Key 的高并发请求自动合并，底层 `fn` 仅执行一次，彻底杜绝缓存击穿与惊群效应（Thundering Herd）。

### 8.2 集成进 KVDB
```ts
const db = new KVDB({ driver: "postgresql", url, cache: { driver: "sqlite-memory" } });
```
- 用途:Query Cache、热数据缓存、Read Cache、Prefix Cache。
- 失效策略:写穿(写时失效相关 key);Query Cache 以 AST 稳定哈希为 key。

---

## 9. 装饰器缓存(TC39)

```ts
class UserService {
  @Cacheable({ ttlMs: 30_000 })
  async getUser(id: string) { /* ... */ }

  @Cacheable({ store: sqliteCache, cacheKey: (args) => `user:${args[0]}` })
  async fetchData(id: string) { /* ... */ }

  @CacheClear({ cacheKey: (args) => `user:${args[0]}` })
  async updateUser(id: string, patch: object) { /* ... */ }
}
```
- **key 生成**:默认 `类名 + 方法名 + stableSerialize(args)`;可用 `cacheKey` 覆盖;参数可实现 `CacheableKey { cacheKey: string }` 逃生接口。
- **稳定序列化**:处理对象 key 排序、`undefined`、拒绝/处理循环引用。
- **约束**:装饰器缓存必须有 TTL 或有界,禁止无界 memoize。

---

## 10. 扩展点

| 扩展 | 方式 |
|---|---|
| 自定义 Driver | 实现 `DriverFactory` + `BackendVisitor`,跑通合规套件 |
| 自定义 Cache Driver | 实现 `KVStore`,塞进 `stores: [...]` |
| Hook | `beforeWrite/afterWrite/beforeRead/afterRead/beforeQuery/afterQuery` |
| 中间件 | 包裹操作管线 |
| Plugin | `Plugin.setup(context)` 内注册以上各项 |

---

## 11. 错误与边界

- 所有错误为可判别的具名类型(如 `KvdbConnectionError` / `KvdbQueryError` / `KvdbSerializationError`)。
- 未连接时操作 → 抛 `KvdbConnectionError`(或自动延迟建连,二选一,实现时定稿并记入 nextsession)。
- 不支持的操作符 → `KvdbQueryError`,信息中含后端与操作符名。
- 循环引用值 → `KvdbSerializationError`。

---

## 12. TypeScript 支持

- `KVDB`/`Table` 泛型化值形状:`db.table<User>("users")` 使 `get` 返回 `User | undefined`。
- 值形状用 phantom 类型携带,提供 `InferValue<typeof table>`。
- 查询 `where` 的 path 在 v1 为字符串(后续可上 typed path)。

---

## 13. 不在 v1 范围(明确排除,避免投机抽象)

- Redis / MySQL / Cloud / Custom 远程后端(契约预留,实现延后)。
- typed JSON path 的编译期校验。
- 跨 namespace / 跨实例事务。
- 分布式缓存一致性协议。

## 14. 动态多键（Multi-Key）与物理 Schema Table

KVDB 支持通过 `db.table<Value, Keys>(name, { schema })` 定义与管理物理 Schema Table。底层在 SQLite、PostgreSQL、MongoDB 中自动创建物理表/集合，将主键与二级键映射为物理字段并挂载原生 B-Tree 索引，兼具 KV 的灵活性与物理关系的索引查询性能。

### 14.1 Schema 契约定义
```ts
interface MultiKeySchema<Keys, PKType> {
  // 物理主键定义（可选，默认 name: "key", type: "string"；支持 integer 自增/主键）
  primaryKey?: { name: string; type?: "string" | "integer" };
  // 二级键（物理列）定义
  keys: Record<string, {
    type: "string" | "integer" | "number" | "boolean" | "json";
    nullable?: boolean;
    default?: unknown;
    index?: boolean | { name?: string; unique?: boolean };
  }>;
  // 表级复合物理索引
  indexes?: Array<{
    name?: string;
    keys?: string[];
    columns?: string[];
    unique?: boolean;
  }>;
}
```

- **保留字段**：`value`、`expires_at`、`created_at`、`updated_at`；默认主键名为 `key`（若未自定义）。
- **兼容性**：`schema.columns` 与 `schema.keys` 互为别名完全等价；无 schema 的表仍为普通 KV 表，同名普通 KV 表与 schema 表禁止冲突。

### 14.2 写入与多键点查
```ts
// 方式 1：多键合一写入（当 keys 中包含主键名时）
await tokens.set({
  keys: { symbol: "ETH", address: "0x1234", chainId: "ethereum" },
  value: { name: "Ethereum", decimals: 18 },
  ttlMs: 3600_000,
});

// 方式 2：显式主键写入
await tokens.set("0x1234", { name: "Ethereum", decimals: 18 }, {
  keys: { symbol: "ETH", chainId: "ethereum" },
});

// 主键读取（仅返回 Value）
const val = await tokens.get("0x1234");

// 任意物理二级键高效点查（直接走物理 B-Tree 索引，返回首个匹配项的 Value）
const token = await tokens.getBy("symbol", "ETH");

// 读取完整物理记录
const record = await tokens.getRecord("0x1234");
// record: { key: "0x1234", keys: { symbol: "ETH", chainId: "ethereum" }, value: { ... } }
```

### 14.3 动态 Key 扩展与物理表自动演进（Zero-Downtime Evolution）
支持应用在运行期间零停机动态扩展键与索引：

```ts
// 1. 动态增加物理键（自动执行 ALTER TABLE ADD COLUMN / 索引创建）
await tokens.addKey("isL2", {
  type: "boolean",
  default: false,
  index: true,
});

// 2. 动态创建多列物理复合索引
await tokens.addIndex({
  keys: ["chainId", "isL2"],
  unique: false,
});
```
- **演进幂等**：重复添加同名 key 或同名/同列索引幂等安全，不抛异常。

### 14.4 原子局部更新与批量操作对齐
物理 Schema Table 具备与普通 KV Table 完全一致的 API 能力与生命周期集成：
- **原子局部更新（`Table.update`）**：在底层驱动独占锁（SQLite 立即事务 / Postgres `FOR UPDATE` / Mongo CAS 乐观锁重试循环）下原子执行读取、合并与持久化；自动保留现有 TTL，维护二级列数据，并同步更新独立点查缓存与触发 `afterWrite`。
- **批量操作（`getMany`, `setMany`, `deleteMany`）**：全面适配物理 Schema 表，自动进行多键批量校验、批量持久化与批量缓存清理。
- **缓存隔离机制**：Schema Table 的点查缓存键严格采用 `schema:${schemaName}:${key}` 命名空间，与普通表 `namespace:key` 完全物理隔离，杜绝跨表缓存污染。
- **全局过期数据清理**：`KVDB.purgeExpired()` 自动遍历 `kvdb_schema_registry` 中所有物理 Schema 表并统一清理过期数据。

### 14.5 安全防卫与演化安全规范
- **ANSI 标识符安全转义**：列名、主键名、索引名在 SQLite 和 PostgreSQL 下统一使用 ANSI 双引号转义 `"${ident}"`，全面支持 SQL 关键字列（如 `order`, `group`, `user`, `select`, `from`）作为物理列名。
- **原型链与保留字拦截**：严格阻止 `__proto__`, `prototype`, `constructor`, `_id` 以及大小写变体的系统保留字段用作键名。
- **查询路径白名单**：JSON 路径和列名字段强制进行 `/^[A-Za-z0-9_$-]+$/` 正则白名单校验，杜绝注入漏洞。
- **非空演化强制默认值**：在已有表中通过 `addKey` 增加非空列（`nullable: false`）时，强制要求指定 `default` 默认值，彻底避免因已有行导致 DDL 扩展失败与崩溃。

---

## 15. 动态多键与 Schema 查询

### 15.1 智能物理列路由
在 `table.find` 查询中，顶层 `where` 条件会自动识别已声明的物理主键与二级键。如果字段属于物理列，查询编译器自动将其编译为列级原生比较（例如 SQL 的 `symbol = ?`，Mongo 的顶层 `{ symbol: "..." }`），直接命中 B-Tree 物理索引；未声明的字段则降级为 JSON 字段路径提取。

```ts
// 直连多键查询（全量走物理索引）
const list = await tokens.find({
  where: {
    chainId: "ethereum",
    isL2: false,
  },
  sort: [{ path: "symbol", dir: "asc" }],
  limit: 20,
});
```

### 15.2 显式命名空间查询（高级混合查询）
亦支持通过 `columns` (或 `keys`) 与 `value` 进行混合过滤：
```ts
await tokens.find({
  where: {
    columns: { chainId: "ethereum" },            // 物理列过滤
    value: { "metrics.holders": { $gt: 1000 } }, // JSON 内部字段过滤
  },
  sort: [{ source: "column", path: "symbol", direction: "asc" }],
});
```

