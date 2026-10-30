# TASK-036-ADVANCED-PRODUCTIVITY-EXTENSIONS: 中长期高价值进阶功能落地 (软删除、PubSub、分块Blob、可观测性)

> **状态**: COMPLETED_AND_VERIFIED  
> **所属里程碑**: Milestone 3+ (生产级功能扩展与生态演进)  
> **依赖**: TASK-035-UNIVERSAL-DEVELOPER-EXTENSIONS  
> **责任文件范围**: 
> - `src/core/table.ts` (软删除与恢复: delete, get, find, restore, hardDelete)
> - `src/pubsub/*` (变更监听与跨实例 Pub/Sub 事件广播)
> - `src/blob/*` (大对象分块存取 Chunked Blob: putBlob, getBlob, deleteBlob)
> - `src/metrics/*` (内置可观测性指标 Metrics 与 APM/OTel 钩子)
> - `src/core/kvdb.ts` (门面暴露: pubsub, getMetrics, resetMetrics)
> - `src/index.ts` (导出定义与契约)
> - `docs/SPEC.md` (规范更新 §23-§26)
> - `docs/AI/SKILL.md` (AI 技能库与接入全景指南更新)
> - `test/unit/advanced-extensions.test.ts` (全量单元测试与压力测试)

---

## 1. 任务背景与核心目标

经过对生产级开发需求的深入评估，以下 4 个功能模块具备极高的业务价值和开发性价比：

1. **软删除与恢复 (Soft Delete & Restore)**：
   - 企业级应用防止误删核心数据，支持标记 `_deletedAt` 并自动在 `get`、`find` 中过滤。
   - 提供 `table.restore(key)` 恢复误删记录，提供 `table.hardDelete(key)` 永久硬删除。
2. **变更监听与事件广播 (Pub/Sub & Watch)**：
   - 支持跨实例、跨进程事件发布订阅（`db.pubsub()`），提供 `table.watch(key, callback)`。
   - 单进程走内存高速分发，多进程基于持久化事件流表跨实例广播，100% 运行于所有 5 种数据库（含 SQLite `:memory:`）。
3. **大对象分块存取 (Chunked Blob Storage)**：
   - 突破 MongoDB 16MB 单文档限制、MySQL `max_allowed_packet` 限制与 Redis/SQLite 大单键性能瓶颈。
   - 将图片、PDF、超大 JSON 自动切片为 256KB 分块并维护元数据 Manifest，提供 `putBlob`、`getBlob`、`deleteBlob`。
4. **内置可观测性指标 (Observability & Metrics)**：
   - 原生统计读写 QPS、缓存命中率、慢查询与延时分位数（P95/P99）、锁竞争与队列积压指标。
   - 零外部 npm 依赖，提供轻量 APM / OpenTelemetry 导出钩子。

---

## 2. 验收结果与验证记录

1. **零外部重依赖**：不强行绑定外部消息队列或 S3 服务，全量基于现有底层驱动抽象与 KVDB 架构。
2. **多数据库通用基准**：在 SQLite 内存模式 (`:memory:`) 与磁盘模式、PostgreSQL、MySQL、MongoDB、Redis 全量运行无阻。
3. **类型安全与严格检查**：`pnpm typecheck` 严格通过，双格式打包正常。
4. **全量单测通过**：新增 `test/unit/advanced-extensions.test.ts`，304 个测试用例（30 个测试文件）100% 绿灯。
5. **官方示例验证**：全量 26 个官方用例通过 `pnpm examples` 100% 正常运行。
6. **文档升级**：同步完成 `docs/SPEC.md` (§23-§26) 与 `docs/AI/SKILL.md` (7.7-7.10 节)。
