# Findings

## P1 - v4 owner/admin 登录没有真正授权 legacy admin 操作面

影响: 组织管理目标被打断。v4 identity 已经有 owner/admin/member/viewer、session、invitation、audit，但大部分 operational admin API 仍只接受 legacy `Space` admin token/cookie。结果是: 用户通过 v4 登录成功后，不能只凭 `gotong_identity` cookie 管理 agents/workflows/services 等核心对象。

证据:

- `WebServerOptions.identity` 注释说 v4 session cookie 会被 `requireAdmin` 接受: `packages/web/src/server.ts:275`
- 但 `findAdminFromRequest` 只检查 Bearer 和 `ADMIN_COOKIE`，并调用 `ctx.space.verifyAdminToken` / `ctx.space.findAdminSession`: `packages/web/src/server.ts:1806`
- `requireAdmin` 失败时统一返回 `admin auth required`: `packages/web/src/server.ts:1879`
- 复现命令结果: v4 login 200，随后只带 `gotong_identity` 调 `/api/admin/agents` 返回 401。

复现输出:

```json
{"loginStatus":200,"cookiePrefix":"gotong_identity=","agentsStatus":401,"agentsBody":"{\"error\":\"admin auth required\"}"}
```

为什么这会影响北极星: 个人模式可以靠首次 admin URL 兜底，但“组织管理多个人 / agent”的身份源应是 v4 identity。邀请来的 admin 或只走 v4 登录的 owner 如果不能管理 agents/workflows，组织层就不是统一闭环。

建议修复:

- 在 `findAdminFromRequest` 中加入 v4 identity fallback，要求 role 为 `owner` 或 `admin`。
- 返回的 admin shape 可以是 structural adapter，不必把 v4 user 写回 legacy `admins.json`。
- 给每个 operational admin route 加 v4 session 回归测试，至少覆盖 `/api/admin/agents`, `/api/admin/workflows`, `/api/admin/services`, `/api/admin/uploads`。

## P1 - Workflow import 可以绕过 self-cycle 检查，且 runner 不传 ancestry，循环边界失效

影响: AI 生成或手写 workflow 可以导入一个会派回自身 trigger capability 的定义。deepCheck 能发现这一类问题，但 import route 不强制 deepCheck；更严重的是 `WorkflowRunner.dispatchOne()` 内部调用 `hub.dispatch()` 时没有传 ancestry，所以 Hub 的 Phase 10 depth/cycle gate 无法约束 workflow 自递归。

证据:

- import route 只调用 `ctx.workflows.importFromText(raw)`: `packages/web/src/workflow-routes.ts:102`
- `WorkflowController.importFromText()` 只 `parseWorkflow`、写文件、注册 runner: `packages/host/src/workflow-controller.ts:268`
- assistant route 注释也明确 `deepCheck.ok=false` 是黄色 warning，admin 仍可保存: `packages/web/src/workflow-routes.ts:133`
- `WorkflowRunner.dispatchOne()` 构造 dispatch opts 时只放 `from/strategy/payload/title/weight/priority/origin`，没有 ancestry: `packages/workflow/src/runner.ts:530`
- Hub depth/cycle gate 只看 `opts.ancestry`: `packages/core/src/hub.ts:943`, `packages/core/src/hub.ts:1067`

为什么这会影响北极星: 项目已经支持 agent-to-agent dispatch 的 ancestry/cycle gate，但 workflow runner 是集体工作流的核心引擎。如果 workflow path 不继承同样边界，AI workflow editor 越强，越容易生成可保存但会失控的 workflow。

建议修复:

- 给 workflow runner 内部 dispatch 建立 ancestry 链，至少把当前 workflow task/frame 传入 child task。
- import 时可选择 hard fail high-risk violations: `self_trigger_cycle`, `bad_ref`, `forward_ref`, `id_collision`。
- 如果仍允许保存 warning，要在运行前做最后一次 check 并阻断明显自递归。

## P1 - Workflow runner 不支持 suspended child task，长期 agent 无法自然成为长期 workflow

影响: Phase 11 的 long-running agent 已在 Hub/Scheduler/LlmAgent 层实现，但 workflow runner 遇到 child task 返回 `kind: 'suspended'` 时，把它当失败处理，并给出误导性错误 `unexpected ok in failure path`。这意味着“深度嵌入 AI 的工作流”无法自然包含需要等待外部条件或延迟 resume 的 agent。

