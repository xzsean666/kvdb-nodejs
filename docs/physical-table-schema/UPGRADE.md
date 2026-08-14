# 真实物理列表升级说明

> 状态：Step 1/2 设计与文档完成，Step 4 实现尚未开始。
> 本文是后续实现的架构与验收基线。这里的“列”指真实数据库列，不是放在 `value` 中的 JSON 字段。

## 1. 背景

当前 SDK 是统一的 KV 存储：

```text
key -> value(JSON text)
```

SQLite 和 PostgreSQL 当前使用一张共享物理表，MongoDB 当前使用一个共享 collection。`db.table("users")` 目前是 namespace handle，不会创建一张独立的业务表。

新需求要求：

- 创建 table 时声明额外字段及字段类型；
- 额外字段必须是数据库中的真实列/文档字段；
- 可以为字段创建索引，包括联合索引；
- 后续仍然只按 table 名调用 `db.table("blocks")` 重新打开；
- 查询 API 要跨 SQLite、PostgreSQL、MongoDB 通用；
- 没有自定义字段时，行为仍然是普通 KV 表。

## 2. 目标与非目标

### 2.1 目标

1. 保留现有 `db.table("name")` 获取表句柄的习惯。
2. schema table 映射到独立的物理表或 MongoDB collection。
3. 保留固定列 `key`、`value`、过期和审计字段。
4. 允许任意数量的用户自定义物理列。
5. 统一声明列类型、可空性、默认值、单列索引和联合索引。
6. `find` 使用统一 AST，区分物理列和 `value` 内 JSON 路径。
7. 老的普通 KV 表继续可用，不被静默转换。

### 2.2 非目标

- 不在本次升级中实现自动删除列或自动改变列类型。
- 不把每次 `set` 缺失字段都变成隐式 DDL。
- 不支持任意 SQL 片段直接拼接到 schema、where 或 index 名称中。
- 不新增 Redis/MySQL 等后端。
- 不改变现有 Cache 的最低层 `KVStore` 契约。

## 3. 核心架构决策

### KD-P1：物理表按 table 名隔离

每一个 schema table 有独立的物理表/collection：

```text
logical name: blocks
SQLite/PG:    <safe physical table name for blocks>
MongoDB:      <safe collection name for blocks>
```

当前共享 `kvdb_kv` 仍用于普通 KV namespace。不能在共享表中为某个 namespace 动态增加列，因为那会把局部 schema 变成全局 schema。

### KD-P2：`db.table()` 负责创建或重新打开

首次提供 schema 并执行第一次操作时：

1. 连接后查找 table schema registry；
2. 记录不存在时创建物理表/collection、字段和索引；
3. 记录存在时校验声明 schema 与已保存 schema；
4. schema 不一致时抛配置/迁移错误，不自动改表。

后续进程只需：

```ts
const blocks = db.table<BlockValue, BlockColumns>("blocks");
```

运行时 schema 从 registry/物理数据库读取，TypeScript 泛型仍由调用方提供以获得编译期类型。

### KD-P3：schema table 与普通 KV table 明确区分

- `db.table("cache")` 且没有 schema：普通 KV 表行为。
- `db.table("blocks", { schema: ... })`：schema table 行为。
- 已存在 schema table 时不能使用空 schema 将其降级为普通 KV 表。
- 已存在普通 KV namespace 时，不能通过同名 schema 声明静默转换；转换必须是显式迁移。

### KD-P4：列类型使用跨后端逻辑类型

首期类型：

| 逻辑类型 | SQLite | PostgreSQL | MongoDB | 说明 |
|---|---|---|---|---|
| `string` | `TEXT` | `TEXT` | string | UTF-8 字符串 |
| `integer` | `INTEGER` | `BIGINT` | BSON int/int64 | JS API 先限制为安全整数 |
| `number` | `REAL` | `DOUBLE PRECISION` | double | 有限数值 |
| `boolean` | `INTEGER` 0/1 | `BOOLEAN` | boolean | 统一布尔语义 |
| `json` | `TEXT` | `JSONB` 或等价 JSON 存储 | object/array/scalar | 仅在明确需要时使用 |

首期不引入跨后端语义不一致的 `Date` 和 JS `bigint`。时间使用 `integer` epoch milliseconds 或 `string` ISO-8601；超过 JS 安全整数范围的链上编号使用 `string`，除非后续单独设计 bigint API。

