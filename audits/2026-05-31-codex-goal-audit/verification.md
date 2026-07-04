# Verification

## Commands

```bash
pnpm -r typecheck
```

结果: 通过。

```bash
pnpm -r test
```

结果: 通过。所有 workspace vitest package run exit code 0。

```bash
pnpm test:python
```

结果:

```text
57 passed in 0.68s
```

## Targeted repros

### v4 identity session does not authorize legacy admin API

脚本行为:

1. 创建临时 Space。
2. 打开 IdentityStore，bootstrap owner，设置 password。
3. 启动 `serveWeb({ identity })`。
4. `POST /api/admin/identity/login` 成功拿到 `gotong_identity`。
5. 只带该 cookie 调 `GET /api/admin/agents`。

输出:

```json
{"loginStatus":200,"cookiePrefix":"gotong_identity=","agentsStatus":401,"agentsBody":"{\"error\":\"admin auth required\"}"}
```

解释: 这证明当前 v4 登录面和 operational admin API 之间没有真正统一。

### workflow deepCheck capability mismatch

脚本行为:

1. 构造 workflow step: `capabilities: ['chat', 'missing']`。
2. 构造 inventory: 一个 agent 只提供 `chat`。
3. 调 `checkWorkflowStructure()`。
4. 用真实 `Registry.byCapabilities(['chat', 'missing'])` 比对 runtime 候选。

输出:

```json
{"deepCheckOk":true,"violations":[],"runtimeCandidates":[]}
```

解释: deepCheck 认为可行，但 runtime scheduler 语义要求单个参与者覆盖全部 capability。

### workflow child task suspended handling

脚本行为:

1. 构造 `WorkflowRunner`。
2. 注入 HubLike，使 step dispatch 返回 `TaskResult.kind='suspended'`。
3. 调 `runner.onTask()`。

输出:

```json
{"kind":"failed","taskId":"root-1","by":"workflow:suspend-gap","error":"step 'sleep' failed: unexpected ok in failure path","ts":1780190503834}
```

解释: workflow runner 没有把 `suspended` 当作一等运行状态处理。

## Notes

测试全绿不否定 findings。这里的 findings 是目标级和跨模块语义问题，当前测试没有覆盖这些组合路径。
