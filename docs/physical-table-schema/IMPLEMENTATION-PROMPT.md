# 真实物理列表升级开发 Prompt

将下面的内容完整交给 Claude Sonnet 5 或 ChatGPT Terra（medium）执行。该 Prompt 面向实现阶段；当前仓库中的本次会话只生成文档，没有实现代码。

---

你是本项目 `kvdb-nodejs` 的实现工程师。请为 KVDB SDK 增加“按 table 名管理、带真实物理自定义列的 schema table”能力。

## 必读顺序

在任何命令或编辑前依次阅读：

1. 根目录 `AGENTS.md`；
2. `docs/nextsession.md`；
3. `docs/ARCHITECTURE.md`、`docs/SPEC.md`、`docs/BUILD.md`；
4. `docs/physical-table-schema/UPGRADE.md`；
5. `docs/physical-table-schema/TASKS.md`。

遵守 `AGENTS.md` 的 Step 1 → Step 2 → Step 3 → Step 4 协议。用户已经明确批准后才进入 Step 4；如果没有批准，继续停在文档阶段，不改源码。

## 用户需求

用户希望保留以下使用习惯：

```ts
const blocks = db.table<BlockValue, BlockColumns>("blocks", {
  schema: {
    columns: {
      blocknumber: { type: "integer", nullable: false, index: true },
      chainId: { type: "string", nullable: false },
      timestamp: { type: "integer", nullable: true }
    },
    indexes: [
      { columns: ["chainId", "blocknumber"] }
    ]
  }
});
```

第一次使用时按 schema 创建真实物理表；以后新进程仍然可以：

```ts
const blocks = db.table<BlockValue, BlockColumns>("blocks");
```

没有 schema 时仍是普通 KV 表：

```ts
const cache = db.table("cache");
```

## 强制架构要求

- 自定义字段必须是 SQLite/PostgreSQL 的真实列，或 MongoDB document 的真实字段；不得把它们全部塞进 `value` JSON。
- schema table 必须和普通共享 KV namespace 隔离；建议一个逻辑 table 映射一个物理 table/collection。
- `key`、`value`、TTL 和审计字段属于固定字段；用户列不能覆盖保留名。
- 列类型使用跨后端逻辑类型：`string`、`integer`、`number`、`boolean`、`json`。
- 列定义支持 `nullable`、`default`、`index`；表级支持联合索引和 `unique`。
- 索引创建幂等；identifier 必须白名单校验/安全 quoting，不能把用户输入直接拼接进 SQL。
- `db.table(name)` 第一次按 schema 创建或校验，之后按 registry/物理结构重新打开。
- schema 不一致不得静默修改；新增列/索引走显式 migration API。
- 现有 `KVStore` 最小契约和普通 KV API 不能被物理列功能污染或破坏。
- 查询必须统一：`where.columns` 查询物理列，`where.value` 查询 value JSON；旧的 dotted value path 继续兼容。
- SQLite、PostgreSQL、MongoDB 共享同一个 AST/语义，各 driver 只做 visitor/下降。
- 不自建连接池；不改变 ESM、Node 24+、pnpm、TypeScript 5.8、TC39 decorator 基线。

## 推荐公共行为

```ts
await blocks.set("tx-1", payload, {
  columns: {
    blocknumber: 12345,
    chainId: "ethereum",
    timestamp: 1720000000
  }
});

const rows = await blocks.find({
  where: {
    columns: { blocknumber: { $gte: 10000 }, chainId: "ethereum" },
    value: { "receipt.status": 1 }
  },
  sort: [{ source: "column", path: "blocknumber", direction: "desc" }],
  limit: 50
});
```

`get(key)` 保持只返回 value；新增 `getRecord(key)` 返回 `{ key, columns, value }`。required 列缺失、错类型、schema 冲突、非法列名、唯一索引冲突都必须抛可判别错误。

## 执行顺序

按 `TASKS.md` 的依赖顺序增量实现：

1. 契约和 schema 类型；
2. schema registry 与 table lifecycle；
3. 富层 Driver 契约；
4. SQLite；
5. PostgreSQL；
6. MongoDB；
7. Core Table API；
8. 统一查询 AST/compiler；
9. index/migration；
10. 真实数据库合规测试；
11. 文档、构建和交接记录。

每完成一个主要阶段：

- 先运行该阶段最小测试；
- 再运行 `pnpm typecheck`；
- 检查 `git diff`，不要覆盖用户已有修改；
- 按 `AGENTS.md` 的格式提交 commit，但不要 push。

## 测试要求

必须增加真实数据库合规覆盖：

- 普通 KV table 和 schema table 并存；
- 首次创建、关闭后按名称重开、新进程重开；
- 全部逻辑列类型、nullable/default/required；
- 单列、联合、unique index；
- columns/value 混合查询、排序、分页；
- set/update/setMany、TTL、clear、delete；
- schema 冲突、错类型、缺 required 列、非法 identifier；
- 现有所有单测和 SQLite 合规测试不得回归。

PG/Mongo 如果本机没有真实服务，不要伪造通过结果；保留可执行的测试，并在 `docs/nextsession.md` 诚实记录未验证状态。

## 禁止事项

- 不要把动态列实现成每次写入自动 `ALTER TABLE`。
- 不要把所有物理列降级成 JSON `columns` 字段来规避 schema。
- 不要为每个自定义列创建专用的 `findByXxx` 方法。
- 不要把 SQL identifier 当成普通参数值绑定。
- 不要为这项功能重写或破坏现有 Cache、装饰器、插件和 TTL 行为。
- 不要修改与本功能无关的代码、依赖或格式。
- 不要在实现未验证时声称三后端全部通过。

## 最终交付

最终回复必须包含：

1. 已修改的文件和每个文件的职责；
2. API 示例和迁移行为；
3. 执行过的命令及结果；
4. SQLite/PG/Mongo 各自真实验证状态；
5. 未完成项、风险和下一步；
6. `docs/nextsession.md` 是否已更新。

---
