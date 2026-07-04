# 例子分级索引 · 先跑哪个，再深到哪

> `examples/` 有 50 个端到端 demo。平铺成一堆，新人不知道从哪下手。这一页按
> **上手台阶**给它们排了序：从「零前置 5 分钟就见结果」一路到「跨 hub 联邦 / 桥接外部
> agent / 完整形态 hub」。每行标了**前置**——绝大多数是 `零`（确定性、无 key、无网络，
> `pnpm start` 直接跑）。
>
> 想先懂概念再看代码：[`OVERVIEW.md`](OVERVIEW.md)；想抄一个开箱 hub：[`HANDS-ON-HUBS.md`](HANDS-ON-HUBS.md)。

## 怎么跑任意一个

```bash
pnpm install && pnpm build        # 第一次：编译整个 workspace（几分钟）
cd examples/<名字> && pnpm start   # 跑任意一个（对所有例子都成立）
# 或用根目录短别名（部分例子有）： pnpm demo:<名字>
pnpm demo                          # = hello-collab（官方第一步，见 QUICKSTART.md）
```

例外：`loadtest` 用 `pnpm inproc` / `pnpm ws`；`oneclick-template` 不是 demo 而是一个
`template.yaml`，导入 hub 后填一次 key 才跑。**前置=零**的行意味着 clone 完就能看到结果，
不用任何 key / 服务 / 联网。

---

## ① 先跑这三个（零前置 · 5 分钟）

| 例子 | 一句话 | 前置 |
|---|---|---|
| [`hello-collab`](../../examples/hello-collab) | agent×2 + 一个人，最短的一条全流程（草稿→评审→修订→人审批）——官方第一步 | 零 |
| [`personal-butler`](../../examples/personal-butler) | 常驻管家：跨会话记忆、benign 工具内联、敏感动作挡在 `/me` 审批后 | 零 |
| [`workflow-architect`](../../examples/workflow-architect) | 大白话 → 工作流 YAML + 讲解 + DAG 图，每条断言自校验（mock LLM） | 零 |

## ② 一个 hub 内的核心机制（零前置）

| 例子 | 一句话 | 前置 |
|---|---|---|
| [`persist-and-resume`](../../examples/persist-and-resume) | FileStorage 持久：一个进程写 transcript，另一个进程接着 seq 续跑 | 零 |
| [`long-running-agent`](../../examples/long-running-agent) | agent 任务中途挂起，resume sweep 稍后唤醒，靠持久工作记忆续跑 | 零 |
| [`heartbeat-agent`](../../examples/heartbeat-agent) | agent 按节拍自唤醒跑 checklist，没事就闭嘴（HEARTBEAT_OK 抑制） | 零 |
| [`broadcast-claim`](../../examples/broadcast-claim) | 广播派发：最快的 reviewer 赢，其余收到 `onTaskCancelled` | 零 |
| [`llm-mock`](../../examples/llm-mock) | LlmAgent + MockLlmProvider：整条 LLM agent 管线，无 key 跑通 | 零 |
| [`architect-team`](../../examples/architect-team) | 一个 architect LlmAgent 用 tool-use 循环把子任务派给写手/评审/测试（mock） | 零 |
| [`cli-human`](../../examples/cli-human) | 把终端当人在环 adapter：stdout 读任务、stdin 回结果（mock 写手） | 零 |
| [`web-demo`](../../examples/web-demo) | Hub + 参考 web UI：写手 agent 和人（alice）在浏览器里协作 | 零（无 env） |
| [`open-space`](../../examples/open-space) | admin-approval 入场闸 + admin/worker web UI + 需批准才能加入的远程写手 | 零 |
| [`butler-vector-recall`](../../examples/butler-vector-recall) | 管家语义召回：本地 embed + cosine / chroma-mcp 接缝——框架从不算向量，注入式 | 零 |

## ③ 接真东西（需 key / 本地 MCP server / 跨进程）

