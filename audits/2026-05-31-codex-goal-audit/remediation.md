# Remediation

修复日期: 2026-05-31
修复方: Codex

本轮已修复 `findings.md` 中 4 个要求立即处理的问题:

1. `P1 - v4 owner/admin 登录没有真正授权 legacy admin 操作面`
   - `findAdminFromRequest()` 现在接受 v4 identity session / v4 bearer。
   - 仅 `owner` / `admin` role 会被映射成 legacy `AdminRecord`，`member` 仍返回 401。
   - 回归测试覆盖 `/api/admin/agents` legacy CRUD。

2. `P1 - Workflow import 可以绕过 self-cycle 检查，且 runner 不传 ancestry`
   - 新增 host 侧 `assertNoSelfTriggerCycle()` guard。
   - `WorkflowController.importFromText()` 和启动时 `loadWorkflows()` 都会拒绝 dispatch 回自身 trigger capability 的 workflow。
   - `WorkflowRunner` 内层 dispatch 会继承触发任务 ancestry，并追加当前 workflow frame。

3. `P1 - Workflow runner 不支持 suspended child task`
   - simple step 子任务返回 `kind: 'suspended'` 时，workflow step 记录为 `suspended`，workflow task 通过 `SuspendTaskError` 停车。
   - resume 时通过 `Hub.taskResult(taskId)` 读取子任务最新结果，从 suspended step 继续。
   - parallel branch 的 suspended child 也会记录 branch/task 映射，避免把 `suspended` 当普通失败。

4. `P2 - workflow deepCheck 的 capability 判定和 runtime scheduler 语义不一致`
   - deepCheck 现在要求存在单个 agent 覆盖 dispatch 要求的全部 capabilities。
   - 判定与 `Registry.byCapabilities(required.every(...))` 对齐。

仍未在本轮处理的问题:

- `P2 - /me 个人工作台还只是单 workflow allowlist`
- `P3 - Federation 能表达集合节点，但能力发现仍偏静态`

## Verification

已运行:

```bash
pnpm --filter @gotong/workflow test -- runner.test.ts
pnpm --filter @gotong/evals test -- workflow-structure.test.ts
pnpm --filter @gotong/host test -- workflow-controller.test.ts
pnpm --filter @gotong/host test -- workflow-loader.test.ts
pnpm --filter @gotong/web test -- agents-route.test.ts
pnpm -r typecheck
pnpm --filter @gotong/core test
pnpm --filter @gotong/workflow test
pnpm --filter @gotong/evals test
pnpm --filter @gotong/host test
pnpm --filter @gotong/web test
git diff --check
```

结果: 全部通过。

说明: `@gotong/host` 和 `@gotong/web` 测试需要监听 `127.0.0.1`，在沙箱内会因 `listen EPERM` 失败；本轮按权限规则用提权重跑后通过。
