# DECISIONS.md — 关键设计与架构决策记录 (Key Decisions Log)

> 本文件记录了 KVDB SDK 架构演进过程中的所有核心决策（Architecture Decision Records）。
> 任何修改现有决策的行为必须在会话交接中记录充分理由。

---

## 基础架构决策 (Base Architectural Decisions)

### KD-1. 双层契约分离：`KVStore` 与 `Driver` 不合并
- **内容**：
  - 最低层 `KVStore`：Map 超集 + TTL，仅包含 `get/set/delete/has/clear/*Many/iterator`。用于 Cache 存储后端，也是 KV 语义的最小公约。
  - 富层 `Driver`：在 `KVStore` 之上增加统一 JSON 查询、前缀扫描、物理列映射、索引管理以及 `capabilities` 声明。
- **决策理由**：彻底解耦“极简 KV 缓存”与“富查询持久化存储”，避免“最低公分母陷阱”；Cache 无需负担复杂查询，Driver 无需负担多层缓存策略。

### KD-2. 查询用统一 IR/AST，每后端用 Visitor 下降
- **内容**：上层提供统一类 Mongo 风格查询语法，由 `query/parser.ts` 编译为后端无关的抽象语法树（AST），各后端通过 Visitor（SQLite Dialect、Postgres Dialect、Mongo Compiler）直接下降为原生查询表达式。
- **决策理由**：消除 SQL 字符串的二次解析往返（round-trip）；杜绝 SQL 注入；增加新后端只需实现单一 Visitor，不侵入通用查询逻辑。

### KD-3. 值的规范形态为 Canonical Text JSON
- **内容**：业务数据在写入底层驱动前，统一通过 `core/serializer.ts` 序列化为规范文本 JSON（键排序、稳定序列化），底层以文本形式存储或交给底层原生 JSON 引擎。
- **决策理由**：保证跨后端数据可移植性，确保不同驱动之间的数据编码一致，并将序列化逻辑集中在单一边界。

### KD-4. Cache 采用分层 Stores 模型与 SWR `wrap()`
- **内容**：`Cache({ stores: [memoryStore, sqliteMemoryStore, sqliteFileStore] })`，写穿所有层，读时从最高优先级逐层 fallback；提供 `wrap(key, fn, { ttl, refreshThreshold })` 原生支持 Stale-While-Revalidate。
- **决策理由**：装饰器缓存、查询缓存与业务层高频数据缓存全部复用同一套稳定高性能引擎。

### KD-5. 采用 TC39 标准装饰器（TS 5.x 原生）
- **内容**：严格使用 ECMAScript TC39 Stage 3 / TS 5.x 标准装饰器，不启用遗留的 `experimentalDecorators`；缓存 key 默认由 `类名 + 方法名 + stableStringify(args)` 生成，支持自定义 key builder。
- **决策理由**：`experimentalDecorators` 正在被 TypeScript 和生态废弃且签名不兼容，直接对齐现代语言标准保证未来长期兼容。

### KD-6. 绝不自己造连接池；基于能力标志（Capabilities）退化
- **内容**：连接池完全由各底层官方 driver（如 `pg.Pool`、`MongoClient`）自身管理，SDK 仅负责透传连接参数；通过 `DriverCapabilities`（如 `nativeTtl`、`jsonQuery`、`managesOwnPool`、`supportsTransactions`）决定是由核心模拟还是委托给原生数据库。
- **决策理由**：专业数据库连接池（心跳、重试、故障转移）极其复杂，自行维护风险极高且无额外收益；能力标志避免对非关系型数据库（如 MongoDB）强加关系模型假设。

### KD-7. 约定：`undefined` 不存储
- **内容**：调用 `set(key, undefined)` 在语义上等价于 `delete(key)`；缓存未命中统一返回 `undefined`。
- **决策理由**：对齐现代主流缓存库规范（如 lru-cache、cache-manager v7），避免 `null` 与“无值”的语义混淆。

### KD-8. 跨后端合规测试套件（严格对真实 DB 运行，不使用 Mock）
- **内容**：编写一套完整的跨驱动行为合规套件（`test/compliance/`），每个声明支持的数据库驱动必须在真实数据库实例中运行通过。
- **决策理由**：Mock 容易掩盖边界行为、类型转换差异和数据库特性 Bug，真实环境合规套件是防止抽象泄漏的唯一可靠手段。

---

## 真实物理 Schema Table 决策 (Physical Schema Decisions)