| 例子 | 一句话 | 前置 |
|---|---|---|
| [`llm-real`](../../examples/llm-real) | Claude 起草、GPT 评审——真 provider | 需 API key |
| [`multimodal-vision`](../../examples/multimodal-vision) | LlmAgent 经 LlmImageBlock 读一张图并描述——多模态内容块端到端 | 需 key |
| [`industry-consultation-deepseek`](../../examples/industry-consultation-deepseek) | 真 DeepSeek 驱动的一条行业咨询流水线 | 需 `DEEPSEEK_API_KEY` |
| [`workflow-assistant`](../../examples/workflow-assistant) | 自然语言 → YAML → parseWorkflow → deepCheck → save 全管线（真 LLM） | 需 key |
| [`mcp-tools-quickstart`](../../examples/mcp-tools-quickstart) | 纯 `@gotong/mcp-client`：spawn 文件系统 MCP server、列工具、调一个（无 Hub 无 LLM） | 需本地 MCP server |
| [`mcp-tools-llm-agent`](../../examples/mcp-tools-llm-agent) | 把 MCP 文件系统工具交给 Claude 的 tool-use 循环，看它读文件 | 需 key + MCP server |
| [`rag-mcp`](../../examples/rag-mcp) | RAG 全走 MCP：一个知识 MCP server（chroma-mcp）灌文档、答问 | 需 MCP server |
| [`elasticsearch-kb`](../../examples/elasticsearch-kb) | 把 ES 索引当知识库——官方 ES MCP server 查，Gotong 不碰集群 | 需 ES + MCP server |
| [`obsidian-kb`](../../examples/obsidian-kb) | 把 Obsidian 库当知识库——mcp-obsidian 读，Gotong 不碰库 | 需 Obsidian + MCP server |
| [`remote-agent`](../../examples/remote-agent) | 跨进程：Hub 一个进程、agents 另一个，走线协议连 | 需 socket |
| [`remote-python`](../../examples/remote-python) | 跨语言：Node Hub + Python worker，走线协议连 | 需 socket + python |
| [`services-sidecar-demo`](../../examples/services-sidecar-demo) | agent 走 WebSocket 调 Hub Services（memory），SERVICE_CALL（mock provider） | 需 socket |

## ④ 跨 hub / 联邦（北极星第 2 层）

| 例子 | 一句话 | 前置 |
|---|---|---|
| [`cross-hub-workflow`](../../examples/cross-hub-workflow) | 两个 hub 一个进程：工作流派一步到 peer hub 的能力，出站审批闸后跨过组织边界 | 零（inproc） |
| [`cross-org-rfp`](../../examples/cross-org-rfp) | 最小真·跨组织流：买方发 RFP，卖方起草 + HITL 批 + 回报价 | 零（inproc） |
| [`cross-hub-mcp`](../../examples/cross-hub-mcp) | hub A 共享 MCP server，hub B 经联邦链调它的工具——子进程 + 凭证留在 A | 零 + 本地 MCP |
| [`cross-hub-federation`](../../examples/cross-hub-federation) | 真 WebSocket 跨组织联邦：双向 bearer token，approve 跨界、reject fail-closed、错 token 握手拒 | 需 socket |
| [`family-learning-hub`](../../examples/family-learning-hub) | 两个主权 hub（孩子+家长）联邦：孩子课程流经话题白名单 + 出站闸调家长订阅的 AI 家教 | 零 |
| [`federated-team`](../../examples/federated-team) | 本地小队（一个人类队长 + 几个子 agent）作为一个 agent 加入上游 Hub | 零 |
| [`tea-supply-link`](../../examples/tea-supply-link) | 组织 hub 模板：奶茶店 ↔ 供货商，补货单经店长审批出组织边界 | 零 |
| [`tea-chain-hq`](../../examples/tea-chain-hq) | 组织 hub 模板：连锁总部 → 门店下发指令，区域经理批准后全链生效 | 零 |

## ⑤ 把外部 agent / 引擎桥进来（适配器专题）

> 每个都对着《[`AGENT-ADAPTER-CONTRACT.md`](AGENT-ADAPTER-CONTRACT.md)》的双向 + 五控制缝验收门。

