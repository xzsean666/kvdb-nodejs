# TASK-025-CACHE: Cache 前缀清理能力 (deleteByPrefix)

## 1. 目标
在 KVDB SDK 的 Cache 子系统与底层存储契约（KVStore）中引入统一、高效的 `deleteByPrefix(prefix: string)` 能力，为跨层级批量失效、Query Cache 失效以及租户级缓存清理提供统一的高性能底层支持。

## 2. 核心范围与交付物
1. **底层接口契约扩展**：
   - `src/cache/types.ts`: `KVStore` 接口增加可选方法 `deleteByPrefix?(prefix: string): MaybePromise<number>`。
2. **存储适配器实现**：
   - `src/cache/stores/memory-store.ts`: 实现高效遍历与 LRU 前缀删除，返回实际删除条数。
   - `src/cache/stores/sqlite-store.ts`: 利用 `DELETE FROM "table" WHERE key LIKE ? ESCAPE '\\'` 实现单条 SQL 极速原子清理。
3. **多层 Cache 门面支持**：
   - `src/cache/cache.ts`: `Cache.deleteByPrefix(prefix: string): Promise<number>`，遍历已配置的 store tiers 执行前缀清理，对不支持原生前缀删除的第三方适配器自动降级为 `iterator(prefix)` + `deleteMany` / `delete`。
4. **单元测试与合规性**：
   - `test/unit/cache.test.ts`: 覆盖单层与多层 Cache 的 `deleteByPrefix`，验证部分匹配、前缀隔离、转义字符（如 `%`、`_`、`\`）安全性。

## 3. 验收标准
- 内存存储与 SQLite 存储均能正确按前缀删除键，不影响不匹配的键。
- 特殊字符（如包含下划线或百分号的前缀）不会被通配符误删。
- 多层 Cache 调用 `deleteByPrefix` 时各层级均被彻底清理。
- 所有单元测试 100% 通过。

## Status
DONE (100% 交付并通过全量验证)

## 4. 交付清单与验证结果
- **KVStore 接口扩展**: `src/cache/types.ts` 定义 `deleteByPrefix?(prefix: string): MaybePromise<number>`。
- **MemoryStore 实现**: `src/cache/stores/memory-store.ts` 实现安全的 LRU 键遍历与前缀删除。
- **SqliteCacheStore 实现**: `src/cache/stores/sqlite-store.ts` 实现基于 `DELETE ... WHERE key LIKE ? ESCAPE '\\'` 的单条 SQL 原子清理。
- **Cache 门面与透明降级**: `src/cache/cache.ts` 实现 `deleteByPrefix(prefix)`，支持多层存储并行清理与降级迭代。
- **单测全覆盖**: `test/unit/cache.test.ts` 增加前缀删除匹配、跨层级清理与通配符转义安全测试，100% 通过。

