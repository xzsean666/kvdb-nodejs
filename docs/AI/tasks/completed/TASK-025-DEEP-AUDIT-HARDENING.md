# TASK-025-DEEP-AUDIT-HARDENING — 全面安全漏洞修复与极端性能瓶颈突破

## 1. 目标与范围 (Goal & Scope)

基于全量代码安全与性能审计结果，全面消除工程中潜藏的安全隐患（SQL 关键字碰撞、原型链污染、装饰器缓存键混淆、分页越界与 AutoIndex 内存溢出），并针对高并发大数据量场景突破极致性能瓶颈（PostgreSQL/MongoDB Schema 表批量操作 10x-100x 吞吐跃升、PostgreSQL 大表游标流式分页杜绝 OOM、序列化器热路径 GC 瘦身、Hook 零开销快速路径、SQLite 查询语句 LRU 缓存与 AutoIndex 非阻塞异步解耦）。

---

## 2. 详细改造项清单 (Action Items)

### 安全加固维度 (Security Hardening)
1. **S1. SQL 标识符严格 ANSI 双引号转义**:
   - `PostgresSchemaTable`: 所有原生 SQL 中的物理表名与列名添加双引号转义 `"${this.table}"`。
   - `SqliteCacheStore`: 物理表名统一添加双引号转义 `"${this.table}"`。
   - `SqliteDialect` / `PostgresDialect`: `column` 属性默认添加转义保护。
2. **S2. 原型链污染与敏感键深层拦截**:
   - `Table.applyPatch`: 严格过滤 `__proto__`, `constructor`, `prototype`，避免对象展开或合并带来的原型污染。
   - `query/parser.ts`: `parseWhere` 与 `parseSchemaWhere` 过滤或拦截 `__proto__`, `constructor`, `prototype` 敏感查询键。
3. **S3. 装饰器缓存键碰撞防御**:
   - `decorators/cache-key.ts`: 引入安全分隔与防碰撞结构序列化；严密约束 `CacheableKey` 识别逻辑，防止普通业务对象的 `cacheKey` 属性意外覆盖整个对象。
4. **S4. 分页参数严格校验 (Soundness)**:
   - `query/parser.ts` 的 `parseFindOptions`: 对 `limit` 与 `offset` 进行非负安全整数断言（`Number.isSafeInteger(n) && n >= 0`），拦截负数与 NaN。
5. **S5. AutoIndexManager 内存与 DDL 边界控制**:
   - 对 `indexed` 集合设定容量上限（`maxIndexed = 200`）及路径深度限制，防止恶意动态路径耗尽堆内存与数据库索引。

### 极致性能突破维度 (Performance & Throughput)
1. **P1. PostgreSQL & MongoDB Schema 表批量操作支持 (Batch setRecords / deleteRecords)**:
   - `PostgresSchemaTable`: 实现单事务批量 `setRecords` 与基于 `WHERE "${pk}" = ANY($1)` 的批量 `deleteRecords`。
   - `MongoSchemaTable`: 实现基于 `bulkWrite` 的批量 `setRecords` 与基于 `{ _id: { $in: keys } }` 的批量 `deleteRecords`。
2. **P2. PostgreSQL 大表遍历内存安全与流式 Keyset 分页 (Streaming Keyset Pagination)**:
   - `PostgresDriver.iterator(prefix)`: 改造为按主键批量分块拉取（500 条/批）并逐条 yield，将内存复杂度从 $O(N)$ 降低至 $O(1)$，杜绝大表遍历 OOM。
3. **P3. Serializer 高频写入热路径 GC 与字符串开销深度优化**:
   - `core/serializer.ts`: 正常序列化路径彻底移除 `path` 字符串拼接；重构对象属性遍历与 `undefined` 过滤，消除多余中间数组分配；针对小对象与基础类型优化 `WeakSet` 分配。
4. **P4. Hook 运行时零开销快速路径 (Zero-Cost Default Path)**:
   - `core/table.ts`: 调用各生命周期 hook 前做 `this.deps.hooks.has(hook)` 同步检查，无插件时完全规避 payload 堆对象分配与 Promise 调度。
5. **P5. AutoIndex DDL 非阻塞后台异步化**:
   - `core/table.ts`: 将自动索引创建从当前查询的临界区中剥离，采用非阻塞后台异步构建，确保查询请求毫秒级返回，彻底消除 P99 毛刺。
6. **P6. SQLite Statement 缓存与复用**:
   - `SqliteDriver` / `SqliteSchemaTable`: 对动态编译的查询语句维护微型 LRU 缓存，相同结构查询直接复用已编译语句。
   - `SqliteCacheStore`: 缓存批量操作事务闭包函数。

---

## 3. 验收标准 (Acceptance Criteria)

1. 全量 180+ 既有单元测试与合规测试 100% 通过。
2. 新增专门覆盖上述 S1~S5、P1~P6 的针对性审计测试用例，覆盖率 100%。
3. 21 个官方示例代码运行全部通过。
4. `pnpm typecheck` 0 报错，`pnpm build` 正常生成产物。
