# Gotong 架构（v0.2）

> 同步自英文版 [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md) @ 2026-05-17

本文档记录框架的设计决策。当代码自相矛盾的时候，**本文档是真相源**。

| 版本 | 落地内容 |
|---|---|
| v0.0 | 可嵌入库：Hub、三种 dispatch 策略、transcript、FileStorage、web UI |
| v0.1 | wire protocol + WebSocket transport + Node SDK —— 远端 agent 可以从另一个进程 / 机器连接 |
| v0.2 | `LlmAgent` 基类 + 中立 `LlmProvider` 接口 + Anthropic / OpenAI provider —— 接入 LLM-backed agent 而不把 Hub 绑死到任何厂商 SDK |
| v0.3 | `SqliteStorage` —— 由 SQLite (`better-sqlite3` optional peer dep) 支撑的持久化 transcript。FileStorage 仍是零依赖默认值。 |
| v0.4 | HELLO 时按 agent 鉴权 —— `authenticate` 可以返回 `{ ok: true, allowedAgents: ['a1', 'a2'] }` 把一个 API key 绑到一组指定的 agent id。泄漏的 key 没法假冒任何其他 agent。新 `forbidden_agent` REJECT code。**向后兼容**：boolean 返回仍可用。 |
| v0.5 | Python SDK（`python-sdk/`，PyPI 名 `gotong`）—— 第二个语言客户端。`AgentParticipant` + `connect()` 跟 Node SDK 对齐；测试跑通 fake Hub server；`examples/remote-python` 跑 Node host + Python worker 跨语言端到端，走同一套 wire protocol。 |
| v0.6 | CLI human adapter —— `examples/cli-human` 演示终端驱动一个 `HumanParticipant`：任务渲染到 stdout，回复通过 readline 进入（`GOTONG_AUTO=1` 在 CI / 非 TTY 下跳过提示）。可作任何 UI / chat / IM adapter 基于 `human.next()` / `human.complete()` / `human.reject()` 的参考实现。 |
| v0.7 | **截止时间** —— wire 类型加 `Task.deadlineMs`：已过期的任务回 `failed`，`error: 'deadline_expired'`，**永远不会**触达参与者。（最初藏在 `PriorityQueueScheduler` wrapper + `Task.priority` 后面；2026-06 审计发现零采用，把截止时间执行折进 `DefaultScheduler`，删掉了 wrapper、`schedulerFactory` seam 和 `Task.priority`。） |

## 1. 哲学

**Hub 是通信空间，不是大脑**。

Gotong **不跑 LLM**。不实现 agent loop。不持有 prompt 或工具
registry。agent 自带智能 —— 不管那智能是一次 Claude API 调用、一个
shell 脚本，还是一个睡着的人 —— Hub 的唯一职责是**路由消息、派任务、
持久化 transcript、发事件**。

这跟 CrewAI、AutoGen、OpenBotX 这些把 agent 执行耦合进框架本身的
框架持相反立场。Gotong 故意低一层：它之于多参与者协作，犹如
**消息中间件之于微服务**。

**人类是一等参与者，不是特殊的 tool call**。

大多数 agent 框架把人当作 `request_human_input` 工具。Gotong 把
人当作 `Participant`，与 agent 走同一套 wire protocol —— 他们
注册、订阅频道、收消息、接任务、发结果。**区别只在 adapter 层**：
human adapter 后面是 UI；agent adapter 后面是代码。**Hub 不关心**。

## 2. 参与者 —— 双轨抽象

系统里**每个角色**都是一个 `Participant`。具体两种：

- **`AgentParticipant`** —— 编程式。`onMessage` / `onTask` 从 Hub
  视角是同步的。
- **`HumanParticipant`** —— 背后是 UI 表面（web、CLI、IM）。任务
  会被展示，可以无限期挂着。

两者实现同一个 `Participant` 接口。**双轨不在 wire protocol 里，
而在 adapter 里** —— 把 wire protocol 包装到该参与者所在介质的层。

wire 级契约：

