# TASK-031: 全面安全漏洞修复与架构性能深度优化 (Security & Performance Hardening)

## Objective
全面修复工程在系统级审计中发现的安全缺陷（原型链属性绕过、NoSQL 运算符注入、JSON 默认值 DDL 崩溃）与重大性能/一致性瓶颈（未排空定时器 unref 数据丢失、Schema Table 单例复用与 RYW 保障、PostgreSQL setMany Multi-Row 聚合、内存直通深拷贝优化）。

## Scope
1. **安全修复**:
   - `src/core/table-schema.ts`: `validateKeyValues` 使用 `Object.prototype.hasOwnProperty` 替换 `key in schemaKeys`，杜绝原型属性穿透。
   - `src/drivers/mongodb/mongodb-driver.ts`: `getRecordByKey` 采用 `{ $eq: keyValue }` 明确操作符，阻断 NoSQL 运算符注入。
   - `src/drivers/postgres/postgres-driver.ts` & `src/drivers/sqlite/sqlite-driver.ts`: `pgDefault` 与 `sqlDefault` 正确序列化对象类型默认值为 JSON 字符串字面量。
2. **性能与可靠性优化**:
   - `src/core/batcher.ts`: 存在 pending 任务时定时器保持活动（移除过早 unref），彻底解决短生命周期脚本提前退出导致数据丢失的问题。
   - `src/core/kvdb.ts`: `table()` 方法支持 Schema 表规范化指纹匹配与单例复用，根除多实例内存泄漏与 RYW 穿透缺陷。
   - `src/drivers/postgres/postgres-driver.ts`: `setMany` 升级为参数化 Multi-Row 单条 SQL 聚合执行，消除 N-RTT 网络往返。
   - `src/core/table.ts`: `Table.get` 内存直通读取采用 `structuredClone` 提升吞吐与降低 GC 开销。
3. **验证与回归测试**:
   - 编写针对性单元测试（验证上述所有安全缺陷与性能瓶颈的修复）。
   - 全量回归测试 214+ 全部通过，全量 22 个 examples 运行无报错。

## Allowed Files
- `src/core/table-schema.ts`
- `src/core/batcher.ts`
- `src/core/kvdb.ts`
- `src/core/table.ts`
- `src/drivers/postgres/postgres-driver.ts`
- `src/drivers/sqlite/sqlite-driver.ts`
- `src/drivers/mongodb/mongodb-driver.ts`
- `test/unit/audit-security-performance.test.ts`
- `docs/AI/TASK_INDEX.md`
- `docs/AI/SESSION_STATE.md`
- `docs/AI/DECISIONS.md`

## Dependencies
TASK-029-AUTO-BATCH, TASK-030-PRODUCTION-HARDENING

## Acceptance Criteria
1. `validateKeyValues` 传入 `toString`、`valueOf`、`constructor` 等原型名称时坚决抛出 `KvdbSchemaError`。
2. `getRecordByKey` 无法被 `{ $ne: null }` 等对象运算符注入。
3. `type: "json"` 列的默认值对象在 SQLite 和 PostgreSQL 下生成合法的 JSON 字符串 DDL。
4. CLI 脚本直接 `await table.set(...)` 无需额外 `flush()` 即可可靠等待落地并自然退出，无 unsettled top-level await 警告。
5. 同一 namespace 传入等价 schema 多次调用 `db.table()` 返回相同单例实例，保障跨模块 RYW 强一致性。
6. `PostgresDriver.setMany` 执行单条 multi-row 参数化 SQL。
7. 全量测试通过，TypeScript 类型检查 0 报错，构建成功。

## Verification Commands
- `pnpm test`
- `pnpm typecheck`
- `pnpm build`
- `pnpm examples`

## Status
DONE
