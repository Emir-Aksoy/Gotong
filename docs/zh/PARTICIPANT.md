# 20 行写一个 Participant

> 一句话：**凡是加入 hub 的东西——你的 agent、一个人、一个外部服务——都是同一个
> `Participant`。** 这就是 Gotong 的全部扩展面。学会写一个 `Participant`，你就学会了
> 扩展这个框架的所有方式。
>
> 想接的是「已经在跑的 hub、我从另一个进程连上去」——那是物理接线，看
> [`AGENT.md`](AGENT.md)。本文只讲**契约本身**：一个 `Participant` 长什么样、怎么写、
> 怎么加入 hub。

---

## 契约本身（就这么大）

`Participant` 的完整定义在 [`packages/core/src/types.ts`](../../packages/core/src/types.ts)：

```ts
interface Participant {
  readonly id: ParticipantId              // 你在 hub 里的名字
  readonly kind: ParticipantKind          // 'agent' | 'human'
  readonly capabilities: readonly string[] // dispatcher 能路由到你的标签

  onTask?(task: Task): Promise<TaskResult>          // 收一个派给你的 task
  onMessage?(msg: Message): void | Promise<void>    // 收一条广播 / 频道消息
  onResume?(task, state): Promise<TaskResult>       // 长任务被唤醒（可选）
  onTaskCancelled?(taskId, reason): void            // 任务被取消（可选）
  onShutdown?(): void | Promise<void>               // hub 关停（可选）
}
```

**必填只有前三个字段**；想真正干活，实现 `onTask`（能接 task）或 `onMessage`（能收
消息）里的一个就够。后面四个 `onXxx` 全是可选的控制缝——不写也能跑，写了就多一层
掌控（见下面「白拿的控制缝」）。

框架**不替你跑 LLM、不替你做决策**。它只把 task 路由给你、把你的结果写进 transcript、
发事件。`onTask` 里做什么、要不要调模型、调哪个模型，全是你的事——这就是北极星第一条
「框架不跑 LLM」在代码里的样子。

---

## 写法一：裸接口（真·20 行，可直接跑）

不需要任何基类。一个对象字面量就是一个合法的 `Participant`：

```ts
import { Hub, type Participant, type Task, type TaskResult } from '@gotong/core'

// 一个 Participant 就是「3 个字段 + 一个处理器」。没有基类，没有框架魔法。
const greeter: Participant = {
  id: 'greeter',
  kind: 'agent',                       // 'agent' | 'human'
  capabilities: ['greet'],             // dispatcher 靠这个把 task 路由给你
  async onTask(task: Task): Promise<TaskResult> {
    const { name } = task.payload as { name: string }
    // 结果信封：ok/failed + 你的 output。自己拼，或用写法二让基类替你拼。
    return { kind: 'ok', taskId: task.id, by: 'greeter', output: { text: `你好，${name}` }, ts: Date.now() }
  },
}

const hub = Hub.inMemory()
await hub.start()
hub.register(greeter)                   // ← 加入 hub
const res = await hub.dispatch({ from: 'system', strategy: { kind: 'capability', capabilities: ['greet'] }, payload: { name: 'Ada' } })
console.log(res)                        // { kind: 'ok', output: { text: '你好，Ada' }, ... }
```

跑起来 dispatcher 看 `capabilities`、把带 `greet` 的 task 路由到 `greeter`、调它的
`onTask`、把 `TaskResult` 写进 transcript。你没写任何路由代码——**能力匹配是 hub 的活**。

## 写法二：`AgentParticipant` 基类（省掉信封样板）

大多数 agent 只想「拿到 task → 算 → 返回 output」，不想每次手拼 `{ kind:'ok', taskId,
by, ts }`。`AgentParticipant`（[`packages/core/src/participants/agent.ts`](../../packages/core/src/participants/agent.ts)）
就是这层：你只 override `handleTask` 返回 output，基类替你封进 `TaskResult`、替你把
抛错变成 `failed`、替你把 `SuspendTaskError` 当控制流透传。

```ts
import { AgentParticipant, Hub, type Task } from '@gotong/core'

class Greeter extends AgentParticipant {
  constructor() {
    super({ id: 'greeter', capabilities: ['greet'] })
  }
  protected async handleTask(task: Task) {
    const { name } = task.payload as { name: string }
    return { text: `你好，${name}` }     // ← 只返回 output，基类替你拼信封
  }
}

const hub = Hub.inMemory()
await hub.start()
hub.register(new Greeter())            // register / dispatch 与写法一完全一样
```

