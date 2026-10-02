# SESSION_STATE.md — 当前工程会话状态与跨 Session 交接

> 本文件是跨 AI 会话恢复的直接事实来源。
> 每次会话开始时**必须首先读取本文件**，每次会话结束前**必须更新本文件**。

---

## 1. 核心状态概要

- **当前 Goal**: 高性能微批处理与写聚合子系统 (TASK-029-AUTO-BATCH)
- **当前 Task**: 交付生产级 Auto Batch 引擎、Multi-Key 增量浅合并、Postgres 防死锁排序、内存直通与防击穿 (Step 1-4 全部完成)
- **当前状态**: **COMPLETED_AND_VERIFIED** (已完成代码实现、全量测试 208 通过、构建与 22 个实战示例 100% 绿灯)

---

## 2. 本次任务完成内容与优化清单

### A. Auto Batch 核心与安全硬化 (TASK-029-AUTO-BATCH)
1. **统一高性能微批缓冲引擎 (`src/core/batcher.ts`)**:
   - 实现 `WriteBatcher<V>`，提供时间窗口（`maxWaitMs` 默认 20ms）与容量阈值（`maxBatchSize` 默认 50 条）自动排空。
   - 内存容量背压保护（`maxBufferSize` 默认 `maxBatchSize * 10`），超过阈值时触发强制同步排空，防止恶性突发流量打爆 Node.js 堆内存。
   - 零异常吞没（Zero Error Swallowing）：当底层写失败时，精准将底层错误分发给批次内每一个 Promise 调用方，不吞没不卡死。
   - 移除不当的 `timer.unref()`，保证 Node.js 在微批排队窗口期内可靠结算落地。

2. **Multi-Key 物理二级索引深度支持与原型链防御**:
   - 物理 Schema 表（`TableSchema` / `MultiKeySchema`）深度集成。
   - `sanitizeSecondaryKeys` 严格过滤 `__proto__`, `constructor`, `prototype`，杜绝原型链污染。
   - 内存折叠模式下对同 Key 的二级键执行增量浅合并（`mergedKeys = { ...existing.keys, ...newItem.keys }`），并发写入不丢失物理索引字段。

3. **两层聚合正交可配置 (`coalesce` & `sqlAggregation`)**:
   - `coalesce: true`（默认）：内存层同 Key 覆盖写与写删抵消，大幅压降数据库 I/O 与 PostgreSQL MVCC 死元组。
   - `coalesce: false`：严格保序微批（FIFO），保留每一条写操作（满足 CDC/触发器审计场景）。
   - `sqlAggregation: true`（默认）：生成单条 multi-row SQL 语句。
   - `sqlAggregation: false`：在单事务内循环执行独立 Prepared Statements。

4. **同 Key 并发冲突治理与数据一致性**:
   - 内存直通更新（In-Memory Fast-Path）：已在缓冲中的 Key 立即在内存中同步执行原子累加或计算，0 次数据库读 RTT。
   - 初次查询防击穿链（In-Flight Deduplication）：并发首更复用在途 Promise 链，排队执行，杜绝丢失更新（压力测试 50 并发累加 100% 准确）。
   - 读己之写（RYW）保证：`get(k)` 优先内存直通命中，`find()` / `getRecord()` 前置透明排空。

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
- `test/unit/auto-batch.test.ts`: 全量 18 项深度测试全部通过。
- `examples/22-auto-batch-coalescing.ts`: 官方高并发写聚合实战示例。

---

## 4. 全量验证结果

- `pnpm test`: **208 tests passing (100% 全部通过，20 个测试套件)**，耗时 1.58s。
- `pnpm typecheck`: **0 errors** (TypeScript 严苛类型检查完全通过)。
- `pnpm build`: **构建成功**，输出 ESM、CJS 与 `.d.ts` 类型定义。
- `pnpm examples`: **22 个官方实战示例全部成功运行通过 (100%)**。

---

## 3. 涉及与修改的核心文件

- `src/drivers/postgres/postgres-driver.ts`: 表名 ANSI 转义、`setRecords`/`deleteRecords` 批量 SQL 实现、Keyset 游标流式 `iterator`。
- `src/drivers/mongodb/mongodb-driver.ts`: `MongoSchemaTable` 原生 `bulkWrite` 与 `deleteMany` 批处理支持。
- `src/drivers/sqlite/sqlite-driver.ts`: `find` 动态语句 LRU 缓存与失效机制、事务函数持久化复用。
- `src/drivers/postgres/dialect.ts` & `src/drivers/sqlite/dialect.ts`: 列标识符精准转义。
- `src/core/table.ts`: `applyPatch` 原型链安全过滤、Hook 零开销快速通路、AutoIndex 异步化索引。
- `src/query/parser.ts`: 原型链污染防御拦截、分页 `limit`/`offset` 非负安全整数断言。
- `src/core/serializer.ts`: `canonicalize` 零无用内存分配重构。
- `src/core/auto-index.ts`: `maxIndexed: 200` 容量硬上限防护。
- `src/cache/stores/sqlite-store.ts`: ANSI 表名转义、过期索引、事务函数复用。
- `test/unit/audit-security-performance.test.ts`: 新增 6 大全量安全与性能集成测试章节（Sections 13-18），共 23 项深度测试全部绿灯。
- `docs/AI/DECISIONS.md`: 记录 `KD-SEC2`, `KD-PERF2`, `KD-PERF3` 架构与技术决策。
- `docs/AI/TASK_INDEX.md`: 登记并闭环 `TASK-025-DEEP-AUDIT-HARDENING`。
- `docs/AI/tasks/TASK-025-DEEP-AUDIT-HARDENING.md`: 完整任务规格与技术验收文档。

---

## 4. 全量验证结果

- `pnpm test`: **190 tests passing (100% 全部通过)**，耗时 1.17s。
- `pnpm typecheck`: **0 errors** (TypeScript 严苛类型检查完全通过)。
- `pnpm build`: **构建成功**，输出 ESM、CJS 与 `.d.ts` 类型定义。
- `pnpm examples`: **21 个官方实战示例全部成功运行通过 (100%)**。

---

## 5. 当前技术债务与后续展望

1. **多驱动端到端环境测试 (Milestone 3)**:
   - SQLite 纯内存与真实磁盘文件测试全部 100% 覆盖。
   - PostgreSQL 与 MongoDB 驱动通过深度 Mock、AST 编译及结构断言测试。后续可在独立 CI/CD Docker 环境下执行外部容器端到端集成测试。
