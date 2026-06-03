# 主流 Agent 适配器契约 — 双向 + 可快速接管

> 立于 2026-06-01。这是往后**每一个「主流 agent 接入」适配器**的标准验收门。
> 新写 adapter 前先对着本文过一遍；不满足的不算「接上了」。
>
> 北极星对齐：**人和 agent 是同一个 `Participant`**（CLAUDE.md §一 第 2 条）。
> 所以「接管」不是一个新子系统，而是让 **suspend/resume（P11）+ inbox/HITL（P16）+
> delegate（inbox-gov M2）** 这套**既有机器**咬合上外部 agent 的一份契约。适配器要做的
> 不是发明接管，而是把这些接缝**露出来**。

---

## 0. 一句话定义

> 一个主流 agent **「双向可快速接管」** =
> ① 它既能调 AipeHub、也能被 AipeHub 驱动（**双向**）；
> ② 它在 hub 里跑的**每个 task 都待在一个控制环里**——人或上级 agent 能在**有界时间内**
> 观测它、拦住它、改派它、让它续跑、或终止它（**可快速接管**）。

两条轴都过才算数。下面分别给可测判据。

---

## 1. 轴一：双向（连通性）

| 方向 | 含义 | 判据（适配器必须证明） |
|---|---|---|
| **入站** 外部 agent → 调 hub | 对方把 AipeHub 当工具/对端 | 对方作为 **MCP 客户端**接 `@aipehub/mcp-server`，或 **A2A 调用方**打 `/a2a`（per-peer bearer，fail-closed）。 |
| **出站** hub → 驱动外部 agent | hub 把它当一个 Participant 派活 | hub 用以下之一把它包成 Participant：**shell-out**（CLI agent）/ **`A2aRemoteParticipant`**（A2A agent）/ **鸭子类型框架 adapter**（P5 模式，框架永不被反向导入）。 |

> 入站对**所有 MCP 客户端**是同一条线——`mcp-server` 一个就覆盖整类，无需 per-agent 代码。
> 缺口几乎总在**出站**。

---

## 2. 轴二：可快速接管（可控性）—— 五个控制缝

每个适配器必须让它跑的 task 满足这 5 条**可测验收判据**（括号是已有原语，适配器只接不造）：

| 控制缝 | 验收判据 | 既有原语 |
|---|---|---|
| **可观测** Observe | task 跑的时候 transcript 能**实时**看到它的 step/输出，不是只在结束时一坨 | transcript（file-first）+ P8 streaming chunk |
| **可拦截/暂停** Intercept | task 能在「下一个有副作用的动作」前**停住**，人在 inbox 看到待决项 | `SuspendTaskError`（P11）+ 出站审批闸 `ApprovalGatedParticipant`（P18-B） |
| **可改派/移交** Handoff | 一个 pending/suspended 的 task 能 **delegate 给另一个 Participant**（人或别的 agent），新 owner 拿到全上下文 | inbox `delegate`（inbox-gov M2）+ `Task.ancestry` + transcript |
| **可续跑** Resume | 人给出决定/编辑后 task 用 `Hub.resumeTask` 续跑，且**钉死 `definitionRevision` 不漂移** | `Participant.onResume`（P11）+ 两步恢复（P16）+ P15 修订快照 |
| **可终止/可逆护栏** Terminate | 人能 cancel 整个 task；任何**不可逆 / 对外副作用**动作前**必须有闸**（fail-closed，默认拦） | dispatch 取消 + 审批闸 + 全局安全规则（不可逆动作先确认） |

恢复侧（暂停→移交→续跑→终止）这套原语**已经全在**。所以适配器真正要补的只有「让外部
agent 在合适的颗粒上停下并回到 hub」——见 §4。

---

## 3.「快」= 接管粒度分级（Tier 0–3）

「快速」不能靠感觉，靠**外部 agent 在多细的颗粒上回到 hub**来量——颗粒越细，接管延迟越低。

| Tier | 能在哪接管 | 典型实现 |
|---|---|---|
| **T0 任务级** | 只能「派发前 / 完成后」 | 不透明单次长跑（`codex exec` 一把梭、Manus 跑 30–60 分钟出一个成品）。最低保。 |
| **T1 回合级** | 回合之间 | CLI 跑成**循环**，一回合一次 invoke 返回 hub。 |
| **T2 动作级** | 每个工具 / 副作用动作前逐个批改 | LangGraph 逐 node checkpoint、MCP 工具调用拦截、A2A + HITL。 |
| **T3 流级** | 生成中途可打断、可取消当前回合 | streaming + cancel token。 |

**硬性 bar**

