# nextsession.md — 上下文交接(Step 3 产出)

> 每次会话开始先读 `AGENTS.md` 再读本文件。每完成一块工作后**更新本文件**。
> 最后更新:2026-05-29。

---

## 1. 当前进度

| 步骤 | 状态 |
|---|---|
| Step 1 架构设计 | ✅ 完成 → `docs/ARCHITECTURE.md` |
| Step 2 文档(SPEC/BUILD) | ✅ 完成 → `docs/SPEC.md`, `docs/BUILD.md` |
| Step 3 上下文交接 | ✅ 完成 → 本文件 |
| Step 4 实现 | ⛔ **未开始,等待用户显式批准** |

仓库当前为空(无 `package.json`、无 `src/`),仅有 `AGENTS.md` 与 `docs/`。

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

1. **工程脚手架**:`package.json` / `tsconfig.json`(不开 experimentalDecorators) / tsup / vitest / eslint / prettier。产出空的 `src/index.ts`。
2. **契约层**:`drivers/types.ts`、`cache/types.ts`(KVStore)、`query/ast.ts`、`plugins/types.ts`。只有类型,无逻辑。
3. **serializer + key**:`core/serializer.ts`(canonical JSON,处理循环引用/undefined)、`core/key.ts`(prefix/namespace)。配单元测试。
4. **Cache 子系统**:`cache/stores/memory-store.ts`(lru-cache)→ `cache/cache.ts`(分层 + wrap + SWR)。可独立交付与测试。
5. **SQLite Driver**(第一个后端,最简):`drivers/sqlite/*`,实现 KVStore + getByPrefix。
6. **查询编译器**:`query/parser.ts` + `query/compiler.ts` + SQLite visitor。先支持 cmp/逻辑/exists。
7. **合规测试套件**:`test/compliance/*`,先让 SQLite 全绿。
8. **core/kvdb.ts + core/table.ts**:把上面拼成对外 API。端到端示例跑通。
9. **PostgreSQL Driver + visitor** → 跑合规套件。
10. **MongoDB Driver + visitor** → 跑合规套件。
11. **sqlite-memory / sqlite-file 缓存后端**。
12. **装饰器**:`decorators/*`(TC39),委托 cache.wrap。
13. **插件/钩子运行时**:`plugins/runtime.ts`。
14. **TTL 后台清理 + 自动索引**(性能收尾)。

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
