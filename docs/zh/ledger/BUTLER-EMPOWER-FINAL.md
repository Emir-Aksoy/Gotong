# BE — 管家增强（给「用户 ↔ 框架」中间层补眼睛 + 闭环）

> 收口文档。对应 CLAUDE.md「三、当前真实缺口」的**缺口 3**：常驻管家
> （`gotong start` 注册的 `chat` agent = per-user `ButlerRouter`）能**写**
> （建 / 改 / 删自己的 agent、改工作流，全走 `/me` 收件箱审批），但几乎
> **看不见** run 状态 / agent 健康 / 用量，也不能诊断→修复、大白话建工作流、
> 把一次性任务直接派给自己的助手。管家正是我们架好的「用户到框架」中间链接
> ——让它更好地管理其他智能体和工作流，就是**给它补眼睛**（读投影）+ **补闭环**
> （benign 内联 / governed park），而写永远走既有审批闸。
>
> **贯穿全系列的一条硬约束：管家在结构上做不出成员自己动手做不到的事。**
> 观察一律复用既有的**成员向只读投影**；写一律落到既有的**成员 surface /
> 审批闸**。管家不是新权限面，是同一套权限的大白话入口。这条约束是 BE 的
> 设计核心，不是事后加的护栏。

Last updated: 2026-07-02

---

## 一、五个里程碑

| 里程碑 | 干了什么 | benign / governed | commit |
|---|---|---|---|
| **BE-M1** 观察面三读工具 | 给管家补**眼睛**：`list_my_runs`（我发起的运行 + 状态 + 抹密失败原因）/ `list_my_agents`（脱敏助手名册，只有 id/label/能力/在线，永远看不到别人的提示词/密钥）/ `my_usage`（本人用量按模型 roll-up）。每个都是成员在 `/me` 已能点开看的读，scoped 到本人。 | **benign**（内联，纯读） | `ef79660` |
| **BE-M2** 诊断→修复闭环 | 给管家补**RES 的眼睛**：`diagnose_my_agents` 对本人拥有的 agent 跑 RES-M2 引擎（哪个 provider 没密钥、能不能一键切）。只读诊断；唯一能代改的修复是既有 governed `edit_agent`（park → `/me` 批准）。**守边界**：只有 `switch_provider`→原生 provider 管家能张口帮你改；`use_local_endpoint`（admin 面板可一键）对管家是**建议性**——成员配不了 baseURL。 | 诊断 **benign**；修复走既有 **governed** `edit_agent` | `8a9da11` |
| **BE-M3** governed create_workflow | 给管家补**手**（建工作流）：`create_workflow`（大白话 → YAML）。复用既有 `MeWorkflowCreateService`——本地限定闸（跨 hub 出站 → `cross_hub` 拒）、draft-never-live、owner-as-grant 全套照搬。管家不另造写通道。 | **governed**（park → `/me` 批准） | `f7b7f6f` |
| **BE-M4** ask_my_agent 一次性派发 | 给管家补**总机**：`ask_my_agent`（把一个问题转给本人拥有的**某一个**助手，等回复带回来，一次问答）。no-leak：目标必须在 `listOwned(userId)` 里，改都改不到别人的助手；派发署名成员本人。 | **benign**（内联，成员问自己的助手 = 自助） | `dbad6cb` |
| **BE-M5** 运行结果主动播报 | 给管家补**主动嘴**：一个工作流是 fire-and-forget，跑完管家**主动**把「『X』跑完了：成功 / 失败 — 原因…」推到成员 IM。轮询 + 单调高水位去重（`endedAt > announcedMax` 才播，严格 `>` 让重播不可能）；**零 LLM**——通知是事实转达，从 run 行拼出，不需 provider/key。观察复用 BE-M1 的 `listRunsByUser`，投递复用 F1 `pushToMember`。DEFAULT-OFF per member（`set_run_broadcast` opt-in，开启不翻旧账）。 | 播报是后台 sweep；opt-in 工具 **benign** | `8fc4c10` |
| **BE-M6** 文档 + 登记 | 本文档 + CLAUDE.md §二/§五 登记。 | — | 本提交 |