```
Participant
  id: string
  kind: 'agent' | 'human'
  capabilities: string[]      // scheduler 匹配的标签
  onMessage(msg): Promise<void>
  onTask?(task): Promise<TaskResult>   // 可选 —— 纯监听参与者也合法
  onShutdown?(): Promise<void>
```

`HumanParticipant` 一般不直接实现 `onTask` —— 它的 adapter 把任务
停泊到"待处理 UI"收件箱，当人类操作时再 resolve promise。

## 3. 消息总线

所有进程内通信都走**异步消息总线**。参与者**互相不直接调用**。
这跟 OpenBotX 用同一个 pattern，原因也一样：让系统**可观察、
可重放、可替换**。

总线上层有两个表面：

- **Channels** —— 按 topic 的 pub/sub。参与者 `subscribe(channelId)`，
  发到那个 channel 的消息触达所有订阅者。适合广播、状态、
  群对话。
- **Tasks** —— 带类型化结果的 request/response。由 **scheduler** 路由
  （见 §4）。适合"做这件事然后告诉我结果"。

消息和任务是**故意区分的两种类型**。消息发了就忘；任务有一个
被 await 的 `TaskResult`。

## 4. Scheduling —— 三种策略

第一版出货**三种任务路由策略**，每个任务可配：

| 策略 | 什么时候 | 行为 |
|---|---|---|
| `explicit` | 你知道找谁 | 调用方点名参与者 id。Hub 直接送。 |
| `capability` | 你知道是什么类型的活 | Hub 挑一个 capability 涵盖任务所需 capability 的参与者。默认策略：负载最轻，然后 round-robin。 |
| `broadcast` | 你要一个志愿者 | Hub 把任务广播给所有合格参与者；第一个 claim 的赢，其他人收 cancel 信号。 |

**按参与者类型的默认策略**：

- agent 任务默认 `capability`。
- human 任务默认 `explicit`（dispatch 方知道是谁）或 `broadcast`
  （任何合格的人都行）。可逐调用配置。

`Scheduler` 是接口，`DefaultScheduler` 是唯一的生产实现
（三种策略）。它也**强制 `Task.deadlineMs`**：提交时已过期的
任务回 `failed`，`error: 'deadline_expired'`，**永远不触达参
与者**。

## 5. Transcript

每条消息、任务和任务结果都追加到该 Hub 的 **transcript**。
transcript 是：

- **append-only**
- 按 Hub 分配的序号排序
- "发生了什么"的真相源

`serveWeb()` 读 transcript 渲染历史。它也是让**多参与者系统调试
变得可处理**的关键。

## 6. Storage

`Storage` 是个接口。第一版出货两个实现：

- **`InMemoryStorage`** —— 测试、demo、临时跑用。**默认**。
- **`FileStorage`** —— 持久化 JSONL append-only 日志。一条 transcript
  一行，单文件，**无外部依赖**。崩溃容忍：加载时跳过尾部不完整行
  并 warn。
- **`SqliteStorage`**（v0.3）—— `better-sqlite3` 撑的表
  `transcript(seq PK, ts, kind, data)`，WAL 模式。`seq` 上索引读、
  单事务插入、SQLite journaling 提供完整崩溃恢复。**Optional peer
  dep**：要用就装 `better-sqlite3`；`FileStorage` 仍是零依赖默认。

怎么选：

- **`FileStorage`** —— 中小 transcript，无 native dep，最容易检视
  （就是 JSONL）。`tail -f` 跟着看。
- **`SqliteStorage`** —— 长跑 Hub、大 transcript、或者你要按 seq
  SELECT 而不是扫整个文件的负载。带一次性 native 模块安装。

v0 **只持久化 transcript 条目**。pending 任务和参与者注册是
运行时的，Hub 重启时丢 —— adapter 必须自己重新注册、重新派
in-flight 工作。resume 的含义见 §12。

`SqliteStorage` 上面加 pending-task journal 是后续动作 —— schema
有位置（加张 `pending_tasks` 表）；缺的是 Hub 侧的接线。

