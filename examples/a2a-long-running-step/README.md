# a2a-long-running-step — 一个会**挂起**的外部 A2A agent 当工作流步

> 一个 hub 上的声明式工作流，其中一步调用一个**外部 A2A agent**，但这个 agent **会花时间**——
> 它对 `message/send` 不是一轮回完，而是**挂起**（返回一个 `working` Task：长计算，或它自己的
> HITL）。于是整个工作流 run **挂起**，轮询 `tasks/get` 直到远端 settle，再把裁决喂给下一步。
>
> 这是 [`a2a-workflow-step`](../a2a-workflow-step) 的**长任务姊妹**：那个的外部 agent **一轮回完**
> （run 从不挂起）；这个的外部 agent **挂起**（run 挂起、轮询、续跑）。两者是**同一套能力调度**。

```
                    本 hub (运行工作流)
  ┌─────────────────────────────────────────────┐
  │ workflow: a2a-long-review-and-file          │
  │   review  → cap[external.review]            │
  │   archive → cap[docs.archive]               │
  └─────────────────────────────────────────────┘
        │ ① review 步派 capability
        ▼
  ┌─────────────────────────────────────────────┐     A2A message/send        ┌──────────────────────┐
  │ ext-reviewer                                │ ──────────────────────────▶ │  外部 A2A 审阅 agent   │
  │   A2aRemoteParticipant  (lifecycle 已开)    │     ② working Task(挂起)     │  (第三方, 长计算/HITL) │
  │   cap: external.review                      │ ◀────────────────────────── │                      │
  └─────────────────────────────────────────────┘                            └──────────────────────┘
        │ ③ 子任务挂起带【有限 resumeAt】→ 整个 run 继承它 → 被 sweep 唤醒
        │   ④ 每拍轮询 tasks/get … working … working … completed
        ▼                          (远端 settle 后)
  ┌─────────────────────────────────────────────┐
  │ doc-archive  cap: docs.archive              │  ⑤ 裁决回流 → 本地归档
  └─────────────────────────────────────────────┘
```

## 为什么这是 Stream H 的「显式推迟」收口

Stream H（[`a2a-workflow-step`](../a2a-workflow-step)）只做了**阻塞**情形：外部 A2A agent 一轮
`message/send` 就回一个 Message。它的收口文档（`docs/zh/V5-H-FINAL.md §七`）把这条列为推迟:

> **A2A task 生命周期作为工作流步**: 若外部 A2A agent 是会**挂起**的 AipeHub（返回 Task 而非
> Message），让工作流步等一个会挂起的远端（`a2aSendRaw` + `a2aGetTask` 轮询 + 工作流侧
> suspend/resume）是独立路径，本 Stream 只做 blocking。

**Stream H2 就是那条独立路径。** 而它的核心发现和 Stream H 一样: **机制几乎不需要改**。

## 关键: 长任务的工作流集成是「自动的」(runner / YAML 零改)

让一个**会挂起**的外部 A2A 步把整个 run 也挂起、然后醒来续跑，**不需要碰 runner 或 host**。
靠的是已经 ship 的两块拼图自动咬合:

1. **`A2aRemoteParticipant` 的 lifecycle（opt-in，本例新依赖的 H2-M1）**: 给它传
   `lifecycle: { pollIntervalMs, maxAttempts }`，当远端返回 `working` Task 时，它不再当失败抛，
   而是**用一个有限的 `resumeAt` 挂起自己**（`SuspendTaskError`），carried state 记下
   `peerTaskId` + 轮询计数。`handleResume` 醒来后 `a2aGetTask` 轮询一次: 还 `working` → 再挂起
   （+1 计数，到 `maxAttempts` 就 fail-closed）；`completed` → 返 ok；`failed`/`canceled` → 抛。
