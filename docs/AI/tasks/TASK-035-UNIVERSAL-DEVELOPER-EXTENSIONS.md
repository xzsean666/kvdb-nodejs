# TASK-035-UNIVERSAL-DEVELOPER-EXTENSIONS: 全数据库通用的高频高价值开发者功能模块扩展

> **状态**: COMPLETED_AND_VERIFIED  
> **所属里程碑**: Milestone 3+ (生产级功能扩展与生态演进)  
> **依赖**: TASK-034-PRODUCTION-HARDENING-UPGRADE  
> **责任文件范围**: 
> - `src/lock/*` (分布式锁与互斥子系统)
> - `src/limiter/*` (API 与业务限流子系统)
> - `src/idempotency/*` (接口与操作幂等性守护子系统)
> - `src/schedule/*` (分布式 Cron 与定时调度子系统)
> - `src/adapters/*` (通用生态适配器，含 Keyv 契约规范)
> - `src/core/table.ts` (table.increment / decrement 原生数值计算)
> - `src/core/kvdb.ts` (顶级门面 API: withLock, acquireLock, rateLimiter, idempotent)
> - `src/queue/queue.ts` (队列调度扩展: schedule, unschedule, listScheduled)
> - `src/core/errors.ts` (新增 KvdbLockError, KvdbRateLimitError, KvdbIdempotencyError)
> - `src/index.ts` (统一入口导出)
> - `docs/SPEC.md` (契约规范更新)
> - `docs/AI/SKILL.md` (AI 技能库与接入全景指南更新)
> - `test/unit/universal-extensions.test.ts` (全驱动通用测试与 SQLite 内存模式单测)

---

## 1. 任务背景与核心目标

KVDB SDK 已经具备了多数据库驱动统一抽象（SQLite、PostgreSQL、MySQL、MongoDB、Redis）、物理动态多键二级索引、独立多级缓存体系（SWR、SingleFlight、装饰器）以及基于持久化表的可靠任务队列（Queue/Worker）。

在实际业务开发（如 Web API、后台调度、支付回调、多实例集群）中，开发者普遍高频需要以下常用功能。**本次任务的核心原则是：不强依赖单一数据库（如 SQLite），以全量驱动为基准，并深度原生支持 SQLite 内存模式（`:memory:`），打造零外部依赖、开箱即用的高性价比功能库**：

1. **分布式锁与互斥控制 (`src/lock/`)**：
   - 跨进程互斥保护、库存扣减、防并发重复跑。
   - 提供 `db.withLock(key, fn, options)` 与 `db.acquireLock(key, options)`。
   - 包含自动租约 TTL、心跳守护自动续期（Auto-Heartbeat）、安全 Token 校验防误删。
   - 支持 SQLite (含 `:memory:`)、PostgreSQL、MySQL、MongoDB (CAS/行锁) 以及 Redis (SET NX PX + Lua 原子释放)。

2. **高频原子数值增减 (`table.increment` / `table.decrement`)**：
   - 支持简单数值递增与深层 JSON 属性路径（如 `stats.views`）原子修改。
   - 避免全量 JSON 反序列化后覆写带来的竞态与性能消耗，在所有数据库上保证原子性。

3. **高性能限流器 (`src/limiter/`)**：
   - API 防刷、登录防护、大模型 Token 限额、外部请求频控。
   - 提供滑动窗口算法与令牌桶算法，支持 `limiter.consume(key, tokens)` 与 `limiter.check(key)`。
   - 跨所有驱动持久化并根据 TTL 自动过期。

4. **接口与任务幂等性守护器 (`src/idempotency/`)**：
   - 解决第三方 Webhook、支付通知、表单重复提交导致的重复入账。
   - 状态机设计（`PENDING` -> `RESOLVED` / `REJECTED`），并发冲突自动等待或拦截，成功直接返回缓存结果。

