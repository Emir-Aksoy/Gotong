# 竞品与生态对比：现实工作流嵌入 × 多人多智能体协作

> 调研日期 2026-05-29。覆盖 30+ 项目/协议，分四赛道。给 agent 与人类读者共用。
> 一句话结论：**没有任何单一竞品同时具备 AipeHub 的四根支柱**——哑 hub（决策在参与者）/
> 人=agent 统一 `Participant` / 文件即状态 / 组织主权联邦。市场被切成四块，每块各占
> 一两根、缺其余。

---

## 一、赛道地图

| 赛道 | 代表玩家 | 它们的共同立场 | 与我们的根本差异 |
|---|---|---|---|
| **① 多智能体编排框架**（库级） | AutoGen→AG2 / MS Agent Framework、CrewAI、LangGraph、OpenAI Agents SDK、MetaGPT、CAMEL、Semantic Kernel、Google ADK、LlamaIndex Workflows、Pydantic AI | **框架即大脑**——库自己跑 LLM、自己持有控制循环/轮转/SOP | hub 是哑路由，决策永远在参与者手里 |
| **② 智能体互操作协议** | MCP、A2A、(IBM ACP→并入 A2A)、AGNTCY/SLIM、NANDA、LMOS、Matrix、ANS/OIDC-A | 2025 下半年集体收编进 **Linux Foundation**，分层为"工具层(MCP)+智能体层(A2A)" | 已实现 MCP；联邦层是自研，应向 A2A 对齐 |
| **③ AI 工作流自动化平台**（低代码/产品级） | n8n、Zapier Agents、Make、Activepieces、Windmill、Gumloop、Relay、Lindy、Sema4、Copilot Studio、Dify、Flowise | **LLM 焊进画布**当节点；**人是"暂停/等审批"节点** | runner 零 LLM（声明式）+ 人是收任务的 Participant |
| **④ 自托管平台 / 持久化执行 / 聊天即 hub** | Dify、Flowise、Langflow、Rivet、LibreChat、Open WebUI、AnythingLLM；Temporal、Inngest、Restate、DBOS；Slack+Agentforce、Mattermost、Rocket.Chat、LangBot、Letta | 状态锁 DB/云；持久化引擎只是无 UI 后端；聊天 hub 无 suspend/resume | bridge+hub+agent+文件状态打包进一个自托管二进制 |

---

## 二、定位

> 别人要么「**框架即大脑**」(①)，要么「**LLM 焊进画布、人是审批节点**」(③)，要么
> 「**只是后端引擎 / 只是消息桥**」(④)。AipeHub 是「**哑 hub + 人即 participant +
> 文件即状态 + 组织主权联邦**」——一个**协作底座**，不是又一个 in-process 编排器。

---

## 三、护城河（架构性优势）

1. **哑 hub / 决策在参与者**——①里没有一个是被动路由，全在进程内跑 LLM 并持有决策。
   只有 LlamaIndex Workflows「you own the loop」精神接近，但仍是 in-process 事件引擎。
   不被任何单一 vendor SDK 绑死——Swarm→Agents SDK、AutoGen→MAF 的连环 churn 正好
   证明"运行时耦合"的风险。
2. **人和 agent 是同一个 `Participant`**——所有竞品都把人建模成特例：UserProxyAgent
   (AutoGen) / interrupt (LangGraph) / deferred-tool (Pydantic) / graph node (ADK) /
   "Human Input" 节点 (Dify) / Outlook 审批表单 (Copilot)。**没有一家让人和 agent 成为
   同一条 message+task+transcript 总线上的对等 peer**。
3. **文件即状态，可移植可审计**——竞品状态在 in-mem / SQLite / Postgres / Redis / Mongo /
   vendor 云。最接近的也只是单 SQLite 文件 (Flowise/Open WebUI)、可查询 Postgres 行
   (DBOS)、或 YAML 图定义 (Rivet)。**没有一家把 transcript+agents+sessions+secrets+vault
   全存成可 grep/diff/rsync/手改的纯文件**。「复制目录 = 搬走房间」最强差异点。
4. **per-org 加密 vault + per-org API 配额是一等公民**——Windmill (workspace-key 加密)、
   Copilot (Key Vault) 最接近，但没有一家把"每组织独立凭证库 + 每组织 LLM 配额"建模成
   联邦感知边界。协议层 (A2A/MCP) 只到"声明 auth scheme"为止，不管 secrets 存储与配额。
5. **跨组织联邦 + 凭证/数据/计费各归各家**——最清晰的空白地带。③全是单租户或单 vendor
   SaaS，team/workspace 只在一个部署内分区；④的引擎只是后端。**没有一家提供开放 P2P
   联邦让工作流跨组织边界而各组织各留凭证/数据/配额**。且 **"跨 hub HITL"（B 组织的人
   满足 A 组织发起的任务）连 A2A（150+ 组织标准）都没覆盖**——A2A 只有 `input-required`
   任务态，无跨组织人类参与者模型。

