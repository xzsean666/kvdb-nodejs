# TASK-018: PostgreSQL 动态多键存储与索引驱动实现

## Objective
在 PostgreSQL 驱动中实现动态多键独立物理表，支持任意类型的检索键与复合 B-Tree 索引加速。

## Scope
- 映射多键类型到 PostgreSQL（`BIGINT PRIMARY KEY`, `TEXT`, `DOUBLE PRECISION`, `BOOLEAN`, `JSONB`）。
- 实现动态加键与建索引的 DDL 生成（参数化、安全标识符转义）。
- 实现主键点查、二级键点查（`getRecordByKey`）与基于多键索引的高效过滤。
- 维护 PostgreSQL 元数据 Registry。

## Allowed Files
- `src/drivers/postgres/postgres-driver.ts`
- `src/drivers/postgres/dialect.ts`
- `test/unit/postgres-multikey.test.ts`
- `test/compliance/postgres.test.ts`

## Dependencies
- TASK-015
- TASK-016
- TASK-017

## Inputs and Outputs
- **Input**: PostgreSQL 连接池、多键定义、读写记录。
- **Output**: 独立 PostgreSQL 表 DDL、强类型数据读写、索引检索。

## Acceptance Criteria
1. 支持动态多键 DDL 与索引创建；
2. 单元测试覆盖 SQL 生成与参数绑定；
3. 真实 PostgreSQL 环境下合规测试通过。

## Verification Commands
```bash
pnpm test test/unit/postgres-multikey.test.ts
pnpm typecheck
```

## Risks and Assumptions
- 外部 Docker PostgreSQL 环境在 CI 或本地需要就绪才能跑完整合规测试。

## Status
DONE