5. **分布式 Cron 定时任务调度器 (`src/schedule/` 与 `Queue.schedule`)**：
   - 解决 `node-cron` 单机无法集群部署、多实例重复触发的痛点。
   - 零依赖 5 段标准 Cron 解析器，将定时任务原子调度入已有的 `Queue` 中，借助队列已有的原子争抢与租约，保证集群内**仅有一台机器执行一次，失败自动重试**。

6. **Keyv 标准生态适配器 (`src/adapters/keyv.ts` 与 `table.asKeyv()`)**：
   - 无缝桥接 Node.js 社区的 `Keyv` / `Unstorage` / Apollo 缓存生态。

---

## 2. 详细技术方案

### A. 分布式锁 (Distributed Lock)
- 接口定义：
  - `acquireLock(key: string, options?: LockOptions): Promise<LockHandle | null>`
  - `withLock<T>(key: string, fn: (handle: LockHandle) => Promise<T>, options?: LockOptions): Promise<T>`
- 租约与防脑裂机制：
  - 使用随机生成的独占 `token` (UUID v4)。
  - 自动心跳 (Auto-Heartbeat)：每 `ttlMs / 2` 自动向底层发送续期指令，任务结束或异常时取消。
  - 释放锁时强制校验 `token`，杜绝慢任务锁超时后释放了新获取锁的持有者。
- 跨驱动适配：
  - Redis：直接使用 `SET key token PX ttl NX` 与 Lua 解锁。
  - 关系型/文档型驱动（SQLite / PG / MySQL / Mongo）：使用统一锁表，通过原子 `updateRecord` 或原子 CAS 操作争抢。

### B. 原子数值操作
- `Table.increment(key, amount = 1, options?: { path?: string; ttlMs?: number; default?: number })`
- `Table.decrement(key, amount = 1, options?: { path?: string; ttlMs?: number; default?: number })`
- 针对数值或嵌套 JSON 字段原子计算，写聚合穿透（自动刷新 WriteBatcher 保证读写一致性）。

### C. 限流器 (RateLimiter)
- `db.rateLimiter({ windowMs, limit, strategy?: "sliding-window" })`
- 采用双窗口滑动加权近似算法（Sliding Window Counter），内存与存储 $O(1)$，精度达到 99.9%，自带 TTL。

### D. 幂等性守护器 (Idempotency Guard)
- `db.idempotent(key, fn, { ttlMs, timeoutMs })`
- 当首个请求到达：记录状态为 `PENDING` 并设置锁；
- 后续并发请求到达：等待当前任务完成并直接返回结果，或超时报错；
- 执行成功：更新为 `RESOLVED` 并记录返回值与过期时间；
- 执行异常：自动清理或标记为 `REJECTED`，允许后续重试。

### E. 分布式 Cron 定时器
- 内置标准 Cron 表达式解析器，支持 `* * * * *`、`*/5 * * * *`、`0 0 * * *`、`@daily`、`@hourly` 等常见格式。
- `queue.schedule(name, cronOrInterval, payload, options)`：计算下次触发时间戳 `nextRunAt`，原子推入队列延时任务。当任务被消费处理完成，Worker 自动调度下一轮任务。

### F. Keyv 适配器
- 暴露 `table.asKeyv()`，返回实现 `get(key)`, `set(key, val, ttl?)`, `delete(key)`, `clear()`, `has(key)` 的对象，零胶水代码接入第三方框架。

---

## 3. 验收标准

1. **类型检查**：`pnpm typecheck` 严格通过，无任何 TypeScript 类型警告。
2. **多驱动与内存模式合规**：所有新增功能在 SQLite 内存模式 (`:memory:`) 下实现 100% 单元测试覆盖。
3. **架构与驱动解耦**：代码无硬编码 SQLite 逻辑，契约透明支持 SQLite、PG、MySQL、Mongo、Redis。
4. **单元测试通过率**：新增全量通用测试文件 `test/unit/universal-extensions.test.ts`，全量测试套件持续保持 100% 绿灯。
5. **文档升级**：全面同步更新 `docs/SPEC.md` 与 `docs/AI/SKILL.md`，提供完整 API 与示例。
