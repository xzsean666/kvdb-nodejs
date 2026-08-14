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
- `wrap(key, fn, { ttlMs, refreshThreshold })`:memoize + stale-while-revalidate。

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

## 14. Schema table（真实物理列）

`db.table<Value, Columns>(name, { schema })` 创建按逻辑名管理的 schema table。首次实际操作创建独立物理 table/collection；后续 `db.table(name)` 从 registry 恢复 schema。无 schema 时仍使用普通 KV table；同名普通 KV 与 schema table 冲突不得静默转换。

列类型为 `string | integer | number | boolean | json`，定义支持 `nullable`、`default`、单列 `index`，表级支持联合索引和 `unique`。`key`、`value`、`expires_at`、`created_at`、`updated_at` 为保留字段。非法 identifier、schema 冲突、错类型、缺少 required 列和唯一冲突必须抛可判别错误。

```ts
const blocks = db.table<BlockValue, BlockColumns>("blocks", {
  schema: {
    columns: {
      blocknumber: { type: "integer", nullable: false, index: true },
      chainId: { type: "string", nullable: false },
      timestamp: { type: "integer", nullable: true },
    },
    indexes: [{ columns: ["chainId", "blocknumber"] }],
  },
});

await blocks.set("tx-1", payload, { columns: { blocknumber: 123, chainId: "eth" } });
const record = await blocks.getRecord("tx-1"); // { key, columns, value }
```

`get` 仍只返回 `value`。schema 变更必须调用显式 `db.alterTable(name, migration)`；首期允许新增 nullable/兼容 default 列及增删索引，禁止隐式改类型、重命名或删除列。

## 15. Schema 查询

```ts
await blocks.find({
  where: {
    columns: { blocknumber: { $gte: 10000 }, chainId: "eth" },
    value: { "receipt.status": 1 },
  },
  sort: [{ source: "column", path: "blocknumber", direction: "desc" }],
});
```

`where.columns` 查询真实列，`where.value` 查询 value JSON；旧的 dotted value path 保持兼容。columns/value 可混合组合，统一支持既有操作符、排序、分页和 TTL 语义。
