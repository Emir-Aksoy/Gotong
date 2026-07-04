# Federation — 把 Hub 串起来

> 同步自英文版 [`docs/FEDERATION.md`](../FEDERATION.md) @ 2026-05-17

Gotong 的 Hub 故意做得很笨：不跑 LLM，也不关心来连接的 agent
到底是一个 Python 脚本，还是另一整个 Hub。这一条就够支撑联邦原语。
把一个本地 Hub **包装成"一个 agent"** 连到上游 Hub 上，你就有了一支
"以单一身份对外说话"的领头小队。

```
                Upstream Hub  （云端，公网）
                ┌────────────────────────────────────┐
                │  admin Bob                         │
                │  worker Carol                      │
                │  agent  claude-prod                │
                │  agent  alice-team  ← bridge       │
                └─────────────────┬──────────────────┘
                                  │  wss://hub.example.com/ws
                                  ▼
                Team Hub  （Alice 的笔记本）
                ┌────────────────────────────────────┐
                │  admin Alice                       │
                │  agent  writer-bot                 │
                │  agent  reviewer-bot               │
                └────────────────────────────────────┘
```

## 什么是 bridge

`TeamBridgeAgent`（在 `@gotong/sdk-node` 里）就是一个普通的
`AgentParticipant`，你把它**向外**连到上游 Hub。它的 `onTask` 不
自己做活，而是**把任务转派给你交给它的那个本地 Hub**，等本地队伍
出 `TaskResult`，再包装成"一个干净的 TaskResult"返回给上游，
让上游看见的是一条带出处的结果。

bridge 对上游呈现的接口：

| 上游看到 | bridge 内部做什么 |
|---|---|
| Agent `alice-team`，capabilities `['draft','review']` | 按 capability 转派任务给本地队伍 |
| `TaskResult.kind='ok'` | 本地结果返回时，`localBy` / `localTaskId` 折叠进 `output` |
| `TaskResult.kind='failed'` | 本地失败，错误信息前缀 `local team (<who>): <error>` |
| `TaskResult.kind='cancelled'` | 本地取消透传 |

## 最小代码

```ts
import { Hub, Space } from '@gotong/core'
import { serveWeb } from '@gotong/web'
import { connect, TeamBridgeAgent } from '@gotong/sdk-node'
import { WriterBot, ReviewerBot } from './bots.js'

// 1. 本地队伍 Hub（Alice 的私人驾驶舱）
const { space } = await Space.openOrInit('.gotong-team', {
  name: 'Alice team',
  adminDisplayName: 'Alice',
  config: { webPort: 3300, gating: 'open' },
})
const local = new Hub({ space })
await local.start()
local.register(new WriterBot())
local.register(new ReviewerBot())
await serveWeb(local, { port: 3300 })   // Alice 的私有 UI

// 2. 向外架桥到上游
const bridge = new TeamBridgeAgent({
  id: 'alice-team',
  capabilities: ['draft', 'review'],     // 你向上游暴露什么能力
  localHub: local,
})
await connect({
  url: 'wss://hub.example.com/ws',
  agents: [bridge],
})
```

就这些。**没有新协议** —— bridge 走的还是其他所有 agent 都在用的
`@gotong/protocol` over WebSocket 传输。

## 为什么有用

- **隐私 / 主权**：只有 bridge 的结果离开 Alice 的网络。内部任务
  分发、每一步 transcript、队伍里到底是谁干的活，全留在本地。
  Alice 的领头 UI 看自己的队伍；上游管理员只看到 `alice-team`。

- **能力组合**：队伍里可以包含 Alice 不想单独暴露的 agent（私有
  LLM key、专用脚本、人类 reviewer）。她把这些打包暴露成一项
  队伍 capability。

- **本地节奏**：bridge 可以在本地侧任意限流 / 排队 / 优先级；
  上游看到的只是一个异步 agent。

- **身份收敛**：对房间运营者来说，上游一行 `alice-team` 比五个
  独立 agent 好推理得多。

- **信任边界**：上游 Hub 即便被攻破，也不会污染 Alice 的本地
  队伍 —— bridge 是**出站单向**的，本地 Hub 没有暴露入站
  WebSocket（除非 Alice 自己愿意）。

## 队伍内部的任务路由

`TeamBridgeAgent` 接受一个可选的 `mapTask(task) → { strategy, payload?, title?, deadlineMs? }`
让领头自己决定上游任务在本地怎么落地：

```ts
new TeamBridgeAgent({
  id: 'alice-team',
  capabilities: ['draft', 'review'],
  localHub: local,
  mapTask: (task) => ({
    // 路由给本地 capability 匹配最多的 agent
    strategy: { kind: 'capability', capabilities: task.payload?.capabilities ?? [] },
  }),
})
```

如果省略 `mapTask`，默认行为是：

1. 如果上游任务的 `payload` 是带 `capabilities` 字符串数组的对象 →
   `capability` 策略
2. 否则 → `broadcast`（整个本地队伍一起抢）

## 结果包装

本地队伍成功时，上游收到的 `TaskResult.output` 形如：

```ts
{
  localBy: 'writer-bot',                      // 本地真正做活的 agent
  localTaskId: '989f107f-…',                  // 跨 Hub 关联用
  output: { /* 本地 agent 实际返回的东西 */ },
}
```

上游管理员可以在自己的 UI 里审计"alice-team 交付了，她那边
真正做活的是 writer-bot"，无需切换上下文。

## 失败语义

| 本地状况 | 上游看到 |
|---|---|
| 本地队伍没有匹配 capability 的 agent | `TaskResult.kind='no_participant'`，reason 含 `local team has no matching participant: …` |
| 本地 agent 抛错 / 返回 failed | `TaskResult.kind='failed'`，错误前缀 `local team (<id>): <msg>` |
| 本地 Hub 取消（如 broadcast 抢输了） | `TaskResult.kind='cancelled'`，reason 前缀 `local team cancelled: …` |
| 到上游的 WS 链路任务途中断开 | 由上游侧决定 —— 典型 scheduler 报 failed；本地队伍可能其实已经做完了。幂等是领头的责任。 |

重试：如果上游管理员重试失败任务（`hub.retry(taskId)` 或管理 UI 的
Retry 按钮），它落地为**全新任务** —— bridge 看到新的 `task.id`，
开启一次新的本地分发。本地 transcript 同时记录两次尝试。

## bridge 套 bridge

bridge 机制是可递归的。Hub X 上的 bridge agent 自己可以有一个
本地 Hub Y，Y 里再有一个 bridge agent 连去 Hub Z。**协议层不限层数**。
实际中每多一层就多一跳网络；保持浅一些。

## 跑 demo

```bash
pnpm demo:federated-team
```

会拉起三个进程：

- **upstream-host** 在 `:3200` (web) / `:4200` (ws) —— "云端"
- **team-host** 在 `:3300`（Alice 的私有 UI）—— 向外连上游，注册成
  agent `alice-team`
- **driver** —— 自动化"批准 bridge、派 3 个任务、打印往返过程"

你会看到同一个任务在每个终端里出现两次 —— 上游一次
`TASK admin "draft about …" via capability`，本地一次
`TASK alice-team "[upstream] draft about …" via capability` —— 然后
结果上游回成 `RESULT ok by alice-team`，本地回成 `RESULT ok by writer-bot`。

`.gotong-upstream/transcript.jsonl` 和 `.gotong-team/transcript.jsonl`
各自保留自己侧的完整审计轨迹。
