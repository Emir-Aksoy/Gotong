# 接入 agent

> 同步自英文版 [`docs/AGENT.md`](../AGENT.md) @ 2026-05-17

agent 就是想接受 Task 并把结果回写到 Hub 的任何程序。AipeHub 支持两种物理形态：

1. **In-process agent** — 你的程序自己内嵌 Hub（`new Hub({ space })`），然后 `hub.register(new MyAgent())`。最快，无网络。
2. **Remote agent** — 你的程序跑在网络任意位置，通过 `@aipehub/sdk-node`（TS/JS）或 `aipehub`（Python）连到 Hub 的 WebSocket 端口。API 表面跟 in-process 一模一样。

两种形态都实现同一个 `Participant` 契约，所以一个 agent 可以在两种形态之间迁移而**不改业务逻辑**。

本文专注 **remote agent** —— Hub 已经在跑着、你想接一个 agent 上去时用的就是这条路径。in-process 的写法参见仓根 [`README.md`](../../README.md) 的代码片段。

---

## 方案 A — Node.js / TypeScript

装 SDK：

```bash
npm install @aipehub/sdk-node
# 或者 pnpm add @aipehub/sdk-node
```

最小 agent：

```ts
import { AgentParticipant, connect, type Task } from '@aipehub/sdk-node'

class GreeterAgent extends AgentParticipant {
  constructor() {
    super({ id: 'greeter', capabilities: ['greet'] })
  }
  protected handleTask(task: Task): unknown {
    const name = (task.payload as { name?: string })?.name ?? 'friend'
    return { text: `Hello, ${name}!` }
  }
}

await connect({
  url: 'wss://hub.example.com/ws',   // 公网部署
  // url: 'ws://127.0.0.1:4000',     // 本机 Hub
  agents: [new GreeterAgent()],
})

console.log('agent online — waiting for tasks')
```

happy path 的完整故事就这么多：

1. 你定义一个 class，它的 `handleTask(task)` 返回结果。
2. `connect(...)` 打开 WebSocket，发出一个 `HELLO` 描述你的 agent。
3. Hub 准备好向你 dispatch 时回 `WELCOME`。如果 Hub 配置了 `gating: 'admin-approval'`，WELCOME 要等管理员人工批准后才会到达。
4. 之后每个 Task 都送到 `handleTask`；返回值就是这个 Task 的 result。

### 单进程多 agent

一次 `connect()` 可以挂多个 agent，它们共享一个 WebSocket session，但 id 和 capability 各不相同：

```ts
await connect({
  url: 'wss://hub.example.com/ws',
  agents: [
    new WriterAgent(),       // capabilities: ['draft']
    new ReviewerAgent(),     // capabilities: ['review']
  ],
})
```

Hub 把它们视为不同的 Participant，按 id / capability 分别路由 Task。

### 自动重连

默认 `connect` 会无限重试，指数退避（1s → 30s）。需要感知连接状态变化的话：

```ts
await connect({
  url: 'wss://hub.example.com/ws',
  agents: [new MyAgent()],
  onStateChange: (state, info) => {
    console.log(`[link] ${state}${info?.reason ? ` (${info.reason})` : ''}`)
  },
})
```

传 `autoReconnect: false` 让 session 在断线时直接 fail-hard —— 测试场景常用。

### 取消（cancellation）

如果一个 Task 在执行过程中被 Hub 取消（比如 broadcast 策略下别的 agent 先抢到了），你的 agent 的 `onTaskCancelled` 会被调用。默认实现是空操作；如果你的 agent 持有外部资源就要覆盖它：

```ts
class WriterAgent extends AgentParticipant {
  constructor() { super({ id: 'writer', capabilities: ['draft'] }) }

  protected async handleTask(task: Task): Promise<unknown> {
    /* ... */
  }

  override async onTaskCancelled(taskId: string, reason: string) {
    console.warn(`[writer] task ${taskId} cancelled: ${reason}`)
    // 拆掉任何中间状态
  }
}
```

### Hub Services（v1.1+）—— memory / artifact / datastore

Remote agent 可以用**跟 in-process LlmAgent 一模一样的 TypeScript 表面**来驱动 Hub Services。在 `connect()` 里声明你需要的，在返回的 `Session` 上读出来，挂到自己的 agent 上：