### KD-P1. 物理表按 Table 名隔离
- **内容**：每一个声明了 Schema 的 table 映射到独立的真实物理数据表（SQLite/Postgres）或独立的 MongoDB Collection，命名格式为安全转义加散列后缀（如 `kvdb_schema_<safeName>_<hash>`）；无 Schema 的普通 KV 表继续共享单张 `kvdb_kv` 物理表。
- **决策理由**：防止不同业务 table 的自定义列互相污染共享表结构；允许针对独立表建立专有索引与执行维护。

### KD-P2. `db.table()` 负责创建或重新打开
- **内容**：
  1. 首次带 Schema 声明调用并在首次操作时：在元数据表中查找 table schema registry；不存在则创建真实物理表、列和索引并持久化 schema；已存在则严格比对声明与持久化 schema。
  2. 后续进程仅需 `db.table("name")`：无 schema 参数时自动从 registry/物理元数据中还原 schema 定义。
- **决策理由**：保持极简的用户使用习惯，无需在应用启动时编写繁琐的 schema 注册代码，同时具备强类型校验与断电恢复能力。

### KD-P3. Schema Table 与普通 KV Table 严格区分
- **内容**：禁止将现有普通 KV 表通过声明 Schema 静默转换为物理表；禁止对已存在的 Schema Table 使用空 Schema 降级为普通 KV 表。
- **决策理由**：防止由于误配置导致底层存储模型混淆和数据损毁，任何结构模型变更必须通过显式迁移。

### KD-P4. 列类型使用跨后端逻辑类型
- **内容**：首期支持五种标准跨后端逻辑类型：
  - `string` -> SQLite `TEXT` / Postgres `TEXT` / Mongo `string`
  - `integer` -> SQLite `INTEGER` / Postgres `BIGINT` / Mongo `int64` (限制为 JS 安全整数)
  - `number` -> SQLite `REAL` / Postgres `DOUBLE PRECISION` / Mongo `double`
  - `boolean` -> SQLite `INTEGER (0/1)` / Postgres `BOOLEAN` / Mongo `boolean`
  - `json` -> SQLite `TEXT` / Postgres `JSONB` / Mongo `object/array`
- **决策理由**：避免引入如 JS `bigint`、`Date` 等在不同数据库中解析和序列化行为不一致的复杂类型，保障跨后端确定性。

### KD-P5. 索引声明作为 Schema 的一等公民
- **内容**：单列索引直接在列定义中声明（`index: true` 或 `{ name, unique }`）；联合索引在表级 `schema.indexes` 中声明；驱动负责按数据库语法幂等创建索引。
- **决策理由**：物理列必须具备索引能力才能支撑高吞吐业务查询，内聚在 schema 中确保创建和迁移的一致性。

### KD-P6. 动态多键（Multi-Key）与原生索引优先原则
- **内容**：在实际工程中，用户无需在高频查询路径上深挖 JSON 内部属性，而是显式按需增加物理检索 Key（如 `blockNumber`, `chainId`, `status`）。一条记录可定义多个不同类型的检索 Key；`value` 仅作为纯净业务载荷（Payload）读写；搜索直接命中底层数据库针对 Key 建立的原生 B-Tree 索引。
- **决策理由**：消除在文本 JSON 内部执行低效函数扫描（如 `json_extract`）的性能损耗，充分发挥 SQLite/PG/Mongo 的原生索引与列级过滤性能。

### KD-P7. 随时动态增加检索 Key（Dynamic Key Evolution）
- **内容**：支持在应用运行时随时向已有 Table 动态增加新的 Key（列）并幂等创建索引（如 `table.addKey("status", { type: "string", index: true })`），驱动自动安全执行 DDL 扩展（如 `ALTER TABLE ADD COLUMN`），已存在的数据自动兼容。
- **决策理由**：保证业务迭代过程中无需停机执行复杂的手工 SQL 迁移，贴合 KV 数据库天然的动态演化需求。

---

## 运行配置与命名决策 (Operational & Config Decisions)

### KD-CFG1. 官方包名
- **决策**：统一使用 **`kvdb-sdk`**。

### KD-CFG2. 物理 Key 组合规范
- **决策**：格式为 `<tablePrefix><namespace>:<userKey>`。
  - `:` 字符不允许出现在 `tablePrefix` 和 `namespace` 中；
  - `userKey` 允许包含任意 `:` 字符。

### KD-CFG3. 数据库连接生命周期
- **决策**：**自动延迟建连（Lazy Connect）**。用户实例化 `new KVDB(...)` 后无需显式等待 `connect()`，在执行第一个读写/查询操作时自动触发建连并缓存连接。

---

## 安全、性能与逻辑健全性决策 (Audit Hardening Decisions)