## 7. Web UI（参考实现）

`packages/web` 出货一个参考 web UI。它是**可视化和介入表面** ——
读 transcript、列参与者、让人在被路由到他们的任务上操作。
**它不跑任何业务逻辑**。

接口：

- **快照** `GET /api/state` —— 当前参与者、完整 transcript、
  pending 人类任务
- **实时流** `GET /api/stream`（Server-Sent Events）—— 每条新增
  `TranscriptEntry`
- **操作** `POST /api/tasks/:id/(complete|reject)` —— 解析
  当前持有的 `HumanParticipant` 上的 pending 任务

前端是**单一 vanilla-JS 页**；无 bundler、无 framework、除了 server
的 `tsc` 之外**没有构建步骤**。原样用，或者把它当作 ~250 行参考
代码来基于 `hub.onEvent()` 构建你自己的 UI。

```ts
import { Hub } from '@gotong/core'
import { serveWeb } from '@gotong/web'

const hub = new Hub()
await hub.start()
const web = await serveWeb(hub, { port: 3000 })
// 之后: await web.close()
```

## 8. 部署形态

Gotong 支持两种部署形态，**Hub API 在两者中完全一样**。本地和
远程 agent 注册进同一个 `Registry`；scheduler **不区分两者**。

### 8a. Embedded —— 一切在一个进程内

**库模式**。Agent 是 in-process 对象。

```ts
import { Hub, FileStorage } from '@gotong/core'

const hub = new Hub({ storage: new FileStorage('./gotong.jsonl') })
await hub.start()
hub.register(new MyAgent())
hub.register(new MyHumanAdapter())
await hub.dispatch({
  from: 'system',
  strategy: { kind: 'capability', capabilities: ['draft'] },
  payload: { topic: 'why TS' },
})
```

### 8b. Distributed —— agent 在其他进程（v0.1）

Hub 进程开一个 WebSocket transport。远端 agent 走
[PROTOCOL.md](./PROTOCOL.md) 定义的 wire protocol。在 Hub 侧它们
以 `RemoteAgentParticipant` 形式出现在 registry —— capability 匹配、
broadcast race、explicit dispatch **一视同仁**。

```ts
// host 进程
import { Hub } from '@gotong/core'
import { serveWebSocket } from '@gotong/transport-ws'

const hub = new Hub()
await hub.start()
const ws = await serveWebSocket(hub, {
  port: 4000,
  authenticate: (apiKey) => apiKey === process.env.GOTONG_API_KEY,
})
// hub.dispatch(...) 照样用 —— 远端 agent 跟本地的一模一样
```

```ts
// worker 进程 —— Node SDK
import { AgentParticipant, connect } from '@gotong/sdk-node'

class MyAgent extends AgentParticipant {
  constructor() { super({ id: 'a1', capabilities: ['draft'] }) }
  protected async handleTask(task) { return { text: '…' } }
}

const session = await connect({
  url: 'ws://hub.example.com:4000',
  agents: [new MyAgent()],
  apiKey: process.env.GOTONG_API_KEY,
})
```

其他语言的 SDK（Python 是下一个）说同样的 JSON 协议。frame 定义、
状态机、心跳、断连语义见 [PROTOCOL.md](./PROTOCOL.md)。

## 9. LlmAgent —— 厂商中立的 LLM 参与者（v0.2）

**Hub 不调 LLM**。`LlmAgent` 调 —— 它是一个薄的 `AgentParticipant`
子类，把 Task 串到 `LlmProvider`，再把模型的响应变成 `TaskResult`。
**Provider 是唯一引入厂商 SDK 的地方**。

```
Hub                                         (对 LLM 一无所知)
 └── LlmAgent                                (Task ↔ LlmRequest/Response 翻译)
       └── LlmProvider                       (中立 ↔ 厂商 SDK 翻译)
              ├── AnthropicProvider          → @anthropic-ai/sdk
              ├── OpenAIProvider             → openai
              └── MockLlmProvider            (in-process，无网络)
```

**中立 wire 类型**（零厂商耦合 —— 在 `@gotong/llm`）：

