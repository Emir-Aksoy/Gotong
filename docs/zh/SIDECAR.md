# Sidecar agent — 让 agent 跑在自己的进程里连 Hub

> 同步自英文版 [`docs/SIDECAR.md`](../SIDECAR.md) @ 2026-05-17

这是"第一天"实用指南：把你已经写好的 agent（TypeScript 或 Python）
接到一个已存在的 AipeHub Hub 上，**不动 Hub 的 `node_modules`、
也不动 YAML 清单**。这个契约从 wire protocol **v1.1** 起就稳定了
（也就是加入 Hub Services over WebSocket 的那个版本）。

要看 high-level 故事，读 [`AGENT.md`](./AGENT.md)。
要查 wire protocol 细节，读 [`PROTOCOL.md`](./PROTOCOL.md)。
本文是中间那层 —— **怎么做**。

---

## 为什么用 sidecar

agent 的三种集成形态，按摩擦从小到大排：

| 形态 | 跑在哪 | 需要在 Hub 上跑 `pnpm install` 吗？ |
|---|---|---|
| In-process | Hub 二进制内部 | 要 —— agent 代码是 host 的依赖 |
| **Sidecar（本文）** | **自己的进程，可以在网络任意位置** | **不要** |
| Federated | 一个被注册成"一个 agent"的更小的 Hub 里 | 不要，但它自己得跑 scheduler |

下面这些场景选 sidecar 最合适：

- 你不掌控 Hub 二进制（你是"外部开发者"，要接别人的 Hub）。
- 你想跟 Hub 的发布节奏脱钩，独立升级 agent。
- 你的 agent 需要一个 Hub 没有的运行时（Python、特定 Node 大版本、
  没预装的 native dep）。
- 你想要"干净重启" —— `Ctrl-C` 你的 agent 而不必重启 Hub。

---

## 5 行 happy path

TypeScript SDK 只暴露一个 `connect()`。其他都是你自己的代码。
把下面这段粘到一个新文件里，指向跑着的 Hub，你就有了一个能干活的 agent。

```ts
import { AgentParticipant, connect, type Task } from '@aipehub/sdk-node'

class Greeter extends AgentParticipant {
  constructor() { super({ id: 'greeter', capabilities: ['greet'] }) }
  protected handleTask(task: Task) {
    return { text: `Hello, ${(task.payload as { name?: string })?.name ?? 'friend'}!` }
  }
}

await connect({ url: 'ws://127.0.0.1:4000', agents: [new Greeter()] })
console.log('online')
```