### KD-P5：索引声明是 schema 的一部分

单列索引：

```ts
blocknumber: { type: "integer", nullable: false, index: true }
```

需要唯一约束或自定义名称时：

```ts
chainId: {
  type: "string",
  nullable: false,
  index: { name: "blocks_chain_id_uq", unique: true }
}
```

联合索引：

```ts
indexes: [
  {
    name: "blocks_chain_block_idx",
    columns: ["chainId", "blocknumber"]
  }
]
```

索引创建必须幂等。首期只支持普通 B-tree/等价 Mongo compound index；部分索引、表达式索引和全文索引暂不进入统一 schema，可通过 `raw()` 逃生。

## 4. 对外 API 设计

以下是契约示意，具体 TypeScript 名称以实现前更新后的 `docs/SPEC.md` 为准。

### 4.1 类型定义

```ts
type PhysicalColumnType = "string" | "integer" | "number" | "boolean" | "json";

interface ColumnIndexOptions {
  name?: string;
  unique?: boolean;
}

interface ColumnDefinition {
  type: PhysicalColumnType;
  nullable?: boolean;
  default?: JsonValue;
  index?: boolean | ColumnIndexOptions;
}

interface TableIndexDefinition {
  name?: string;
  columns: string[];
  unique?: boolean;
}

interface TableSchema<Columns extends Record<string, unknown>> {
  columns: { [Name in keyof Columns]-?: ColumnDefinition };
  indexes?: TableIndexDefinition[];
  version?: number;
}
```

### 4.2 创建/打开

```ts
interface BlockColumns {
  blocknumber: number;
  chainId: string;
  timestamp?: number;
}

const blocks = db.table<BlockValue, BlockColumns>("blocks", {
  schema: {
    columns: {
      blocknumber: { type: "integer", nullable: false, index: true },
      chainId: { type: "string", nullable: false, index: true },
      timestamp: { type: "integer", nullable: true }
    },
    indexes: [
      { name: "blocks_chain_block_idx", columns: ["chainId", "blocknumber"] }
    ]
  }
});
```

没有自定义字段时：

```ts
const cache = db.table("cache");
await cache.set("k", { value: 1 });
```

重新打开已有 schema table：

```ts
const blocks = db.table<BlockValue, BlockColumns>("blocks");
const row = await blocks.getRecord("tx-1");
```

`get` 继续只返回 value 以保持兼容；`getRecord` 返回完整行：

```ts
{
  key: "tx-1",
  columns: { blocknumber: 12345, chainId: "ethereum" },
  value: {...}
}
```

### 4.3 写入

```ts
await blocks.set("tx-1", payload, {
  columns: {
    blocknumber: 12345,
    chainId: "ethereum",
    timestamp: 1720000000
  }
});
```

规则：

- `nullable: false` 且无 default 的列必须提供；
- `nullable: true` 的列可以省略并写入 `NULL`/缺失等价状态；
- default 由后端或 SDK 在插入时应用，但跨后端结果必须一致；
- 更新 value 与 columns 必须是同一条记录的一个原子写入；
- `setMany` 必须支持同一 schema 校验和批量事务/批量写入；
- TTL 仍作用于整条记录，不作用于单个列。

### 4.4 通用查询

物理列和 value JSON 使用同一个查询入口，显式区分来源：

```ts
const rows = await blocks.find({
  where: {
    columns: {
      blocknumber: { $gte: 10000 },
      chainId: "ethereum"
    },
    value: {
      "receipt.status": 1
    }
  },
  sort: [
    { source: "column", path: "blocknumber", direction: "desc" }
  ],
  limit: 50
});
```

统一操作符继续使用现有集合：`$eq`、`$ne`、`$gt`、`$gte`、`$lt`、`$lte`、`$in`、`$nin`、`$exists`、`$and`、`$or`、`$nor`、`$not`。

现有写法：

```ts
where: { "profile.age": { $gt: 18 } }
```

继续表示 `value.profile.age`，不破坏现有 API。新 AST 增加 field source：`column` 或 `value`。物理列名必须来自已加载 schema，不能把用户输入直接拼接成 SQL identifier。

## 5. 物理存储

### 5.1 SQLite/PostgreSQL

