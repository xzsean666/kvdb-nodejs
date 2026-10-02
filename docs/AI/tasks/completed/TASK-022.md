# TASK-022: 动态多键使用规范、示例与文档发布

## Objective
完善公开文档与可运行示例，向用户完整展现“随时动态创建不同类型 Key、多键高效检索与索引管理”的生产级用法。

## Scope
- 更新 `docs/SPEC.md`：详细阐述动态多键（Multi-Key）体系、主键定义、二级键点查、直连多键查询与动态加键 API。
- 更新 `docs/BUILD.md`：记录多键合规测试执行命令与真实数据库环境要求。
- 增加实战示例代码：创建 `examples/16-dynamic-multi-keys.ts`，展示动态加键、二级键索引与多键高效查询完整流程。
- 执行类型检查、全量测试与发布打包构建。

## Allowed Files
- `docs/SPEC.md`
- `docs/BUILD.md`
- `examples/16-dynamic-multi-keys.ts`
- `README.md`
- `docs/AI/SESSION_STATE.md`
- `docs/AI/TASK_INDEX.md`

## Dependencies
- TASK-021

## Inputs and Outputs
- **Input**: 已实现并通过合规测试的多键驱动与门面 API。
- **Output**: 准确同步的规格文档、独立可运行示例脚本与打包产物。

## Acceptance Criteria
1. `pnpm example examples/16-dynamic-multi-keys.ts` 顺利运行并打印预期输出；
2. `pnpm typecheck` 零错误；
3. `pnpm build` 成功产出 ESM / CJS / .d.ts。

## Verification Commands
```bash
pnpm typecheck
pnpm test
pnpm build
```

## Risks and Assumptions
- 示例代码保持自包含，默认使用内存或临时 SQLite，零配置可运行。

## Status
DONE