2. **工作流 runner 早就会「继承子步的 resumeAt」**: 当一步的 dispatch 返回
   `{kind:'suspended', resumeAt}`，runner 用**那个 resumeAt** 挂起**整个 run**
   （`step-executors.ts` 抓 `record.resumeAt`，`runner.ts` `suspendWorkflow(state, resumeAt)`）。
   醒来时它**重新读子任务的结果**: 还挂起 → 用子任务**新的** resumeAt 再挂起 run；终态 → 把结果
   折进 run 续跑下一步。

所以 host 的那个**普通 suspend/resume sweep**（Phase 11）**同时**把「子任务行」和「run 行」推到
收敛——**零新机制**。一个 `{kind: capability, capabilities: [external.review]}` 工作流步路由到
这个 lifecycle participant，跟路由到任何本地能力**一模一样**——「外部 agent 会挂起」对工作流
作者是**不可见**的。

### 有限 `resumeAt` vs `NEVER_RESUME_AT`——这是和审批闸的关键分水岭

| | 长任务 A2A 步（本例） | 出站审批闸（Stream G）/ inbox（Phase 16） |
|---|---|---|
| 挂起的 `resumeAt` | **有限值**（`now + pollIntervalMs`） | `NEVER_RESUME_AT`（9_999_999_999_000） |
| sweep 会不会唤醒它 | **会**——到点自动轮询 | **不会**——sweep 永远取不到它 |
| 谁来恢复 | **定时器/sweep**（自动轮询远端） | **一个人**在 `/me` 收件箱点批准 |
| 工作流侧要不要两步恢复 | **不要**（同一条 sweep 收敛 run+子任务） | **要**（子 broker 先于父 run，host inbox-service 编排） |

一句话: **会挂起的「机器」用有限 resumeAt（自动轮询）；要「人」拍板的用 NEVER（等收件箱）。**
本例是前者，所以它比跨 hub 审批步**简单**——不碰 inbox、不要两步恢复，纯靠 Phase 11 sweep。

## 这个 demo 证明了什么（确定性，无需 API key，无 socket）

「外部长任务 A2A agent」由一个注入的 `fetchImpl` 扮演（和 `@aipehub/a2a` 单测同一手法）:
`message/send` → 一个 `working` Task；每次 `tasks/get` 推进一个内部轮询计数，**到阈值才**返
`completed`——模拟一个需要时间的远端计算。`now` 钉死成常量、sweep 由 demo **手动**驱动（一个
内联的 sweep 循环，镜像 host 的 resume sweep），所以全程**无真定时器、无 sleep、无 socket**。

三幕（11 条自断言全绿）:

| 幕 | 发生什么 |
|---|---|
| **[A] 挂起** | fire trigger → `review` 步派给外部 agent → 远端**挂起**（working Task）→ `review` 步挂起 → **整个 run 挂起**。**两行**挂起（lifecycle 子任务 + run），**都带有限 `resumeAt`**（可被 sweep 唤醒，**不是** NEVER）。 |
| **[B] 轮询** | 一拍 sweep 唤醒挂起行: 子任务 `tasks/get` → 仍 `working` → **再挂起**；run 重读子任务 → **再挂起**。下游 `archive` **没跑**（远端没 settle）。 |
| **[C] 续跑** | 继续 sweep → 远端 `completed` → 裁决折进 run → 本地 `archive` 步跑 → run `ok`。`archive` **恰好跑一次**，且**只在**远端 settle 之后。 |

## 跑

```bash
pnpm demo:a2a-long-running-step
```

11 条自断言全绿即闭环成立。这个 demo 同时是一个冒烟测试。

## 文件

| 文件 | 作用 |
|---|---|
| `workflows/review-and-file.yaml` | 声明式工作流：`review`（外部 A2A 能力，**会挂起**）→ `archive`（本地能力）。**YAML 里没有任何 agent 端点 / token，也没有「这步会挂起」的标记**——长任务对工作流作者不可见。 |
| `src/demo.ts` | 一个 hub + lifecycle `A2aRemoteParticipant`（注入 fetch 扮会挂起的外部 agent）+ 本地归档 worker + 一个内联 sweep 循环（镜像 host 的 resume sweep）+ 确定性自断言。 |