```ts
interface LlmProvider {
  readonly name: string                                          // 'anthropic' | 'openai' | …
  complete(req: LlmRequest): Promise<LlmResponse>
}
interface LlmRequest {
  system?: string                                                // 顶层，Anthropic 风格
  messages: { role: 'user' | 'assistant'; content: string }[]
  maxTokens?: number
  temperature?: number
  model?: string                                                 // 单请求覆盖 model
}
interface LlmResponse {
  text: string
  stopReason: 'end_turn' | 'max_tokens' | 'error'
  usage?: { inputTokens: number; outputTokens: number }
  raw?: unknown                                                  // 厂商信封（escape hatch）
}
```

**`LlmAgent` 上的两个 override 点** —— 几乎每种定制只需要其一：

| Hook | 用来做什么 |
|---|---|
| `buildRequest(task): LlmRequest` | prompt 拼装。默认读 `task.payload` 里的 `{ prompt }` / `{ topic }` / `{ history }`，注入 agent 级的 `system`。Override 注入检索上下文、few-shot 示例、工具描述。 |
| `parseResponse(response, task): unknown` | 输出整形。默认返回 `{ text, stopReason, by, usage }`。Override 解析 JSON、抽代码块、用 re-prompt 校验失败的情况。 |

要完全控制（多步推理、自定义重试、流式），**直接 override
`handleTask(task)`** —— `AgentParticipant` 本来就提供的 escape hatch。

**Provider 错误语义**：provider 在传输 / 鉴权 / 限流错误上**抛**；
`AgentParticipant.onTask` 捕获后产出 `failed` `TaskResult` 带错误消息。
成功响应上的 `stopReason: 'error'` 是**软失败** —— provider 拿到
响应体但模型半路放弃了（refusal、内容过滤、未知原因）；调用方
看到部分 text 加 stop reason，自己决定怎么办。

**为什么 provider 拆成单独包**。`@anthropic-ai/sdk` 和 `openai`
都是 ~1MB+ 的 peer 依赖。多数用户只想要一家；把两家都打进一个
`@gotong/llm` 大包是**惩罚所有人来支持 polyglot 场景**。拆开也
让每个 provider 独立跟自己厂商 SDK 的版本。

**流式、tool call、JSON mode** **不在 v0.2 范围** —— 见 §10。
中立 `LlmResponse` 是一个完成的、纯文本的 completion。

## 10. 范围里 / 不在范围里（v2.1 状态）

自 v0.2 起项目填上了很多曾经在 "not yet" 名单上的项。下表是
**当前**状态，不是历史。

