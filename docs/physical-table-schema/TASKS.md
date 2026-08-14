# 真实物理列表升级任务拆分

> 目标：实现 `docs/physical-table-schema/UPGRADE.md` 定义的 schema table 能力。
> 本文件只拆分开发任务；当前会话不执行任何代码任务。

## 0. 开发前检查

- 阅读根目录 `AGENTS.md`、`docs/nextsession.md`。
- 阅读本目录 `UPGRADE.md` 和现有 `docs/ARCHITECTURE.md`、`docs/SPEC.md`。
- 确认用户已明确批准进入 Step 4。
- 检查 worktree，保留用户已有修改，不做 destructive git 操作。
- 先更新架构/规格文档，再改源码；每个主要任务独立构建和测试。

## 1. 契约与 schema 类型

**目标**：定义跨后端通用的列、索引、schema、row 类型。

**主要位置**：

- `src/core/table-schema.ts`（新文件）
- `src/core/table.ts`
- `src/core/kvdb.ts`
- `src/index.ts`
- `src/core/errors.ts`

**工作内容**：

- 定义 `PhysicalColumnType`、`ColumnDefinition`、`TableIndexDefinition`、`TableSchema`。
- 运行时校验列名、类型、nullable/default、index 和联合索引引用。
- 定义 `Table<Value, Columns>` 泛型及完整 row 类型。
- 保留无 schema 的普通 KV table 行为。
- 增加可判别 schema/config/migration 错误。

**完成条件**：类型检查通过；schema 非法输入有单测；公共导出稳定。

## 2. Schema registry 与 table 生命周期

**目标**：按逻辑 table 名创建、发现、重新打开和校验物理表。

**主要位置**：

- `src/core/table-registry.ts`（新文件）
- `src/core/kvdb.ts`
- `src/drivers/types.ts`

**工作内容**：

- 设计 registry 的 provider-neutral 契约。
- 生成安全、稳定的物理表名/collection 名。
- 实现首次使用：无 registry 时要求 schema 并创建；有 registry 时校验。
- 实现后续 `db.table("name")` 无 schema 重新打开。
- 明确普通 KV namespace 与 schema table 的冲突错误。
- 不在 `set` 路径隐式执行 schema 变更。

**依赖**：任务 1。

**完成条件**：SQLite 文件关闭重开后按名称恢复 schema；冲突场景有测试。

## 3. 富层 Driver 契约

**目标**：扩展 Driver，而不污染 Cache 的 `KVStore` 最低契约。

**主要位置**：

- `src/drivers/types.ts`
- 可能的新文件 `src/drivers/schema-types.ts`

**工作内容**：

- 增加 create/open/inspect/alter schema table 的能力接口。
- 定义物理列读写、完整 row、批量写入、原子 update、find 的契约。
- 增加 capabilities，例如 `supportsPhysicalColumns`、`supportsSchemaMigration`。
- 定义单列/联合索引的幂等创建契约。
- 保持旧 Driver/custom Driver 可通过旧 KV 路径工作。

**依赖**：任务 1。

**完成条件**：接口可被三后端实现；旧 SQLite driver 单测无回归。

## 4. SQLite 物理表实现

**目标**：使用 better-sqlite3 创建真实列、索引和迁移。

**主要位置**：`src/drivers/sqlite/*`

**工作内容**：

- schema 到 SQLite DDL 的安全映射。
- 固定列 `key/value/expires_at/created_at/updated_at`。
- schema table 的真实列、NULL/default、insert/upsert/update。
- 单列和联合索引，名称与 identifier 安全校验。
- schema introspection/registry 读写。
- 物理列与 value JSON 的统一查询编译。
- 保留普通共享 KV 表路径。

**依赖**：任务 2、3。

**完成条件**：`:memory:` 和 file SQLite 覆盖创建、重开、写读、索引和迁移。

## 5. PostgreSQL 物理表实现

**目标**：实现与 SQLite 等价的 PostgreSQL table/column/index 行为。

**主要位置**：`src/drivers/postgres/*`

**工作内容**：

- 逻辑类型到 PostgreSQL 类型映射。
- identifier quoting、参数化值和事务边界。
- schema table DDL、registry、introspection、migration。
- 普通 B-tree 和联合索引。
- 物理列 + `value` JSONB/text 查询统一编译。
- 使用 pg 自有 pool，不实现第二套连接池。

**依赖**：任务 2、3、4 的契约稳定。

**完成条件**：真实 PostgreSQL 合规套件通过。

## 6. MongoDB 物理 collection 实现

