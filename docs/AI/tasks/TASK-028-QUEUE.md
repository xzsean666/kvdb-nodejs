# TASK-028-QUEUE: 生产级可靠任务队列系统 (Reliable Queue Subsystem)

## 1. 目标
在 `kvdb-nodejs` 中设计与实现开箱即用、零外部服务依赖（无需 Redis/RabbitMQ）、高并发防重消费的生产级任务队列。

## 2. 核心范围与交付物
1. **类型定义与错误**：
   - `src/queue/types.ts`: `Job`, `JobState`, `JobOptions`, `WorkerOptions`, `QueueStats`, `BackoffOptions`。
   - `src/core/errors.ts`: `KvdbQueueError`（`QUEUE_EMPTY`, `LOCK_LOST`, `MAX_ATTEMPTS_EXCEEDED` 等）。
2. **队列核心与物理存储**：
   - `src/queue/queue.ts`: 负责基于物理 Schema Table `_kvdb_queue_<name>` 封装 `push`, `pushMany`, `pop`, `ack`, `nack`, `heartbeat`, `getStats`, `clean`, `retryFailed`。
3. **Worker 运行器**：
   - `src/queue/worker.ts`: 并发槽位调度、优雅停机、失败退避与自动心跳续期。
4. **门面集成**：
   - `src/core/kvdb.ts`: 扩展 `db.queue<Payload, Result>(name, options?)`。
   - `src/index.ts`: 导出队列核心与类型。
5. **合规与多后端单测**：
   - `test/unit/queue.test.ts`
   - `test/integration/queue-sqlite.test.ts`

## 3. 验收标准
- 跨进程多 Worker 并发争抢时无重复消费（原子租约保证）。
- 支持延迟任务与基于指数退避的自动重试。
- 超时未确认任务由 Visibility Timeout 机制自动回收。
- 达到最大尝试次数自动进入死信队列（`failed`）。

## Status
DONE (100% 交付并通过全量验证)

## 4. 交付清单与验证结果
- **类型系统与错误**: `src/queue/types.ts` 定义了完整的 `Job`, `JobState`, `JobOptions`, `WorkerOptions`, `QueueStats`, `BackoffOptions`, `JobProcessor`；`src/core/errors.ts` 导出 `KvdbQueueError`。
- **物理队列引擎**: `src/queue/queue.ts` 基于物理 Schema 表 `_kvdb_queue_<name>` 实现了 `push`, `pushMany`, `pop`, `ack`, `nack`, `heartbeat`, `getJob`, `getStats`, `retryFailed`, `clean`。
- **Worker 运行器**: `src/queue/worker.ts` 实现多并发槽位调度、后台自动心跳续约、指数退避重试、暂停/恢复与优雅停机（`close()` 自动等待活跃槽位清空并注销资源）。
- **物理 Schema 列级更新强化**: 发现并修复了底层驱动在 `updateRecord` 时丢失更新列的缺陷，使 `table.update(..., { keys: ... })` 在 SQLite、PostgreSQL、MongoDB 全面支持列级原子修改。
- **门面与导出**: `src/core/kvdb.ts` 挂载 `db.queue()` 与 `db.worker()`，并在 `db.close()` 时自动关闭并注销所有活跃 Worker；`src/index.ts` 导出全部核心类与类型。
- **单元与集成测试**:
  - `test/unit/queue.test.ts`: 11 项全功能单测覆盖优先级抢占、租约防重、心跳续约、指数退避重试、死信队列、优雅停机。
  - `test/integration/queue-sqlite.test.ts`: 2 项磁盘文件真实多连接与故障恢复集成测试。
- **实战示例**: `examples/23-reliable-task-queue.ts` 演示多 Worker 异步订单处理、网络抖动退避重试与平滑停机。

