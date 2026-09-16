# TASK-021: 跨后端动态多键与索引合规测试套件

## Objective
编写跨 SQLite、PostgreSQL、MongoDB 的真实合规测试套件，全面验证动态增键、多类型主键、二级键点查与复合索引搜索的一致性。

## Scope
- 验证普通 KV 表与多键物理表并存。
- 验证动态添加新键（`addKey`）后能够立即写入、建立索引并检索。
- 验证 `integer` 主键与 `string` 主键的读写一致性。
- 验证通过二级键 `table.getBy(...)` 进行单点点查的准确性与命中索引。
- 验证多键联合过滤、复合排序与分页查询。
- 验证全量单元测试与无 Mock 真实 DB 测试。

## Allowed Files
- `test/compliance/multikey-compliance.ts`
- `test/compliance/sqlite.test.ts`
- `test/compliance/postgres.test.ts`
- `test/compliance/mongodb.test.ts`

## Dependencies
- TASK-017
- TASK-018
- TASK-019
- TASK-020

## Inputs and Outputs
- **Input**: 针对 SQLite、PG、Mongo 实例运行同一套标准化合规用例。
- **Output**: 跨三个后端的一致性通过断言。

## Acceptance Criteria
1. SQLite 本地测试完全通过；
2. 动态增键与索引创建跨后端无语法错误；
3. 多键查询结果与排序行为在三端一致。

## Verification Commands
```bash
pnpm test test/compliance/sqlite.test.ts
KVDB_TEST_PG_URL=postgres://postgres:dev@localhost:5432/postgres pnpm test test/compliance/postgres.test.ts
KVDB_TEST_MONGO_URL=mongodb://localhost:27017/kvdb_test pnpm test test/compliance/mongodb.test.ts
```

## Risks and Assumptions
- 外部 Docker 服务在缺失时自动跳过真实集成测试，不造成本地单测红灯。

## Status
DONE
