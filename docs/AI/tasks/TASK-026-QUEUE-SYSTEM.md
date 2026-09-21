# TASK-026: 生产级可靠任务队列系统 (Reliable Queue Subsystem)

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
