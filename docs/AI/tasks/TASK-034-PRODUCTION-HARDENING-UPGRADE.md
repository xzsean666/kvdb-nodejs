# TASK-034-PRODUCTION-HARDENING-UPGRADE: 生产缺陷全面修复与高可用性能升级

> **状态**: COMPLETED_AND_VERIFIED  
> **所属里程碑**: Milestone 3+ (生产就绪与生态演进)  
> **依赖**: TASK-033-PRODUCTION-AUDIT-REMEDIATION  
> **责任文件范围**: 
> - `src/core/batcher.ts`
> - `src/core/table.ts`
> - `src/core/serializer.ts`
> - `src/drivers/types.ts`
> - `src/drivers/sqlite/sqlite-driver.ts`
> - `src/drivers/postgres/postgres-driver.ts`
> - `src/drivers/mysql/mysql-driver.ts`
> - `src/drivers/mysql/dialect.ts`
> - `src/drivers/mongodb/mongodb-driver.ts`
> - `src/drivers/redis/redis-driver.ts`
> - `src/queue/queue.ts`
> - `test/unit/production-hardening-upgrade.test.ts`

---

## 1. 任务背景与目标

在经过全方位的生产就绪度审计后，发现了 1 项致命的 Node.js 现代运行时阻断问题（P0）、2 项高并发/大数据集下的严重性能瓶颈与 OOM 隐患（P1）、以及 2 项精度与规范性问题（P2）。

本次任务的目标是：
1. **[P0] 修复 WriteBatcher 防抖定时器生命周期**：移除破坏 Node.js 事件循环的 `timer.unref()`，彻底解决 ESM Top-Level Await 进程以 code 13 崩溃的阻断问题，使 26 个官方实战示例全部正常运行。
2. **[P1] 原生下推 Table.count() 与 Queue 统计防 OOM 改造**：在驱动抽象层和各数据库实现真正的 `SELECT COUNT(*)`，重构 `Queue.getStats()`，将获取队列统计的资源消耗从数百兆完整 JSON 传输降至毫秒级元数据查询；为 `clean()` 与 `retryFailed()` 增加批量流转保护。
3. **[P1] Redis Driver 检索安全与 O(N) 算法重构**：将 Redis 驱动 `find()` 的映射比对复杂度从 $O(N^2)$ 降为 $O(N)$，并增加扫描容量安全保护。
4. **[P2] MySQL JSON 路径转义优化**：为含连字符等特殊字符的 JSON 字段自动添加引号包裹 `$."field"`，消除 MySQL 语法错误。
5. **[P2] 序列化原型链防护精细化**：精准防御原型链污染，避免合法业务字段如 `constructor` / `prototype` 被无差别强制丢弃。

---

## 2. 详细改动设计

### A. WriteBatcher 定时器生命周期
- 移除 `src/core/batcher.ts` 中针对 `this.timer` 的 `unref?.()`。
- 待持久化的微批写入属于业务活跃等待队列，其防抖定时器（默认 20ms）必须保持活跃以驱动 Promise 兑现。

### B. 核心层与驱动层 count() 下推
- `src/drivers/types.ts`:
  - `Driver.count?(where?: QueryNode, keyPrefix?: string): Promise<number>`
  - `SchemaTableDriver.count?(where?: QueryNode): Promise<number>`
- `src/core/table.ts`:
  - 增加 `async count(query?: { where?: Record<string, unknown>; columns?: Record<string, unknown> }): Promise<number>`
- 各驱动实现：
  - SQLite: `SELECT COUNT(*) AS c FROM ... WHERE ...`
  - PostgreSQL: `SELECT COUNT(*) AS c FROM ... WHERE ...`
  - MySQL: `SELECT COUNT(*) AS c FROM ... WHERE ...`
  - MongoDB: `collection.countDocuments(...)`
  - Redis: 支持基于过滤条件的流式计数

### C. 任务队列 Queue 防 OOM 与批量化
- `Queue.getStats()`: 改造为 5 次并行的 `this.table.count({ where: { state: s } })`，彻底免除加载全部任务实体的开销。
- `Queue.clean()` / `Queue.retryFailed()`: 增加默认分批限制（每次最多处理 500 条），防止单次事务膨胀或内存溢出。

### D. Redis Driver 检索效率优化
- 废除嵌套 `.find()` 算法，采用 Map 构建 $O(1)$ 查找字典。

### E. MySQL Dialect 语法加固
- `MysqlDialect`: 规范化 `jsonPath`，对于带有特殊字符的 segment 使用 `$."key"`。

---

## 3. 验收标准

1. `pnpm typecheck` 严格通过，无类型错误。
2. `pnpm test` 单元测试套件 100% 绿灯，新增覆盖测试。
3. `pnpm examples` 官方实战示例全部成功运行，零 code 13 崩溃。
4. `pnpm build` 双格式产物打包平稳，大小保持轻量。
