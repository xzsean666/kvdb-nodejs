# TASK-026: PostgreSQL 与 MongoDB 真实 Docker 环境合规验证

## 1. 任务背景与目标
KVDB SDK 拥有三套核心物理存储驱动：SQLite、PostgreSQL、MongoDB。
在 Milestone 1 和 Milestone 2 中，SQLite 已通过内存数据库完成了全量测试，PostgreSQL 与 MongoDB 也已实现完整的 KV 驱动、AST 查询下推、动态多键物理表映射、复合索引与并发原子突变。

本任务目标：
1. 在宿主机真实 Docker 环境中部署 PostgreSQL 和 MongoDB 容器；
2. 运行 `test/compliance/postgres.test.ts` 与 `test/compliance/mongodb.test.ts`；
3. 验证两个远程数据库驱动的全部功能（基础 KV、原子更新并发 CAS、TTL 过期、批量操作、前缀删除、AST JSON 查询、动态多键与顶级字段复合索引）；
4. 提供开箱即用的跨驱动端到端自动化验证脚本与 npm 命令。

## 2. 验收标准与验证结果
- [x] PostgreSQL 真实容器合规套件 31 项测试全部通过（100% Pass）。
- [x] MongoDB 真实容器合规套件 31 项测试全部通过（100% Pass）。
- [x] SQLite 内存合规套件 31 项测试全部通过（100% Pass）。
- [x] 合规测试总数达到 93 项全部绿灯，无任何跳过或失败。
- [x] PostgreSQL 真实端到端测试 `test/e2e/postgres-e2e.test.ts` 42 项全部通过（100% Pass）。
- [x] 跨驱动新增并统一 `dropSchemaTable` 契约，支持动态测试幂等清理与独立物理表生命周期销毁。
- [x] 修复 MongoDB 动态扩展列默认值回填机制与 `extractColumns` 兜底缺陷。
- [x] 提供统一执行脚本 `scripts/run-docker-compliance.sh` 与 `pnpm test:compliance:all` 命令。

## 3. 状态
**DONE** (已完成并通过全套跨驱动真实数据库合规验证)