BE 全系列共 **74** 个测试（见 §七），host 全量 1554 通过 0 失败。

---

## 二、一条贯穿约束：管家做不出成员做不到的事

BE 给管家加了五道缝，但**没有加一分新权限**。每道缝都能落到「成员本来就能
在 `/me` 手动做的同一件事」上：

| 管家能做 | 成员手动等价 | 权限落点（管家没绕过它） |
|---|---|---|
| `list_my_runs` / `my_usage` | `/me` 最近运行面板 / 用量页 | 同一个 `listRunsByUser`（按 `triggeredByOrigin.userId` 收口）/ 同一个 `aggregateLedger({userId})` |
| `list_my_agents` | `/me`「我的 AI 助手」 | 同一个脱敏投影 `meAgentsSurface`（id/label/能力/在线 only） |
| `diagnose_my_agents` → 修复 | 在 agent 面板看红信号 → 改 provider | 修复 = 既有 governed `edit_agent` → `/me` 收件箱审批 |
| `create_workflow` | `/me` 工作流架构师建草稿 | 同一个 `MeWorkflowCreateService`（本地限定 + draft + owner grant） |
| `ask_my_agent` | `/me` 直接给那个助手发消息 | `hub.dispatch` 署名 `origin.userId`，目标必须 `listOwned` 命中 |
| 运行播报 | `/me` 刷新最近运行看状态 | 只读 `listRunsByUser` + F1 `pushToMember`（和提醒/每日问候同一出口） |

**结构性论证**：管家是 per-user 的——`ButlerRouter` 按 `task.origin.userId`
给每个成员建一个只绑他自己 id 的实例。所以每个工具里的 `userId` 是 host 强制
注入的，**从不是模型的入参**。alice 的管家拿到的是 alice 的 id，改都改不到
bob 的运行 / 助手 / 账单。加上「写只落既有 surface」，管家在结构上就是成员
自己的大白话代理，不是一个更高权限的东西。

---

## 三、benign 内联 vs governed park

管家的工具分两类，`PersonalButlerAgent({ benign, governed })` 各收一半：

- **benign（内联跑，不 park）**：读，或「成员对自己做的自助动作」。后果只及
  成员本人，没有要 gate 的审批。BE 里：三读工具（M1）、诊断（M2 的只读半边）、
  `ask_my_agent`（M4）、`set_run_broadcast` opt-in（M5）。
- **governed（park → `/me` 收件箱 → 批准才执行）**：代成员改会影响持久状态的
  东西。`GovernedActionToolset` 分类默认 `approve`，park 成 `SuspendTaskError`
  → `butlerApprovalItemFor` → `/me` 收件箱 → 成员点一次批准 → 恢复那一回合真正
  执行。BE 里：`edit_agent`（M2 的修复半边，既有闸）、`create_workflow`（M3，
  新 `GovernedActionToolset`，与 steward 闸数组组合，工具名不相交，各 gate 各的）。

判据一句话：**读 / 自助 → benign；代改持久状态 → governed**。BE-M5 的播报本身
是后台 sweep（不在 tool-loop 里），它的 opt-in 工具是 benign（改自己的通知偏好）。

---

## 四、「绝不给一个打不响的工具」——surface 门控

每个管家工具的后端 surface 都是**鸭子类型注入**，host 在 `createForUser`
里按需接线（`butlerObserveRunsRef` / `butlerDiagnoseAdaptRef` / `butlerAskRosterRef`
/ `butlerWorkflowCreateRef` …都是 forward-ref，boot 后期赋值，per-message 惰性读）。

原则：**surface 缺席 → 该工具从 `listTools()` 直接掉队，绝不提供**。例如
BE-M2 的 `diagnose_my_agents` 需要「本人拥有 agent 的 lister」+「适配引擎」两个
surface 都在场才提供；BE-M4 的 `ask_my_agent` 缺 roster 就不出现。这样模型永远
不会看到一个调了必然报「没接线」的工具，也不会拿它去糊弄成员。BE-M5 更进一步：
`butlerRunBroadcastOn && butlerObserveRunsRef` 才 arm sweep——功能开关关了，或
run 投影没接，整条 sweep 都不 arm。

