# TASK-017: SQLite 动态多键存储与索引驱动实现

## Objective
在 SQLite 驱动中实现基于独立物理表的多键存储体系，支持灵活主键类型、任意数量二级物理键、动态加键及单列/联合 B-Tree 索引。

## Scope
- 物理表结构实现：
  - 主键支持自定义名称与类型（`INTEGER PRIMARY KEY` 或 `TEXT PRIMARY KEY`）。
  - 声明的二级 Key 均映射为真实物理列，附加 `value TEXT NOT NULL`（数据载荷）、`expires_at` 与审计列。
- 动态扩键支持：
  - 实现 `addColumn(name, definition)`：执行安全 identifier 转义的 `ALTER TABLE ADD COLUMN`。
  - 实现 `addIndex` / `addCompositeIndex`：幂等创建普通或唯一 B-Tree 索引。
- 记录读写与检索：
  - `setRecord(primaryKey, value, secondaryKeys, ttlMs)`。
  - `getRecord(primaryKey)` 返回主键、二级键集合与解析后的 value。
  - `getRecordByKey(keyName, keyValue)`：通过唯一二级键直接 O(1) 点查。
- 状态恢复：
  - 进程重启后通过 `kvdb_schema_registry` 自动加载所有已定义的 Key 与索引配置。

## Allowed Files
- `src/drivers/sqlite/sqlite-driver.ts`
- `src/drivers/sqlite/dialect.ts`
- `test/unit/sqlite-multikey.test.ts`

## Dependencies
- TASK-015
- TASK-016

## Inputs and Outputs
- **Input**: 表名、多键定义、读写记录对象。
- **Output**: 真实 SQLite 物理表执行、原生 B-Tree 索引生成、结构化记录返回。

## Acceptance Criteria
1. 支持数字主键或字符串主键；
2. 动态调 `addKey` 能实时在物理库中添加列并建索引；
3. 二级键点查 `getRecordByKey` 与多键过滤 `find` 准确命中物理列。

## Verification Commands
```bash
pnpm test test/unit/sqlite-multikey.test.ts
pnpm typecheck
```

## Risks and Assumptions
- better-sqlite3 需确保在目标环境正常编译运行。

## Status
DONE

