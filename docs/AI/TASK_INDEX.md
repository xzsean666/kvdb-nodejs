# TASK_INDEX.md — 全局任务索引与状态跟踪

> 本文件是所有开发任务的中心索引。
> 任务状态遵循：`TODO` -> `IN_PROGRESS` -> `REVIEW` -> `DONE`（或 `BLOCKED`）。
> 任何单个会话仅允许聚焦并执行一个依赖已满足的任务。

---

## 1. 任务全局汇总

| Task ID | 任务名称 | 里程碑 | 状态 | 依赖 | 责任文件范围 |
|---|---|---|---|---|---|
| **TASK-001** | 工程脚手架与构建配置 | M1 | **DONE** | None | `package.json`, `tsconfig.json`, `tsup.config.ts`, `vitest.config.ts` |
| **TASK-002** | 核心契约与能力标志抽象 | M1 | **DONE** | TASK-001 | `src/drivers/types.ts`, `src/cache/types.ts`, `src/core/errors.ts` |
| **TASK-003** | 序列化器、Key 工具与 TTL 助手 | M1 | **DONE** | TASK-002 | `src/core/serializer.ts`, `src/core/key.ts`, `src/core/expiry.ts` |
| **TASK-004** | 独立 Cache 子系统与 SWR 引擎 | M1 | **DONE** | TASK-002 | `src/cache/*` |
| **TASK-005** | 统一查询 AST、解析器与 SQL 编译器 | M1 | **DONE** | TASK-002 | `src/query/*` |
| **TASK-006** | SQLite 基础 KV 驱动实现 | M1 | **DONE** | TASK-002..005 | `src/drivers/sqlite/*` |
| **TASK-007** | 核心门面 API (KVDB 与 Table) | M1 | **DONE** | TASK-006 | `src/core/kvdb.ts`, `src/core/table.ts`, `src/index.ts` |
| **TASK-008** | 跨后端合规测试套件基础 | M1 | **DONE** | TASK-007 | `test/compliance/*` |
| **TASK-009** | PostgreSQL 基础 KV 驱动实现 | M1 | **DONE** | TASK-007 | `src/drivers/postgres/*` |
| **TASK-010** | MongoDB 基础 KV 驱动实现 | M1 | **DONE** | TASK-007 | `src/drivers/mongodb/*` |
| **TASK-011** | SQLite Cache 存储后端适配 | M1 | **DONE** | TASK-004, 006 | `src/cache/stores/sqlite-store.ts` |
| **TASK-012** | TC39 标准装饰器实现 | M1 | **DONE** | TASK-004 | `src/decorators/*` |
| **TASK-013** | 插件与钩子运行时 | M1 | **DONE** | TASK-007 | `src/plugins/*` |
| **TASK-014** | 后台 TTL 清理与自动索引建议引擎 | M1 | **DONE** | TASK-007 | `src/core/auto-index.ts`, `src/core/kvdb.ts` |
| **TASK-015** | 动态多键（Multi-Key）契约与类型定义 | M2 | **DONE** | TASK-002 | `src/core/table-schema.ts`, `src/core/errors.ts` |
| **TASK-016** | 动态 Key 扩展与物理表自动演进机制 | M2 | **DONE** | TASK-015 | `src/core/table-schema.ts`, `src/core/table.ts` |
| **TASK-017** | SQLite 动态多键存储与索引驱动实现 | M2 | **DONE** | TASK-015, 016 | `src/drivers/sqlite/*` |
| **TASK-018** | PostgreSQL 动态多键存储与索引驱动实现 | M2 | **DONE** | TASK-015..017 | `src/drivers/postgres/*` |
| **TASK-019** | MongoDB 动态多键与复合索引驱动实现 | M2 | **DONE** | TASK-015..017 | `src/drivers/mongodb/*` |
| **TASK-020** | Table API 多键统一点查与索引直连查询 | M2 | **DONE** | TASK-015..017 | `src/core/table.ts`, `src/query/*` |
| **TASK-021** | 跨后端动态多键与索引合规测试套件 | M2 | **DONE** | TASK-017..020 | `test/compliance/multikey-compliance.ts` |
| **TASK-022** | 动态多键使用规范、示例与文档发布 | M2 | **DONE** | TASK-021 | `docs/SPEC.md`, `examples/*` |
| **TASK-023-AUDIT** | 全面安全/性能/逻辑审计与生产级修复及文档升级 | M2+ | **DONE** | TASK-022 | `src/*`, `test/unit/audit-*`, `docs/*` |
| **TASK-025-DEEP-AUDIT-HARDENING** | 全面安全漏洞修复与极端性能瓶颈突破 | M2+ | **DONE** | TASK-023-AUDIT | `src/*`, `test/unit/*` |
| **TASK-024** | 查询结果缓存 (Query Cache + Write Invalidation) | M3 | **DONE** | TASK-020 | `src/core/table.ts`, `src/cache/*` |
| **TASK-025-CACHE** | Cache 前缀清理能力 (deleteByPrefix) | M3 | **DONE** | TASK-004 | `src/cache/*` |
| **TASK-026** | PostgreSQL 与 MongoDB 真实 Docker 环境合规验证 | M3 | **DONE** | TASK-008, 021 | `test/compliance/*` |
| **TASK-027** | Redis 与 MySQL 驱动扩展与全生态合规 | M3 | **DONE** | TASK-007 | `src/drivers/*`, `src/cache/*`, `src/query/*` |
| **TASK-028-QUEUE** | 生产级可靠任务队列子系统 (Queue Subsystem) | M3 | **DONE** | TASK-020 | `src/queue/*`, `src/core/kvdb.ts` |
| **TASK-029-AUTO-BATCH** | 高性能微批处理与写聚合子系统 (Auto Batch & Write Coalescing) | M3 | **DONE** | TASK-020 | `src/core/batcher.ts`, `src/core/table.ts`, `src/core/kvdb.ts`, `src/drivers/*` |
| **TASK-031-SECURITY-PERF-HARDENING** | 全面安全漏洞修复与架构性能深度优化 | M3 | **DONE** | TASK-029-AUTO-BATCH | `src/*`, `test/unit/*` |
| **TASK-032-PRODUCTION-READY** | 生产就绪度深度审计与工业级生产加固 | M3 | **DONE** | TASK-031-SECURITY-PERF-HARDENING | `src/*`, `test/*`, `package.json` |
| **TASK-033-PRODUCTION-AUDIT-REMEDIATION** | 生产环境深度缺陷与短板全量加固 | M3+ | **DONE** | TASK-032-PRODUCTION-READY | `src/*`, `test/*`, `package.json` |
| **TASK-034-PRODUCTION-HARDENING-UPGRADE** | 生产缺陷全面修复与高可用性能升级 | M3+ | **DONE** | TASK-033-PRODUCTION-AUDIT-REMEDIATION | `src/*`, `test/*`, `docs/*` |
| **TASK-035-UNIVERSAL-DEVELOPER-EXTENSIONS** | 全数据库通用的高频高价值开发者功能模块扩展 | M3+ | **DONE** | TASK-034-PRODUCTION-HARDENING-UPGRADE | `src/lock/*`, `src/limiter/*`, `src/idempotency/*`, `src/schedule/*`, `src/adapters/*`, `src/core/*` |