- 每个 adapter **至少到 T1**。
- 凡是**能改文件 / 能花钱 / 能对外发消息**的，必须到 **T2**（动作级闸）——这跟全局安全规则
  「不可逆动作先确认」是同一条线。
- **黑盒 agent 的诚实兜底**：有些自主 agent（Devin/Manus/Operator）中途无法停（自身只到 T0/T1）。
  这时**不在 agent 里强求**，而是**在 hub 边界把它的副作用出口钉到 T2**——它要写文件/对外发/花钱，
  得经过 hub 一侧的动作闸（出站审批 / inbox）。**agent 可以是黑盒，副作用面不许是黑盒。**

---

## 4. 适配器落地真正要额外做的，只有两样

现有原语覆盖了 5 个控制缝的恢复侧。新 agent adapter 只需补：

1. **checkpoint 式增量执行** —— 别把外部 agent 当一个不透明的长阻塞调用。要让它在
   step / 工具调用 / 回合边界**回到 hub**（这一项直接决定它能到哪个 Tier）。
2. **on-demand 接管信号** —— 现在只有「预设审批闸」（提前声明哪步要批）；还缺
   「人随时点一下『接管』，正在跑的 task 就停在下一个 checkpoint」。这是唯一需要新写的小机制
   （一个 cooperative cancel/park 标志，adapter 在每个 checkpoint 检查它）。

---

## 5. E2E 验收门（每个 adapter 必须能跑通这个用户故事）

> Codex 在跑一个重构，我盯着 transcript →
> ① **看到**它下一步要 `rm` 一批文件（可观测）→
> ② 我点「接管」，task **停在那一步**进 inbox（可拦截 + on-demand 信号）→
> ③ 我把它**改派**给自己 / 或另一个更稳的 agent（可移交）→
> ④ 我改成只删两个文件 / 或干脆自己接手做完 →
> ⑤ 让它 **`resume` 续跑**，跑的还是钉死的那一版定义（可续跑，不漂移）→
> ⑥ 如果跑歪了我能**直接 kill**（可终止）。

照这个故事写一个**确定性 E2E 测试**（mock 外部 agent + 真 Hub + suspendNotifier + inbox +
versioning），就是该 adapter 的验收门——和项目里其它「无漂移 E2E 验收门」同形。

---

## 6. 目标主流 agent 清单（2026-06 快照）

> 联网查证于 2026-06-01（来源见文末）。Tier 是**可达上限**的诚实标注，不是承诺值——
> 真实现到哪个 Tier 由 adapter 决定。

### 6.1 CLI 编码 agent（出站 = shell-out；入站 = MCP）

| Agent | 厂商/开源 | MCP | A2A | 可达 Tier | 备注 |
|---|---|:---:|:---:|:---:|---|
| **Claude Code** | Anthropic | ✅ | — | T1（循环跑）/ T2* | 我们的起点之一 |
| **Codex** | OpenAI | ✅ | — | T1 / T2* | 我们的起点之一 |
| **Antigravity CLI** | Google（5/19 取代 Gemini CLI） | ✅ | ✅ 原生 | T1，A2A 路可 T2 | Gemini CLI 6/18 停服 |
| **OpenCode** | sst（开源第一） | ✅ | — | T1 | ~150K star |
| **Goose** | Linux 基金会 | ✅ | — | T1 / T2* | MCP-native、厂商中立 |
| **Cline** | 开源（VS Code→CLI） | ✅ | — | T1 | 并行 agent / SDK |
| **Cursor CLI** | Cursor（$2B ARR） | ✅ | — | T1 | 67% 财富 500 在用 |
| **Aider** | 开源老牌 | ✅ | — | T1 | |
| **Amazon Q Dev CLI** | AWS | ✅ | — | T1 | |
| **Qwen Code** | 阿里 | ✅ | — | T1 | 国内场景相关 |

\* T2 需该 CLI 暴露 per-tool-call hook；多数现在只做到回合级，诚实标 T1。

### 6.2 Agent 框架（出站 = P5 鸭子 adapter）

| 框架 | MCP | A2A | 可达 Tier | 现状 |
|---|:---:|:---:|:---:|---|
| **LangGraph** / **CrewAI** | ✅ | 部分 | T2（逐 node/step checkpoint） | ✅ P5 已做 |
| **AutoGen / AG2** | ✅ | ✅ | T2 | 待补 |
| **Google ADK** | ✅ | ✅ 原生 | T2 | 待补（A2A 路白捡） |
| **OpenAI Agents SDK** | ✅ | 部分 | T2 | 待补 |
| **Pydantic AI** | ✅ | — | T2 | 待补 |
| **LlamaIndex** / **Letta** | ✅ | 部分 | T2 | 待补 |

