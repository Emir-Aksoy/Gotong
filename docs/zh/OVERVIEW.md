# AipeHub 总览 · 5 分钟读懂

<!-- doc-version: 1.0 -->
> **文档版本 1.0** · 中文译本 · 最后更新 2026-06-27 · 权威源：[English](../OVERVIEW.md)。如译文与英文版冲突，以英文版为准。

> 这是项目的**单页地图**。看完你会知道：AipeHub 是什么、它在"谁之下"、
> 参与者怎么接入、模板从哪来、几个人能怎么配合、组织之间怎么在
> **不交出钥匙**的前提下联起来。想深入某一块时，每节末尾的 →
> 链接告诉你下一篇读哪。
>
> 同步自英文版 [`docs/OVERVIEW.md`](../OVERVIEW.md) @ 2026-06-26。

---

## 一句话

**AipeHub** 是一个 **自托管的协作工作空间，TypeScript / Python 通吃**：
人和 AI agent 同时在一个"房间"里，由一个故意做得很笨的 Hub
负责派任务、收结果、记录全程。

不是 agent 框架（不跑 LLM），是**多参与者通信底座**——
组织之间可以联邦协作，而**凭证、数据、计费各归各家**。

---

## 它是什么 — 又在谁之下

市面上大多数"agent"项目，要么是一个 agent，要么是给一个 agent 写循环的
框架（LangGraph、CrewAI、AutoGen）。AipeHub **两者都不是**——它是它们
往里**接入**的那一层。一个 LangGraph graph、一个 CrewAI crew、一个 CLI
编码 agent（Claude Code、Codex）、一个外部 A2A agent、一个人，全都作为
同一个 `Participant` 进同一个房间。Hub 负责路由消息、派任务、记 transcript、
守边界——它**永远不跑 LLM**，所以每一个决策都留在参与者手里。

有三件事让它不只是一根消息总线：

- **参与者一律平等**——人就是一个 `Participant`，和 agent 一模一样。没有
  "request-human-input 工具"；人和 agent 走同一套 task + transcript，
  共享同一套异步 / 长任务原语。
- **治理**——敏感动作和跨组织动作不会"直接就发"。它们可以要求一个人从
  收件箱里批准（提议 → 审阅 → 确认），并留下完整审计。
- **主权**——每个工作空间都是磁盘上一个属于你的目录。两个组织联邦时，
  凭证、数据、计费各归各家；跨过边界的东西，由一份**逐链信任契约**约束。

这个组合——而不是某个精巧的协议——才是 AipeHub 的本体。它是第一个把
**人-agent 平等 + 受治理的跨组织联邦 + 自托管主权**装进一个可跑、
file-first 包里的底座。

---

## 一张图

```
        ┌──────────────────────────────────────────────────────────┐
        │                       一个 Space (.aipehub/)               │
        │  ─────────────────────────────────────────────────────── │
        │                                                          │
        │   👤 admin       👤 worker      👤 worker                │
        │      Alice          Bob            Carol                 │
        │       │              │              │                    │
        │       │              │              │                    │
        │   ┌───┴──────────────┴──────────────┴───┐                │
        │   │       Hub（只做路由）                │                │
        │   │  · dispatch（派任务）                │                │
        │   │  · transcript（append-only 日志）    │                │
        │   │  · scheduler（3 种策略）             │                │
        │   │  · 治理闸（审批 · 信任契约 · 审计）   │                │
        │   └───┬──────────────┬──────────────┬───┘                │
        │       │              │              │                    │
        │   🤖 宿主托管          🤖 外部 SDK     🪢 另一个 Hub         │
        │      LLM agent       (Node/Py)      (HubLink 联邦)        │
        │   (templates/      （你自己的代码）  （它的钥匙留本地）     │
        │    community/)                                            │
        └──────────────────────────────────────────────────────────┘
                                  ↑
                          一切状态都是文件
                       (.aipehub/transcript.jsonl
                        .aipehub/agents.json
                        .aipehub/secrets.enc.json …)
```

……图里这三列只是举例。同一个 `Participant` 槽位还装得下 **CLI / ACP 编码
agent**（Claude Code、Codex）、**外部 A2A agent**、以及 **LangGraph /
CrewAI 适配器**——对调度器全都透明。

---

## 四条边 — AipeHub 怎么连接世界

AipeHub 经四条边连到生态里。**有现成开放协议的地方就用现成的**——它不重新
发明：