```ts
import { AgentParticipant, connect, type Task } from '@aipehub/sdk-node'

class CoachAgent extends AgentParticipant {
  services?: import('@aipehub/sdk-node').ServiceClient

  constructor() {
    super({ id: 'coach', capabilities: ['draft'] })
  }

  protected async handleTask(task: Task): Promise<unknown> {
    const caseId = (task.payload as { caseId: string }).caseId
    // 跟 in-process LlmAgent 完全一样的 MemoryHandle 接口。
    const caseMem = this.services!.memoryFor('file', {
      kind: 'workflow-run',
      id: caseId,
    })
    const prior = await caseMem.recall({ k: 20 })
    await caseMem.remember({ kind: 'episodic', text: 'draft v1' })
    return { saw: prior.length }
  }
}

const coach = new CoachAgent()
const session = await connect({
  url: 'wss://hub.example.com/ws',
  agents: [coach],
  services: [
    // 静态的 per-agent memory（常见情况）
    { type: 'memory', impl: 'file', owner: { kind: 'agent', id: 'self' } },
    // case-scope memory —— agent 在调用时决定 case id
    { type: 'memory', impl: 'file', owner: { kind: 'workflow-run', id: '*' } },
  ],
})
coach.services = session.services
```

它带来什么：

- Hub 在每个 `(type, impl, owner)` 第一次调用时 lazy-attach；之后的调用复用缓存。
- `owner.id: 'self'` 在服务器端解析成当前 agent 的 id。
- `owner.id: '*'` 是通配符 —— case-scope memory 必须用这个，因为 id 来自 `task.payload.caseId`，只有调用时才知道。
- 调用 allowlist 之外的方法（memory 的 allowlist 是 `recall` / `remember` / `list` / `forget` / `clear`）会返回 `unknown_method`。这条 allowlist 存在的目的是防止行为不端的 agent 沿原型链探查。
- 连接断开时，Hub 自动 detach 所有缓存的 handle；重连后重新 attach。

ACL 是**声明式**的：HELLO 写错 = ACL 错。在 `gating: 'admin-approval'` 模式下，管理员审核申请时能看到完整的 `services` 列表。设计意图和完整 ACL 语义见 [`../services-over-ws-rfc.md`](../services-over-ws-rfc.md)。

SDK 端的错误处理表现为 `ServiceCallError`，`error.code` 就是 wire 协议里的错误码枚举：

```ts
import { ServiceCallError } from '@aipehub/sdk-node'

try {
  await this.services!.memory!.recall({})
} catch (err) {
  if (err instanceof ServiceCallError && err.code === 'forbidden_owner') {
    // …
  }
}
```

### Channel（自由格式的消息通道）

非 Task 类型的参与者间通信：

```ts
const session = await connect({ /* ... */ })
session.subscribe('writer', '#announcements')
session.publish('writer', '#announcements', { kind: 'hello' })
```

在 agent class 上覆盖 `onMessage(msg)` 接收发到 agent 订阅 channel 的消息。

---

## 方案 B — Python

安装：

```bash
pip install aipehub
```

等价的 agent：

```python
from aipehub import AgentParticipant, connect

class Greeter(AgentParticipant):
    id = "greeter"
    capabilities = ["greet"]

    async def handle_task(self, task):
        name = (task.payload or {}).get("name", "friend")
        return {"text": f"Hello, {name}!"}

async def main():
    await connect(
        url="wss://hub.example.com/ws",
        agents=[Greeter()],
    )

import asyncio
asyncio.run(main())
```

Python SDK 在 wire 协议层面跟 `@aipehub/sdk-node` API 兼容 —— 一样的 `HELLO` / `WELCOME` / `TASK` / `RESULT` frame，一样的自动重连行为，一样的 cancellation 语义。

详细参考 [`../../python-sdk/README.md`](../../python-sdk/README.md)。

---

## 幕后到底发生了什么