---

## 2. 状态流转总览

- **已完成 (DONE)**: TASK-001 ~ TASK-035 全部任务 (共 35 项任务已 100% 全部完成交付)
- **进行中 (IN_PROGRESS)**: 0 项
- **后续规划 (TODO)**: 0 项
- **待审查/验证中 (REVIEW)**: 0 项
- **已阻塞 (BLOCKED)**: 0 项

---

## 3. 当前主线执行链路

### 当前主线: Milestone 3+ (工业级生产就绪与高价值功能扩展)

- **Milestone 1**: 核心 KV 存储与基础驱动架构 (100% DONE)
- **Milestone 2**: 动态多键与物理索引架构 (100% DONE)
- **Milestone 3**:
  - [x] TASK-029-AUTO-BATCH: 高性能微批处理与写聚合子系统 (DONE)
  - [x] TASK-031-SECURITY-PERF-HARDENING: 全面安全漏洞修复与架构性能深度优化 (DONE)
  - [x] TASK-032-PRODUCTION-READY: 生产就绪度深度审计与工业级生产加固 (DONE)
  - [x] TASK-033-PRODUCTION-AUDIT-REMEDIATION: 生产环境深度缺陷与短板全量加固 (DONE)
  - [x] TASK-034-PRODUCTION-HARDENING-UPGRADE: 生产缺陷全面修复与高可用性能升级 (DONE)
  - [x] TASK-035-UNIVERSAL-DEVELOPER-EXTENSIONS: 全数据库通用的高频高价值开发者功能模块扩展 (DONE)


