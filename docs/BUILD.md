# BUILD.md — 构建与使用说明(Step 2 产出)

> 本文件描述如何安装、构建、测试、运行本 SDK。
> 注意:Step 4 尚未开始,以下命令对应**目标**工程结构;实际脚本在实现时落地到 `package.json`。

---

## 1. 环境要求

| 工具 | 版本 | 说明 |
|---|---|---|
| Node.js | v22+(开发机 v24.2) | 同步 SQLite 与现代 ESM |
| pnpm | 10.x | 唯一包管理器 |
| TypeScript | 5.8 | TC39 标准装饰器 |

---

## 2. 安装(终端用户)

```bash
pnpm add kvdb-sdk
# 按需安装后端驱动(peerDependencies,不强制全装)
pnpm add better-sqlite3      # SQLite
pnpm add pg                  # PostgreSQL
pnpm add mongodb             # MongoDB
```

> 后端驱动作为 **optional peerDependencies**:只装你用的后端,体积与安装成本最小。

---

## 3. 目标工程结构

```text
kvdb-nodejs/
  AGENTS.md                 # AI 工作守则(入口)
  docs/                     # 架构与规格文档
  src/                      # 源码(见 ARCHITECTURE.md 模块树)
  test/
    unit/                   # 纯单元测试(无 DB)
    compliance/             # 跨后端合规套件(对真实 DB)
  package.json
  tsconfig.json
  tsup.config.ts            # 构建(ESM + CJS + d.ts)
  vitest.config.ts          # 测试
```

---

## 4. 目标 package.json 关键字段(规格,非最终)

```jsonc
{
  "type": "module",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js", "require": "./dist/index.cjs" }
  },
  "scripts": {
    "build": "tsup src/index.ts --format esm,cjs --dts",
    "dev": "tsup --watch",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:compliance": "vitest run test/compliance",
    "lint": "eslint .",
    "format": "prettier --write ."
  },
  "peerDependencies": {
    "better-sqlite3": "*", "pg": "*", "mongodb": "*"
  },
  "peerDependenciesMeta": {
    "better-sqlite3": { "optional": true },
    "pg": { "optional": true },
    "mongodb": { "optional": true }
  }
}
```

---

## 5. 目标 tsconfig 关键项

```jsonc
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "declaration": true,
    "verbatimModuleSyntax": true
    // 注意:不设置 experimentalDecorators —— 使用 TS5.x 原生 TC39 装饰器
  }
}
```

---

## 6. 常用命令(实现后)

```bash
pnpm install                # 安装依赖
pnpm build                  # 构建产物到 dist/
pnpm typecheck              # 仅类型检查
pnpm test                   # 单元测试
pnpm test:compliance        # 跨后端合规测试(需本地/容器数据库)
```

---

## 7. 合规测试的数据库(本地)

合规套件**不 mock 数据库**。建议用容器:

```bash
# PostgreSQL
docker run --rm -e POSTGRES_PASSWORD=dev -p 5432:5432 postgres:17
# MongoDB
docker run --rm -p 27017:27017 mongo:7
# SQLite 无需服务,使用临时文件 / :memory:
```

环境变量(测试读取):
```bash
KVDB_TEST_PG_URL="postgres://postgres:dev@localhost:5432/postgres"
KVDB_TEST_MONGO_URL="mongodb://localhost:27017/kvdb_test"
```

---

## 8. 最小使用示例(目标 API)

```ts
import { KVDB } from "kvdb-sdk";

const db = new KVDB({ driver: "sqlite", url: "./data.db", tablePrefix: "app_" });
const users = db.table<{ name: string; profile: { age: number } }>("users");

await users.set("u1", { name: "Ann", profile: { age: 20 } }, { ttlMs: 60_000 });
const u = await users.get("u1");
const adults = await users.find({ where: { "profile.age": { $gt: 18 } } });

await db.close();
```

Schema table 示例：

```ts
const blocks = db.table("blocks", {
  schema: { columns: { blocknumber: { type: "integer", nullable: false } } },
});
await blocks.set("b1", { hash: "..." }, { columns: { blocknumber: 1 } });
```

物理表合规测试覆盖真实列/字段、registry 重开、索引、迁移和 columns/value 混合查询。SQLite 可直接运行；PostgreSQL/MongoDB 需设置 `KVDB_TEST_PG_URL` / `KVDB_TEST_MONGO_URL`：

```bash
pnpm test:compliance
pnpm typecheck && pnpm build
```

---

## 9. 发布(后续)

```bash
pnpm build && pnpm test && pnpm test:compliance
# 版本与变更日志策略(changesets)在进入发布阶段时定稿
```
❗ 任何发布/推送动作需用户显式批准。
