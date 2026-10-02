# TASK-027: Redis 与 MySQL (MariaDB) 物理驱动扩展与全生态合规

## 1. 任务背景与目标
KVDB SDK 作为面向 Node.js 的企业级多驱动统一 KV 数据库 SDK，在 Milestone 1 和 Milestone 2 中已完成 SQLite、PostgreSQL、MongoDB 的深度支持与合规验证。

本任务推进 Milestone 3 生态扩展：
1. **AST 内存通用求值引擎 (`src/query/evaluator.ts`)**:
   - 为无原生嵌套 JSON 查询下推能力的后端（如 Redis、简单 KV 存储）提供纯内存 QueryNode AST 完整求值器与排序器，保证 100% 契约保真度。
2. **Redis 物理驱动与缓存 Store 适配 (`src/drivers/redis/redis-driver.ts`, `src/cache/stores/redis-store.ts`)**:
   - 基于 `ioredis` 实现高并发 KV 读写、原生毫秒级 PX TTL、SCAN 游标前缀清理、服务端单线程原子 Lua CAS 乐观更新与 AST 查询过滤。
   - 实现独立 `RedisStore` 缓存后端，无缝集成 SWR 与 Stampede Collapse 机制。
3. **MySQL / MariaDB 物理驱动与多键表 (`src/drivers/mysql/mysql-driver.ts`)**:
   - 基于 `mysql2/promise` 连接池实现严格关系型 KV 存储与事务级行锁并发（`SELECT ... FOR UPDATE`）。
   - 完整支持 Dynamic Multi-Key Schema Tables（物理二级索引、复合索引、动态加列 `addKey`、`addIndex`、点查 `getRecordByKey` 与多键过滤排序）。
4. **真实 Docker 容器环境合规测试**:
   - 挂载 `redis:8-alpine` (6380) 与 `mariadb:11` (3307) 物理容器。
   - 接入 `describeDriverCompliance` 与 `describeMultiKeyCompliance` 严苛测试套件。

## 2. 验收标准与验证结果
- [x] **AST 内存求值器 (`src/query/evaluator.ts`)**: 支持 `$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$in`, `$nin`, `$exists`, `$elemMatch`, 嵌套路径与深度排序，支持 `column` 字段源映射。
- [x] **Redis 驱动与 Store**:
  - 服务端单线程原子 Lua 脚本消除并发更新竞争条件，通过 50 并发增量写零丢失测试。
  - 支持负数/0 TTL 拦截删除语义与 Cache 参数宽容解析。
  - `test/compliance/redis.test.ts` 25 项合规单测 100% 通过。
  - `test/unit/redis-driver.test.ts` 6 项单测 100% 通过。
  - `examples/25-redis-kv-and-cache.ts` 100% 成功运行。
- [x] **MySQL / MariaDB 驱动**:
  - 行锁事务更新避免并发写丢失，支持自动建表与元数据注册。
  - 自动适配 InnoDB utf8mb4 索引长度上限（VARCHAR 255），支持复合索引。
  - `test/compliance/mysql.test.ts` 31 项合规单测 100% 通过。
  - `test/unit/mysql-driver.test.ts` 5 项单测 100% 通过。
  - `examples/26-mysql-kv-and-multikey.ts` 100% 成功运行。
- [x] **全驱动合规套件**:
  - `pnpm test:compliance:all` 自动化执行 SQLite (31) + PostgreSQL (31) + MongoDB (31) + Redis (25) + MySQL (31) 共 **149 项真实物理数据库合规单测 100% 绿灯**！
- [x] **全量单元测试与构建**:
  - `pnpm test`: 253 项测试全量通过，0 失败。
  - `pnpm typecheck`: 0 错误通过。
  - `pnpm build`: ESM / CJS / DTS 产物编译成功。
  - `pnpm examples`: 全部 26 个官方实战示例全部成功运行。

## 3. 状态
**DONE** (已完成并通过 Redis 与 MySQL 物理驱动扩展及全量跨驱动合规验证)