| 边 | 协议 | 方向 | 传什么 |
|---|---|---|---|
| 工具 & 数据 | **MCP** | 双向 | agent 调外部 MCP 工具；外部客户端（Claude Desktop、Cursor）反过来驱动 Hub。 |
| agent ↔ agent | **A2A** | 双向 | 入站 `message/send` 变成一次 dispatch；出站调一个远端 A2A agent。 |
| 编码 agent | **ACP** | 出站 | Hub spawn 并 hold 住一个 Claude Code / Codex 的 session，一轮一轮驱动它。 |
| Hub ↔ Hub | **HubLink** | 双向 | AipeHub 自己的 hub 间联邦链路——逐链信任契约、跨组织任务转发、审批闸都住在这。 |

前三个是 AipeHub 实现的生态标准。HubLink 是它唯一自己拥有的那块——**不是**
作为某种精巧的线协议（底层就是 WebSocket + bearer token + JSON-RPC），而是
作为**两个受治理的 hub 之间交换什么**的契约：能力 manifest、保留 ancestry 的
任务转发、以及下面那份逐链信任契约。

→ 深入：[`MCP.md`](MCP.md) · [`FEDERATION.md`](FEDERATION.md) · [`PROTOCOL.md`](PROTOCOL.md)

---

## 上手 — 你是哪类人？

