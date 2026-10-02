# SESSION_STATE.md — 当前工程会话状态与跨 Session 交接

> 本文件是跨 AI 会话恢复的直接事实来源。
> 每次会话开始时**必须首先读取本文件**，每次会话结束前**必须更新本文件**。

---

## 1. 核心状态概要

- **当前 Goal**: Milestone 3 生产级功能扩展与生态演进
- **当前 Task**: 生产级可靠任务队列子系统 (TASK-028-QUEUE) — 零外部依赖、可见性租约、多并发 Worker、自动心跳续期与优雅停机
- **当前状态**: **COMPLETED_AND_VERIFIED** (代码实现、底层 Schema 列级原子修改增强、单元与文件集成测试、实战示例 100% 绿灯全部交付)

---

## 2. 本次任务交付清单 (TASK-028-QUEUE)

### A. 队列核心与架构设计
1. **类型与错误契约**:
   - `src/queue/types.ts`: 定义了 `Job`, `JobState`, `JobOptions`, `WorkerOptions`, `QueueStats`, `BackoffOptions`, `JobProcessor`。
   - `src/core/errors.ts`: 扩展并导出 `KvdbQueueError`。
2. **物理表持久化与防重防丢原子租约**:
   - `src/queue/queue.ts`: 基于物理 Schema 表 `_kvdb_queue_<name>` 封装 `push`, `pushMany`, `pop`, `ack`, `nack`, `heartbeat`, `getJob`, `getStats`, `retryFailed`, `clean`。
   - `pop()` 机制：原子租约抢占（Visibility Timeout）与过期租约自动回收，多 Worker 并发争抢相同候选时通过事务行锁与 CAS 二次核验状态，彻底杜绝重复消费。
3. **并发 Worker 运行器与生命周期**:
   - `src/queue/worker.ts`: 支持 `concurrency` 槽位调度、后台自动心跳续租（`autoHeartbeat`，间隔 `visibilityTimeoutMs / 2`）、指数与固定退避重试（达最大次数自动流转至死信队列 `failed`）、`pause` / `resume` 动态控制，以及优雅停机（`close()` 自动唤醒轮询并等待所有进行中活跃任务执行完毕）。
4. **底层物理 Schema 列级更新强化 (跨驱动重大修复)**:
   - 修复了此前各数据库驱动（SQLite, PostgreSQL, MongoDB）在 `updateRecord` 时仅写回原始列、忽略 `options.keys / options.columns` 的缺陷；现在 `table.update(key, patch, { keys: ... })` 全面支持在单次原子事务中同步修改物理列（如 `lockToken`, `lockExpiresAt`, `state`）。
5. **门面集成与导出**:
   - `src/core/kvdb.ts`: 挂载 `db.queue()` 单例管理与 `db.worker()` 自动注册；`db.close()` 触发所有活跃 Worker 优雅停机并释放句柄。
   - `src/index.ts`: 导出 `Queue`, `Worker`, `KvdbQueueError` 以及全部类型。

---

## 3. 涉及与修改的核心文件

- `src/queue/types.ts`: 任务队列完整类型契约。
- `src/queue/queue.ts`: 任务队列引擎实现。
- `src/queue/worker.ts`: 并发槽位 Worker 运行器。
- `src/core/kvdb.ts`: `db.queue()` 与 `db.worker()` 挂载与清理。
- `src/core/errors.ts`: `KvdbQueueError`。
- `src/core/table.ts`: `update()` 传递 `keys / columns` 至驱动。
- `src/drivers/types.ts`: `UpdateResult` 扩展 `columns?: Record<string, unknown>`。
- `src/drivers/sqlite/sqlite-driver.ts`: `updateRecord` 合并 `columns`。
- `src/drivers/postgres/postgres-driver.ts`: `updateRecord` 合并 `columns`。
- `src/drivers/mongodb/mongodb-driver.ts`: `updateRecord` 合并 `columns`。
- `src/index.ts`: 导出队列核心与类型。
- `test/unit/queue.test.ts`: 11 项全方位单测。
- `test/integration/queue-sqlite.test.ts`: 2 项磁盘文件多连接与宕机恢复集成测试。
- `examples/23-reliable-task-queue.ts`: 官方实战队列示例。
- `docs/AI/tasks/TASK-028-QUEUE.md`: 状态变更为 DONE。
- `docs/AI/TASK_INDEX.md`: 任务索引更新为 DONE。

---

## 4. 全量验证结果

- `pnpm test`: **233 tests passing (100% 全部通过，22 个测试套件，0 失败)**。
- `pnpm typecheck`: **0 errors** (严苛 TypeScript 检查通过)。
- `pnpm build`: **构建成功**，输出 ESM、CJS 与 `.d.ts` 类型定义。
- `pnpm examples`: **23 个官方实战示例全部成功运行通过 (100%)**。

---

## 5. 下一步工作规划 (Milestone 3 待开发项)

1. **TASK-024 (查询结果缓存 Query Cache + Write Invalidation)**:
   - 在 `find()` / `findRecords()` 层实现基于查询 AST 指纹的结果缓存，并在对应命名空间发生 `set`/`delete`/`update` 时按策略精确失效。
2. **TASK-025-CACHE (Cache 前缀清理能力 deleteByPrefix)**:
   - 为内存缓存、SQLite 缓存等存储后端提供 `deleteByPrefix(prefix)` 高效原子清理。
3. **TASK-026 (PostgreSQL 与 MongoDB 真实 Docker 环境合规验证)**:
   - 建立 Docker 驱动容器矩阵，执行全套 compliance 测试。
4. **TASK-027 (Redis 与 MySQL 驱动扩展)**:
   - 接入 Redis 驱动与 MySQL 驱动。
