# V4 Phase 10 — Agent → 子 agent dispatch toolset (收尾)

> Phase 10 把 "agent 决定调谁、调几次、怎么聚合" 从 workflow runner
> 配置上升到 LlmAgent 的 tool-use 主循环里 —— `dispatch_task` 现在是
> LLM 可以自己选择的工具，而不是 workflow YAML 预先规定的步骤。
>
> Last updated: 2026-05-26

---

## 一、本阶段动了什么

| Milestone | Commit | 关键产物 |
|---|---|---|
| M1 | `705e462` | `DispatchToolset` (LlmAgentToolset, 暴露单 tool `dispatch_task`) |
| (fix) | `c813a04` | 10 个 example 的 Phase 8 `llm_stream_chunk` case 收尾 + OpenAIProviderOptions `maxRetries` 死字段清理 |
| M2 | `07e2124` | `Task.ancestry` 字段、Hub.dispatch 深度 + 环路 gate、ALS-based `runForTask` 任务隔离 |
| M3 | `c2a60d7` | `installPeerLink` inbound 透传 ancestry —— 跨 hub 深度 gate 不重置 |
| M4 | `7a88902` | `ManagedAgentSpec.dispatch:` allow-list、`ComposedToolset` 多路复用、admin UI 渲染 ancestry chain |
| M5 | `3650578` | `examples/architect-team` 端到端 demo (architect + writer/reviewer/tester) |
| M6 | (this commit) | 本文 + CLAUDE.md 标 Phase 10 完 |

总改动: 6 commits + 1 fix。+12 example/fix 文件 (Phase 8 残留) + 5 新文件 (M5 example) +若干新建测试。`@aipehub/llm` 加 2 个导出 (`DispatchToolset`, `ComposedToolset`)，`@aipehub/core` 加 1 个 type (`AncestryNode`)。

---

## 二、为什么做这阶段

Phase 9 之前 LlmAgent 的 tool-use loop 只能调 MCP server tool —— 也就是
"读文件、查天气、调 API" 这类**纯函数式**工具。要做"协调多个 agent"
得在 workflow YAML 里写显式 dispatch 步骤：

```yaml
steps:
  - parallel:
      - dispatch: { to: writer }
      - dispatch: { to: reviewer }
      - dispatch: { to: tester }
  - dispatch: { to: aggregator }
```

这套机制的问题：
1. 不是 LLM 决定，是 YAML 决定 —— 改 flow 要改文件，agent 自己学不到
2. fan-out 形状固定 —— 想跳过 reviewer 没办法
3. 聚合是 aggregator agent 二次调用 —— 多一跳

Phase 10 把这层翻转：agent 通过 `dispatch_task` tool 主动调度，aggregation
就在 tool-use loop 的下一轮 LLM 调用里自然完成。Architect 模式从
"workflow 编排" 变成 "agent 自主调度"。

---

## 三、关键设计决策

| 决策点 | 选择 | 为什么 |
|---|---|---|
| 单 tool vs 多 tool | 单 `dispatch_task`，input 含 agentId/capability | LLM 少 input tokens；语义清晰 |
| target 互斥参数 | `agentId` XOR `capability` | JSON Schema `oneOf` 在某些 LLM 不稳；两个互斥字段更鲁棒 |
| Allow-list 越界处理 | 返 `isError: true`，不抛 | LLM 可以重试，不必整轮 task 失败 |
| 不暴露给 LLM 的字段 | `weight`、`countContribution`、`origin` | 这些是 publisher / federation 政策，agent 没资格自己设 |
| Ancestry 字段语义 | `{ taskId, by }` 不是 `{ taskId, from }` | `by` = 实际执行者，才是 cycle 检测要看的对象。`from` 是 dispatcher（agent 可以正常递归自调） |
| Ancestry 透传 | dispatcher 显式传，Hub 不查 task registry | Hub 不持有所有历史 task 对象 |
| Depth gate 默认值 | 5 | architect-team 实际需要 2 跳；超过基本是 runaway。env `AIPE_MAX_DISPATCH_DEPTH=N` 可覆盖 |
| 拒收时落 transcript | 创建 task + 立即 failed 结果 | 跟 deadline_expired 一致；审计有迹可循 |
| Cycle gate 范围 | 只查 explicit target，不查 from / capability | self-dispatch 是合理范式；capability 不知谁会接，留给 depth gate |
| Toolset task 隔离 | `runForTask(task, fn)` + ALS.run | `enterWith` 会污染兄弟 async chain；`run` 是 push/pop 正解 |
| MCP + Dispatch 共存 | `ComposedToolset` 多路复用 | LlmAgent 只接受单 toolset；不破坏现有接口 |
| 跨 hub ancestry | peer-link-install inbound 加 1 行透传 | 已有 task.ancestry 字段；transport 自动序列化 |
| Audit 通路 | transcript 已有 task entry with ancestry 即足够 | 不为单字段重复写 vault audit 行 |

---

## 四、数据流端到端

