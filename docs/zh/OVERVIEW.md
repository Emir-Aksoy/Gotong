# AipeHub 总览 · 5 分钟读懂

> 这是项目的**单页地图**。看完你会知道：AipeHub 是什么、能干什么、
> 怎么接入、模板从哪来、几个人能怎么配合、多个团队怎么联起来。
> 想深入某一块时，每节末尾的 → 链接告诉你下一篇读哪。
>
> 同步自英文版 [`docs/OVERVIEW.md`](../OVERVIEW.md) @ 2026-05-12。

---

## 一句话

**AipeHub** 是一个 **TypeScript / Python 通吃的协作工作空间**：
人和 AI agent 同时在一个"房间"里，由一个故意做得很笨的 Hub
负责派任务、收结果、记录全程。

不是 agent 框架（不跑 LLM），是**多参与者通信底座**。

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
        │   │  · contribution scoring（贡献评分）  │                │
        │   └───┬──────────────┬──────────────┬───┘                │
        │       │              │              │                    │
        │   🤖 宿主托管          🤖 外部 SDK     🪢 TeamBridge        │
        │      LLM agent       (Node/Py)       (另一个 Hub)         │
        │   (templates/      （你自己的代码）   （递归 federation）   │
        │    community/)                                            │
        └──────────────────────────────────────────────────────────┘
                                  ↑
                          一切状态都是文件
                       (.aipehub/transcript.jsonl
                        .aipehub/agents.json
                        .aipehub/secrets.enc.json …)
```

---

## ① 使用方式 — 你是哪类人？

| 你是 | 第一步 | 深入阅读 |
|---|---|---|
| **个人开发者 / 想 5 分钟跑起来** | `docker compose up` 或 `pnpm install && pnpm host` → 浏览器打开首次 admin URL | [`README.md` Quick start](../../README.md#quick-start) |
| **小组运维 / 开一个 hub 给团队用** | LAN 模式（绑 0.0.0.0）或 VPS + Caddy + systemd | [`DEPLOY.md`](../DEPLOY.md) |
| **普通用户被邀请进 room** | 拿到邀请 URL → 选昵称 → 勾能力 → 进入 | [`HUMAN.md`](HUMAN.md) |
| **想理解整体设计** | 这篇 → `ARCHITECTURE.md` → `PROTOCOL.md` | [`ARCHITECTURE.md`](../ARCHITECTURE.md) |

---

## ② 开源协议 — MIT，可商用

整个项目 **MIT License**。短答案：

- ✅ 可以**商用**，包括做闭源 SaaS / 内部工具 / 转售
- ✅ 可以**修改**源码、改名重发
- ⚠️ 必须**保留 LICENSE 文件 + copyright 行**

`templates/community/` 里收录的第三方 prompt 改造模板有自己的来源
许可（CC0 / MIT），都和 MIT 兼容，**也都允许商用**。

详细 FAQ 见 [`../LICENSE-FAQ.md`](../LICENSE-FAQ.md) —— 回答典型问题：
"我能否把 AipeHub 嵌进自己的闭源产品 / 我商用这些模板要不要注明 /
我能不能改 LICENSE 重新打包"。

---

## ③ Agent 接入方式 — 两条路

| 路径 A · 宿主托管（host-managed） | 路径 B · 外部 SDK 接入 |
|---|---|
| 在 admin UI 填表 / 导入 YAML / 粘贴模板 → host 进程内直接 spawn 一个 `LlmAgent` | 自己写代码（Node / Python）实现 `AgentParticipant.handleTask`，用 `connect(url, agents)` 连到 Hub 的 WebSocket 端口 |
| **0 行代码** | 写代码 |
| 仅限 LLM 类 agent（封装好的 Anthropic / OpenAI / Mock） | **任意类型**（LLM、爬虫、本地工具、私有逻辑、Python ML 模型）|
| Provider key 走加密落盘 `secrets.enc.json`（per-agent 或工作区默认）或环境变量 | API key 自己管，agent 跑在自己机器上 |
| 重启 host 自动 respawn | 自己负责生命周期，SDK 自带 auto-reconnect |
| 适合：普通用户 / 标准 LLM 角色 / 60 秒上线 | 适合：开发者 / 私有数据 / 不想暴露代码 |

→ 想走 A：[`HUMAN.md §1 智能体`](HUMAN.md#1-智能体v21) + [`TEMPLATES.md`](TEMPLATES.md)
→ 想走 B：[`../AGENT.md`](../AGENT.md)

两条路可以**混着用** —— 同一个 room 里既有 host-managed 的 writer-zh，
也有你自己 SDK 连进来的 private-rag-agent，对调度器完全透明。

---

## ④ Agent 下载方式 — 模板从哪来

```
                  templates/
                  ├── agents/           原创官方模板（5 个，中文）
                  ├── teams/            原创官方团队（3 个）
                  └── community/        改造自第三方（12 个）
                       ├── agents/      CC0 + MIT，可商用
                       └── teams/