```
        ┌─ 你的 agent 进程 ─────┐
        │  AgentParticipant     │
        │     onTask(task) ─────┼──── TASK frame ───────────────┐
        │  ▲                    │                                │
        └──┼────────────────────┘                                ▼
           │                                       ┌─ Hub ─────────────┐
           └──── RESULT frame ─────────────────────┤  Scheduler        │
                                                   │  按 capability /  │
                                                   │  id / broadcast    │
                                                   │  路由              │
                                                   └───────────────────┘
```

每个 TASK 和 RESULT 也会追加到 `transcript.jsonl`。transcript 是 source of truth —— `hub.tasks()` 和管理员 task 面板都是从它派生出的视图，不是独立状态。

Wire 协议细节见 [`../PROTOCOL.md`](../PROTOCOL.md)。

---

## 批准流程（`gating: 'admin-approval'` 时）

这是任何非琐碎 Hub 的默认设置。在 `connect` 时：

1. SDK 发出 `HELLO { agents: [{ id, capabilities }], … }`
2. Hub 追加一条 `agent_pending` 事件到 transcript，**暂不** WELCOME。管理员 UI 把你的申请列在「待批准应用」里。
3. 管理员点 **Approve**，服务器把你的申请翻成 approved，在仍然开着的 WS 上发 `WELCOME { sessionId }`。
4. 从此你的 agent 就是普通 `Participant` 一员。

如果管理员拒绝，你收到 `REJECT`。SDK **不会**自动重试 REJECT —— 它是终态。

告诉你的用户用哪个 token / URL：

- 公网 ws URL：`wss://hub.example.com/ws`
- 测试时：本机 `pnpm host` / `pnpm demo:open-space` 的 `ws://127.0.0.1:4000`

如果 `gating: 'open'`（仅开发用，**生产环境绝不能用**），没有 pending 状态；agent 直接加入。

---

## 联邦 agent —— 把一个 Hub 当 agent 用

要让一个 *团队*（一个小 AipeHub）以单个 agent 的形态出现在更大的 AipeHub 上，用 `@aipehub/sdk-node` 里的 `TeamBridgeAgent`。完整教程 + 可跑 demo（`pnpm demo:federated-team`）见 [`../FEDERATION.md`](../FEDERATION.md)。

---

## Task weight（v2.1）

到达的 Task 带一个可选的 `weight: number`（0.1–10.0，一位小数）。大部分 agent 可以无视它 —— 这个字段的存在是为了让事后**人类** review 时能算贡献分（`weight × rating`）。但如果对你有用，可以读：

```ts
class WriterAgent extends AgentParticipant {
  protected async handleTask(task: Task): Promise<unknown> {
    const w = task.weight ?? 1.0
    // 高分量 Task → 多花点 token
    const maxTokens = w >= 5 ? 4000 : 1000
    return await callLlm(task.payload, { maxTokens })
  }
}
```

Hub 在 `weight` 到达你这里之前已经 clamp + 四舍五入过，所以拿到的值一定在范围内。如果管理员没填这个字段，Hub 默认填 `1.0` —— 你不会看到 `undefined`，只会看到默认值。

---

## Capability 命名约定

Capability 是自由格式字符串，AipeHub 没有内置的分类法。一些实用建议：

- 保持短而像动词：`draft`、`review`、`translate`、`code`。
- 在能相互替代的 agent 之间复用同一字符串 —— `capability` dispatch 策略就是靠这个找候选。
- 不要在里面编码版本（`draft-v2`）—— 那是 id 的活。

没有全局注册表；重要的是**管理员**和**agent** 对字符串达成一致。

---

## 排错

| 现象 | 可能原因 |
|---|---|
| `connect` 立即被拒，提示 `hub rejected: gating: admin-approval` | Hub 在管理员批准前就先拒了。看一下管理员 UI。 |
| WS 打开后立刻悄悄关闭 | URL 是 `wss://` 但服务端只跑 HTTP，或反过来。把 scheme 跟部署对齐。 |
| `connect` 一直挂着不动 | `gating: 'admin-approval'` 但没人批准你。打开管理员面板。 |
| 浏览器里看到 `Upgrade Required` | 你在浏览器里打开了 WS 端口。浏览器只能跑 HTTP，请打开 Web 端口。 |
| Task 永远不到 | 你的 `capabilities` 跟管理员 dispatch 的不匹配。用 `/api/state` 验证。 |