**目标**：用 collection/document 字段表达同一 schema 契约。

**主要位置**：`src/drivers/mongodb/*`

**工作内容**：

- collection 命名和 schema registry。
- Mongo validator 或等价运行时校验。
- `_id`、自定义字段、value、TTL 字段的读写。
- 单字段和 compound index 的幂等创建。
- 统一查询 AST 到 Mongo filter/sort 的下降。
- 明确缺失字段与 null 的跨后端语义。

**依赖**：任务 2、3。

**完成条件**：真实 MongoDB 合规套件通过。

## 7. Core Table API

**目标**：用户继续通过 `db.table("name")` 操作。

**主要位置**：

- `src/core/table.ts`
- `src/core/kvdb.ts`
- `src/index.ts`

**工作内容**：

- `db.table<Value, Columns>(name, { schema })` 首次创建/校验。
- `db.table<Value, Columns>(name)` 后续按名重新打开。
- `set/get/getRecord/update/setMany/getMany/find/clear` 的 columns 语义。
- required/default/null 类型校验。
- 普通 KV 表无 schema 时保持原 API。
- cache 和 hooks 处理完整 row，避免 columns 与 value 不一致。

**依赖**：任务 1、2、3、至少任务 4。

**完成条件**：SQLite 端到端 API 测试通过，旧 API 测试不回归。

## 8. 通用查询 AST/compiler

**目标**：物理列和 value JSON 使用一套查询入口。

**主要位置**：

- `src/query/ast.ts`
- `src/query/parser.ts`
- `src/query/compiler.ts`
- `src/drivers/sqlite/dialect.ts`
- `src/drivers/postgres/dialect.ts`
- `src/drivers/mongodb/compiler.ts`

**工作内容**：

- 增加 field source：`column` / `value`。
- 支持 `where.columns`、`where.value` 的显式查询结构。
- 保留旧 dotted value path 作为 value 查询。
- 物理列名必须由已加载 schema 白名单验证。
- 支持 columns/value 混合 AND/OR/NOT、sort、limit、offset。
- 对物理列按 schema 类型绑定参数；不得把参数值拼入 SQL。

**依赖**：任务 1、3、4、5、6。

**完成条件**：相同查询在三后端得到一致结果；非法列和类型错误有测试。

## 9. Index 与 migration API

**目标**：显式、可重复、可审计地维护物理 schema。

**主要位置**：

- `src/core/table-registry.ts`
- `src/core/kvdb.ts`
- 各 backend driver

**工作内容**：

- `index: true` 单列索引。
- `index: { unique, name }` 唯一/命名索引。
- `schema.indexes` 联合索引。
- `alterTable({ add, addIndex, dropIndex })` 首期能力。
- 禁止隐式 drop/alter type/rename。
- 迁移版本和失败错误。

**依赖**：任务 2、3、4、5、6。

**完成条件**：索引重复创建幂等；唯一冲突可诊断；迁移重跑安全。

## 10. 合规测试与回归

**目标**：用真实数据库验证跨后端契约，不使用 mock 掩盖差异。

**主要位置**：

- `test/compliance/*`
- `test/unit/*`
- `test/e2e/*`

**必须覆盖**：

- 普通 KV table 与 schema table 并存。
- 首次创建、同进程重开、新进程重开。
- string/integer/number/boolean/json 类型。
- nullable/default/required。
- 单列、联合、unique index。
- columns/value 混合查询、排序、分页。
- set/update/setMany、TTL、clear、delete。
- schema 冲突、非法 identifier、错类型、缺 required 列。
- 旧 96 个单测和现有 SQLite 合规套件。

**完成条件**：SQLite 本地全绿；PG/Mongo 在真实服务可用时全绿，并把结果回填 `docs/nextsession.md`。

## 11. 文档与发布检查

- 更新 `docs/ARCHITECTURE.md` 的模块、数据流和关键决策。
- 更新 `docs/SPEC.md` 的 schema table、query、index、migration API。
- 更新 `docs/BUILD.md` 的数据库初始化和测试命令。
- 更新 `docs/nextsession.md` 的实现进度、风险和验证状态。
- `pnpm typecheck`、`pnpm test`、`pnpm build`。
- 每个主要阶段独立 commit；不要 push。

## 建议提交顺序

```text
feat: add physical table schema contracts
feat: add table registry and lifecycle
feat: implement sqlite physical columns
feat: implement postgres physical columns
feat: implement mongodb physical columns
feat: add unified physical-column queries
feat: add schema indexes and migrations
test: add physical table compliance suite
docs: document physical table schema upgrade
```
