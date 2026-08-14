# nextsession.md — 上下文交接(Step 3 产出 + Step 4 进行中)

> 每次会话开始先读 `AGENTS.md` 再读本文件。每完成一块工作后**更新本文件**。
> 最后更新:2026-08-14(Step 4 进行中；新增真实物理列表升级文档)。

---

## 0. 已拍板决策(用户确认)

- 包名:**`kvdb-sdk`**。
- 未连接时:**自动延迟建连**(首次操作触发,无需手动 `connect()`)。
- 物理 key:`<tablePrefix><namespace>:<userKey>`,`:` 不可出现在 prefix/namespace,user key 可含 `:`。
- 装饰器 key 默认:类名 + 方法名 + `stableStringify(args)`(实现中,见 backlog #12)。
- API 统一 Promise 接口(SQLite 同步底层也包成 Promise)。
- `find` 的 `where` path v1 用字符串。

---

## 1. 当前进度

| 步骤 | 状态 |
|---|---|
| Step 1 架构设计 | ✅ 完成 → `docs/ARCHITECTURE.md` |
| Step 2 文档(SPEC/BUILD) | ✅ 完成 → `docs/SPEC.md`, `docs/BUILD.md` |
| Step 3 上下文交接 | ✅ 完成 → 本文件 |
| Step 4 实现 | ✅ **全部 14 项完成**(SQLite 已验证;PG/Mongo 待真实 DB 验证) |

**已可用**:三后端全链路(KVDB → Table → CRUD/批量/prefix/JSON 查询/排序分页/TTL/索引)
+ 独立 Cache(memory / sqlite-memory / sqlite-file 分层 + wrap SWR)+ 装饰器缓存(TC39)
+ 插件钩子 + 自动索引(opt-in)+ TTL 后台清理。**96 个单测全绿**,构建产出 ESM+CJS+d.ts。

仓库结构见 `docs/ARCHITECTURE.md` 模块树;已落地 `src/{core,drivers/{sqlite,postgres,mongodb},query,cache,decorators,plugins,types}`、`test/{unit,compliance}`。

### ⚠️ 验证状态(诚实记录)
- **SQLite**:单测 + 20 例合规套件全绿(`:memory:`,真实 better-sqlite3)。
- **PostgreSQL / MongoDB**:代码完成且通过类型检查,合规套件已接好,但**本机无 Docker 权限,未对真实 DB 跑过**。验证命令:
  ```bash
  # Postgres(需可用 docker / 远程库)
  KVDB_TEST_PG_URL=postgres://postgres:dev@localhost:5432/postgres pnpm test:compliance
  # MongoDB
  KVDB_TEST_MONGO_URL=mongodb://localhost:27017/kvdb_test pnpm test:compliance
  ```
  跑通后请把结果回填到本节。

---

## 2. 架构摘要(30 秒版)

- 三层对象:`KVDB` → `Table/Namespace` → CRUD/Query。
- **双层契约**:最低层 `KVStore`(缓存后端 + KV 最小公约)+ 富层 `Driver`(查询/prefix/索引/能力标志)。
- 值统一存为 **canonical text JSON**。
- 查询走 **统一 AST → 每后端 visitor 下降**(SQLite/PG/Mongo)。
- Cache 独立模块,**分层 stores + wrap()**(memory=lru-cache,sqlite-mem,sqlite-file)。
- 装饰器用 **TC39 标准装饰器**,委托 `cache.wrap()`。
- **不自己实现连接池**;能力标志允许 Mongo 退出关系型假设。
- 最高价值实践:**跨后端合规测试套件(不 mock DB)**。

关键决策清单见 `docs/ARCHITECTURE.md` 第 2 节(KD-1 … KD-8)。

---

## 3. 已完成

- [x] 调研成熟方案(keyv / cache-manager / Prisma / Kysely / Drizzle / lru-cache / better-sqlite3 / node:sqlite),并据此优化架构。
- [x] `AGENTS.md`:执行协议 + 架构原则 + 反模式 + 技术基线 + 文档地图。
- [x] `docs/ARCHITECTURE.md`:模块树、模块定义表、数据流、核心契约示意、性能策略、扩展性。
- [x] `docs/SPEC.md`:数据模型、全部 API 签名与语义、查询操作符、Cache、装饰器、错误、TS、v1 范围。
- [x] `docs/BUILD.md`:环境、安装、目标工程结构、package/tsconfig 关键项、命令、合规测试 DB。
- [x] `docs/EXTERNAL-DOCS.md`:依赖/参考项目官方文档地址登记。

---

## 4. 待办(Step 4 实现,建议顺序 —— 每步可独立测试)

> 遵循"增量可构建":每步跑通后再进下一步,先 commit。

1. ✅ **工程脚手架**:`package.json` / `tsconfig.json`(未开 experimentalDecorators)/ tsup / vitest。
2. ✅ **契约层**:`drivers/types.ts`、`cache/types.ts`、`query/ast.ts`、`plugins/types.ts`、`core/errors.ts`。
3. ✅ **serializer + key + expiry**:canonical JSON / prefix-namespace / TTL 助手。
4. ✅ **Cache 子系统**:`cache/stores/memory-store.ts` + `cache/cache.ts`(分层 + wrap + SWR)。
5. ✅ **查询编译器**:`query/parser.ts` + `query/compiler.ts` + SQLite dialect。
6. ✅ **SQLite Driver**:`drivers/sqlite/*`(KV/批量/prefix/find/index/raw)。
7. ✅ **core/kvdb.ts + core/table.ts**:对外 API,端到端跑通。
8. ✅ **合规测试套件**:`test/compliance/driver-compliance.ts`,SQLite 全绿(20 例)。
9. ✅ **PostgreSQL Driver + pg-jsonb dialect**(复用 SQL 编译器)。合规套件已接,待真实库验证。
10. ✅ **MongoDB Driver + mongo 编译**。合规套件已接,待真实库验证。
11. ✅ **sqlite-memory / sqlite-file 缓存后端**:`SqliteCacheStore`,已接入 Cache `resolveStore`。
12. ✅ **装饰器**:`@Cacheable`/`@CacheClear`(TC39),委托 `cache.wrap()`。
13. ✅ **插件/钩子运行时**:`HookRuntime`,已接入 Table 读写查路径 + `KVDB({ plugins })`。
14. ✅ **TTL 后台清理 + 自动索引**:`KVDB.purgeExpired()` / `ttlCleanupIntervalMs`(unref 定时器)/ `autoIndex`(opt-in)。

### 后续可做(非阻塞)
- 在真实 PG / Mongo 上跑合规套件并回填结果(见上方验证状态)。
- Query Cache 开关(目前 find 不走缓存)。
- Cache `deleteByPrefix`,让 `Table.clear()` 能清对应缓存。
- typed JSON path / `$elemMatch` 在 SQL 后端的支持。
- eslint/prettier 配置与 CI。

### 已知 v1 简化(实现时记录,后续完善)
- **Query Cache 未接入**:`Table.find` 暂不走缓存(写失效较复杂),仅点读走缓存。后续加 `cacheQueries` 开关 + TTL。
- **`Table.clear()` 不清共享 cache**:Cache 无按前缀清空能力;依赖缓存的场景建议每表独立 cache。后续给 Cache 加 `deleteByPrefix`。
- **`$elemMatch`** 在 SQL 后端 v1 抛 `KvdbUnsupportedError`(Mongo 后端可原生支持)。
- **标量比较**:`find` 的比较值限标量;对象/数组比较未支持。

---

## 5. 进入 Step 4 前需用户拍板的开放问题

1. **包名**:`kvdb-sdk`?(README 里是占位 `your-sdk`)
2. **未连接时行为**:自动延迟建连 vs 抛 `KvdbConnectionError`?(SPEC §11 待定稿)
3. **物理 key 分隔符**:`prefix + namespace + ":" + key` 是否可接受?是否允许 key 含 `:`?
4. **装饰器 key 默认是否包含实例字段**(还是仅类名+方法+args)?
5. **API 是否需要同步变体**(better-sqlite3 同步,但 Mongo/PG 异步;建议统一 Promise 接口)。
6. **`find` 的 `where` path** v1 用字符串(后续再上 typed path)是否 OK?

---

## 6. 风险 / 未知

- **node:sqlite 仍为 RC(2026)**:不可作为唯一 SQLite 后端,先用 better-sqlite3,node:sqlite 做版本门控适配。
- **Node 24 上 better-sqlite3 SELECT 有性能回退报告**(相对 Node 20):需在目标 Node 线基准测试。
- **同步 SQLite 阻塞事件循环**:大扫描需 worker thread 下放,Web 服务热路径要注意。
- **跨后端 JSON 语义差异**(缺失 vs NULL、负数组下标、数值强转):必须由合规套件守住,否则抽象会泄漏。
- **PG GIN 索引只加速 `@>/?/@?/@@`,不加速 `->>` 等值**:`->>`/范围查询要用表达式 B-tree 索引。
- **TC39 装饰器生态**:多数现成缓存装饰器库仍是 legacy,我们自研装饰器需自己处理 key 生成与稳定序列化。

---

## 7. 下一步行动(给下一个会话)

> 若用户已批准 Step 4:从 待办#1(脚手架)开始,先 commit `feat: scaffold project`。
> 若用户未批准:停在此处,回答用户对架构/规格的疑问,按需修订文档。

---

## 8. 新需求：真实物理列表升级（文档阶段）

用户确认需要在保留 `db.table("name")` 使用方式的前提下，支持 schema table：自定义字段必须是真实数据库列/文档字段，而不是 `value` JSON 内的字段。无 schema 时继续使用普通 KV 表。

本次仅完成文档，没有修改 `src/` 或测试代码：

- `docs/physical-table-schema/UPGRADE.md`：架构、API、物理存储、索引、查询、迁移和验收标准。
- `docs/physical-table-schema/TASKS.md`：按契约、registry、三后端、查询、迁移和合规测试拆分的实现任务。
- `docs/physical-table-schema/IMPLEMENTATION-PROMPT.md`：交给 Claude Sonnet 5 或 ChatGPT Terra medium 的实现 Prompt。

### 已确认设计方向

- `db.table<Value, Columns>("blocks", { schema })` 首次操作时创建或校验独立物理 table/collection。
- 后续 `db.table<Value, Columns>("blocks")` 按逻辑表名重新打开，schema 由 registry/物理结构恢复。
- 列类型首期为 `string`、`integer`、`number`、`boolean`、`json`。
- 列支持 `nullable`、`default`、单列 `index`；表级支持联合索引和 `unique`。
- 查询统一使用 `where.columns` 查询物理列，`where.value` 查询 value JSON；旧 dotted value path 保持兼容。
- schema 变更走显式 migration，不在写入路径隐式 `ALTER TABLE`。
- 现有普通 KV table、Cache、插件、TTL 和共享 `KVStore` 契约保持兼容。

### 本次升级交接（真实物理 schema table）

- [x] Step 1 架构边界确认：独立物理 table/collection、provider-neutral registry、富层 Driver、AST `column/value` 来源。
- [x] Step 2 更新 `docs/ARCHITECTURE.md`、`docs/SPEC.md`、`docs/BUILD.md`。
- [x] Step 3 记录交接；用户已明确批准进入 Step 4。
- [~] Step 4 进行中：已完成 schema 契约/运行时校验、SQLite registry + 独立物理表/列、列 CRUD/getRecord、SQLite columns/value 查询与索引创建；PG/Mongo、显式 migration API 和完整合规覆盖待继续实现。

本需求保持 ESM、Node 24+、pnpm、TypeScript 5.8、TC39 decorators、普通 KV、Cache、插件和 TTL 契约不变。PG/Mongo 真实服务状态仍需在实现后诚实回填，不得伪造通过。

### 本阶段验证

- `pnpm typecheck` ✅
- `pnpm build` ✅（ESM/CJS/d.ts）
- `pnpm test`：非 SQLite 单测通过；SQLite 相关测试因 `better-sqlite3` 缺少 Node 24 原生 binding 未能执行。安装时 Node headers 下载失败（网络 ECONNRESET）。