```

三种获取方式，按用户口味挑：

1. **复制粘贴**（最快）：
   GitHub 上点 `.yaml` 文件的 **Raw** 按钮 → 全选复制 → admin UI 「智能体 → 导入」粘贴。

2. **下载文件**：
   下载 `.yaml` 到本地 → admin UI「上传文件」按钮。

3. **将来从云端 raw URL**：
   `templates/` 会迁到独立仓 `AipeHub/aipehub-templates`，到时
   admin UI 会内置一个"浏览公网库"按钮，一键拉取。

每个文件头部有 `# Source` / `# Upstream` / `# License` / `# Adapted`
四行注释，**永不丢失上游产权信息**。第三方许可全文集中保存在
[`../../templates/community/LICENSE-NOTICES.md`](../../templates/community/LICENSE-NOTICES.md)。

→ 完整流程：[`TEMPLATES.md`](TEMPLATES.md)
→ 模板长什么样：[`../../templates/README.md`](../../templates/README.md)

---

## ⑤ 多人合作队伍使用 — 一个 room 内的协作

AipeHub 把"团队"做成了**一个 room** = 一个 `.aipehub/` 目录。
角色三层：

| 角色 | URL | 在这个 room 里能干嘛 |
|---|---|---|
| **admin** | `/admin` | 配置 room、批准 / 拒绝 agent 申请、派任务、做评价、邀请其他 admin |
| **worker** | `/` | 选昵称 + 自己能干的活，接派给自己的任务，完成或拒绝 |
| **agent** | WS port | 自动接派来的任务、返结果 |

### 典型小队工作流（剧本式）

```
0  Alice（admin）开 hub → 启动后浏览器拿到一次性 admin URL，存进 1Password。
1  Alice 在 admin UI 配 ANTHROPIC_API_KEY → 工作区默认 key 加密落盘。
2  Alice 从 templates/community/agents/storyteller.yaml 复制 → 导入
   → host 进程立刻 spawn 一个 LLM agent，状态显示 online。
3  Alice 发邀请 URL 给 Bob 和 Carol。两人选昵称、勾选自己擅长的
   capability（draft / review）→ 进入 room，自动持久化在 workers.json。
4  Alice 派任务："写一个关于坚持的儿童故事"，strategy = capability:[story]
   → host-managed 的 storyteller 抢到任务 → 30 秒后产出 600 字故事。
5  Alice 又派任务："review 这个故事，给改进建议"
   → strategy = capability:[review] → Bob 抢到 → Bob 在浏览器写完反馈。
6  Alice 给两份任务做 evaluation（0–5 星，1 位小数），勾上 weight。
   → 贡献榜立刻刷新：storyteller / Bob 各自的 contribution 出现在排行。
7  所有事件都在 transcript.jsonl 里，崩了重启也能完整恢复。
```

