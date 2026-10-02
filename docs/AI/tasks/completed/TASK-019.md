# TASK-019: MongoDB 动态多键与复合索引驱动实现

## Objective
在 MongoDB 驱动中实现独立集合与动态多键顶级字段映射，支持单字段与复合索引加速。

## Scope
- 将自定义检索键映射为文档顶级字段（与 `_id`、`value` 并列）。
- 动态添加键时，幂等创建对应的 MongoDB 索引。
- 支持通过主键（`_id`）或指定键（`getRecordByKey`）直接查找文档。
- 将针对多键的查询编译为高效的原生 Mongo Filter。

## Allowed Files
- `src/drivers/mongodb/mongodb-driver.ts`
- `src/drivers/mongodb/compiler.ts`
- `test/unit/mongodb-multikey.test.ts`
- `test/compliance/mongodb.test.ts`

## Dependencies
- TASK-015
- TASK-016

## Inputs and Outputs
- **Input**: MongoDB 连接句柄、集合名、多键定义、读写文档。
- **Output**: 独立集合文档写入与复合索引创建。

## Acceptance Criteria
1. 自定义多键存放在文档第一层，保证索引最高效率；
2. 动态新增索引幂等生效；
3. 单元测试验证 Filter 构造与结果解析。

## Verification Commands
```bash
pnpm test test/unit/mongodb-multikey.test.ts
pnpm typecheck
```

## Risks and Assumptions
- MongoDB 原生即为无模式，需确保运行时类型校验与索引配置对齐。

## Status
DONE
