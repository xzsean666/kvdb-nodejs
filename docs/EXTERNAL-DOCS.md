# EXTERNAL-DOCS.md — 对接 / 依赖项目的官方文档地址

> 本文件集中存放本项目所**对接 / 依赖**的外部项目最新文档地址,方便 AI 后续查找。
> 新增依赖时,请把官方文档地址登记到这里,并注明用途与版本注意事项。
> 最后核对日期:2026-05-29。

---

## 1. 后端数据库驱动

| 项目 | 用途 | 官方文档 |
|---|---|---|
| better-sqlite3 | SQLite 同步驱动(现阶段主力) | https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md |
| node:sqlite | Node 内置 SQLite(2026 仍为 RC,版本门控可选适配) | https://nodejs.org/api/sqlite.html |
| pg (node-postgres) | PostgreSQL 驱动 + 连接池 | https://node-postgres.com/ |
| PostgreSQL JSON/JSONB 函数 | JSON 查询下降目标 | https://www.postgresql.org/docs/current/functions-json.html |
| PostgreSQL GIN 索引 | jsonb 索引(`@>`/`?`/`@?`/`@@`) | https://www.postgresql.org/docs/current/gin-intro.html |
| SQLite JSON 函数 | `json_extract` / `->` / `->>` | https://sqlite.org/json1.html |
| mongodb (Node Driver) | MongoDB 原生驱动 | https://www.mongodb.com/docs/drivers/node/current/ |
| MongoDB 查询操作符 | AST→Mongo 原生映射 | https://www.mongodb.com/docs/manual/reference/operator/query/ |

## 2. 缓存后端

| 项目 | 用途 | 官方文档 |
|---|---|---|
| lru-cache (v11) | 内存缓存后端 | https://github.com/isaacs/node-lru-cache#readme |

## 3. 架构参考(借鉴,非直接依赖)

| 项目 | 借鉴点 | 文档 |
|---|---|---|
| keyv | 最小 KVStore 适配器契约 / TTL 包装 / 合规套件 | https://keyv.org/docs/ |
| cache-manager (cacheable) | 分层 stores / `wrap()` / refreshThreshold | https://github.com/jaredwray/cacheable |
| Prisma Driver Adapters | driver 工厂 + 能力标志 + 连接管理 | https://www.prisma.io/docs/orm/overview/databases/database-drivers |
| Kysely | 轻量类型推导 / `DB` 接口映射 | https://kysely.dev/ |
| Drizzle ORM | phantom 类型元数据 / `InferSelect` vs `InferInsert` | https://orm.drizzle.team/docs/overview |

## 4. 工具链

| 项目 | 用途 | 文档 |
|---|---|---|
| TypeScript Decorators(TC39) | 标准装饰器签名 | https://www.typescriptlang.org/docs/handbook/decorators.html |
| tsup | 构建(ESM+CJS+dts) | https://tsup.egoist.dev/ |
| Vitest | 测试框架 | https://vitest.dev/ |
| pnpm | 包管理 | https://pnpm.io/ |

---

## 登记格式

新增依赖请按表格补充,并在条目后用一句话注明:**为什么依赖它 + 有无版本陷阱**。
例如 node:sqlite 当前为 RC,不可作为唯一 SQLite 后端。
