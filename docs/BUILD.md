# BUILD.md — 工程构建与使用说明

> 本文件描述如何安装、构建、测试与运行 KVDB SDK。

---

## 1. 环境要求

| 工具 | 版本 | 说明 |
|---|---|---|
| Node.js | >= 22 (推荐 Node.js v24+) | 现代 ESM 与 Node.js 运行时 |
| pnpm | 10.x | 唯一包管理器 |
| TypeScript | 5.8 | TC39 标准装饰器支持 |

---

## 2. 安装 (终端用户)

```bash
pnpm add kvdb-sdk

# 按需安装后端驱动 (optional peerDependencies，只装你使用的数据库驱动)
pnpm add better-sqlite3      # SQLite
pnpm add pg                  # PostgreSQL
pnpm add mongodb             # MongoDB
```

---

## 3. 工程结构

```text
kvdb-nodejs/
  AGENTS.md                 # AI 代理工作守则与最高规范入口
  README.md                 # 面向开发者的项目说明
  package.json
  tsconfig.json
  tsup.config.ts            # 构建配置 (ESM + CJS + d.ts)
  vitest.config.ts          # 测试配置
  docs/                     # 架构、规格与 AI 上下文文档
    ARCHITECTURE.md         # 统一系统架构总述
    SPEC.md                 # API 契约与行为规格
    BUILD.md                # 构建运行指南 (本文档)
    EXTERNAL-DOCS.md        # 外部依赖官方文档索引
    AI/                     # AI 状态机与任务管理
      GOAL.md               # 里程碑与总目标
      TASK_INDEX.md         # 任务总索引
      SESSION_STATE.md      # 会话交接状态
      DECISIONS.md          # 架构决策记录 (ADR)
      tasks/                # 活跃任务卡片
        completed/          # 历史已完成任务归档
  src/                      # SDK 源码
  test/                     # 单元测试与合规测试套件
  examples/                 # 官方可运行实战示例
```

---

## 4. 常用开发命令

```bash
pnpm install                # 安装依赖
pnpm build                  # 构建产物到 dist/ (ESM + CJS + .d.ts)
pnpm dev                    # 监听变动增量构建
pnpm typecheck              # 严苛 TypeScript 类型检查
pnpm test                   # 运行全量单元测试与 SQLite 合规测试
pnpm test:compliance        # 跨后端驱动合规测试
pnpm test:e2e               # 真实文件与磁盘 E2E 测试
pnpm examples               # 运行全量 22 个官方实战示例
pnpm lint                   # ESLint 代码检查
pnpm format                 # Prettier 代码格式化
```

---

## 5. 合规测试与多数据库环境

KVDB 合规套件严格针对真实数据库运行（不使用 Mock）：

```bash
# SQLite 合规测试（零外部依赖，使用内存或临时文件）
pnpm test:compliance

# PostgreSQL 真实环境验证（建议使用 Docker）:
docker run --rm -d --name kvdb-pg -e POSTGRES_PASSWORD=dev -p 5432:5432 postgres:17
KVDB_TEST_PG_URL="postgres://postgres:dev@localhost:5432/postgres" pnpm test test/compliance/postgres.test.ts

# MongoDB 真实环境验证（建议使用 Docker）:
docker run --rm -d --name kvdb-mongo -p 27017:27017 mongo:7
KVDB_TEST_MONGO_URL="mongodb://localhost:27017/kvdb_test" pnpm test test/compliance/mongodb.test.ts
```

---

## 6. 核心使用示例

### 6.1 基础 KV 与 Auto Batch
```ts
import { KVDB } from "kvdb-sdk";

const db = new KVDB({ driver: "sqlite", url: "./data.db", tablePrefix: "app_" });
const users = db.table<{ name: string; age: number }>("users");

// 自动微批处理与内存写折叠（默认开启）
await users.set("u1", { name: "Ann", age: 20 }, { ttlMs: 60_000 });
const u = await users.get("u1"); // 0-RTT 内存直通读取
const adults = await users.find({ where: { age: { $gte: 18 } } });

await db.close(); // 自动排空所有活跃表的批处理队列并释放连接
```

### 6.2 动态多键（Multi-Key）物理表
```ts
const tokens = db.table("tokens", {
  schema: {
    primaryKey: { name: "address", type: "string" },
    keys: {
      symbol: { type: "string", index: true },
      chainId: { type: "string", index: true },
    },
    indexes: [{ keys: ["chainId", "symbol"] }],
  },
});

// 多键写入与点查
await tokens.set({
  keys: { address: "0x123", symbol: "ETH", chainId: "ethereum" },
  value: { name: "Ether", decimals: 18 },
});
const eth = await tokens.getBy("symbol", "ETH"); // 原生 B-Tree 索引点查

// 动态加键与建索引（零停机演进）
await tokens.addKey("isL2", { type: "boolean", default: false, index: true });
```