每个 schema table 生成自己的物理表，固定列概念如下：

```text
key          primary key
<custom>     schema declared physical columns
value        canonical JSON text, not nullable
expires_at   nullable absolute epoch milliseconds
created_at   creation timestamp
updated_at   update timestamp
```

真实 SQL 类型由逻辑类型映射产生。表名、列名、索引名必须经过 schema 校验和安全 identifier quoting。不能依赖参数占位符替换 identifier。

### 5.2 MongoDB

每个 schema table 对应一个 collection/document shape：

```json
{
  "_id": "tx-1",
  "blocknumber": 12345,
  "chainId": "ethereum",
  "timestamp": 1720000000,
  "value": "{...}",
  "expiresAt": null
}
```

Mongo 的 collection validator 和 index 应由同一份 schema 驱动。`_id` 是固定 key，不允许用户列覆盖。

### 5.3 Schema registry

需要一个内部 registry 保存：

```text
logical table name
provider / physical name
schema JSON
schema version
created_at / updated_at
```

registry 本身不能依赖用户自定义列。打开 table 时先查 registry，再加载物理结构。物理表名可以使用安全名称或稳定 hash，避免任意 namespace 字符进入 SQL identifier。

## 6. 迁移与兼容

新增/改变 schema 必须显式迁移：

```ts
await db.alterTable("blocks", {
  add: {
    confirmations: {
      type: "integer",
      nullable: true,
      index: true
    }
  }
});
```

首期允许：

- add nullable column；
- add column with compatible default；
- add/drop index；
- add non-unique/unique index（唯一性冲突必须报错）。

首期不自动执行：

- drop column；
- 改变已有列类型；
- 重命名列；
- 将 nullable 列直接改成 required；
- 自动把现有 `kvdb_kv` 数据转换为 schema table。

所有迁移应记录版本，并在失败时保持可诊断的错误信息。普通 KV 表继续使用现有 Driver 路径。

## 7. 模块影响

保持 `KVStore` 最小契约不变，在富层新增/扩展 schema table 契约：

```text
src/core/table.ts              schema-aware Table facade
src/core/kvdb.ts               table registry / table handle lifecycle
src/core/table-schema.ts       schema types and validation
src/core/table-registry.ts     logical-to-physical table metadata
src/drivers/types.ts           schema table and migration contracts
src/drivers/sqlite/*           physical table DDL and SQL compiler
src/drivers/postgres/*         physical table DDL and SQL compiler
src/drivers/mongodb/*          collection validator and indexes
src/query/ast.ts               field source: column/value
src/query/parser.ts            namespaced query parsing
src/query/compiler.ts          identifier-safe physical column rendering
src/plugins/types.ts           write/read payload includes columns
src/cache/*                    full-record cache invalidation if enabled
test/compliance/*              shared physical-table contract suite
```

不要把 schema table 的 DDL、物理列和迁移能力塞进 Cache 的 `KVStore`。

## 8. 错误语义

至少需要这些可判别错误：

- schema table 不存在且未提供 schema；
- table 类型冲突（普通 KV vs schema table）；
- schema 版本或字段定义不匹配；
- 未声明的列被写入或查询；
- 类型不匹配；
- required/non-null 列缺失；
- 非法 table/column/index identifier；
- unique index 创建时已有重复数据；
- 不支持的迁移操作。

## 9. 验收标准

1. SQLite 中能创建带 `blocknumber`、`chainId` 等真实列的 table。
2. PostgreSQL 和 MongoDB 具有等价的 schema table 行为。
3. `db.table("blocks")` 能在新进程中按 registry 重新打开已有 table。
4. 无 schema 的 table 继续通过原有 KV API 工作。
5. 单列索引和联合索引在三后端创建且幂等。
6. 物理列查询与 value JSON 查询可在同一个 `find` 中组合。
7. 缺字段、错类型、schema 冲突和非法 identifier 都有明确错误。
8. `set`、`setMany`、`update`、TTL、clear、prefix 和 find 的行为有跨后端合规测试。
9. 现有 96 个单测及现有 SQLite 合规测试不回归。
10. 本功能实现前先更新 `docs/SPEC.md`、`docs/ARCHITECTURE.md`、`docs/BUILD.md` 和 `docs/nextsession.md`。