---

## 五、BE-M2 守边界：admin 能一键 ≠ 管家能张口

BE-M2 复用 RES-M2 引擎，但**管家能代改的集合严格小于 admin 能一键的集合**。
RES 的 `applicable: true` 是「admin 面板能经 agent 更新写路径代执行」；管家还多
一层约束：**成员在 `/me` 自己能不能配这个东西**。

| RES 提议 | admin RES-M3 | 管家 BE-M2 | 为什么管家更窄 |
|---|---|---|---|
| `switch_provider` → 原生（anthropic/openai） | 一键应用 | **能代改**（走 `edit_agent`） | 原生 provider 密钥从 env/vault 解析，不用填 baseURL——成员在 `/me` 本就能切 |
| `use_local_endpoint`（改指本地 Ollama…） | 一键应用 | **只建议**（advisory） | 接本地端点要填 baseURL = openai-compatible 配置，`MEMBER_PROVIDERS` 不含它，属运维基建，成员配不了 |
| `set_env_key` / `wire_mcp_server` | 建议性 | 只建议 | hub 之外的人的动作 |

`enactableProvider(p)` 只在 `p.kind === 'switch_provider' && p.applicable === true`
时返回 `toProvider`，否则 null——这条判定把「守边界」钉死在纯函数里。管家对
advisory 修复会老实说「这步要管理员在面板做，我改不了」，不假装能一键。

---

## 六、BE-M5 事件播报机制：轮询 + 高水位 + 零 LLM

播报是**事件驱动**（一个 run 跨入终态），但没有运行完成事件总线可订阅——加一个
会把 workflow controller 耦合到管家。所以照抄 S3-M2 `ButlerProactiveSweeper` 的
姿态：

- **观察**：后台 sweep 扫每个成员命名空间（`<rootDir>/user/*`），读他 opt-in 的
  最近运行（BE-M1 的 `listRunsByUser` 投影，服务端已收口 + 抹密）。
- **去重**：单调高水位 `announcedMax`（已播报的最大 `endedAt`）。`endedAt >
  announcedMax` 才播。**严格 `>` 让「重播」在数学上不可能**；唯一边角（同毫秒
  两个运行漏一个）是可接受的 best-effort 漏播，绝不重播。
- **只播终态**：run 级状态 `running | done | failed | cancelled`，人工挂起的 run
  仍是 `running`——不到真结束不播。
- **零 LLM**：运行完成通知是事实转达（工作流 id、状态、抹密原因），不是对成员
  画像的生成式合成。直接从 run 行拼出，不需 provider/key，不烧 token。副作用：
  哪怕 hub 一个管家 LLM key 都没配，播报照样工作（和 S3-M1 提醒转达同一姿态）。
- **best-effort**：投递失败**不推进标记**（那条 + 之后的下 tick 重试，oldest-first
  保证顺序不乱不漏），读故障 fail-closed（标记不动）。burst cap 每 tick 每成员
  最多播几条，其余下 tick 补。
- **DEFAULT-OFF + 不翻旧账**：没有 `run-broadcast.json` 的成员什么都收不到；只有
  `set_run_broadcast`（benign）才写它，且把 `announcedMax` 盖成 `now()`——开启永远
  不倒灌开启前就结束的运行。

环境开关：`GOTONG_BUTLER_RUN_BROADCAST`（默认随管家开），节流
`GOTONG_BUTLER_RUN_BROADCAST_MS`（clamp [1min, 1h]）。

---

## 七、测试矩阵