| 你是 | 第一步 | 深入阅读 |
|---|---|---|
| **个人开发者 / 想 5 分钟跑起来** | `docker compose up`（或从源码：`pnpm install && pnpm build && pnpm host`）→ 浏览器打开首次 admin URL | [`README.md` Quick start](../../README.md#quick-start) |
| **只想*先跑一个真 hub***| 导入一个现成的个人 / 组织 / 跨组织 hub 跑起来 | [`HANDS-ON-HUBS.md`](HANDS-ON-HUBS.md) |
| **小组运维 / 开一个 hub 给团队用** | LAN 模式（绑 0.0.0.0）或 VPS + Caddy + systemd | [`DEPLOY.md`](DEPLOY.md) |
| **普通用户被邀请进 room** | 拿到邀请 URL → 选昵称 → 勾能力 → 进入 | [`HUMAN.md`](HUMAN.md) |
| **想理解整体设计** | 这篇 → `ARCHITECTURE.md` → `PROTOCOL.md` | [`ARCHITECTURE.md`](ARCHITECTURE.md) |

---

## 开源协议 — MIT，可商用

整个项目 **MIT License**。短答案：

- ✅ 可以**商用**，包括做闭源 SaaS / 内部工具 / 转售
- ✅ 可以**修改**源码、改名重发
- ⚠️ 必须**保留 LICENSE 文件 + copyright 行**

`templates/community/` 里收录的第三方 prompt 改造模板有自己的来源
许可（CC0 / MIT），都和 MIT 兼容，**也都允许商用**。

详细 FAQ 见 [`LICENSE-FAQ.md`](LICENSE-FAQ.md) —— 回答典型问题：
"我能否把 AipeHub 嵌进自己的闭源产品 / 我商用这些模板要不要注明 /
我能不能改 LICENSE 重新打包"。

---

## 参与者怎么接入

主线是**两条路加一个 LLM agent**：

| 路径 A · 宿主托管（host-managed） | 路径 B · 外部 SDK 接入 |
|---|---|
| 在 admin UI 填表 / 导入 YAML / 粘贴模板 → host 进程内直接 spawn 一个 `LlmAgent` | 自己写代码（Node / Python）实现 `AgentParticipant.handleTask`，用 `connect(url, agents)` 连到 Hub 的 WebSocket 端口 |
| **0 行代码** | 写代码 |
| 仅限 LLM 类 agent（封装好的 Anthropic / OpenAI / Mock） | **任意类型**（LLM、爬虫、本地工具、私有逻辑、Python ML 模型）|
| Provider key 走加密落盘 `secrets.enc.json`（per-agent 或工作区默认）或环境变量 | API key 自己管，agent 跑在自己机器上 |
| 重启 host 自动 respawn | 自己负责生命周期，SDK 自带 auto-reconnect |
| 适合：普通用户 / 标准 LLM 角色 / 60 秒上线 | 适合：开发者 / 私有数据 / 不想暴露代码 |

→ 想走 A：[`HUMAN.md §1 智能体`](HUMAN.md#1-智能体v21) + [`TEMPLATES.md`](TEMPLATES.md)
→ 想走 B：[`AGENT.md`](AGENT.md)

……而因为一切都是同一个 `Participant`，同一个 room 还接得下：

- **CLI / ACP 编码 agent**——Hub 经一个 hold 住的 ACP session 驱动 Claude
  Code / Codex（已真机验证），并带一个危险动作闸，能把破坏性命令挂起
  等人批准。
- **外部 A2A agent**——把一个远端 agent 注册到某个 capability 下；工作流的
  一步就像派给任何别人一样路由到它。
- **框架适配器**——用 Python SDK 把一个 LangGraph graph 或 CrewAI crew 包成
  `Participant`；框架本身永远不被 Hub 导入。

它们**可以混着用**——同一个 room 里既有宿主托管的 `writer-zh`、你自己 SDK
连进来的 `rag-agent`，还有一个 Codex 编码 session，对调度器完全透明。

---

## 模板从哪来

```
                  templates/
                  ├── agents/           原创官方模板
                  ├── teams/            原创官方团队
                  └── community/        改造自第三方（CC0 + MIT）
```

三种获取方式，按用户口味挑：

1. **模板画廊，一键装**——admin UI 内置一个现成 hub 的画廊（个人 / 组织 /
   跨组织）；挑一个 → 安装 → 它把 agent + 工作流 + KB 槽位落进你的 Space。
2. **复制粘贴**——GitHub 上点 `.yaml` 的 **Raw** → 复制 → admin UI
   「智能体 → 导入」粘贴。
3. **下载文件**——下载 `.yaml` 到本地 → admin UI「上传文件」。

每个文件头部有 `# Source` / `# Upstream` / `# License` / `# Adapted` 四行
注释，**永不丢失上游产权信息**。第三方许可全文集中保存在
[`../../templates/community/LICENSE-NOTICES.md`](../../templates/community/LICENSE-NOTICES.md)。

> **模板和框架在结构上是分离的。** 模板带的是*结构和引用*——agent、工作流、
> KB 槽位——**从不**带知识*内容*本身，也从不带你的人员或密钥。装一个模板
> 是把接线接好；它永远不会还原另一个组织的数据。

→ 完整流程：[`TEMPLATES.md`](TEMPLATES.md)
→ 现成可装的 hub：[`HANDS-ON-HUBS.md`](HANDS-ON-HUBS.md)

---

## 几个人在一个 room 里

AipeHub 把"团队"做成了**一个 room** = 一个 `.aipehub/` 目录。
角色三层：

| 角色 | URL | 在这个 room 里能干嘛 |
|---|---|---|
| **admin** | `/admin` | 配置 room、批准 / 拒绝 agent 申请、派任务、做评价、邀请其他 admin |
| **worker** | `/`（`/me` 工作台） | 选昵称 + 自己能干的活，为自己跑成员级工作流，处理自己的收件箱，完成或拒绝任务 |
| **agent** | WS port | 自动接派来的任务、返结果 |

### 典型小队工作流（剧本式）

```
0  Alice（admin）开 hub → 启动后浏览器拿到一次性 admin URL，存进密码管理器。
1  Alice 在 admin UI 配 provider key → 工作区默认 key 加密落盘。
2  Alice 装一个模板（或导入 storyteller.yaml）→ host 进程立刻 spawn 一个
   LLM agent，状态显示 online。
3  Alice 发邀请 URL 给 Bob 和 Carol。两人选昵称、勾选自己擅长的
   capability（draft / review）→ 进入 room。
4  Alice 派任务："写一个关于坚持的儿童故事"，strategy = capability:[story]
   → host-managed 的 storyteller 抢到任务 → 30 秒后产出 600 字故事。
5  工作流某一步需要签字 → 它挂进 Bob 的收件箱；Bob 在自己的 /me 工作台批准，
   run 继续——这是人在环里，不是一个工具调用。
6  Alice 给工作做 evaluation，贡献榜刷新；所有事件都在 transcript.jsonl 里，
   崩了重启也能完整恢复。
```

**关键概念**（详细在 HUMAN.md）：

- **三种派任务策略**：`direct`（指名）、`capability`（按能力）、`broadcast`（谁抢到算谁）
- **人在环里**：工作流的一步可以派到某个人的收件箱，等他批准 / 选择 / 修改后再继续
- **`/me` 工作台**：成员跑自己的成员级工作流、看自己最近的 run、管自己的 agent（自带 key），全部只限自己
- **API Key 三层**：per-agent 私有 → 工作区默认 → 环境变量

→ 完整说明：[`HUMAN.md`](HUMAN.md)

---

## 跨组织 — 受治理的联邦

**两种"多团队"语义**，别混了：

### 一个 room 多个角色（= 上面那节）

所有人都在同一个 `.aipehub/` 目录、同一个 hub 进程。这是默认情况。

### 多个 room 联起来（= 真·跨组织）

每个组织跑自己独立的 hub（自己的 `.aipehub/`、自己的人和 agent、
**自己的 API key、自己的计费**）。两个 hub 经 **HubLink** 相连，
一方能向另一方要什么，由一份**逐链信任契约**钉死：

- **能力白名单**——对方到底能调哪些 capability
- **data-class 闸**——哪几类数据允许跨过这条链路（fail-closed）
- **配额**——逐链的速率 / 预算上限，跨重连保留
- **撤销**——随时断链
- **知识库白名单**——对方能够到哪些共享 KB

最简单的模式是 `TeamBridgeAgent`：把整个子 hub 在上游显示成**一个 agent**，
内部成员 / 钥匙 / 子任务对父 hub 不可见。

```
   公司总 Hub（Bob 当 admin）
       │
       ├── agent · alice-team   ←─┐
       │                          │  TeamBridgeAgent（走 HubLink）
       │                  ┌───────┴────────┐
       │                  │ Alice 的 Hub    │（Alice 当 admin）
       │                  │  · writer-bot  │   钥匙 / 人员 / 计费
       │                  │  · reviewer-bot│   全留在 Alice 的 hub
       │                  └────────────────┘
       └── agent · david-team   ←── 同理另一个团队
```

除了桥接，**一个 hub 上的工作流可以把一步派到另一个 hub 的 capability**。
如果那个对端要求审批，这一步就挂进某个人的收件箱，直到有人批准——跨组织
调用是受治理的、两步的、可完整审计的，而且工作流 YAML 里**从不**点名对端
（它只点名一个 capability；链路是运行时配置）。

**为什么这要紧 — 主权完好无损**：

- 上游看到的是*聚合结果*（"alice-team 完成了 N 个任务"），从看不到对端的钥匙或原始数据
- 每个 hub 都有**自己的凭证 vault** 和**自己的用量 / 成本 ledger**——计费按 hub 各算各的
- 想做个私有内部 PoC？跑一个本地 hub 就行，零接入成本
- 想让公司一起协作？挂一条受治理的链路上去，**不动现有团队结构**

→ 同一台机器：[`FEDERATION.md`](FEDERATION.md)
→ 两台机器 / 两个组织，一步步来：[`FEDERATION-RUNBOOK.md`](FEDERATION-RUNBOOK.md)

---

## 深入阅读路线

按"我现在最想搞清什么"挑一条：

| 我想… | 读这 |
|---|---|
| 五分钟跑起来 | [`README.md` Quick start](../../README.md#quick-start) |
| 先跑一个现成 hub（个人 / 组织 / 跨组织） | [`HANDS-ON-HUBS.md`](HANDS-ON-HUBS.md) |
| 当 admin / 当 worker | [`HUMAN.md`](HUMAN.md) |
| 写一个外部 agent | [`AGENT.md`](AGENT.md) |
| 不写代码上线 LLM agent | [`HUMAN.md §1`](HUMAN.md#1-智能体v21) + [`TEMPLATES.md`](TEMPLATES.md) |
| 给 agent 接上 MCP 工具生态 | [`MCP.md`](MCP.md) |
| 联接两个 hub（同一台机器） | [`FEDERATION.md`](FEDERATION.md) |
| 跨两台机器 / 两个组织联邦 | [`FEDERATION-RUNBOOK.md`](FEDERATION-RUNBOOK.md) |
| 部署给团队 / 上线 | [`DEPLOY.md`](DEPLOY.md) + [`GO-LIVE.md`](GO-LIVE.md) |
| 整体架构 / 为什么这样设计 | [`ARCHITECTURE.md`](ARCHITECTURE.md) |
| Wire 协议 / 写其他语言 SDK | [`PROTOCOL.md`](PROTOCOL.md) |
| 商用 / 派生 / license 边界 | [`LICENSE-FAQ.md`](LICENSE-FAQ.md) |
| 报告安全问题 | [`../../SECURITY.md`](../../SECURITY.md) |
| 贡献代码 | [`../../CONTRIBUTING.md`](../../CONTRIBUTING.md) |