---

## 四、短板（诚实清单）

1. **集成/连接器广度**——最大实战护城河在对面：Zapier 8000+、Make 3000+、Lindy 4000+、
   n8n 1200+。我们目前几乎为零。
2. **UX 打磨 + NL 编排**——Make Reasoning Panel、Gumloop "Gummie" NL→workflow、Relay
   HITL 体验都远比 YAML-first（哪怕带 NL→YAML 助手）成熟。
3. **持久化成熟度**——Temporal (signal + 无限期零资源等待 + 事件重放) / DBOS (durable
   sleep 数周) / Inngest / Restate 在 suspend/resume 上**领先数年**。我们的
   `SuspendTaskError`+SQLite sweep 概念相同，但年轻、单节点、保证更弱。
4. **企业治理**——Copilot (Entra ID+Key Vault+细粒度 RBAC)、Windmill (5 角色+folder ACL)、
   Lindy/Sema4 (SOC2/HIPAA) 的 SSO/审计/合规故事我们还没建。
5. **多智能体编排 UX**——Flowise Agentflow (supervisor/worker、冲突解决、动态角色)、
   Lindy Agent Swarms、Zapier agent-to-agent calling 都做成了成品 UI；我们只有 dispatch 原语。
6. **IM 广度并非独有**——LangBot 已桥接更多平台 (+DingTalk/LINE/KOOK/微信公众号)，
   且 backend-agnostic。"6 桥"在原始广度上不是护城河——护城河是"带文件状态和参与者
   模型的 hub，它只是路由器"。
7. **生态/心智份额**——对面 50k–110k star (CrewAI 52k、MetaGPT 68k、Dify 110k+)；我们早期。

---

## 五、互操作协议层（最可执行的对齐目标）

2025 下半年，互操作协议集体收编进 Linux Foundation，分成两层，AipeHub 横跨两层：

- **工具层（agent↔工具）：MCP 完胜。** 2025-12 Anthropic 捐给 LF 旗下 **Agentic AI
  Foundation (AAIF)**（与 OpenAI/Block 共建），~9700 万月下载、~1 万 server。
- **智能体层（agent↔agent 跨组织）：A2A 完胜。** 2025-06 入 LF；2025-08 **吸收 IBM ACP**；
  一周年 **150+ 组织**生产使用。
- 其余在上下叠：**AGNTCY/SLIM**=基础设施/传输面；**NANDA**=研究级身份信任 (DID+AgentFacts)；
  **Matrix**=我们哲学近亲（联邦、主权、状态在自己服务器）。

| 协议 | 层 | 治理 | 跨组织身份 | 传输/语义 | 采纳 |
|---|---|---|---|---|---|
| **MCP** | 工具调用 | Anthropic→AAIF/LF | OAuth2.1+PKCE+RFC8707 (client↔server) | 两者 (JSON-RPC/stdio/Streamable HTTP) | 主导 |
| **A2A** | agent↔agent | Google→LF | Agent Card 声明 OAuth2/OIDC/API-key/mTLS | 两者 (JSON-RPC/HTTPS+SSE) | 150+ 组织 |
| ACP (IBM) | agent↔agent | →并入 A2A (2025-08) | (并入) | — | 已废 |
| AGNTCY+SLIM | 发现+身份+**传输** | Cisco→LF | 去中心 Agent Identity Service | SLIM=传输(gRPC/H2/H3)，载 A2A/MCP | 75+ 公司 |
| NANDA | 发现+身份+经济 | MIT Media Lab | DID+可验证凭证+AgentFacts | 语义(注册表) | 研究/未上线 |
| Matrix | 联邦消息**传输** | Matrix.org | homeserver 联邦 MXID | 传输 | 60M+ 用户 |

**AipeHub 联邦原语 → 标准映射**：

| 我们的原语 | 对齐标准 | 结论 |
|---|---|---|
| `peerToken` | A2A auth scheme (Bearer/OAuth2/OIDC/mTLS) | **对齐**——重表达成 A2A 声明的 scheme |
| `Task.origin` | A2A Task 元数据 / OIDC-A delegation chain | **领先**——保留，映射到 A2A Task metadata |
| inbound ACL | A2A "opaque agents" + 选择性披露 | 保留，语义对齐 |
| per-org vault | （无标准覆盖） | **独有，保留** |
| per-org 配额 (OrgApiPool) | （无标准；近似 NANDA 经济层，研究中） | **独有，保留** |
| peer registry + reputation | A2A 注册表 / NANDA Index / ANS | 长期对齐，跟 NANDA 可验证方向 |
| 跨 hub HITL | **无协议覆盖** | **独有 + 切中北极星** |

---

## 六、增强方向（按"杠杆/对北极星贡献"排序）

