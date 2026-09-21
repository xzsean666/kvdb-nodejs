# GOAL.md — KVDB SDK 核心目标与演化路线

> 本文件是项目的总目标与长期规划事实来源（Source of Truth）。
> 任何功能扩展与架构调整均需对齐本文档设定的目标与边界。

---

## 1. 项目定位与核心愿景

**KVDB SDK** 是一个面向 Node.js 的**高性能、多驱动、可扩展**的 Key-Value 与真实物理 Schema Database SDK。

### 核心定位

- **统一数据接口**：提供直观的 `db.table("name")` 操作门面，抹平底层数据库差异（当前支持 SQLite、PostgreSQL、MongoDB；后续规划 Redis、MySQL）。
- **双层契约分离**：
  - 最低层 `KVStore`：针对缓存与极简 KV 存储，提供纯粹的键值存取能力。
  - 富层 `Driver`：提供多后端 JSON 查询、前缀扫描、物理列映射、索引管理和原生能力暴露。
- **动态多键（Multi-Key）与原生索引**：
  - 突破传统 KV 仅支持单主键字符串的限制，支持一条记录定义多个不同类型的检索键（如数值型主键、二级键、哈希、状态等）。
  - 支持随时动态增加检索 Key，底层自动完成物理列演进与单列/复合 B-Tree 索引创建。
  - 搜索直接命中检索 Key，享受底层数据库原生索引加速；`value` 作为纯净载荷（Payload）高效持久化，免除在深层 JSON 内部低效模糊扫描。
- **独立 Cache 子系统**：
  - 分层存储架构（Memory / SQLite-Memory / SQLite-File）。
  - 提供 `wrap()` 引擎与 Stale-While-Revalidate (SWR) 刷新支持。
- **现代化装饰器与插件**：
  - 基于 TC39 标准装饰器（TypeScript 5.x 原生），提供声明式缓存能力（`@Cacheable`、`@CacheClear`）。
  - 基于洋葱模型的 Plugin / Hook 运行时，方便拦截与链路追踪。
- **自动化运维**：
  - 基于 `unref` 定时器的后台 TTL 自动清理。
  - 基于查询模式分析的自动索引建议与可选自动创建（Opt-in）。

---

## 2. 演进里程碑 (Milestones)

### Milestone 1: 核心 KV 存储与基础驱动架构 (已完成 ✅)
- [x] 工程脚手架与 TypeScript 5.8 + ESM/CJS 双产物配置
- [x] 核心契约抽象（`KVStore`、`Driver`、`capabilities`、错误分级体系）
- [x] Canonical JSON 序列化器与命名空间 key 解析
- [x] 独立 Cache 子系统（MemoryStore、SqliteStore、分层 Fallback、SWR wrap）
- [x] 统一查询 AST 解析器与 SQLite Dialect 查询下降
- [x] SQLite 驱动实现（better-sqlite3）
- [x] PostgreSQL 与 MongoDB 驱动实现（核心代码就绪，待真实服务端到端验证）
- [x] TC39 标准装饰器实现与参数稳定序列化
- [x] 插件/钩子运行时系统
- [x] 基础单测套件（96 个单测全绿）与跨后端驱动合规套件骨架

### Milestone 2: 动态多键（Multi-Key）与原生索引架构 (当前进行中 ⏳)
- [ ] 动态多键契约与类型定义（`primaryKey` 声明、二级检索键声明、多类型支持）
- [ ] 动态 Key 扩展与物理表自动演进机制（支持随时增键与幂等创建索引）
- [ ] SQLite 动态多键驱动实现（支持数值/字符串主键、物理二级键、复合 B-Tree 索引）
- [ ] PostgreSQL 动态多键驱动实现（多键映射与复合索引加速）
- [ ] MongoDB 动态多键与顶级字段复合索引实现
- [ ] Table API 升级（主键点查、二级键点查 `getBy`、直连物理 Key 索引查询）
- [ ] 跨后端真实多键合规测试套件（SQLite / PG / Mongo）
- [ ] 动态多键实战示例与发布验证（`examples/16-dynamic-multi-keys.ts`）

### Milestone 3: 生产级验证与高级功能扩展 (规划中 📅)
- [ ] 在 Docker / 真实环境中完成 PostgreSQL 与 MongoDB 端到端合规验证并回填测试状态
- [ ] 查询级缓存（Query Cache：`find()` 结果缓存与写入自动失效）
- [ ] 缓存前缀清理能力（`Cache.deleteByPrefix`，让 `Table.clear()` 级联清空对应缓存）
- [ ] SQL 后端对高级嵌套查询（如 `$elemMatch`）的原生/虚拟支持
- [ ] 扩展后端支持：Redis 驱动适配器
- [ ] 生产级可靠任务队列子系统 (Queue Subsystem：原子租约、Visibility Timeout、指数退避重试、死信队列、全托管 Worker)
- [ ] CI/CD 自动化流水线（Lint、Prettier、Matrix 驱动测试）

---

## 3. 验收基准与非目标

### 验收基准
1. **真实数据库验证**：任何声明完成的驱动，必须在真实数据库（无 Mock）上通过驱动合规套件测试。
2. **渐进可扩展**：添加新后端驱动只需实现 `Driver` 契约与 AST Visitor，不侵入核心 Core 逻辑。
3. **严格向后兼容**：所有普通 KV 接口行为不受 Schema Table 升级影响；所有公开 API 变动有明确版本演进说明。

### 非目标 (Non-Goals)
- 不自己造连接池轮子（透传各后端成熟连接池，如 `pg.Pool`、`MongoClient`）。
- 不把底层降级为最低公分母（通过 `capabilities` 和 `raw()` 逃生通道保留各数据库独特能力）。
- 不在数据写入路径进行隐式 DDL / 自动改表（所有结构变更走显式迁移）。
- 不使用正在废弃的旧版 TypeScript `experimentalDecorators`。