## 对应的生产组件

| demo 用的 | 生产真东西 |
|---|---|
| lifecycle `A2aRemoteParticipant` + 注入 `fetchImpl` | 同一个 `A2aRemoteParticipant`（`@aipehub/a2a`，`lifecycle` opt-in），`fetchImpl` 用 `global fetch` 调真端点 |
| 内联 sweep 循环（`sweepOnce`） | host 的 Phase 11 resume sweep（`main.ts` `sweepResume`：`listDueSuspendedTasks` → `claimSuspendedTask` → `hub.resumeTask` → 终态才删行） |
| `parked` Map（按 task.id keyed，re-park 覆盖） | identity `suspended_tasks` 表（INSERT-OR-REPLACE，同一 task.id 一行） |
| `EXTERNAL_URL` / `EXTERNAL_TOKEN` 常量 | identity `a2a_outbound_agents` 表（url + `tokenEnv` 从环境变量读 bearer，永不入库）+ admin「联邦」tab 出站 A2A agent 面板（Route B P1-M11） |

## 对比：a2a-workflow-step（阻塞姊妹）vs a2a-long-running-step（本例）

| 维度 | a2a-workflow-step（阻塞） | a2a-long-running-step（本例） |
|---|---|---|
| 外部 agent 的应答 | `message/send` → **Message**（一轮回完） | `message/send` → **working Task**（挂起） |
| 工作流 run | **从不挂起**（一步到底） | **挂起 → 轮询 → 续跑** |
| `A2aRemoteParticipant` | 默认 blocking（拿到 Task 会抛） | `lifecycle` opt-in（拿到 Task 会挂起轮询） |
| 客户端调用 | `a2aSend`（拿文本） | `a2aSendRaw` + `a2aGetTask`（拿 Message\|Task + 轮询） |
| 挂起的 `resumeAt` | 不适用 | **有限值**（sweep 可唤醒） |
| host / runner 改动 | 零 | **零**（同一条 suspend/resume sweep） |
| 共同点 | **都是 capability dispatch；工作流那一步都不点名目的地、也不标「会挂起」；runner / YAML 零改。** | 同左 |

## 验收门（真 socket + 真 sweep）

和示例的分工同 Stream H 先例: **示例**用注入 fetch + 手动 sweep（确定性、可见、教学）；
**验收门** `packages/host/tests/a2a-long-running-step-e2e.test.ts` 用一个**真 loopback A2A
server**（`http.createServer`）背靠第二个真 hub + 一个**生产形态的 `suspendNotifier`** →
真 `IdentityStore`，跑同一条流程: 远端挂起 → run 挂起带有限 resumeAt → 真 sweep 轮询 →
远端 settle → run 续跑、裁决回流。两测: happy（settle 后归档）+ fail-closed（`maxAttempts`
耗尽 → run failed，含 `/failing closed/`）。

## 进阶可叠加（本 demo 故意不做，保持聚焦）

- **per-agent lifecycle 的 admin-UI 配置**: 把 `lifecycle: {pollIntervalMs, maxAttempts}` 落
  identity `a2a_outbound_agents`（加策略列）+ admin「联邦」tab 出站 A2A agent 面板的开关。
  本例 example-first，host `main.ts` 零改（同 Stream H / IM-bridge 先例）——**显式推迟**。
- **per-step 数据分类 / 配额闸**: `A2aRemoteParticipant` 是裸出站边，不过 P4-M4 出站
  data-class / per-link 配额 chokepoint。给长任务 A2A 出站也叠这些闸是后续。

详见 [`docs/zh/V5-H-FINAL.md`](../../docs/zh/V5-H-FINAL.md)（§九 Stream H2）。