**🔴 高杠杆**
1. **向 A2A 对齐（单点最高价值）**——暴露 `/.well-known/agent-card.json`、把 `peerToken`
   重表达成 A2A 声明的 Bearer/OAuth2/mTLS scheme，使 AipeHub hub 能与 150+ 组织的 A2A
   生态联邦，而不只是 AipeHub↔AipeHub。`Task.origin` 全程 provenance 其实领先 A2A 现规范。
2. **用 MCP 生态补集成广度**，而非自造连接器——MCP 已是 LF 旗下、~1 万 server。把
   "接入能力 = 装 MCP server"做成一等 onboarding，把对面"8000 连接器"护城河转成"拥抱开放标准"。
3. **dispatch 原语升级成可复用编排模板**——supervisor/worker、辩论、swarm 并行做进
   `templates/`，对标 Flowise Agentflow / Lindy Swarms 成品体验（已有 architect-team 打底）。

**🟡 中杠杆**
4. **持久化：诚实标定 + 可选强后端**——文档如实对比我们 vs Temporal/DBOS 的保证边界；
   考虑可选 **DBOS/Temporal-backed 模式**承接 suspend/resume（DBOS 是库、状态在你自己
   Postgres，与"状态你可见"气质最合）。
5. **HITL 交接 UX 打磨**——概念赢 Slack/Rocket.Chat，但缺成品逃生口：把"带完整上下文
   交接给人 / 多人审批 / 超时升级"做成开箱模板。
6. **企业治理补齐**——SSO(OIDC/SAML)、审计日志、细粒度 RBAC，进组织场景门槛。

**🟢 观察/长期**
7. **盯身份信任层**——NANDA(DID+AgentFacts)/ANS/OIDC-A delegation chain 是 "peer registry +
   reputation" 的可验证未来版本，目前都未批准为标准，**别现在采纳**，要跟。
8. **定位叙事**——对外讲清「**边缘 A2A/MCP-native，但带着 wire 协议故意不管的组织边界
   原语（vault / 配额 / 跨组织 HITL / origin provenance）**」。

**净结论**：别去和 Temporal/DBOS 比持久化、和 Dify/n8n 比集成广度。防御性楔子是**那个
组合**：文件优先可移植 + 人即 participant + 多 IM 原生桥 + 够用 suspend/resume，全装进
一个自托管 OSS 二进制。最该补的两块：**A2A 对齐**（拿生态可达性）+ **集成走 MCP 路线**。

---

## 七、关键引用

**协议**
- MCP→AAIF/LF: anthropic.com/news/donating-the-model-context-protocol-and-establishing-of-the-agentic-ai-foundation ; linuxfoundation.org/press/linux-foundation-announces-the-formation-of-the-agentic-ai-foundation
- A2A→LF: linuxfoundation.org/press/linux-foundation-launches-the-agent2agent-protocol-project... ; 150+ 组织: linuxfoundation.org/press/a2a-protocol-surpasses-150-organizations...
- ACP→A2A: lfaidata.foundation/communityblog/2025/08/29/acp-joins-forces-with-a2a...
- A2A 发现/Agent Card: a2a-protocol.org/dev/topics/agent-discovery/
- AGNTCY/SLIM: outshift.cisco.com/blog/building-the-internet-of-agents-introducing-the-agntcy ; datatracker.ietf.org/doc/draft-mpsb-agntcy-slim
- NANDA: arxiv.org/abs/2507.07901 ; media.mit.edu (Beyond DNS / AgentFacts)

**框架**
- AG2: github.com/ag2ai/ag2 ; MS Agent Framework: github.com/microsoft/agent-framework
- CrewAI: github.com/crewAIInc/crewAI ; LangGraph: github.com/langchain-ai/langgraph
- OpenAI Agents SDK: openai.github.io/openai-agents-python ; MetaGPT: github.com/FoundationAgents/MetaGPT
- Google ADK + A2A: google.github.io/adk-docs/a2a/ ; Pydantic AI: github.com/pydantic/pydantic-ai

**平台 / 引擎**
- n8n HITL: docs.n8n.io/advanced-ai/human-in-the-loop-tools/ ; Zapier Agents: zapier.com/blog/zapier-agents-guide/
- Dify: github.com/langgenius/dify (Human Input 节点: releases/tag/1.13.0) ; Flowise Agentflow: docs.flowiseai.com/using-flowise/agentflowv2
- Windmill: windmill.dev/docs/core_concepts/variables_and_secrets ; Copilot Studio: learn.microsoft.com/microsoft-copilot-studio/flows-advanced-approvals
- Temporal HITL: docs.temporal.io/ai-cookbook/human-in-the-loop-python ; DBOS: github.com/dbos-inc/dbos-transact-py
- LangBot: github.com/langbot-app/LangBot ; Letta: github.com/letta-ai/letta
