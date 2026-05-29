# nextsession.md — 上下文交接(Step 3 产出 + Step 4 进行中)

> 每次会话开始先读 `AGENTS.md` 再读本文件。每完成一块工作后**更新本文件**。
> 最后更新:2026-05-29(Step 4 进行中)。

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
| Step 4 实现 | 🚧 **进行中**:backlog #1–8 完成,#9–14 待做 |

**已可用**:SQLite 后端全链路(KVDB → Table → CRUD/批量/prefix/JSON 查询/排序分页/TTL/索引)
+ 独立 Cache(memory 分层 + wrap SWR)。**78 个测试全绿**,构建产出 ESM+CJS+d.ts。

仓库结构见 `docs/ARCHITECTURE.md` 模块树;实际已落地 `src/{core,drivers/sqlite,query,cache}`、
`test/{unit,compliance}`。

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
9. ⬜ **PostgreSQL Driver + pg-jsonb dialect** → 跑合规套件(需 docker pg)。
10. ⬜ **MongoDB Driver + mongo 编译** → 跑合规套件(需 docker mongo)。
11. ⬜ **sqlite-memory / sqlite-file 缓存后端**:实现 KVStore,接入 Cache 的 `resolveStore`("sqlite-memory"/"sqlite")。
12. ⬜ **装饰器**:`decorators/*`(TC39 标准装饰器),委托 `cache.wrap()`;稳定 key 已有 `stableStringify`。
13. ⬜ **插件/钩子运行时**:`plugins/runtime.ts`,在 Table 写读查路径触发 Hook。
14. ⬜ **TTL 后台清理 + 自动索引**(性能收尾)。

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