| 特性 | 状态 | 在哪 |
|---|---|---|
| Python SDK | ✅ 已出（v0.5） | `python-sdk/`，PyPI 名 `gotong` |
| `SqliteStorage` | ✅ 已出（v0.3） | `packages/core/src/storage/sqlite.ts`，peer dep `better-sqlite3` |
| HELLO 按 agent 鉴权 | ✅ 已出（v0.4） | `authenticate(apiKey) → { ok, allowedAgents? }`；新 `forbidden_agent` REJECT code |
| 截止时间 | ✅ 已出（v0.7，2026-06 折进 `DefaultScheduler`） | `Task.deadlineMs`；`error: 'deadline_expired'` |
| Host 托管 LLM agent（无代码） | ✅ 已出（v2.1） | `@gotong/host` 里的 `LocalAgentPool`；管理 UI 里 YAML/JSON 清单 |
| 加密 API key 存储 | ✅ 已出（v2.1） | `<space>/secrets.enc.json` 用 AES-256-GCM；master key 文件或 `GOTONG_SECRET_KEY` env |
| 贡献评分 + 榜单 | ✅ 已出（v2.1） | `Task.weight`、`Evaluation.rating`、`hub.leaderboard(...)`、按 publisher 退出 |
| 模板库（内建 + 社区） | ✅ 已出（v2.1） | `templates/{,community}/{agents,teams}/`；`@gotong/web` 里的清单解析 |
| LLM 流式 | ✅ 已出 (v3.8 / Phase 8) | `LlmProvider.stream(req)` 返回 `AsyncIterable<LlmStreamChunk>`。`LlmAgent` 按 chunk 消费;`LocalAgentPool` 把它们写入 transcript (`llm_stream_chunk`);`@gotong/web` SSE 推到 admin UI 做打字机渲染。 |
| **`LlmAgent` 内的 tool / function calling** | ❌ 暂无 | `LlmAgent` 透传 `task.payload`，返回 text。多轮工具循环今天还是 app code 的事。 |
| **跨重启的 pending 任务持久化** | ❌ 暂无 | 只持久化 transcript。`SqliteStorage` 上的 pending-tasks 表草图有了，但 Hub 侧没接。见 §12。 |
| **保留 in-flight 任务的重连** | ❌ 暂无 | 断连用 `remote_disconnect` 失败所有 outstanding 任务。wire 上保留了用之前 `sessionId` 的 `RESUME` frame，没实现。 |
| **Go / Rust / 浏览器 SDK** | ❌ 暂无 | wire protocol **稳定且语言无关** —— 社区移植欢迎。 |
| **成本感知 / 延迟感知 / 优先级调度** | ❌ 暂无 | `DefaultScheduler` 覆盖路由 + 截止时间；更丰富的策略（优先级队列、成本上限、P99 延迟目标、agent 健康度加权）在 roadmap。 |
| **浏览器自动化作为内建 capability** | ❌ 暂无 | core 范围外；应该归到独立 agent 包。 |

这些**裁剪是故意的**。surface 保持小，直到每个特性有具体用例
要求它。

## 11. 模块地图

```
packages/core/src/
  types.ts              核心类型：Message、Task、TaskResult、Participant 等
  hub.ts                Hub 门面 —— 用户唯一会 construct 的东西
  bus.ts                MessageBus —— pub/sub 图 + 异步分发
  registry.ts           参与者 registry —— 谁在线、capabilities、负载
  scheduler.ts          Scheduler 接口 + DefaultScheduler（三种策略 + 截止时间执行）
  transcript.ts         append-only 事件日志
  storage/
    index.ts            Storage 接口 + re-exports
    memory.ts           InMemoryStorage（默认；临时）
    file.ts             FileStorage（JSONL append-only，持久）
    sqlite.ts           SqliteStorage（better-sqlite3，WAL，按 seq 索引）
  participants/
    agent.ts            AgentParticipant 基类
    human.ts            HumanParticipant —— 由 adapter 驱动的异步任务收件箱
  index.ts              公共 re-exports

packages/web/
  src/server.ts         Node http server：SSE 流 + 状态快照 + 任务操作 API
  src/index.ts          serveWeb() 导出
  static/index.html     单页 UI 外壳
  static/app.js         vanilla-JS 客户端；连接 /api/stream
  static/styles.css

packages/protocol/      wire-protocol 类型、常量、codec —— 零运行时
  src/frames.ts         ClientFrame / ServerFrame discriminated union
  src/constants.ts      PROTOCOL_VERSION、心跳 / 超时默认值
  src/codec.ts          decodeFrame / encodeFrame

packages/transport-ws/  Hub 侧 WebSocket transport
  src/server.ts         serveWebSocket(hub, opts)
  src/session.ts        每连接状态机（AWAIT_HELLO → READY → DEAD）
  src/remote-participant.ts  RemoteAgentParticipant —— 通过 WS 代理的 Participant

packages/sdk-node/      远端 agent 的 Node SDK
  src/session.ts        connect(opts) + 指数退避自动重连
  src/index.ts          re-export AgentParticipant，一站式 import

packages/llm/           LlmAgent 基 + 中立 LlmProvider 接口（v0.2）
  src/types.ts          LlmProvider、LlmRequest、LlmResponse —— 零厂商耦合
  src/agent.ts          LlmAgent —— buildRequest / parseResponse override 点
  src/mock.ts           MockLlmProvider —— 测试/demo 用的确定性 in-process provider

packages/llm-anthropic/ Anthropic Claude provider —— peer dep @anthropic-ai/sdk
  src/provider.ts       AnthropicProvider —— 翻译 LlmRequest ↔ messages.create

packages/llm-openai/    OpenAI provider —— peer dep openai
  src/provider.ts       OpenAIProvider —— 翻译 LlmRequest ↔ chat.completions.create

examples/
  hello-collab/         capability + explicit dispatch，mock 人类自动批准
  broadcast-claim/      broadcast 策略：三个 reviewer 抢，输的人被 cancel
  persist-and-resume/   FileStorage 往返：重启后 seq 续上
  web-demo/             web UI 前面挂一个 writer + alice 永动循环
  remote-agent/         host + worker 在分开进程里走 wire protocol
  llm-mock/             LlmAgent + MockLlmProvider —— 不需要 API key
  llm-real/             LlmAgent + Anthropic & OpenAI —— Claude 写，GPT 评
  remote-python/        Node Hub + Python worker（跨语言）—— v0.5
  cli-human/            终端当 human 的 adapter；readline 驱动的批准循环 —— v0.6

python-sdk/             Python SDK（PyPI 名：gotong）—— v0.5
  src/gotong/
    protocol.py         frame 常量 + 出站 builder（对齐 @gotong/protocol）
    agent.py            AgentParticipant —— sync 或 async handle_task
    session.py          connect() + Session 状态机（对齐 @gotong/sdk-node）
  tests/                pytest-asyncio 对一个真 websockets fake-Hub 跑
```

