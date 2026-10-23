# 竞品与生态对比：现实工作流嵌入 × 多人多智能体协作

<!-- doc-version: 1.1 -->
> **文档版本 1.1** · 中文译本 · 最后更新 2026-10-23 · 权威源：[English](../COMPETITIVE-LANDSCAPE.md)。如译文与英文版冲突，以英文版为准。


> 调研日期 2026-05-29（赛道 ⑤ 为 2026-10-23 增补）。覆盖 30+ 项目/协议，分五赛道。给 agent 与人类读者共用。
> 一句话结论：**没有任何单一竞品同时具备 Gotong 的四根支柱**——哑 hub（决策在参与者）/
> 人=agent 统一 `Participant` / 文件即状态 / 组织主权联邦。市场被切成四块，每块各占
> 一两根、缺其余。
>
> 配套阅读：[`PRODUCT-MATRIX.md`](PRODUCT-MATRIX.md)（2026-06-21）——产品级同台矩阵（优势/劣势各一张）
> + 「我们最适合哪类有需求但今天没被满足的用户」+ DeepSeek 降价如何解锁那个格子。本篇是赛道地图，那篇是产品级目标用户判断。
>
> **2026-10-23 增补**：新增赛道 ⑤「巨头常驻个人 agent」（ChatGPT dots / Meta Muse / Grok Bot）
> 和「给 agent 配邮箱」的趋势，相应补了定位、护城河的适用边界、短板 8–9、增强方向 9（邮件桥，只记一笔）。
> ⑤ 不占四根支柱的任何一根，它比的是另一条轴（个人助手体验），所以上面的一句话结论不变。
> ①–④ 仍是 2026-05-29 的调研快照，未逐条复核；其中几条短板此后已有进展（SSO 的 OIDC/SAML、
> A2A Agent Card、MCP 连接器目录），以 [`PROGRESS-LEDGER.md`](PROGRESS-LEDGER.md) 为准。

---

## 一、赛道地图

| 赛道 | 代表玩家 | 它们的共同立场 | 与我们的根本差异 |
|---|---|---|---|
| **① 多智能体编排框架**（库级） | AutoGen→AG2 / MS Agent Framework、CrewAI、LangGraph、OpenAI Agents SDK、MetaGPT、CAMEL、Semantic Kernel、Google ADK、LlamaIndex Workflows、Pydantic AI | **框架即大脑**——库自己跑 LLM、自己持有控制循环/轮转/SOP | hub 是哑路由，决策永远在参与者手里 |
| **② 智能体互操作协议** | MCP、A2A、(IBM ACP→并入 A2A)、AGNTCY/SLIM、NANDA、LMOS、Matrix、ANS/OIDC-A | 2025 下半年集体收编进 **Linux Foundation**，分层为"工具层(MCP)+智能体层(A2A)" | 已实现 MCP；联邦层是自研，应向 A2A 对齐 |
| **③ AI 工作流自动化平台**（低代码/产品级） | n8n、Zapier Agents、Make、Activepieces、Windmill、Gumloop、Relay、Lindy、Sema4、Copilot Studio、Dify、Flowise | **LLM 焊进画布**当节点；**人是"暂停/等审批"节点** | runner 零 LLM（声明式）+ 人是收任务的 Participant |
| **④ 自托管平台 / 持久化执行 / 聊天即 hub** | Dify、Flowise、Langflow、Rivet、LibreChat、Open WebUI、AnythingLLM；Temporal、Inngest、Restate、DBOS；Slack+Agentforce、Mattermost、Rocket.Chat、LangBot、Letta | 状态锁 DB/云；持久化引擎只是无 UI 后端；聊天 hub 无 suspend/resume | bridge+hub+agent+文件状态打包进一个自托管二进制 |
| **⑤ 巨头常驻个人 agent**（2026-09 起，消费/团队级） | OpenAI ChatGPT dots、Meta Muse、xAI+Cursor Grok Bot；周边：AgentMail 等「agent 邮箱」服务 | **强模型 + 现成巨量入口（ChatGPT / WhatsApp / X）+ 常驻云电脑和数千连接器**；邮箱是触达「非 agent 世界」的附件，agent 互发邮件只是「有地址就能收发」的副作用，不是协议；治理做在单一厂商围墙之内 | 不争模型和入口；做跨厂商、跨组织的交互治理和数据主权——凭证、记忆、档案留在自己盘上 |

---

## 二、定位

> 别人要么「**框架即大脑**」(①)，要么「**LLM 焊进画布、人是审批节点**」(③)，要么
> 「**只是后端引擎 / 只是消息桥**」(④)。Gotong 是「**哑 hub + 人即 participant +
> 文件即状态 + 组织主权联邦**」——一个**协作底座**，不是又一个 in-process 编排器。
>
> ⑤ 比的是另一条轴：**个人助手体验**（模型、入口、连接器）。这条轴上，Gotong 的原生 agent
> 阿同与它们正面重叠，而且没有性能优势。Gotong 作为网络的位置不在这条轴上，而在 ⑤ 各家的
> 围墙之间：跨厂商、跨组织的任务语义、权限、审计、计费和身份核验，这些它们都没有。

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