### 6.3 自主 / 计算机操作 agent（长跑、偏黑盒 → 副作用面钉 T2）

| Agent | 厂商 | 接入路 | 可达 Tier | 备注 |
|---|---|---|:---:|---|
| **Devin** | Cognition | 自身 API / A2A | T0–T1 | 自主 SWE，长跑 |
| **Manus** | Meta（2026 初收购） | 自身 API | T0 | Linux 沙箱跑 30–60 分钟出成品，强黑盒 |
| **OpenAI Operator** | OpenAI | 自身 API | T0–T1 | 计算机操作 |
| **Claude computer use** | Anthropic | SDK | T1 | |
| **Perplexity Computer** | Perplexity | 自身 API | T0–T1 | 多模型编排 |

> 这类一律走 §3 黑盒兜底：agent 自己到不了 T1 没关系，**它的副作用出口必须经 hub 的 T2 动作闸**。

### 6.4 企业平台 / 通用助手（是「机构」层 → 走 A2A 联邦，不是 shell-out）

| 平台 | 厂商 | 接入路 | 备注 |
|---|---|---|---|
| **Microsoft Copilot Studio** / Foundry Agent Service | 微软 | A2A 联邦 | 16 万组织、40 万+ agent；Foundry 原生托管 LangGraph/Claude SDK/OpenAI SDK |
| **Salesforce Agentforce** | Salesforce | A2A 联邦 | $800M ARR |
| **Gemini Enterprise Agent Platform** | Google | A2A 联邦 | 原 Vertex AI/Agentspace；Agent Garden/Registry |
| **ChatGPT Agent** / **IBM watsonx** / **Lindy** | 各家 | A2A / MCP | 视其对外协议而定 |

> 这些不该 shell-out——它们是**对端机构**。走 **Phase 18 A2A + per-link 信任契约（P4）**，
> 接管发生在**各自机构内部**，AipeHub 这侧的接管粒度由它们暴露的 HITL 决定（多为 T0–T2）。

---

## 7. 落地优先级

1. ✅ **P0｜一个通用 CLI shell-out adapter**（`examples/coding-agent-bridge/`）——**已落地**
   （Stream E E2, commit `e5ebd51`→`57fe00d`）。`@aipehub/cli-agent`（`CliParticipant` +
   `cli-runner` 进程引擎 + checkpoint 原语，core-only 叶包）参数化命令模板 **一次覆盖 §6.1
   整类**（`CLI_PRESETS`: Claude Code/Codex/OpenCode/Aider/Goose…）。实际做到 **T2**：五缝齐全
   （observe `onChunk` / intercept `TakeoverController` / handoff `SuspendTaskError` 带状态 /
   resume `onResume` 无漂移 / terminate `onTaskCancelled`→SIGTERM→SIGKILL），外加 `dangerousCommandGate`
   动作闸（危险命令 spawn 前挂起等人批，fail-closed）。验收门 = `packages/host/tests/cli-agent-e2e.test.ts`
   照 §5 故事跑真 Hub+suspendNotifier→identity+FileInboxStore。详见 `docs/zh/V5-E2-CLI-ADAPTER.md`。
2. **P1｜A2A-native（Antigravity / Google ADK / 企业平台）**——出入站代码 Phase 18 已就绪，
   只差注册配置 + 文档，近乎白捡。
3. **P2｜补框架 adapter**——AutoGen / ADK(py) / OpenAI Agents SDK / Pydantic AI / LlamaIndex /
   Letta，照 P5 鸭子模式每个 ~30 行，可达 T2。
4. **P3｜自主 / 企业平台**——按需，且重点是 §3 的「副作用面钉 T2」兜底而非追 agent 内部接管。

---

## 8. 显式不做 / 推迟

- 不替每个 CLI 逐个手写 adapter（P0 的参数化模板覆盖整类）。
- 不追自主 agent（Devin/Manus）的 agent 内部 mid-run 接管——只在 hub 边界钉副作用面。
- A2A streaming / tasks/get lifecycle、出站 redaction、per-agent admin-UI 配置——沿用各自
  Phase 的推迟项。

---

## 附：数据来源（查证 2026-06-01）

主流 agent 清单与协议支持据公开来源综合（CLI 编码 / 框架 / 自主·计算机操作 / 企业平台四类
对比与排名文章、各厂商文档、awesome-ai-agents-2026 目录）。Tier 与接入路是 AipeHub 侧的
工程判断，非厂商承诺。清单是**快照**——agent 生态迭代极快（如 Gemini CLI→Antigravity 的更替），
新写 adapter 时应重新核对当时状态。
