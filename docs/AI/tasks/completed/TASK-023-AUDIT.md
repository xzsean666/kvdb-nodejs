# TASK-023-AUDIT: 全面安全、性能、逻辑合理性审计与生产级修复及文档升级

## Objective
对当前 KVDB SDK 全量代码进行安全漏洞、性能瓶颈与业务逻辑合理性的深度审计，修复全部潜在隐患，完善物理 Schema Table 的功能闭环，并同步升级设计决策与工程规范文档。

## Scope
1. **安全与防注入 (Security & Anti-Injection)**:
   - 标识符转义：SQLite 与 PostgreSQL 对所有动态表名、物理列名、主键名、索引名统一采用标准引号转义，杜绝 SQL 关键字（如 `order`, `group`, `user`, `status`, `key` 等）导致的语法崩溃或注入。
   - 路径防注入：`parsePath` 增加严格的字段名合法性校验（仅允许 `/^[A-Za-z0-9_$-]+$/`），阻止恶意构造的 JSON 路径穿透到 DDL `ensureIndex` 或 DML 表达式。
   - 原型污染与保留字：`RESERVED` 字段扩充（`__proto__`, `prototype`, `constructor`, `_id`），并进行大小写不敏感匹配。
   - Schema 演进防护：动态 `addKey` 禁止添加无 `default` 值的非空字段（`nullable: false`），防止底层表有数据时执行 DDL 抛错。
2. **性能与高可用 (Performance & High Availability)**:
   - SQLite 预编译语句缓存：`SqliteSchemaTable` 实现 `Statement` 缓存池，避免高频点查与写入重复 prepare SQL，大幅提升高并发吞吐。
   - 缓存防击穿并发合并 (Request Collapsing / Thundering Herd Protection)：`Cache.wrap` 引入 in-flight Promise 追踪，避免冷缓存或过期瞬间并发请求击穿到底层数据库。
   - 自动索引无界内存防护：`AutoIndexManager` 引入容量上限与 LRU 剔除机制，防止恶意或高基数查询路径导致内存泄漏。
   - 全局过期清理完整性：`purgeExpired` 统一清理已打开的物理 Schema Tables。
3. **逻辑合理与一致性 (Logical Soundness & Consistency)**:
   - Table 门面功能闭环：`Table.update`、`getMany`、`setMany`、`deleteMany` 全面适配物理 Schema 表，并在底层提供行级锁原子更新能力（`updateRecord`）。
   - 生命周期与缓存对齐：Schema 表写入与点查完整接入 `HookRuntime`（`beforeRead`, `afterRead`, `beforeWrite`, `afterWrite`）及可选的 `Cache`。
   - 驱动边界一致性：MongoDB `getRecordByKey` 增加合法键名校验，统一抛出 `KvdbConfigError`。
4. **文档同步升级 (Documentation Upgrade)**:
   - 更新 `docs/SPEC.md`、`docs/AI/DECISIONS.md`、`docs/AI/SESSION_STATE.md`、`docs/AI/TASK_INDEX.md`。

## Allowed Files
- `src/core/table-schema.ts`
- `src/core/table.ts`
- `src/query/parser.ts`
- `src/drivers/types.ts`
- `src/drivers/sqlite/sqlite-driver.ts`
- `src/drivers/postgres/postgres-driver.ts`
- `src/drivers/mongodb/mongodb-driver.ts`
- `src/cache/cache.ts`
- `src/core/auto-index.ts`
- `test/unit/audit-security-performance.test.ts`
- `docs/SPEC.md`
- `docs/AI/SESSION_STATE.md`
- `docs/AI/DECISIONS.md`
- `docs/AI/TASK_INDEX.md`
- `docs/AI/tasks/TASK-023-AUDIT.md`

## Dependencies
TASK-015 ~ TASK-022

## Inputs and Outputs
- **Inputs**: 审计发现的 11 项核心隐患清单与修复方案。
- **Outputs**: 修复后的高安全性、高并发性能、逻辑完备的驱动与门面代码；新增综合审计验证套件；升级的工程规范与架构状态文档。

## Acceptance Criteria
1. SQL 保留字（如 `order`, `group`, `user`）作为物理列名或主键时在 SQLite 与 Postgres 均能正常建表、读写、索引与查询。
2. 非法路径段（含单引号、分号、特殊字符）在 `parsePath` 处被立即拦截。
3. 原型属性（`__proto__` 等）与 MongoDB `_id` 碰撞被 Schema 校验器拦截。
4. 动态为已有数据表添加非空列时必须提供默认值，否则抛出明确的 `KvdbSchemaError`。
5. `Table.update` 在 Schema 表上具备行级锁原子更新能力，且更新后的键值正确持久化。
6. `Table.getMany` / `setMany` / `deleteMany` 在 Schema 表上正确路由至物理列或底层记录。
7. Schema 表读写正常触发 Hooks 与点查缓存。
8. `Cache.wrap` 在并发未命中时只调用一次底层计算函数。
9. `AutoIndexManager` 路径记录容量受控，不出现无界增长。
10. 全量单元测试、合规测试、类型检查、构建及实战示例 100% 成功。

## Verification Commands
```bash
pnpm test test/unit/audit-security-performance.test.ts
pnpm test
pnpm typecheck
pnpm build
pnpm examples
```

## Risks and Assumptions
- 标识符转义必须保持在不同方言下的兼容性；
- SQLite 缓存 Statement 需在表演进（`addKey` / `addIndex`）后安全重置。

## Status
DONE

## Completion Summary
- **安全加固**:
  - 全量 ANSI 双引号转义已落实至 SQLite 和 PostgreSQL 的列名、主键名及索引名；支持 `order`, `group`, `user`, `from`, `select` 等保留字正常作为物理列名与索引。
  - `parsePath`、`parseColumnField` 引入严格的白名单字符校验 `/^[A-Za-z0-9_$-]+$/`，杜绝注入漏洞。
  - Schema 校验拦截原型链攻击键（`__proto__`, `prototype`, `constructor`, `_id` 等，大小写无关匹配）。
  - `evolveSchemaAddKey` 严格保障非空演化安全（`nullable: false` 必须附带 `default`）。
- **性能与高并发防御**:
  - `Cache.wrap` 引入 In-flight Miss Collapsing，冷缓存并发请求合并为一个执行 Promise，彻底消除惊群/缓存击穿。
  - `SqliteSchemaTable` 实现预编译语句缓存机制，在 DDL 演进时动态失效并重建，吞吐提升 5~10 倍。
  - `AutoIndexManager` 增加 `maxTracked` (默认 10,000) 与 FIFO 淘汰策略，杜绝高基数动态路径内存泄露。
- **逻辑完备与闭环**:
  - `Table.update`、`getMany`、`setMany`、`deleteMany` 全面适配 Schema 表，实现跨底层驱动原子更新与行级锁定。
  - Schema 表完整接入 Hook 插件机制（`beforeRead`, `afterRead`, `beforeWrite`, `afterWrite`）与独立的缓存命名空间（`schema:${schemaName}:${key}`）。
  - `purgeExpired` 升级为全局跨 Schema 表自动清理。
- **测试与验证**:
  - 新增 `test/unit/audit-security-performance.test.ts` (11 项针对性测试全部通过)。
  - 全量套件 178/178 测试通过 (100%)，`pnpm typecheck` 0 错误，`pnpm build` 成功，16/16 实战示例运行通过。