## 12. 异步 —— 什么同步 / 什么不同步

一旦你在 Hub 上构建真东西，会撞到的几个语义边缘。每个都是
**v0 的故意选择，不是疏漏**。

### Resume 时每次 boot 重写 `participant_joined`

`Transcript.load()` 把所有先前条目带回来，但 boot 后的 `register()`
**会写一条全新的 `participant_joined`** —— Hub 把每个进程当作
新 session。如果你单从 transcript 推 "当前在线"，得把每个
`participant_joined` 配上**最近的 `participant_left`**（或 session 边界）
才知道**当下**到底谁在场。transcript 是发生历史的日志，不是
"此刻"的快照。

### Broadcast cancel 通知跟 `dispatch()` 解析有竞争

broadcast 胜者确定时，`dispatch()` **立即**用胜者结果 resolve。
输家的 `onTaskCancelled` 回调被调度了但**不一定跑过**。在
`await dispatch(...)` 之后立刻打印 "winner!" 的 demo 经常看到
cancel 日志在那之后才到，**顺序非确定**。这是**故意如此**——
cancel 是 best-effort 通知，不是 task-result 契约的一部分。
如果你要它们有序，先 sleep 一拍再读。

### 远端断连失败 in-flight 任务

WebSocket session 掉时，Hub 侧的 `RemoteAgentParticipant`
把所有 outstanding `onTask` promise resolve 成
`{ kind: 'failed', error: 'remote_disconnect' }`，并自我注销。
dispatch 方的 `await hub.dispatch(...)` 会**返回**那个失败结果而
不是挂住。transcript 记录一条 `participant_left`。未来协议修订
**可能**加 `RESUME` frame，用之前的 `sessionId` 在短断连后恢复
in-flight 任务 —— v0.1 范围外。

### Transcript 持久化是 per-append fire-and-forget

`Transcript.append()` 在把条目推到 in-memory log 之后**同步返回**；
Storage 写在一个独立 promise 链上派发。后果：

- 在 `await dispatch(...)` 和 `await hub.stop()` **之间**崩可能丢
  最后几条。
- `await hub.stop()` **会** flush —— 对 `FileStorage`，`close()`
  await 串行写队列。
- 如果你要某个特定时刻写穿，await 一次 no-op 后续或调 `hub.stop()`。

未来版本**可能**在出现真实用例时加 `transcript.flush(): Promise<void>`。
目前看来快速 in-memory 路径比 per-append 持久化保证更有价值。
