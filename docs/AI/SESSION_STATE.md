# SESSION_STATE.md — 当前工程会话状态与跨 Session 交接

> 本文件是跨 AI 会话恢复的直接事实来源。
> 每次会话开始时**必须首先读取本文件**，每次会话结束前**必须更新本文件**。

---

## 1. 核心状态概要

- **当前 Goal**: Milestone 3 生产级功能扩展与生态演进
- **当前 Task**: 查询结果缓存与写失效 (TASK-024) & Cache 前缀清理 (TASK-025-CACHE)
- **当前状态**: **COMPLETED_AND_VERIFIED** (代码实现、规范指纹哈希、多层级前缀清理、单写/批写自动失效、单测与实战示例 100% 绿灯全部交付)

---

## 2. 本次任务交付清单 (TASK-024 & TASK-025-CACHE)

### A. Cache 前缀清理能力 (TASK-025-CACHE)
1. **接口契约**:
   - `src/cache/types.ts`: `KVStore` 接口扩充可选契约 `deleteByPrefix?(prefix: string): MaybePromise<number>`。
2. **底层存储驱动实现**:
   - `src/cache/stores/memory-store.ts`: 实现基于 LRU 迭代器的安全前缀匹配批量删除。
   - `src/cache/stores/sqlite-store.ts`: 实现单条 SQL `DELETE FROM "table" WHERE key LIKE ? ESCAPE '\\'` 原子极速清理（带通配符 `_`, `%`, `\` 转义安全）。
3. **缓存门面层级清理**:
   - `src/cache/cache.ts`: `Cache.deleteByPrefix(prefix)` 支持遍历各级存储层，优先调用驱动原生 `deleteByPrefix`，无原生支持时自动降级安全迭代清理。

### B. 查询结果缓存与自动写失效 (TASK-024)
1. **查询规范指纹与 AST 序列化**:
   - `src/core/table.ts`: 实现 `canonicalQueryString(query)`，递归深度对过滤对象键名排序并序列化，消除 JSON 字段乱序造成的缓存击穿。
2. **零配置 / 可选配置 Query Cache**:
   - `TableOptions` 扩充 `queryCache?: boolean | QueryCacheOptions`（含 `ttl`, `prefix` 等配置）。
   - `find()` 与 `findRecords()` 先行计算 `_qc:<namespace>:<hash>` 并查表内 Cache，未命中时执行物理驱动查询并自动回填。
3. **全局写变更原子失效 (Write Invalidation)**:
   - 全局写突变 (`set`, `delete`, `update`, `setMany`, `deleteMany`, `clear`, `deleteByPrefix`, `flushBatch`) 自动调用 `cache.deleteByPrefix("_qc:" + namespace + ":")` 精确写失效，彻底杜绝脏读。
4. **门面集成与导出**:
   - `src/core/kvdb.ts` & `src/index.ts`: 导出 `QueryCacheOptions`。

---

## 3. 涉及与修改的核心文件

- `src/cache/types.ts`: `KVStore.deleteByPrefix`。
- `src/cache/stores/memory-store.ts`: 内存缓存前缀删除。
- `src/cache/stores/sqlite-store.ts`: SQLite 缓存高效 SQL 前缀删除与转义。
- `src/cache/cache.ts`: `Cache.deleteByPrefix` 门面。
- `src/core/table.ts`: 查询缓存选项、规范查询指纹、查询拦截回填、写操作自动失效。
- `src/core/kvdb.ts`: `QueryCacheOptions` 导出与 Table 构造透传。
- `src/index.ts`: 导出 `QueryCacheOptions`。
- `test/unit/cache.test.ts`: 前缀删除与通配符转义单测。
- `test/unit/query-cache.test.ts`: 7 项查询缓存与写失效单测。
- `examples/24-query-cache-and-invalidation.ts`: 实战示例。
- `docs/AI/tasks/TASK-024.md`: 任务卡片。
- `docs/AI/tasks/TASK-025-CACHE.md`: 任务卡片。
- `docs/AI/TASK_INDEX.md`: 任务索引更新为 DONE。

---

## 4. 全量验证结果

- `pnpm test`: **242 tests passing (100% 全部通过，23 个测试套件，0 失败)**。
- `pnpm typecheck`: **0 errors** (严苛 TypeScript 检查通过)。
- `pnpm build`: **构建成功**，输出 ESM、CJS 与 `.d.ts` 类型定义。
- `pnpm examples`: **24 个官方实战示例全部成功运行通过 (100%)**。

---

## 5. 下一步工作规划 (Milestone 3 待开发项)

1. **TASK-026 (PostgreSQL 与 MongoDB 真实 Docker 环境合规验证)**:
   - 建立 Docker 驱动容器矩阵，执行全套 compliance 测试。
2. **TASK-027 (Redis 与 MySQL 驱动扩展)**:
   - 接入 Redis 驱动与 MySQL 驱动。
