# TASK-024: 查询结果缓存 (Query Cache + Write Invalidation)

## 1. 目标
在 `Table` 查询层（`find()` 与 `findRecords()`）引入生产级查询结果缓存。通过对查询 AST 与选项生成确定性指纹进行缓存，并在任何发生写突变（`set`, `delete`, `update`, `setMany`, `deleteMany`, `flush`）时，借助 `deleteByPrefix` 实现针对该命名空间的自动、精确写失效（Write Invalidation），彻底消除陈旧脏读，提升高频读密集场景吞吐量。

## 2. 核心范围与交付物
1. **配置接口扩展**：
   - `src/core/table.ts` 与 `src/core/kvdb.ts`: `TableOptions` 增加 `queryCache?: boolean | { enabled?: boolean; ttlMs?: number }`。
2. **确定性查询指纹引擎**：
   - 实现规范化序列化器，保证 `{ a: 1, b: 2 }` 与 `{ b: 2, a: 1 }` 产生完全相同的缓存键指纹。
3. **Query Cache 读取与回填**：
   - `find()` 与 `findRecords()`: 若命中缓存直接反序列化返回；未命中时执行物理查询，回填缓存并打上 TTL。
4. **精确写失效机制 (Write Invalidation)**：
   - 在 `set`, `delete`, `update`, `setMany`, `deleteMany`, `flush`, `clear` 触发时，自动调用 `cache.deleteByPrefix("_qc:" + namespace + ":")`。
5. **单元测试与集成测试**：
   - `test/unit/query-cache.test.ts`: 覆盖缓存命中、不同排序与过滤条件的指纹隔离、写操作自动失效、TTL 到期回查、AutoBatch 刷新失效。

## 3. 验收标准
- 相同的 `find()` / `findRecords()` 多次执行，仅首次打到底层驱动（底层查询计数为 1）。
- 键顺序不同的等价查询共享相同缓存条目。
- 任何写突变执行后，下一次查询必须获取最新数据（失效有效性 100%）。
- 未开启 `queryCache` 的表行为完全不受影响。

## Status
DONE (100% 交付并通过全量验证)

## 4. 交付清单与验证结果
- **类型与配置扩展**: `src/core/table.ts` 导出 `QueryCacheOptions`；`TableOptions` 支持 `queryCache?: boolean | QueryCacheOptions`；`src/core/kvdb.ts` 与 `src/index.ts` 导出配置类型。
- **确定性查询键生成**: 递归对象键排序序列化算法，确保 `{ where: { a: 1, b: 2 } }` 与 `{ where: { b: 2, a: 1 } }` 命中相同缓存。
- **Query Cache 查询拦截与回填**: `find()` 与 `findRecords()` 在查询前优先检查 `_qc:<namespace>:...` 缓存键，未命中时执行物理查询并透明回填，支持独立 TTL。
- **全局写失效自动同步**: 在 `set`, `delete`, `update`, `setMany`, `deleteMany`, `clear`, `deleteByPrefix` 以及 `flushBatch` 时，自动调用 `cache.deleteByPrefix("_qc:" + namespace + ":")`，杜绝任何脏读。
- **单元测试与实战示例**:
  - `test/unit/query-cache.test.ts`: 7 项严苛单测覆盖缓存击中、指纹一致性、单写失效、批量失效、Schema 物理表失效与 AutoBatch 刷新失效。
  - `examples/24-query-cache-and-invalidation.ts`: 实战演示文章查询、极速缓存击中与写失效后秒级数据同步。
