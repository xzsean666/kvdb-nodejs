# TASK-016: 动态 Key 扩展与物理表自动演进机制

## Objective
提供随时动态增加检索 Key（列）和索引的能力，底层驱动根据声明自动平滑演进物理表结构，无需手动执行繁复的外部迁移。

## Scope
- 设计与实现 `table.addKey(name, definition)` / `KVDB.alterTable(...)` 动态扩键接口。
- 支持在已有表上动态新增 `KeyDefinition`（自动推演物理 DDL `ALTER TABLE ADD COLUMN` / Mongo 模式更新）。
- 支持动态新增单列索引与联合索引（幂等执行 `CREATE INDEX IF NOT EXISTS`）。
- 自动维护持久化元数据注册表（`kvdb_schema_registry`），递增版本号并同步内存缓存。
- 保证已存在的数据不受影响，新增加的 Key 自动兼容已写入旧记录（可空或赋予默认值）。

## Allowed Files
- `src/core/table-schema.ts`
- `src/core/table.ts`
- `src/core/kvdb.ts`
- `src/drivers/types.ts`
- `test/unit/schema-evolution.test.ts`

## Dependencies
- TASK-015

## Inputs and Outputs
- **Input**: 目标表名、新增的 Key 键名与定义、新增索引。
- **Output**: 动态更新的物理表结构、持久化注册表元数据更新。

## Acceptance Criteria
1. 在已有表上调用 `addKey` 后，后续读写立即能直接使用新 Key。
2. 重复调用相同增键操作具有幂等性。
3. 新增索引自动生效，支持针对新 Key 进行快速查询。

## Verification Commands
```bash
pnpm test test/unit/schema-evolution.test.ts
pnpm typecheck
```

## Risks and Assumptions
- SQLite 的 `ALTER TABLE` 仅支持添加列，因此动态操作聚焦于增量扩展，不做破坏性的删列或类型变更。

## Status
DONE