| 例子 | 一句话 | 前置 |
|---|---|---|
| [`coding-agent-bridge`](../../examples/coding-agent-bridge) | hub 驱动编码 CLI（Claude Code/Codex/Aider/Goose…）当 Participant，五缝全展示（mock CLI） | 零 |
| [`acp-coding-bridge`](../../examples/acp-coding-bridge) | hub HOLD 一个 ACP 会话反复派任务（OpenClaw 式），逐动作权限闸（mock ACP） | 零 |
| [`a2a-workflow-step`](../../examples/a2a-workflow-step) | 外部 A2A agent 当工作流步（message/send 立即回，injected fetch） | 零 |
| [`a2a-long-running-step`](../../examples/a2a-long-running-step) | 会挂起的 A2A 步：远端 working→completed，整个 run park 到收敛 | 零 |
| [`codex-deepseek-hub`](../../examples/codex-deepseek-hub) | 一个 router LLM 管 Codex + DeepSeek TUI 编码 agent，同一 repo 共享 AGENTS.md/PROGRESS.md | 零 |
| [`personal-coding-hub`](../../examples/personal-coding-hub) | 一个 router LLM 管 Claude Code + Codex，按目标派编码任务，同一 repo | 零 |
| [`im-bridge-host`](../../examples/im-bridge-host) | 把 IM 桥（`@gotong/im-*`）经 host 路由端到端接进 `Hub.dispatch`，带绑定码流程 | 需 IM 绑定 |
| [`im-steward-bridge`](../../examples/im-steward-bridge) | 从 IM 找管家：`/steward <大白话>` → plan、`/apply <n>` → apply，危险动作 park 到审批 | 需 IM 绑定 |
| [`activepieces-bridge`](../../examples/activepieces-bridge) | 入站自动化 webhook（Activepieces/n8n/Make/Zapier）→ `Hub.dispatch`，共享密钥鉴权 | 需 webhook |
| [`windmill-bridge`](../../examples/windmill-bridge) | 出站：Gotong agent 把任务委托给 Windmill 持久工作流引擎并轮询结果 | 需 Windmill |

## ⑥ 完整形态 hub（照着抄一个真的）

| 例子 | 一句话 | 前置 |
|---|---|---|
| [`cafe-ops`](../../examples/cafe-ops) | 门店运营组织 hub：入职 / 排班 / 加班申领工作流 + `/me` 自助 + 经理 HITL | 零 |
| [`warband-club`](../../examples/warband-club) | 协作 + 共享资源的组织 hub：成员投稿进一个共享档案、查询、提议由队长确认（单 hub 共享） | 零 |
| [`battle-monk-training`](../../examples/battle-monk-training) | 个人成长 hub：教官 router 驱动三支柱（身/心/识），各自写进持久 Codex | 零 |
| [`personal-research-hub`](../../examples/personal-research-hub) | 个人研究/知识库 hub：Karpathy 的「LLM as compiler」循环，编纂 + 反查你的 wiki | 零 |
| [`smart-home-hub`](../../examples/smart-home-hub) | 智能家居 hub 的一个小可跑样例 | 零 |
| [`morning-brief-hub`](../../examples/morning-brief-hub) | 我的晨报：模板装晨报员 + 晨报流，补一条「定时」即每早自动跑、管家播到 IM（调度环零 LLM） | 装模板 + 填 key |

## ⑦ 模板 / 压测 / 参考

| 例子 | 一句话 | 前置 |
|---|---|---|
| [`oneclick-template`](../../examples/oneclick-template) | 一键模板：**一个** `template.yaml` 描述整套架构（客服 agent + 工单流 + 知识库槽），导入即用 | 导入 + 填 key |
| [`loadtest`](../../examples/loadtest) | 上线前压测：N 个并行 agent 下的 dispatch 吞吐 / 延迟分位 / 内存增长（`pnpm inproc`/`pnpm ws`） | 零 |

---

## 按主题横查

- **人在环 / HITL** → `hello-collab` · `cli-human` · `cafe-ops` · `personal-butler` · `cross-org-rfp`
- **工作流** → `workflow-architect` · `workflow-assistant` · `cross-hub-workflow` · `tea-supply-link` · `tea-chain-hq`
- **记忆 / 管家** → `personal-butler` · `butler-vector-recall`（更多能力细节见 [`ledger/MEMORY-ADVANCED-FINAL.md`](ledger/MEMORY-ADVANCED-FINAL.md)）
- **MCP / 知识库** → `mcp-tools-quickstart` · `mcp-tools-llm-agent` · `rag-mcp` · `elasticsearch-kb` · `obsidian-kb` · `cross-hub-mcp`
- **跨 hub / 联邦** → 见 ④；真网络看 `cross-hub-federation`
- **桥接外部 agent** → 见 ⑤；契约看 [`AGENT-ADAPTER-CONTRACT.md`](AGENT-ADAPTER-CONTRACT.md)
- **组织 hub 模板** → `cafe-ops` · `warband-club` · `tea-supply-link` · `tea-chain-hq`

**想自己写一个** → [`PARTICIPANT.md`](PARTICIPANT.md)（20 行写一个 Participant）+
[`AGENT.md`](AGENT.md)（接进已在跑的 hub）。