| 里程碑 | 测试 | 钉死什么 |
|---|---|---|
| BE-M1 | `butler-observe.test.ts`（9） | 三读工具 scoped 本人 / 脱敏投影不漏别人提示词密钥 / fail-closed / surface 缺席掉队 |
| BE-M2 | `butler-diagnose.test.ts`（13）+ `butler-diagnose-e2e.test.ts`（4） | 守边界：advisory `use_local_endpoint` 非 enactable；「N 处我能帮你改」vs「都要你/管理员手动」；e2e 真 `HostMeAgentService` + 真引擎，`edit_agent` 走 governed → 批准 → provider **真切成 anthropic** |
| BE-M3 | `butler-workflow-create.test.ts`（8）+ `butler-workflow-create-e2e.test.ts`（3） | governed 分类 approve / describe 截断 / `cross_hub` 拒为 error / 空指令不调用；e2e 真 `MeWorkflowCreateService`：park → 批准 → 真存草稿 + owner grant + steward 闸不受扰；跨 hub 无 saveDraft |
| BE-M4 | `butler-ask-agent.test.ts`（13）+ `butler-ask-agent-e2e.test.ts`（2） | 5 种 `TaskResult` 各诚实映射 / 两种 output 形状 / no-leak（拒非本人拥有 + 绝不派发；只用本人 userId 问 listOwned）/ 输入守卫 / fail-closed；e2e 真 hub 派发 + 真 `listOwned`：拥有→真跑回复带回；未拥有→拒且 `calls===0` |
| BE-M5 | `butler-run-broadcast.test.ts`（19）+ `butler-run-broadcast-e2e.test.ts`（3） | 去重幂等 / 无翻旧账 / 仅终态 / oldest-first 单调推进 / burst cap / 投递漏 cut-short / 读故障 fail-closed / 多成员 best-effort / opt-in 工具；e2e 真 `WorkflowController.listRunsByUser`：一次播报 → 二次静默 / 失败原因随行 / 跨成员 no-leak |

E2E 一律用**真的成员向 surface**（真 `HostMeAgentService` / 真 `MeWorkflowCreateService`
/ 真 `WorkflowController` / 真 hub 派发），因为 BE 的整个论点就是「管家复用既有
成员 surface」——e2e 钉的正是这条复用真成立，不是 mock 出来的假象。

---

## 八、显式推迟

- **管家侧的诊断也覆盖 `use_local_endpoint` 代改**：需要成员能在 `/me` 配
  openai-compatible baseURL；那是 `MEMBER_PROVIDERS` 的边界问题，不在 BE 叠。
  当前管家对本地端点修复只建议、由运维在 admin RES 面板一键。
- **`create_workflow` 之外的 `edit_workflow` 大白话入口给管家**：成员大白话改
  既有工作流已有 V5-WFEDIT 的 `edit_workflow` governed 路径（S1-M4 已给 MiMo
  接通），BE 只补了「新建」；「改」沿用既有闸，不在 BE 重造。
- **播报可配置文案 / 汇总成日报**：BE-M5 是逐条即时事实转达。攒一天成「今天你的
  N 个运行……」汇总，可复用 S3-M2 每日问候的 composer，但那要 LLM——当前保持零
  LLM 的即时逐条。
- **`ask_my_agent` 的多轮 / 流式**：当前是一次问答（一个 bounded turn，await 回
  复）。多轮对话 / 流式转发是更大的总机语义，未做。

---

## 九、为什么这样切

- **补眼睛先于补手**：BE-M1 三读工具是整条 track 的地基——管家先能**看见** run /
  agent / 用量，后面的诊断（M2）、播报（M5）都建在这个只读投影上，不另开读路径。
- **写永远复用既有闸**：M2 修复用既有 `edit_agent`、M3 建流用既有
  `MeWorkflowCreateService`、M4 派发用既有 `hub.dispatch` + `listOwned`。BE 全程
  **没有新造一条写通道**——validate / 审计 / reconcile / 本地限定 / owner grant
  全套自动适用，不重复实现也不留后门。这是「管家做不出成员做不到的事」能成立的
  结构前提。
- **benign / governed 的判据统一**：读 / 自助内联，代改持久状态 park。同一条线贯穿
  五个里程碑，成员对「什么时候会弹审批」有稳定预期。
- **鸭子 surface + 门控**：web/host 解耦（web 零 host 运行时依赖），surface 缺席
  → 工具掉队 / sweep 不 arm，绝不给打不响的工具。管家的能力面严格等于当前接线的
  surface 集，可观测、可裁剪。
- **播报零 LLM**：把「事实转达」和「生成式合成」分开——运行完成是前者，每日问候是
  后者。前者不该烧 token，也不该因为没配 key 就哑。
