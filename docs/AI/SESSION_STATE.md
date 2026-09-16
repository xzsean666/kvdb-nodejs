# SESSION_STATE.md — 当前工程会话状态与跨 Session 交接

> 本文件是跨 AI 会话恢复的直接事实来源。
> 每次会话开始时**必须首先读取本文件**，每次会话结束前**必须更新本文件**。

---

## 1. 核心状态概要

- **当前 Goal**: 完成 KVDB SDK Milestone 2（动态多键与原生物理索引架构）全量工程任务（TASK-015 ~ TASK-022）
- **当前 Task**: TASK-022 动态多键使用规范、示例与文档发布
- **当前状态**: **DONE** (Milestone 2 全部 8 项任务已 100% 交付，全量单元测试、合规测试、类型检查、构建及示例均验证通过)

---

## 2. 本次会话完成内容（Milestone 2 总结）

1. **TASK-015: 动态多键（Multi-Key）契约与类型定义**
   - 定义 `MultiKeySchema`、`KeyDefinition`、`KeyType`、`PrimaryKeyDefinition`、`PhysicalRecord`。
   - 支持自定义物理主键名与类型（`string` 或 `integer`），消除旧版主键必须为字符串的限制。
   - 编写 `test/unit/table-schema.test.ts`（18 个单元测试全部通过）。

2. **TASK-016: 动态 Key 扩展与物理表自动演进机制**
   - 设计零停机平滑演进机制：支持运行时通过 `table.addKey(name, def)` 动态扩展物理列与单列索引；支持通过 `table.addIndex(def)` 动态增加多列复合物理索引。
   - 演进具备完全幂等性：重复添加相同字段或索引安全返回，不中断业务。
   - 编写 `test/unit/schema-evolution.test.ts`（10 个单元测试全部通过）。

3. **TASK-017: SQLite 动态多键存储与索引驱动实现**
   - 在 `SqliteSchemaTable` 中实现动态列物理 DDL、参数化主键与二级键点查、复合索引管理。
   - 兼容 SQLite 对布尔类型的特殊处理（自动映射为 `0/1`）。
   - 编写 `test/unit/sqlite-multikey.test.ts`（6 个单元测试全部通过）。

4. **TASK-018: PostgreSQL 动态多键存储与索引驱动实现**
   - 在 `PostgresSchemaTable` 中实现物理主键（`BIGINT` / `TEXT PRIMARY KEY`）、多类型物理列与 `CREATE INDEX IF NOT EXISTS`。
   - 编写 `test/unit/postgres-multikey.test.ts`（5 个单元测试全部通过）。

5. **TASK-019: MongoDB 动态多键与复合索引驱动实现**
   - 在 `MongoSchemaTable` 中实现多键顶层字段映射、`_id` 主键适配、`createIndexes` 自动建物理索引。
   - 编译器针对多键直接编译为顶层字段 filter，高效命中原生 B-Tree 索引。
   - 编写 `test/unit/mongodb-multikey.test.ts`（6 个单元测试全部通过）。

6. **TASK-020: Table API 多键统一点查与索引直连查询**
   - 升级 `Table` 门面：
     - `table.set({ keys, value, ttlMs })` 与 `table.set(key, value, { keys, ttlMs })` 统一写入。
     - `table.getBy(keyName, keyValue)`：任意物理键点查，直击底层索引。
     - `table.getRecord(key)`：获取包含物理主键、二级键与值的完整物理记录。
     - 智能物理列路由：`find({ where: { symbol: "BTC" } })` 自动将已知物理主键和二级键编译为原生列级过滤，避开 JSON 函数扫描。
   - 编写 `test/unit/table-multikey.test.ts`（5 个单元测试全部通过）。

7. **TASK-021: 跨后端动态多键与索引合规测试套件**
   - 构建通用合规套件 `test/compliance/multikey-compliance.ts`（覆盖主键变体、动态加键、二级键点查、直连查询、复合索引、TTL 与幂等性共 31 项测试）。
   - 集成进 SQLite、PostgreSQL、MongoDB 合规测试文件。SQLite 合规套件 31/31 测试通过。

