# Findings

## P1: `@aipehub/protocol` 不再是 zero-runtime 底层契约

证据:

- `packages/protocol/package.json` 的 description 写着 `Zero runtime`。
- 同一文件的 dependencies 包含 `@aipehub/core`。
- `packages/protocol/src/frames.ts` 从 `@aipehub/core` import `ChannelId`, `Message`, `ParticipantId`, `Task`, `TaskId`, `TaskResult`。

影响:

- 协议层依赖 core, 方向反了。按初始设计, protocol 应是 wire contract, core / transport / sdk 应依赖它。
- 这会让第三方 SDK 或轻量协议消费者被迫拉入 core 的 package 边界。
- 后续如果 core 引入更多 runtime 依赖, protocol 包的"零运行时"承诺会继续被侵蚀。

建议:

- 把 wire-level primitives 和 frame payload types 下沉到 `@aipehub/protocol`。
- 或新增 `@aipehub/types` 作为无 runtime shared type 包, 由 core 和 protocol 同时依赖。
- 迁移后删除 protocol 对 core 的 dependency, 并加一条 dependency-boundary 测试或脚本。

## P1: 架构文档真相源失效

证据:

- `docs/zh/ARCHITECTURE.md` 写明"代码自相矛盾时, 本文档是真相源"。
- `docs/zh/V4-ARCH.md` 仍写 `Status: Phase 1 进行中`, 但当前 HEAD 是 `823c49a feat(workflow): WorkflowAssistantAgent — natural language → workflow YAML (Phase 13 M1)`。
- 根目录 `AGENTS.md` 当前未跟踪, 且其中仍把 Phase 13 标为下一步。
- `AGENTS.md` 写 `packages/` 为 19 个包, 当前实际有 26 个 package 目录。

影响:

- 后续 agent 或人类按文档做决策时会回到旧路线。
- "北极星"文件未跟踪, 新会话或 clean checkout 不一定能看到当前规则。
- 审查时需要从 commit / 代码反推真实阶段, 增加协作成本。

建议:

- 将 `AGENTS.md` 纳入版本控制, 或明确它只是本地工作副本。
- 把 `docs/zh/V4-ARCH.md` 标记为 historical, 新建或更新一个当前架构总览。
- 在文档中把 Phase 13 M1 记录为已开始, 并同步 package / example 数量。

## P2: `@aipehub/workflow` 混入 AI authoring 职责

证据:

- `packages/workflow/package.json` runtime dependencies 包含 `@aipehub/llm`。
- `packages/workflow/src/index.ts` 导出 `WorkflowAssistantAgent`。
- `packages/workflow/src/assistant.ts` 实现 natural-language 到 workflow YAML 的 LLM agent。

影响:

- workflow 包从"声明式 workflow schema + runner"变成"runner + AI authoring"。
- 不需要 LLM 的 workflow 消费者也会被 package 边界牵引到 LLM 抽象。
- 这和"Hub is dumb on purpose"不直接冲突, 但和"节点轻量、边界清晰"有张力。

建议:

- 拆出 `@aipehub/workflow-assistant`, 由它依赖 `@aipehub/workflow` 和 `@aipehub/llm`。
- `@aipehub/workflow` 保留 `parseWorkflow`, `WorkflowRunner`, `RunStore`, resolver / predicate 等纯 workflow 能力。
- host/web 需要 assistant 时显式接入新包。

## P2: Workflow assistant 成功语义偏松

证据:

- `packages/workflow/src/assistant.ts` 注释明确"不 validate YAML"。
- `packages/workflow/tests/assistant.test.ts` 固定了 missing fence 时仍返回 `TaskResult.kind === 'ok'`, 但 `yaml === ''` 的行为。

影响:

- 调用方可能看到 `ok` 后继续导入空 YAML 或不可用 YAML。
- "LLM 回答成功"和"生成了可用 workflow 草稿"混在一起。

建议:

- 输出加 `draftStatus: 'valid' | 'unvalidated' | 'no_yaml' | 'invalid'`。
- 或无 YAML fence 时直接返回 failed result。
- 后续 M2/M3 接 HTTP route 前, 在 route 层强制 `parseWorkflow(out.yaml)`。

## P2: Python SDK 根级测试脚本不可一键复现

证据:

- `package.json` 的 `test:python` 是 `cd python-sdk && .venv/bin/python -m pytest -q`。
- 当前直接运行失败: `ModuleNotFoundError: No module named 'aipehub'`。
- `python-sdk` 是 src-layout, 包位于 `python-sdk/src/aipehub`。
- 带 `PYTHONPATH=src .venv/bin/python -m pytest -q` 后 57 个测试通过。

影响:

- `pnpm test:all` 在干净工作区可能因为 Python import path 失败。
- CI 或新机器需要隐式知道先执行 editable install。

建议:

- 把根脚本改为 `cd python-sdk && PYTHONPATH=src .venv/bin/python -m pytest -q`。
- 或新增 `python-sdk` 的 bootstrap 脚本, 明确先 `.venv/bin/python -m pip install -e .[test]`。

## P3: 巨型文件增加维护成本

证据:

- `packages/web/src/server.ts`: 约 3563 行。
- `packages/web/static/admin.js`: 约 3265 行。
- `packages/core/src/space.ts`: 约 1325 行。
- `packages/host/src/main.ts`: 约 1099 行。
- `packages/host/src/local-agent-pool.ts`: 约 1101 行。

影响:

- 局部安全改动难以审查完整影响面。
- route 分支和产品行为集中在一个大函数内, 容易产生旁路。
- 前端 admin IIFE 后续加 Phase 13 编辑器时会继续膨胀。

建议:

- 继续沿用 `identity-routes.ts` / `me-routes.ts` 的拆分方向。
- 把 workflow routes、uploads routes、services routes 从 `server.ts` 拆出。
- admin 前端至少按 feature 拆静态模块, 保持无构建也可以用多个脚本文件。