证据:

- scheduler 对 `SuspendTaskError` 会返回 `kind: 'suspended'`: `packages/core/src/scheduler.ts:294`
- workflow step 只把 `ok` 视作完成，其他结果走 `describeFailure`: `packages/workflow/src/runner.ts:382`
- `describeFailure()` 没有处理 `suspended`，落到 `unexpected ok in failure path`: `packages/workflow/src/runner.ts:561`
- 复现输出:

```json
{"kind":"failed","taskId":"root-1","by":"workflow:suspend-gap","error":"step 'sleep' failed: unexpected ok in failure path","ts":1780190503834}
```

建议修复:

- 明确 workflow-level suspend 语义。推荐: child suspended 时 workflow run 记录 step status `suspended`，workflow task 也返回 `suspended`，resume 时从该 step 继续。
- 如果短期不做完整 resume，至少把错误改为明确的 `child task suspended; workflow runner does not support suspended steps yet`。
- 加 workflow runner suspend tests，覆盖 simple step、parallel branch、retry/continue policy。

## P2 - workflow deepCheck 的 capability 判定和 runtime scheduler 语义不一致

影响: AI workflow assistant 可能返回 `deepCheck.ok=true` 的 workflow，但运行时 `Registry.byCapabilities()` 找不到候选，最终 `no_participant`。这削弱了 AI 助手“帮用户生成可运行 workflow”的可信度。

证据:

- runtime registry 要求参与者覆盖所有 required capabilities: `packages/core/src/registry.ts:69`
- scheduler capability dispatch 使用 `registry.byCapabilities(required)`: `packages/core/src/scheduler.ts:163`
- deepCheck 只在“所有列出的 capability 都没人提供”时才报错: `packages/evals/src/checkers/workflow-structure.ts:275`
- 测试还把“至少一个 capability 满足就通过”固定为期望行为: `packages/evals/tests/workflow-structure.test.ts:239`
- 复现输出:

```json
{"deepCheckOk":true,"violations":[],"runtimeCandidates":[]}
```

建议修复:

- deepCheck 应查“是否存在单个 agent 覆盖全部 required capabilities”，和 `Registry.byCapabilities()` 保持一致。
- violation message 应列出缺失组合，而不只是单个 capability 是否存在。
- 更新 `workflow-structure.test.ts` 中的错误期望。

## P2 - `/me` 个人工作台还只是单 workflow allowlist，不是通用个人 agent hub

影响: 个人模式已经是 first-class UI shell，但真正面向普通个人用户的 `/me` 操作面目前只允许 `personal-growth-flow`。用户要管理多个 agent、多种个人 workflow，仍主要回到 admin UI。对于“个人管理自己和多个智能体”的产品承诺，这还偏运维，不够个人工作台化。

证据:

- `/me` route 明确只允许小 allowlist: `packages/web/src/me-routes.ts:23`
- 当前 allowlist 只有 `personal-growth-flow`: `packages/web/src/me-routes.ts:73`
- handler 会拒绝不在 allowlist 的 workflow: `packages/web/src/me-routes.ts:241`

建议修复:

- 保留 allowlist 安全边界，但让 workflow 定义显式声明 `meEntry` / `personalSurface`，通过审核后自动出现在 `/me`。
- `/me` 展示“我的 agents / 我的 workflows / 最近 transcript / 文件上传”而不是单一 personal-growth 表单。
- 继续保持 admin 能力完整，但不要让个人用户必须理解 admin tabs 才能完成日常任务。

## P3 - Federation 能表达集合节点，但能力发现仍偏静态

影响: `RemoteHubViaLink` 可以把一个 peer hub 包成 agent，ACL/origin/ancestry 也成立；但 wrapper capabilities 主要由安装方传入，注释中也说明尚未自动协商。对于多组织动态扩展，能力漂移需要人工配置或外部注册表兜底。

证据:

- `installPeerLink` 通过 `remoteCapabilities` 注册 wrapper: `packages/core/src/peer-link-install.ts:117`
- `RemoteHubViaLink` 注释说明当前不通过 wire 自动协商 capabilities: `packages/core/src/participants/remote-hub.ts:15`

建议修复:

- 先不做复杂 discovery。可以在 peer registry 中记录 capability manifest 的刷新时间和来源。
- 给 admin UI 标出 remote capability stale / unknown 状态。
- 长期再考虑 HELLO capability negotiation。
