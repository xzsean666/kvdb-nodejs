# TASK-015: 动态多键（Multi-Key）契约与类型定义

## Objective
定义面向 KV 数据库的多键（Multi-Key）契约，支持为一条记录定义多个不同类型的检索键（Primary Key + Secondary Keys），支持灵活类型约束与索引声明。

## Scope
- 导出 `KeyType`: `"string" | "integer" | "number" | "boolean" | "json"`。
- 导出 `KeyDefinition`:
  ```ts
  export interface KeyDefinition {
    type: KeyType;
    nullable?: boolean;
    default?: unknown;
    index?: boolean | { name?: string; unique?: boolean };
  }
  ```
- 导出 `MultiKeySchema`:
  - `primaryKey?: { name: string; type: "string" | "integer" }`（默认主键名为 `key`，类型默认为 `string`）。
  - `keys: Record<string, KeyDefinition>`（除主键外的多类型二级检索键）。
  - `indexes?: TableIndexDefinition[]`（多键联合索引）。
- 运行时校验：校验 Key 名称合法性，禁止覆盖保留字（`value`, `expires_at`, `created_at`, `updated_at`）。
- 泛型支持：`Table<Value, Keys>` 完整推导主键与二级键的输入输出。

## Allowed Files
- `src/core/table-schema.ts`
- `src/core/errors.ts`
- `src/index.ts`
- `test/unit/table-schema.test.ts`

## Dependencies
- None (依赖已完成的 M1 基础类型)

## Inputs and Outputs
- **Input**: 用户声明的 `MultiKeySchema`（主键定义、二级键定义、联合索引）。
- **Output**: 校验合法的多键元数据规范，或抛出可判别的 `KvdbSchemaError`。

## Acceptance Criteria
1. 支持 `string`、`integer`、`number`、`boolean`、`json` 五种键类型。
2. 支持声明主键名称和类型（如 `blockNumber: integer` 或默认 `key: string`）。
3. 允许二级键标记为 `index: true` 或 `{ unique: true }`。
4. 提供清晰的 TypeScript 类型推导，在写入与查询时自动感知所有 Key 的类型。

## Verification Commands
```bash
pnpm test test/unit/table-schema.test.ts
pnpm typecheck
```

## Risks and Assumptions
- 键名不包含冒号等分隔符，保证物理拼接安全。

## Status
DONE