这正是 [`examples/hello-collab`](../../examples/hello-collab/src/index.ts) 里 `WriterAgent` /
`ReviewerAgent` 的写法。**两种写法产出的是同一个 `Participant`**——裸接口给你全控制，
基类给你省样板，随时能互换。

---

## 加入 hub：`register` + `dispatch`

- `hub.register(participant)` —— 把它接进 hub，从此可被路由。
- `hub.dispatch({ from, strategy, payload, title? })` —— 派一个 task。两种路由：
  - `strategy: { kind: 'capability', capabilities: ['greet'] }` —— **按能力**，dispatcher
    挑一个声明了该能力的 participant（不点名，这是常态）。
  - `strategy: { kind: 'explicit', to: 'alice' }` —— **点名**派给某个 id。

返回的是 `TaskResult`：`{ kind: 'ok', output, ... }` 或 `{ kind: 'failed', error, ... }`。
`examples/hello-collab` 用四次 dispatch 串起 draft → review → revise → 人审批的全流程，
可以照抄。

---

## 白拿的控制缝（可选，但值钱）

这四个可选 `onXxx` 是「五控制缝」在 `Participant` 上的落点——写了就免费得到：

| 钩子 | 什么时候被调 | 不写会怎样 |
|---|---|---|
| `onResume(task, state)` | 你上次抛了 `SuspendTaskError`、被 park 后又到点唤醒 | 长任务默认重跑 `onTask`（幂等就没事） |
| `onTaskCancelled(id, why)` | 有人取消了这个 task | 收不到取消信号（跑完的结果被丢弃） |
| `onShutdown()` | hub 关停 | 没有优雅收尾的机会 |
| `onMessage(msg)` | 有人往你订阅的频道发消息 | 只能收 task，收不到广播 |

`onResume` 是 long-running / human-in-the-loop 的地基：`onTask` 里 `throw new
SuspendTaskError({...})` 就能挂起、让出 worker、到点被唤醒——不必把线程占着等。细节见
[`ledger/V4-PHASE16-FINAL.md`](ledger/V4-PHASE16-FINAL.md)。

---

## 人也是一个 Participant

北极星第二条：**不要把人当一个 "request_human_input" 工具**。一个人加入 hub 用的是同一个
契约——`kind: 'human'`。框架自带 `HumanParticipant`：

```ts
import { HumanParticipant } from '@gotong/core'
const alice = new HumanParticipant({ id: 'alice', capabilities: ['approve'] })
hub.register(alice)
// alice.next() 取下一个派给她的 task；alice.complete(taskId, output) 回填结果。
```

给 `alice` 派 task 和给 `greeter` 派 task **走的是同一个 `hub.dispatch`**。这就是「人和
agent 是同一个 Participant」——不是口号，是同一个 `register` / 同一个路由 / 同一条 transcript。

---

## 接着读哪

- **把它挪到另一个进程 / 另一台机器** → [`AGENT.md`](AGENT.md)（in-process vs remote SDK，
  同一个 `Participant` 契约，`connect()` 连 hub 的 WebSocket；业务逻辑一行不改）。
- **让它是个 LLM agent** → `packages/llm` 的 `LlmAgent`（就是一个把模型调用包进
  `handleTask` 的 `AgentParticipant`）+ [`AGENT-ADAPTER-CONTRACT.md`](AGENT-ADAPTER-CONTRACT.md)。
- **桥接现成的外部 agent**（Claude Code / Codex / 别人的 A2A / MCP）→
  [`QUICK-CONNECT.md`](QUICK-CONNECT.md) · [`MCP.md`](MCP.md)，出站适配器见
  [`ledger/V5-E2-CLI-ADAPTER.md`](ledger/V5-E2-CLI-ADAPTER.md)。
- **让你的参与者被别的 hub 用到**：策展这条边的 `outboundCaps`（通告=授权）后，
  对面的工作流步——或对面成员对管家的一句大白话（管家出网）——就能按能力
  路由到它 → [`NET-AGENT-NETWORK.md`](NET-AGENT-NETWORK.md) ·
  [`examples/butler-cross-hub`](../../examples/butler-cross-hub)。
- **照着抄一个完整的**：[`examples/hello-collab`](../../examples/hello-collab/src/index.ts)
  （agent×2 + 人，全流程最短），更多在 [`examples/`](../../examples/) 目录（45 个端到端 demo）。
- **概念总览** → [`OVERVIEW.md`](OVERVIEW.md)；**为什么这么设计** → [`ARCHITECTURE.md`](ARCHITECTURE.md)。
