# TASK-033-PRODUCTION-AUDIT-REMEDIATION — 生产环境深度缺陷与短板全量加固

> **状态**: `DONE`  
> **所属里程碑**: `Milestone 3+` (工业级生产就绪专项)  
> **依赖任务**: `TASK-032-PRODUCTION-READY`  
> **责任文件范围**:
> - `src/core/kvdb.ts`
> - `src/core/table.ts`
> - `src/core/batcher.ts`
> - `src/drivers/postgres/postgres-driver.ts`
> - `src/drivers/redis/redis-driver.ts`
> - `src/drivers/mysql/mysql-driver.ts`
> - `src/drivers/sqlite/sqlite-driver.ts`
> - `src/queue/queue.ts`
> - `package.json`
> - `test/unit/mysql-driver.test.ts`
> - `test/unit/redis-driver.test.ts`

---

## 1. 目标与交付清单

基于生产环境全面工程审计报告（`production-audit-report.md`），彻底修复所有已发现缺陷与短板：

### A. 4 项致命阻断缺陷修复 (P0)
1. **`db.getDriver()` 连接失败后实例死锁修复**: 捕获异常并清空 `this.driverPromise`，支持失败重试；清理未生效定时器。
2. **多租户前缀隔离全链路生效**: 修复 `Table`、MultiKey 物理表、Queue、点查缓存和 QueryCache 对 `tablePrefix` 的丢弃，保证跨租户数据 100% 物理隔离。
3. **PostgreSQL 连接池断线进程崩溃防御**: 挂载 `pool.on("error")`，防范空闲连接被云网关切断导致 Node.js 进程退出；初始化异常时释放 pool。
4. **Redis 驱动异常与重连死锁清除**: 挂载 `instance.on("error")`，在 `connect()` 失败时显式执行 `instance.disconnect()`，消除后台无限重连导致的关机卡死。

### B. 5 项稳定性与容量短板加固 (P1)
1. **MySQL 64 位标识符超限保护**: 引入安全标识符裁剪与哈希机制，物理表名与索引名无论多长均严格 $\le 64$ 字符。
2. **Redis 海量键调用爆栈与阻塞消除**: 消除 `mget(...keys)` 与 `del(...keys)` 的 spread 传参，实施 500 行安全分块；`iterator()` 升级为真正的分批流式生成器。
3. **Redis `setMany` 错误透传**: 检查 `pipeline.exec()` 返回的每个命令结果，拒绝静默吞没错误。
4. **Queue `getStats()` 防 OOM 优化**: 避免全表反序列化大对象，按状态分页或高效聚合。
5. **Cache 子系统资源关闭补全**: 在 `KVDB.close()` 中补齐 `cache.close()` 调用，杜绝连接句柄泄漏。

### C. 5 项中危与运维规范加固 (P2)
1. **`WriteBatcher` 定时器 `unref()`**: 落实防抖定时器 unref，保障事件循环不受延阻。
2. **SQLite 连接 `busy_timeout`**: 默认启用 `busy_timeout = 5000` 防并发冲突。
3. **单元测试外部强依赖解耦**: MySQL / Redis 单测在未配置或无法连接时优雅跳过，保证 `pnpm test` 纯净通过。
4. **`package.json` CJS 类型分支映射**: 规范导出 `index.d.cts`。

---

## 2. 验收标准

1. `pnpm typecheck` 0 错误通过。
2. `pnpm build` 构建成功，ESM/CJS 双产物正常。
3. `pnpm test` 单元测试在无需任何外部 Docker 数据库的前提下 100% 绿灯全部通过。
4. `pnpm examples` 26 个示例在无外部依赖场景下 100% 顺畅执行，不再挂死或抛出 unhandled error。
5. 编写针对 P0 缺陷的回归测试用例验证重试、租户前缀隔离与连接安全。