还没装就 `pnpm add @aipehub/sdk-node`。Python 是镜像写法，见
[`AGENT.md` § Option B](./AGENT.md#option-b--python)。

Hub **不需要**给你的 agent 配 yaml 条目。**HELLO 帧就是清单**。

---

## 给 sidecar 加上 Hub Services

这是 v1.1 加的部分。声明你想要哪些 services，把返回的
`ServiceClient` 交给你的 agent，然后**像 in-process LlmAgent 那样**
调用它的 handle。

```ts
import { AgentParticipant, connect, type ServiceClient, type Task } from '@aipehub/sdk-node'

class CoachAgent extends AgentParticipant {
  services?: ServiceClient   // connect() 之后填充

  constructor() { super({ id: 'coach', capabilities: ['draft'] }) }

  protected async handleTask(task: Task) {
    const caseId = (task.payload as { caseId: string }).caseId
    // 按 case 的记忆 —— owner.id 是动态的，调用时才解析。
    const caseMem = this.services!.memoryFor('file', {
      kind: 'workflow-run',
      id: caseId,
    })

    const history = await caseMem.recall({ k: 20 })
    const draft  = await this.draft(task, history)
    await caseMem.remember({
      kind: 'episodic',
      text: `coach draft: ${draft.summary}`,
      meta: { taskId: task.id },
    })
    return draft
  }

  private async draft(_t: Task, _h: unknown[]) { return { summary: '...' } }
}

const coach = new CoachAgent()
const session = await connect({
  url: 'wss://hub.example.com/ws',
  agents: [coach],
  services: [
    // 1) 每个 agent 自己的草稿本（'self' → 'coach' 在 server 端代换）
    { type: 'memory', impl: 'file', owner: { kind: 'agent', id: 'self' } },
    // 2) 跨 workflow 中其他 agent 共享的按 case 记忆
    { type: 'memory', impl: 'file', owner: { kind: 'workflow-run', id: '*' } },
  ],
})
coach.services = session.services
```

三件事要记住：

1. **`services` 数组本身就是 ACL**。没列的都会在调用时回成
   `forbidden_service` 或 `forbidden_owner`。审你的入站申请的
   管理员（在 `gating: 'admin-approval'` 时）看见的就是这份列表原文。
2. **`owner.id: 'self'` 由 server 代换**。别试图传 agent 字面 id；
   server 在每个 SERVICE_CALL 上自动填。这让同一份声明在
   多 agent 进程里通用。
3. **`owner.id: '*'` 是通配符**。当 id（比如 `caseId`）只在
   调用时才知道的时候用。具体 id 通过 `memoryFor(impl, { kind, id })` 传入。

---

## 把 in-process agent 迁成 sidecar

拿 `examples/industry-consultation-deepseek/src/index.ts` 当对照例子。
那个 pipeline 现在在一个 host 进程里跑 coach + researcher + case-manager
+ reviewer 的小队伍；这里说"把 coach 抽成 sidecar"**长什么样**。

### Step 1 —— 抽出 agent 类

in-process 的写法是把 coach 内联声明在那个文件里：

```ts
class CoachAgent extends LlmAgent {
  protected async handleTask(task: Task) { /* ... */ }
}
```

原样搬到新文件 `sidecar-coach/src/index.ts`。**类本身不用变**
—— `LlmAgent` 两种形态都能用。唯一的约束是它的依赖：不能 import
`@aipehub/host` 里的东西，因为 sidecar 进程里没有 host。

### Step 2 —— 用 SDK 的 `AgentParticipant`

如果你的 agent 已经继承了 `LlmAgent`，继续继承 —— `LlmAgent` 在
`@aipehub/llm`，sidecar 安全。如果你继承的是 host 的内部类
（比如 `LocalAgentPool` 的 spawn shape），降到 `@aipehub/sdk-node`
的 `AgentParticipant`，用显式 `provider` 和 `services` 字段把行为
重建一遍。

### Step 3 —— 在 HELLO 里声明 services

in-process 版本通过 `LocalAgentPool` 解析 agent yaml 的 `uses:` 块
拿到 `memory` / `artifact` handle。sidecar 模式下，你在 `connect()`
里声明：

```ts
const session = await connect({
  url: process.env.AIPEHUB_URL ?? 'ws://127.0.0.1:4000',
  agents: [coach],
  services: [
    { type: 'memory', impl: 'file', owner: { kind: 'agent',       id: 'self' } },
    { type: 'memory', impl: 'file', owner: { kind: 'workflow-run', id: '*'  } },
  ],
})
coach.services = session.services
```

`case-memory` 的读写还是落到同一份 host 端 `service-memory-file`
插件管理的磁盘 JSONL 文件里。**跨进程可见性是自动的** —— 留在原地的
in-process agent 和你的 sidecar coach 都指向 host 上同一个插件。

### Step 4 —— 把 Hub 指向 sidecar 的 ws URL

**Hub 啥都不用改**。Hub 已经在 host 运营者配置的端口上接受
WebSocket 连接。你的 sidecar 打开那个 URL，从 scheduler 视角看就是
另一个参与者。capabilities（`draft` / `review` …）按字符串匹配分发
—— 两种形态用同一个 key。

### Step 5 —— workflow yaml 保持不动

workflow yaml 按 capability 分发，不按参与者 id 分发。一旦 sidecar
注册成 `capabilities: ['draft']`，`industry-consultation-flow`
workflow 的 `draft` step 就开始打到 sidecar 上（替代或并行 in-process
coach）。

---

## 鉴权与 gating

Hub 默认跑 `gating: 'open'`，HELLO 不经过 admin 直接放行。
**生产 hub 必须设 `gating: 'admin-approval'`**，这时：

1. `connect()` 停在 `AWAIT_APPROVAL`。
2. 管理 UI 显示你的申请，包含你声明的 `services` 列表、
   `client.name` / `client.version`、还有 `remoteAddress`。
3. 管理员点 Approve，你的 sidecar 收到 `WELCOME`。

SDK 在任何短暂 WebSocket 失败上**重试**（指数退避 1s → 30s），但
**不会**在 `REJECT` 上重试 —— 那是终止状态。如果你传了
`on_state_change` 回调，原因会在 `decision.reason` 里。

零摩擦本地开发，跑 `gating: 'open'`。共享 dev cluster 用
`gating: 'admin-approval'`，admin 通过 host 的 `--admin <token>` flag
预先植入。

---

## 取消、断连与重连

Hub 可能在任务途中取消 —— 最常见的原因是 broadcast 任务被别人
抢到了。SDK 调用你 agent 的 `onTaskCancelled(taskId, reason)`；
默认实现是 no-op，如果你持有外部资源（HTTP 请求、子进程、
LLM stream），覆盖它。

断连后，host 会**释放它为你的 session 缓存的每个 service handle**。
当你 sidecar 重连，Hub 把它当作全新的 HELLO，把你声明的所有 services
再 attach 一遍。所以：

- **不要假设 handle 跨重连还活**。它们不活 —— 重连后第一次
  SERVICE_CALL 时 `(type, impl, owner)` 槽会重新解析。
- **不要在 `onStateChange('reconnecting')` 之外缓存 `services.memory`**。
  每次 WELCOME 后重新读 `session.services`。
- **pending 的 SERVICE_CALL 在连接掉的瞬间就以 `session_not_ready` reject**。
  不会自动重试 —— Hub 不知道你 agent 的恢复策略是什么。

---

## 可观察性

host 给每个解析的 SERVICE_CALL 追加一条 `service_call` transcript 条目
—— 见 管理 UI → Services 标签 → "SERVICE_CALL audit"。记的是
调用方 agent 的 id、service 身份、方法名、结果（`ok` 或 wire
`ServiceErrorCode`）、还有往返耗时。**args 不持久化**。它们可能很大，
也可能含用户数据。

如果你要 agent 里更丰富的遥测（token 数、慢路径、模型选择），
**在 sidecar 进程里自己做** —— 它就是普通 Node / Python。SDK 本身
不提供 metrics 接口。

---

## 错误图鉴

人们实际踩到的错，每个对应啥意思。

| 症状 | 怎么回事 |
|---|---|
| `forbidden_service` | `(type, impl)` 对没在你的 HELLO `services` 数组里。加上。 |
| `forbidden_owner` | 你传给 `memoryFor(...)` 的 owner 不匹配任何声明的 pattern。声明里的通配只覆盖 `id: '*'`；字面 id 必须精确匹配。 |
| `unknown_method` | 方法名不在该 service type 的 wire 白名单上。built-in 看 `BUILTIN_SERVICE_METHODS`；第三方 type 需要 host 插件在启动时调 `registerServiceMethods`。 |
| `forbidden_method` (v1.2) | 你 `services[...]` 声明里写了 `methods: [...]` 收窄，你调的方法不在那个列表里。要么放宽收窄，要么别调那个方法。**和 `unknown_method` 不同**：如果你没收窄，这个方法**本来是**允许的。 |
| `attach_failed` | host 插件的 `attach()` 抛了 —— 配置错、磁盘路径坏 etc. host 日志是真相源。 |
| `session_not_ready` | SDK 的 pending-call 表被 fail-all 了。要么连接掉了，要么 `session.close()` 在调用 in-flight 时被调了。 |
| `bad_args` | wire `args` 字段不是 JSON 数组。不要传不可序列化的对象（函数、带私有字段的类实例 etc.）。 |
| `unknown_agent` | 你 SERVICE_CALL 上的 `from` 不匹配你 HELLO 里声明的任何 agent。通常是 bug —— SDK 会自动从第一个 agent 填 `from`。 |

---

## 参考

- **代码示例**：`examples/services-sidecar-demo/`（TypeScript）和
  `python-sdk/tests/test_services.py`（Python wire-level driver）。
- **wire frames**：`docs/PROTOCOL.md` § SERVICE_CALL / SERVICE_RESULT。
- **ACL 模型**：`docs/services-over-ws-rfc.md` § 3。
- **`docs/AGENT.md`**：本指南的叙述版。