**关键概念**（详细在 HUMAN.md）：

- **三种派任务策略**：`direct`（指名）、`capability`（按能力）、`broadcast`（谁抢到算谁）
- **评价系统**：weight × rating = contribution，每位参与者可见
- **opt-out 开关**：你可以让自己派出的任务不计入贡献榜（但接到的依然计）
- **API Key 三层**：per-agent 私有 → 工作区默认 → 环境变量

→ 完整说明：[`HUMAN.md`](HUMAN.md)

---

## ⑥ 多队伍合作 — 联合多个 hub

**两种"多团队"语义**，别混了：

### 6a. 一个 room 里多个角色（= 上面 ⑤）

所有人都在同一个 `.aipehub/` 目录、同一个 hub 进程。这是默认情况。

### 6b. 多个 room 通过 federation 联起来（= 真·多团队）

每个团队跑自己独立的 hub（自己的 `.aipehub/`、自己的人和 agent、
自己的 API key），通过一个叫 `TeamBridgeAgent` 的特殊 agent 把
**整个团队 hub** 当成**一个 agent** 接入上游 hub。

```
   公司总 Hub（Bob 当 admin）
       │
       ├── agent · alice-team   ←─┐
       │                          │  TeamBridgeAgent
       │                          │
       │                  ┌───────┴────────┐
       │                  │ Alice 的 Hub    │（Alice 当 admin）
       │                  │  · writer-bot  │
       │                  │  · reviewer-bot│
       │                  └────────────────┘
       └── agent · david-team   ←── 同理另一个团队
```

Bob 派任务给 `alice-team` → 桥接转发给 Alice 团队内部 → 内部按
capability 派给 writer-bot → 结果原路返回。Bob 只看到一个干净的
TaskResult，Alice 团队的内部分工对 Bob **不可见**（隐私 / 主权）。

**为什么这模式有用**：

- 上游 hub 看到的是 "alice-team 完成了 N 个任务"，团队成果**聚合可见**
- Alice 团队内部的 prompt、API key、人员、子任务**全部留在本地**
- 想让自己团队拿去**做内部 PoC**？跑一个本地 hub 就行，零接入成本
- 想让公司一起协作？挂一个 bridge 上去，**不动现有团队结构**

→ 完整代码 + demo：[`../FEDERATION.md`](../FEDERATION.md)

---

## 七、深入阅读路线

按"我现在最想搞清什么"挑一条：

| 我想… | 读这 |
|---|---|
| 五分钟跑起来 | [`../../README.md` Quick start](../../README.md#quick-start) |
| 部署给团队 / 上 VPS | [`../DEPLOY.md`](../DEPLOY.md) |
| 当 admin / 当 worker | [`HUMAN.md`](HUMAN.md) |
| 写一个外部 agent | [`../AGENT.md`](../AGENT.md) |
| 不写代码上线 LLM agent | [`HUMAN.md §1`](HUMAN.md#1-智能体v21) + [`TEMPLATES.md`](TEMPLATES.md) |
| 联接两个 hub | [`../FEDERATION.md`](../FEDERATION.md) |
| 写自己的模板贡献回来 | [`TEMPLATES.md`](TEMPLATES.md) + [`../../templates/CONTRIBUTING.md`](../../templates/CONTRIBUTING.md) |
| 整体架构 / 为什么这样设计 | [`../ARCHITECTURE.md`](../ARCHITECTURE.md) |
| Wire 协议 / 写其他语言 SDK | [`../PROTOCOL.md`](../PROTOCOL.md) |
| 商用 / 派生 / license 边界 | [`../LICENSE-FAQ.md`](../LICENSE-FAQ.md) |
| 报告安全问题 | [`../../SECURITY.md`](../../SECURITY.md) |
| 贡献代码 | [`../../CONTRIBUTING.md`](../../CONTRIBUTING.md) |
