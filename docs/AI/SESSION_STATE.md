# SESSION_STATE.md — 当前工程会话状态与跨 Session 交接

> 本文件是跨 AI 会话恢复的直接事实来源。
> 每次会话开始时**必须首先读取本文件**，每次会话结束前**必须更新本文件**。

---

## 1. 核心状态概要

- **当前 Goal**: 高性能微批处理与写聚合子系统生产就绪加固 (TASK-030-PRODUCTION-HARDENING)
- **当前 Task**: 工业级并发时序保序、异常透传、Table 单例缓存防 OOM 与 In-Flight 快照穿透读 (已全部完成)
- **当前状态**: **COMPLETED_AND_VERIFIED** (已完成代码重构加固、全量测试 214 通过、构建与 22 个实战示例 100% 绿灯)

---

## 2. 本次加固优化内容清单 (TASK-030)

### A. 并发时序保序与写删一致性
1. **严格保序流水线 (`coalesce: false`)**:
   - `BatchFlushPayload` 升级支持 `operations: BatchOpItem[]`。
   - 当关闭写折叠时，底层驱动按严格 FIFO 调用流依次执行 `set` 与 `delete`，彻底解决先删后写被颠倒为先写后删导致数据丢失的严重缺陷。

### B. 落盘屏障与异常完整传播
2. **基于 Sequence/Generation 的并发 Flush 屏障**:
   - 记录进入 `flush()` 时的批次目标序列号，直到所属批次真正完成 I/O 持久化后才返回，彻底根绝因并发唤醒清空队列误判提前返回的竞态屏障穿透。
3. **零异常吞没 (Zero Error Swallowing)**:
   - `executeFlush()` 在底层落盘失败时不仅分发给每条操作的 reject，同时向外重新 `throw err`，确保应用显式调用 `await table.flush()` 时能如实捕获数据库失败异常。
4. **连续 Delete 契约修复**:
   - 修复同 Key 连续 delete 时第一次调用提前以 `undefined` resolve 的类型破坏问题，所有调用方均可靠收到实际执行结果。

### C. 资源生命周期与读取毛刺消除
5. **Table 实例单例化治理**:
   - `KVDB` 引入 `tableCache: Map<string, Table>`，相同命名空间自动复用 Table 单例，根治高并发下 Table 实例无界增长导致的堆内存泄漏（OOM），并保障跨模块/跨函数调用的 100% RYW 内存直通。
6. **In-Flight Snapshot 穿透点查**:
   - 批处理执行写库期间，正在落盘的快照维护为 `inFlightSnapshot`。点查操作优先从内存直读（0-RTT），不相干 Key 直接穿透查库，彻底消除了写库期间无差别阻塞读请求引起的延迟毛刺（Latency Spike）。
7. **Node.js 优雅退出**:
   - 异步排空定时器统一引入 `timer.unref?.()`，保证在没有其他网络/事件循环任务时 Node.js 进程可以自然退出。

5. **PostgreSQL 交叉行锁死锁消除 (Deadlock Prevention)**:
   - `compareKeysDeterministic`: 在将批次下发给 PostgreSQL（`setRecords` 与 `setMany`）前，对待写主键进行严格确定性升序排序，使所有并发事务获取行锁的顺序永远单调一致，数学上彻底根除 `deadlock detected`。

6. **生命周期与优雅停机 (Graceful Shutdown)**:
   - `table.flush()` 供应用显式排空。
   - `kvdb.close()` 自动追踪所有活跃 Table 并并发等待批处理缓冲 100% 排空落地，杜绝停机丢数据。
   - `SqliteDriver.close()` 清理预编译语句引用，根治 Node.js v24 环境下 C++ 析构断言问题。

---

## 3. 涉及与修改的核心文件

- `src/core/batcher.ts`: 核心微批与写聚合引擎实现（`WriteBatcher`, `compareKeysDeterministic`, `sanitizeSecondaryKeys`）。
- `src/core/table.ts`: Table 全量接入批处理、`flushBatch`、内存直通、防击穿链、RYW 读己之写拦截。
- `src/core/kvdb.ts`: `KVDBOptions` 增加全局 `autoBatch`，`close()` 自动排空所有 Table 批处理。
- `src/drivers/postgres/postgres-driver.ts`: `setRecords` 与 `setMany` 增加确定性主键排序，消除行锁死锁。
- `src/drivers/sqlite/sqlite-driver.ts`: 增加 schemaTable 追踪与语句安全释放，避免 Node v24 退出竞争。
- `src/index.ts`: 导出 `WriteBatcher` 及相关类型。
- `docs/AI/tasks/TASK-029-AUTO-BATCH.md`: 完整任务规格与技术卡片。
- `docs/AI/DECISIONS.md`: 记录 `KD-BATCH1`, `KD-BATCH2`, `KD-BATCH3`。
- `docs/SPEC.md`: 新增 §13 Auto Batch 规格章节。
- `test/unit/auto-batch.test.ts`: 全量 24 项深度测试全部通过（新增 6 项生产级加固测试）。
- `examples/22-auto-batch-coalescing.ts`: 官方高并发写聚合实战示例。

---

## 4. 默认配置规范 (Zero-Config Default-On)

按用户需求，KVDB 已默认开启 Auto Batch 微批合并与写聚合：
- `DEFAULT_AUTOBATCH_OPTIONS`:
  - `maxBatchSize: 50`: 50 条聚合阈值
  - `maxWaitMs: 20`: 20ms 排空窗口
  - `coalesce: true`: 内存折叠去重与 Multi-Key 增量浅合并
  - `sqlAggregation: true`: 聚合单条 multi-row SQL / bulkWrite 降低往返
  - `maxBufferSize: 500`: 10 倍缓冲背压防御
- 支持通过 `new KVDB({ autoBatch: false })` 或 `db.table("ns", { autoBatch: false })` 显式禁用以回退至传统同步直写。

---

## 5. 全量验证结果

- `pnpm test`: **214 tests passing (100% 全部通过，20 个测试套件)**，耗时 ~1.7s。
- `pnpm typecheck`: **0 errors** (TypeScript 严苛类型检查完全通过)。
- `pnpm build`: **构建成功**，输出 ESM、CJS 与 `.d.ts` 类型定义。
- `pnpm examples`: **22 个官方实战示例全部成功运行通过 (100%)**。

---

## 6. 当前技术债务与后续展望

1. **多驱动端到端环境测试 (Milestone 3)**:
   - SQLite 纯内存与真实磁盘文件测试全部 100% 覆盖。
   - PostgreSQL 与 MongoDB 驱动通过深度 Mock、AST 编译及结构断言测试。后续可在独立 CI/CD Docker 环境下执行外部容器端到端集成测试。

