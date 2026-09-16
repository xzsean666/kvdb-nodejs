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
| **TASK-023** | 查询结果缓存 (Query Cache + Write Invalidation) | M3 | **TODO** | TASK-020 | `src/core/table.ts`, `src/cache/*` |
| **TASK-024** | Cache 前缀清理能力 (deleteByPrefix) | M3 | **TODO** | TASK-004 | `src/cache/*` |
| **TASK-025** | PostgreSQL 与 MongoDB 真实 Docker 环境合规验证 | M3 | **TODO** | TASK-008, 021 | `test/compliance/*` |
| **TASK-026** | Redis 与 MySQL 驱动扩展 | M3 | **TODO** | TASK-007 | `src/drivers/*` |

---

## 2. 状态流转总览

- **已完成 (DONE)**: TASK-001 ~ TASK-022 (22 项，Milestone 1 基础架构与 Milestone 2 动态多键原生索引全面完成)
- **待开发 (TODO)**: 0 项 (Milestone 2 全部任务交付完毕)
- **后续规划 (TODO)**: TASK-023 ~ TASK-026 (4 项，Milestone 3 生产级功能扩展与生态演进)

- **待审查/验证中 (REVIEW)**: 0 项
- **已阻塞 (BLOCKED)**: 0 项

---

## 3. 当前主线执行链路

### Milestone 2: 动态多键与物理索引架构 (已全部完成 100%)

```text
[TASK-015 多键契约与类型] (DONE) ──> [TASK-016 动态 Key 扩展与演进] (DONE)
                                         │
            ┌────────────────────────────┼────────────────────────────┐
            ▼                            ▼                            ▼
      [TASK-017 SQLite] (DONE)   [TASK-018 Postgres] (DONE)   [TASK-019 Mongo] (DONE)
            │                            │                            │
            └────────────────────────────┼────────────────────────────┘
                                         ▼
                         [TASK-020 Table API 点查与索引查询] (DONE)
                                         │
                                         ▼
                         [TASK-021 跨后端动态多键合规测试] (DONE)
                                         │
                                         ▼
                         [TASK-022 规范文档与实战示例发布] (DONE)
```

> **当前阶段完成**：Milestone 2 全部 8 个任务（TASK-015 ~ TASK-022）已全部顺利交付并通过完整单元、合规与示例验收。
> **下一里程碑**：Milestone 3（生产级功能扩展：TASK-023 查询结果缓存、TASK-024 Cache 前缀清理、TASK-025 容器集成测试、TASK-026 Redis/MySQL 驱动扩展）。