**2026-10 适用边界修正**：⑤ 把单厂商内的治理做成了标配。dots 可按动作类别设放行/先问/禁止，
发信前自动审查收件人和内容，有活动记录；Muse 有独立的 Sentinel agent 审核所有出网请求，
支付走 Stripe 一次性卡号；Grok Bot 申领邮箱要用户批准、团队要管理员开启，本地命令默认审批。
所以「有审批、有审计」本身已不是差异点。第 4、5 条只在两处成立：**跨边界**（跨厂商、跨组织）
和**主权**（文件、记忆、凭证在自己盘上）。三家也都没公开怎么处理陌生 agent 的来信
（发件人信任、白名单、注入隔离），这同样是空白。

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
8. **个人助手层没有性能优势**（2026-10 增补）——阿同的个人助手部分与 ⑤ 正面重叠：模型、
   入口规模（面向数十亿用户的现成 App）、连接器数量（4000+）、云端常驻执行都在对面。
   阿同能拼的是主权（生活档案和记忆在自己盘上、可整目录搬走），拼不了聪明。
9. **跨边界治理的需求还缺真实用户证据，邮件可能先占位**（2026-10 增补）——「跨厂商、跨组织」
   是我们押注的空白，但还没有真实用户在用。与此同时，⑤ 正让邮箱成为 agent 事实上的互联方式
   （Grok Bot 2026-10-09 起每个 bot 可申领独立地址，一手来源有限），可能绕过 A2A 等正式协议先占位。
   邮件没有任务状态、能力声明和审批语义；SPF/DKIM 只能证明域名，证明不了「哪个 agent 代表谁」；
   陌生来信本身就是注入入口。这些是我们的机会，也说明我们迟早要能接住邮件这条通道，不能只等 A2A。

---

## 五、互操作协议层（最可执行的对齐目标）

2025 下半年，互操作协议集体收编进 Linux Foundation，分成两层，Gotong 横跨两层：

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

**Gotong 联邦原语 → 标准映射**：

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
   重表达成 A2A 声明的 Bearer/OAuth2/mTLS scheme，使 Gotong hub 能与 150+ 组织的 A2A
   生态联邦，而不只是 Gotong↔Gotong。`Task.origin` 全程 provenance 其实领先 A2A 现规范。
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
9. **邮件桥（2026-10-23 只记一笔：等真实需求，不设计、不排期；方向 C+T）**——让外部 agent
   能用邮件联系阿同。要点只有三条：入站邮件一律按**不可信**处理（发件人信任分级、隔离区、
   要回复先过审批）；阿同代用户回信走现有审批闸；起点是已有的 Gmail OAuth 连接器
   （[`REAL-LIFE-CONNECTORS.md`](REAL-LIFE-CONNECTORS.md) C-M2），不自建邮件服务。
   重新评估的信号：出现真实的「外部 agent 来信需要处理」的用户场景。

**净结论**：别去和 Temporal/DBOS 比持久化、和 Dify/n8n 比集成广度。防御性楔子是**那个
组合**：文件优先可移植 + 人即 participant + 多 IM 原生桥 + 够用 suspend/resume，全装进
一个自托管 OSS 二进制。最该补的两块：**A2A 对齐**（拿生态可达性）+ **集成走 MCP 路线**。
2026-10 补一句：也别和 ⑤ 比模型和入口——阿同拼主权，Gotong 守跨边界治理。

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

**常驻个人 agent / agent 邮箱（2026-10 增补）**
- ChatGPT dots: openai.com/index/introducing-dots/ ; siliconangle.com/2026/09/29/openai-launches-dots-always-on-ai-agents-in-chatgpt-with-their-own-cloud-computers/
- Meta Muse: about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/
- Grok Bot: every.to/personal-agents-comparison ; Agent Email（未完全核实）: pasqualepillitteri.it/en/news/22755/grok-bot-email-address-mail-grokbot ; letsdatascience.com/news/grok-bot-adds-dedicated-email-addresses-7e47912d ; 此前走 AgentMail 插件: docs.agentmail.to/integrations/grokbot
- AgentMail 种子轮（2026-03-10）: globenewswire.com/news-release/2026/03/10/3253159/0/en/AgentMail-Raises-6M-led-by-General-Catalyst-to-Build-the-First-Email-Provider-for-AI-Agents.html
- IETF 个人草案（非标准）: datatracker.ietf.org/doc/draft-klrc-aiagent-auth/ ; datatracker.ietf.org/doc/html/draft-daniel-ai-agent-internet-architecture-00
