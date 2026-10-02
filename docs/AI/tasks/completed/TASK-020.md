# TASK-020: Table API 多键统一点查与索引直连查询

## Objective
在核心 `Table` 门面中打通多键能力：提供极简的写入、主键点查、二级键快速点查（`getBy`）以及直接命中物理 Key 索引的高效搜索。

## Scope
- 写入能力：
  - `table.set(primaryKey, value, { keys?: Partial<Keys>, ttlMs?: number })`。
- 快速点查：
  - `table.get(primaryKey)`：获取 `value`。
  - `table.getRecord(primaryKey)`：获取完整记录（包含主键、所有物理键字典与 `value`）。
  - `table.getBy(keyName, keyValue)`：通过唯一/单列索引的二级键直接 O(1) 点查。
- 高效搜索（直连物理键索引）：
  - 用户查询直接面向声明的键：
    ```ts
    await table.find({
      where: {
        chainId: "ethereum",
        blockNumber: { $gte: 10000 }
      },
      sort: [{ path: "blockNumber", direction: "desc" }],
      limit: 20
    });
    ```
  - 查询引擎自动匹配物理 Key 索引，无需繁琐区分 `columns` 与 `value`。
- 兼容性：未声明多键 Schema 的 Table 保持极简纯 KV 行为。

## Allowed Files
- `src/core/table.ts`
- `src/core/kvdb.ts`
- `src/query/parser.ts`
- `src/index.ts`
- `test/unit/table-multikey.test.ts`

## Dependencies
- TASK-015
- TASK-016
- TASK-017

## Inputs and Outputs
- **Input**: 上层调用的多键写操作、多键点查与多键范围查询。
- **Output**: 协调驱动层完成基于物理索引的高性能读写。

## Acceptance Criteria
1. `table.getBy("hash", val)` 能在 O(1) 复杂度通过物理索引获取记录；
2. `table.find` 查询声明的键时自动命中底层数据库的 B-Tree 索引；
3. 普通无模式 KV Table 完全不受影响。

## Verification Commands
```bash
pnpm test test/unit/table-multikey.test.ts
pnpm typecheck
```

## Risks and Assumptions
- 确保查询中的键名由 Table 当前已注册的 Key 白名单验证，防止 SQL 注入。

## Status
DONE