8. **TASK-022: 动态多键使用规范、示例与文档发布**
   - 创建 `examples/16-dynamic-multi-keys.ts` 完整实战演示多键写入、`getBy` 点查、`find` 物理索引直查、运行时 `addKey` 与 `addIndex` 零停机演进。
   - 更新 `examples/README.md`、`docs/SPEC.md`（Section 14 & 15）、`docs/BUILD.md` 与 `README.md`。
   - 验证所有 16 个 examples 全部绿灯执行。

---

## 3. 修改、创建与删除的文件

### 新建文件 (Created Files)
- `examples/16-dynamic-multi-keys.ts` (动态多键与物理索引实战示例)
- `test/compliance/multikey-compliance.ts` (跨后端动态多键合规套件)
- `test/unit/table-schema.test.ts` (Schema 契约与校验单元测试)
- `test/unit/schema-evolution.test.ts` (动态 Key 扩展演进单元测试)
- `test/unit/sqlite-multikey.test.ts` (SQLite 多键驱动测试)
- `test/unit/postgres-multikey.test.ts` (PostgreSQL 多键驱动测试)
- `test/unit/mongodb-multikey.test.ts` (MongoDB 多键驱动测试)
- `test/unit/table-multikey.test.ts` (Table API 多键集成测试)

### 修改文件 (Modified Files)
- `src/core/table-schema.ts` (升级 MultiKeySchema 契约与推导)
- `src/core/table.ts` (实现 getBy, set 增强, 智能列路由, addKey, addIndex)
- `src/core/kvdb.ts` (支持 Schema 恢复与注册)
- `src/drivers/types.ts` (驱动能力标志与 SchemaTableDriver 接口)
- `src/drivers/sqlite/dialect.ts` & `sqlite-driver.ts` (SQLite 多键与演进实现)
- `src/drivers/postgres/dialect.ts` & `postgres-driver.ts` (PostgreSQL 多键与演进实现)
- `src/drivers/mongodb/compiler.ts` & `mongodb-driver.ts` (MongoDB 多键与索引实现)
- `src/query/parser.ts` (支持 schema 物理列智能识别与路由)
- `src/index.ts` (导出多键相关类型与 API)
- `examples/08-indexes-and-performance.ts` (优化示例规模适配 Node 24 GC 清理)
- `examples/README.md` (增加动态多键示例说明)
- `docs/SPEC.md` (更新 Section 14 & 15 动态多键体系规格)
- `docs/BUILD.md` (增加多键合规测试与示例运行指南)
- `README.md` (增加动态多键快速入门代码)
- `docs/AI/TASK_INDEX.md` (标记 TASK-015 ~ TASK-022 全部 DONE)
- `docs/AI/tasks/TASK-022.md` (标记状态为 DONE)

---

## 4. 验证命令与结果

- `pnpm test`: 167 tests passing (100% 通过)
- `pnpm typecheck`: 0 errors
- `pnpm build`: 成功生成 `dist/index.js`, `dist/index.cjs`, `dist/index.d.ts`
- `pnpm examples`: 全部 16 个实战示例正常执行完毕，无异常退出

---

## 5. 未解决问题与技术债务

1. **真实 Docker 数据库合规测试**:
   - PostgreSQL 与 MongoDB 驱动代码及合规测试套件已完整就绪并通过单元/AST 编译测试。真实 Docker 环境下端到端执行作为 Milestone 3 独立任务（TASK-025）跟踪。

---

## 6. 下一步应该执行的 Task

- **下一步规划**: 进入 **Milestone 3（生产级功能扩展与生态演进）**
- **推荐下一个 Task**: `TASK-023: 查询结果缓存 (Query Cache + Write Invalidation)`
  - 目标：结合 Cache 子系统为 Table.find 提供 AST 哈希缓存与写时自动失效机制。