```
1.  user / workflow / admin
       │
       │  hub.dispatch({ from, strategy, payload })   ← root, ancestry=[]
       ▼
2.  Hub.dispatch
       │  Gate: ancestry.length < MAX → ok
       │  写 transcript: task entry
       │  scheduler.dispatch(task)
       ▼
3.  capability matcher / explicit picker
       │  picks architect (LlmAgent with DispatchToolset)
       ▼
4.  LlmAgent.handleTask(task)
       │  toolset.runForTask({id, from, ancestry: []}, async () => {
       │    ┌── ALS frame entered ──┐
       │    │ LLM round 1: returns 3 tool_use chunks │
       │    │   for each tool_use:                   │
       │    │     toolset.callTool('dispatch_task', input)
       │    │       │
       │    │       │  reads ALS frame → builds child ancestry:
       │    │       │     [...inherited, { taskId: parentId, by: 'architect' }]
       │    │       ▼
       │    │     hub.dispatch({ from: 'architect', strategy: explicit-to-writer,
       │    │                    ancestry: child_chain })
       │    │       │  Gate: depth + cycle check
       │    │       │  写 transcript: child task entry (with ancestry)
       │    │       │  ▼ scheduler → writer.onTask
       │    │     returns TaskResult.ok
       │    │   ...similar for reviewer, tester...
       │    │ LLM round 2: synthesises final plan
       │    └──── ALS frame exited ────┘
       │  }) ← runForTask returns
       ▼
5.  TaskResult.ok with architect's final plan
6.  写 transcript: root task_result

       ┌─ admin UI reads transcript ─┐
       │  task entry .ancestry shown │
       │  as compact dispatch chain  │
       └─────────────────────────────┘
```

---

## 五、被覆盖的测试

| 文件 | 测试数 | 主要场景 |
|---|---|---|
| `packages/llm/tests/dispatch-toolset.test.ts` | 23 | listTools / callTool / allow-list / result mapping / throw catch |
| `packages/llm/tests/dispatch-toolset-ancestry.test.ts` | 9 | runForTask + ALS 隔离 + ancestry 透传 |
| `packages/llm/tests/composed-toolset.test.ts` | 9 | concat / route / nest / 兼容无 runForTask 子 toolset |
| `packages/core/tests/dispatch-ancestry.test.ts` | 16 | Hub.dispatch depth gate / cycle gate / env override |
| `packages/core/tests/peer-link-ancestry.test.ts` | 3 | Cross-hub ancestry preserve / depth gate enforce |
| `packages/host/tests/local-agent-pool-dispatch.test.ts` | 3 | Manifest dispatch:field wiring + e2e tool-use loop |
| **总计** | **+63 tests** | workspace 之前 2079 → 2191（含一些其他 phase 的小数变化也都跑过验证） |

跑下来 workspace 全过。`pnpm demo:architect-team` 跑通输出 12 transcript entries 含 3 个子 task 都带 `ancestry=architect`。

---

## 六、运维须知

### 环境变量

- `AIPE_MAX_DISPATCH_DEPTH` —— 默认 5；范围 1-50；out-of-range 静默
  fallback 到 5。用于在生产把 cap 调严（深度 limit 2 让任何 multi-hop
  调度全部被拒），也可用于偶尔需要 deeper chains 的研发场景。

### Allow-list 配置入口

YAML 里 `ManagedAgentSpec.dispatch`：

```yaml
agents:
  - id: architect
    managed:
      kind: llm
      provider: anthropic
      model: claude-opus-4-7
      system: |
        You are an architect. Use dispatch_task to delegate to
        writer/reviewer/tester then synthesise their replies.
      dispatch:
        agents:       [writer, reviewer, tester]
        capabilities: []      # 也可以填能力名
```

空 arrays 与 `dispatch:` 字段完全省略等价 —— LLM 看不到 `dispatch_task` 工具。

### 跨 hub dispatch

要让 architect 跨 hub 调子 agent，把目标的 capability 列入
`allowedCapabilities`，scheduler 自动通过 `peerLink` 路由（D2
cross-hub HITL 同款路径）。ancestry 跨 hub 透传，depth gate 不重置。

### Audit trail

事件按以下顺序写 transcript：
1. parent `task` entry（带 ancestry 字段，可能 absent）
2. parent `task_result`（agent 完成）
3. 每个 child task entry / result（带 child ancestry）
4. 跑 transcript reader 看 → ancestry 字段给你完整 dispatch DAG

如果要 SQL 查询 / 时间序列聚合，Phase 11/12 再加 dedicated audit table。

---

## 七、未开放给 LLM 的字段（policy 边界）

`dispatch_task` 工具的 input schema 仅暴露：

```
agentId / capability / payload / title / deadlineMs / priority
```

故意**没**包含：

- `weight` —— contribution-system 权重，publisher 政策
- `countContribution` —— leaderboard opt-out，publisher 政策
- `origin` —— federation 身份声明，HubLink / OrgApiPool 决定
- `ancestry` —— hub 自己构造，agent 不能伪造祖先链

如果未来发现 agent 真的需要其中某个，再单独 widen schema 并配相应
allow-list / sanitiser。

---

## 八、Phase 11 入口

下一步 (Phase 11): **long-running agent — suspend/resume**。

agent 通过 `SuspendTaskError({ resumeAt, state })` 把当前 task 暂停；调度器持久化 state 到 SQLite，到点自动唤醒重派给原 agent，调 `onResume(state)`。结合 Phase 10 的 dispatch 链就能做"等 24 小时后让另一个 agent 继续"这种长流程。

详见 `docs/zh/V4-PHASE7-13-PLAN.md` 第六节。