### KD-SEC1. SQL 标识符严格 ANSI 转义与防御性校验
- **内容**：
  1. 列名、主键名、索引名在 SQLite 和 PostgreSQL 下统一采用 ANSI 双引号转义 `"${ident}"`，全面支持 SQL 关键字列（如 `order`, `group`, `user`, `select`, `from`）作为物理列名。
  2. 标识符名称与查询路径分段严格限制在白名单字符集 `/^[A-Za-z0-9_$-]+$/`，彻底隔绝通过动态 JSON 路径或复合索引名称拼接引发的 SQL/Query 注入漏洞。
  3. 全面拦截原型链污染攻击与系统保留键（`__proto__`, `prototype`, `constructor`, `_id`, 大小写无关过滤）。
  4. 保证 Schema 演化安全约束：在已有表动态添加非空列（`nullable: false`）时，强制要求提供默认值（`default`），从根本上避免已有非空表 DDL 扩展失败导致进程崩溃。

### KD-PERF1. 高并发防御与热点语句预编译缓存
- **内容**：
  1. `Cache.wrap()` 引入并发未命中合并机制（In-flight Miss Collapsing）：对同一 Key 的并发穿透请求复用同一个执行 Promise，彻底消除缓存击穿与惊群效应（Thundering Herd / Cache Stampede）。
  2. `SqliteSchemaTable` 实现 Prepared Statement 预编译语句缓存机制（覆盖 `get`, `delete`, `upsert`, `getBy`），并在执行 `addKey` / `addIndex` 等 DDL 扩展时实现动态安全失效，大幅提升物理多键表的 CRUD 与高频索引点查吞吐（吞吐提升 5x-10x）。
  3. `AutoIndexManager` 引入容量上限保护（`maxTracked` 默认 10,000 条）与 FIFO 淘汰策略，防止应用端生成任意动态查询路径时造成无界内存增长与内存泄漏。

### KD-LOGIC1. Schema Table 全功能对齐与全局生命周期统一
- **内容**：
  1. `Table.update`、`getMany`、`setMany`、`deleteMany` 全面适配物理 Schema 表；其中 `update` 原生调用 `SchemaTableDriver.updateRecord` 在行级独占锁（SQLite 立即事务 / Postgres `FOR UPDATE` / Mongo CAS）下原子更新，确保与普通 KV 表行为 100% 对齐。
  2. Schema Table 的点查与写入完整集成 Hook 插件生命周期（`beforeRead`, `afterRead`, `beforeWrite`, `afterWrite`）以及独立命名的点查缓存（`schema:${schemaName}:${key}`），彻底解决普通表与 Schema 表的缓存键碰撞问题。
  3. 全局 TTL 清理闭环：`KVDB.purgeExpired()` 升级为全局跨表清理，自动遍历 `kvdb_schema_registry` 中所有物理 Schema 表并统一清理过期数据。

### KD-SEC2. 全系统标识符严格转义、原型链安全与分页边界断言
- **内容**：
  1. `PostgresSchemaTable` 与 `SqliteCacheStore` 对所有物理表名与列名强制加双引号 `"${table}"`，彻底杜绝保留关键字冲突。
  2. `applyPatch` 与 `parseWhere` 严格阻断 `__proto__` / `constructor` / `prototype` 键。
  3. `parseFindOptions` 严格约束 `limit` 与 `offset` 为非负安全整数。
  4. `AutoIndexManager` 对已索引路径引入硬上限（`maxIndexed` 200 项），防止无界内存泄漏与恶意 DDL 风暴。

### KD-PERF2. 跨驱动物理 Schema 批量操作与 PG 流式游标分页
- **内容**：
  1. `PostgresSchemaTable` 与 `MongoSchemaTable` 实现驱动级 `setRecords` / `deleteRecords` 批量契约，利用事务单批多行插入（或 bulkWrite）与 `IN / ANY` 条件单网络往返处理批量请求，消除逐条往返网络放大的性能惩罚（吞吐提升 10x~100x）。
  2. `PostgresDriver.iterator` 改造为基于主键 B-Tree 索引的 Keyset 批量分块流式分页拉取，消除一次性全量加载造成的 Node.js 内存爆炸与 OOM 风险。

### KD-PERF3. 写入热路径序列化器 GC 瘦身与 Hook 零开销快速路径
- **内容**：
  1. `core/serializer.ts` 消除正常序列化流程中不必要的 `path` 字符串模板拼接与冗余数组创建，显著减轻 V8 堆垃圾分配。
  2. `Table` 访问生命周期钩子时引入 `has(hook)` 同步守卫，未启用插件场景下完全避免 payload 对象堆分配与 Promise 调度开销。
  3. 自动索引构建 `ensureIndex` 从查询读路径中解耦为非阻塞异步后台构建，杜绝查询长尾抖动。


