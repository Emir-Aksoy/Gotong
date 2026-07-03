# v5 · Stream H — A2A 外部 agent 当工作流步小结

> 状态: **H 完**（M1 验收门: workflow 步 → 外部 A2A agent，真 loopback HTTP；M2 扩
> 「离开本 hub」检测覆盖 A2A 外部步骤（`kind:'peer'|'a2a'` 判别）;M3 admin UI 区分目的地
> + 诚实「无审批闸」提示;M4 `examples/a2a-workflow-step` 示例 + 本文档 + CLAUDE.md）。
>
> **H2 完**（§九）—— Stream H 推迟的「**会挂起**的外部 A2A agent 当工作流步」做实:
> H2-M1 lifecycle `A2aRemoteParticipant`（opt-in 轮询 `tasks/get`，有限 `resumeAt`）;H2-M2
> 真 socket + 真 sweep 验收门;H2-M3 `examples/a2a-long-running-step` 示例 + 本节 + CLAUDE.md。
>
> **H2-OUT 完**（§十）—— H2 自己列的「显式推迟」之首「per-agent lifecycle 的 admin-UI
> 配置」做实: 把 lifecycle 从 example-only 折进**生产 `a2a_outbound_agents` 配置路径**。
> H2-OUT-M1 identity **v32** `lifecycle` 列;M2 `A2aOutboundManager` 物化时穿 lifecycle;
> M3 web 鸭子 CRUD + admin UI「模式」列/表单/逐行切换;M4 生产路径 e2e（**列即开关**）+ 本节。
>
> Stream G 收口时 §六显式列出 deferred:「编排一个 **A2A** 外部 agent
> （`A2aRemoteParticipant`）作为工作流步骤是独立路径」。Stream H 就是把这条独立路径做实。
>
> commit: H-M1 `0994295` · H-M2 `54c9cff` · H-M3 `de3e308` · H-M4 `（H 收口）`
> · H2-M1 `1681db8` · H2-M2 `4aa5c71` · H2-M3 `（H2 收口）`
> · H2-OUT-M1 `030618e` · H2-OUT-M2 `d63dc34` · H2-OUT-M3 `8ab7ffc` · H2-OUT-M4 本提交
>
> Last updated: 2026-06-07

---

## 一、为什么做（Stream G 的姊妹）

Stream G 把「一个 hub 的工作流编排**另一个 mesh hub**（AipeHub↔AipeHub）的能力」收口。
但工作流的一步还能派给**另一种**目的地: 一个**外部 A2A agent**——第三方服务，走 A2A
`message/send` 协议，不是 mesh 对等 hub。这条边早在 Phase 18 C-M4 就 ship 了
（`A2aRemoteParticipant`），但**从没被当作「工作流的一步」端到端验证过**。

把代码翻一遍发现一件关键事实: **机制根本不需要改**。

> `A2aRemoteParticipant` 是一个**本地参与者**（`extends AgentParticipant`），注册在某个
> capability 下。被派发时它把任务转发到 agent 的 HTTP 端点，把回复变成 `ok` 输出。所以一个
> `{kind:capability}` 工作流步**本来就会**路由到它——runner / scheduler / resolver / YAML
> schema **零改**。

所以 Stream H **不是新机制**，而是三件事:

1. **(H-M1)** 一个验收门，把「workflow 步 → 外部 A2A agent → 回流 → 本地步」证一遍
   （真 loopback HTTP，确定性）——证明上面那句「机制根本不需要改」。
2. **(H-M2)** 把 G2 的「启动前可见性」（哪些步骤离开本 hub）**扩到覆盖 A2A 外部步骤**——
   之前只认 mesh peer。
3. **(H-M3)** admin UI **诚实地区分**两种目的地: mesh 对等 hub **可能**挂起等审批；外部
   A2A agent **无审批闸，立即外发**。
4. **(H-M4)** 一个 host-free 可跑示例 + 本文档。

### 北极星红线（一寸不让）

- **框架不跑 LLM / 不存知识**: 工作流 runner 仍是纯声明式。外部 A2A 那一步对它只是「一个
  capability dispatch」，它根本不知道能力由一条出站 HTTP 边来服务。
- **能力是统一抽象**: 调本地 agent、调 mesh peer、调外部 A2A agent——对工作流是**同一件事**。
  差异只在「目的地的行为」（有没有审批闸），那是 admin 启动前该看见的**可见性**，不是
  runner 该关心的**机制**。

### 与 Stream G 的对比

| 维度 | cross-hub-workflow (Stream G) | a2a-workflow-step (Stream H) |
|---|---|---|
| 目的地 | mesh 对等 hub（联邦链路） | 外部 A2A agent（第三方 HTTP） |
| 协议 | mesh RPC over HubLink | A2A `message/send` over HTTP |
| 审批闸 | **可有**（peer 设 `requireApprovalOutbound`→挂起等批） | **无**（裸注册出站边，立即外发） |
| 出站参与者 | peer wrapper（`installPeerLink`） | `A2aRemoteParticipant`（本地参与者） |
| 共同点 | **都是 capability dispatch；工作流那一步都不点名目的地；runner / YAML 零改。** | 同左 |

---

## 二、H-M1 — 验收门（workflow 步 → 外部 A2A agent）

`packages/host/tests/a2a-workflow-step-e2e.test.ts`（2 测，commit `0994295`）——**整个
Stream 的理由那一个测**。

之前没有任何测试覆盖这个**组合**: 一个声明式工作流的步骤，其能力由一条**出站 A2A 边**
（`A2aRemoteParticipant`）来服务，走**真 HTTP**到一个外部 A2A 端点，再把回复喂回下一个
本地步。

### 2.1 全真栈

- 一个真 `Hub`（hubA，运行工作流）；
- 一个真 `A2aServer`（host 入站端点）架在 `http.createServer` 的 loopback 端口上，背靠
  第二个真 `Hub`（hubB，serving 外部 agent）——**真 socket，不是 mock**；
- hubA 注册一个真 `A2aRemoteParticipant`（cap `external-review`），其 url 指向 hubB 的
  `/a2a`，bearer 是 hubB token resolver 认的那个；
- 真 `WorkflowController` + `WorkflowRunner` 跑 `translate→archive` 形状的工作流。

### 2.2 两条剧情（全绿）

| 剧情 | 断言 |
|---|---|
| **happy** | fire trigger → `fired.kind==='ok'`（**不挂起**——外部 A2A 步无审批闸，一步到底）；run `done`；`review.output === {text:'reviewed: hello'}`（外部 agent 的回复跨真 HTTP 回流）；`archive.filed[0].payload === {note:'reviewed: hello'}`（回流喂进本地步）。 |
| **wrong bearer** | hubA 的 participant 带错 bearer → 外部端点 401 → `a2aSend` 抛 → `review` 步 `failed`，`error` 含 `401`；run `failed`；`archive.filed` 长度 0（halt before archive，fail-closed）。 |

这两条钉死了: **机制本来就能用**（happy），且**外部失败正确 fail-closed**（wrong bearer）。

---

## 三、H-M2 — 扩「离开本 hub」检测覆盖 A2A 外部步骤

**一句话**: G2 的 `crossHubSteps` 检测之前只认 **mesh peer**；H-M2 给每个被标出的步骤加一个
`kind: 'peer' | 'a2a'` 判别，让外部 A2A 步**也**被标为「离开本 hub」，并带上正确的目的地类型。

### 3.1 改动（`packages/host/src/workflow-controller.ts` + `main.ts`，commit `54c9cff`）

- `CrossHubStep` / `PeerCapabilityView` 各加 `kind?: 'peer' | 'a2a'`（缺省视为 `'peer'`，
  legacy 行为零变化）；纯函数 `crossHubStepsOf` 把命中的 peer 的 `kind` 透传到输出。
- `A2aOutboundManager` 加一个**只读** `liveCapabilities()`，返回**当前活跃**的出站 A2A agent
  的 `[{peer, label, capabilities}]`——manager 是「什么 agent 在线」的权威，封装在它里面比
  让 main.ts 去翻 `private source` 干净。
- `main.ts` 的 `peerCapabilities()` 闭包（G2 注入 `createWorkflowController` 的那个）现在
  返回 **mesh peers（`kind:'peer'`）+ A2A agents（`kind:'a2a'`）** 拼起来的列表。

### 3.2 一个**正确性钉死**的细节: 为什么 A2A agent 的 id 必须在 entry 集里

`computeCrossHubSteps` 构 `localCaps` 时会**排除** peer wrapper（id ∈ peerIds），否则
peer 通告的能力会被误当「本地满足」而漏标。**A2A agent 和 mesh peer wrapper 在这点上不同**:

> mesh peer wrapper 是 `installPeerLink` 注册的占位参与者；A2aRemoteParticipant 是一个
> **真·本地注册的参与者**。所以如果不把它的 id 放进 entry 集（`peerIds`），它**自己的能力**
> 会出现在 `localCaps` 里 → 看起来「本地有人能干」→ 永远不被标为跨 hub。

这件事**自动成立**: A2A entry 的 `peer` 字段就是 `agent.id`，和注册的 participant id 一致，
所以它天然进 entry 集、从 `localCaps` 里被排除。H-M2 的两个新单测专门钉这条
（见 §五）。

### 3.3 首个通告该能力的目的地胜——mesh peer 排在 A2A 前

`peerCapabilities()` **故意把 mesh peers 排在 A2A agents 之前**。一个能力若**同时**被一个
mesh peer 和一个 A2A agent 通告，`crossHubStepsOf` 的「首个通告者胜」会把它归给 **mesh
peer**——因为 mesh peer **可能**带审批闸（保守地提示「可能要批」比提示「立即外发」更安全）。

---

## 四、H-M3 — admin UI 区分目的地 + 诚实「无审批闸」提示

**一句话**: 一个离开本 hub 的步骤，目的地是 mesh peer 还是外部 A2A agent，**行为不同**，
admin 启动**前**该看见区别。

### 4.1 改动（`packages/web/*`，commit `de3e308`）

沿用 G2 的**鸭子镜像 + verbatim echo** 屋规（workflows 路由原样回 summary，新可选字段
自然流通，零路由改动）:

- `server.ts` `CrossHubStepView` 加 `kind?: 'peer' | 'a2a'`（pass-through）；
- `admin-src/workflows.js` 卡片 `crossHubPanel` 逐行按 `kind` 出标签:
  `s.kind === 'a2a'` → 「→ **外部 A2A agent**: X」，否则「→ **对等 hub**: X」
  （新 i18n `workflowCrossHubA2a`）；
- `admin-src/main.js` `openWorkflowStart` 把步骤**按 kind 分组**，启动对话框的 `wf-xhub-note`
  分别陈述**诚实行为**——`workflowCrossHubNote` 从 `(n, peers)` 进化成
  `(peerDests, a2aDests)`（单一调用方）:
  - mesh peer 组:「派到对等 hub (X);若对方设了审批闸，需在收件箱批准后才会真正发出」；
  - A2A 组:「派到外部 A2A agent (X);这类步骤**无审批闸，会立即发出**」。
- i18n（zh/en）入 `static/app-core.js`；`pnpm -C packages/web build:assets` 重建并 commit
  git-tracked `static/admin.js` + `src/static-assets.ts`。

**纯可见性，零派发路径改动。** admin 现在点「开始」前就知道:「这一步会立即外发给外部
agent」vs「这一步可能卡在我的收件箱等批准」。

---

## 五、H-M4 — `examples/a2a-workflow-step` 示例 + 文档

### 5.1 示例（host-free，同 cross-hub-workflow 先例）

`examples/a2a-workflow-step/`: 一个 hub 上的声明式工作流，一步派给外部 A2A agent，回流喂进
本地步。只依赖 `@aipehub/core` + `@aipehub/workflow` + `@aipehub/a2a`。

**和 H-M1 验收门的分工**（同 cross-hub-workflow 对 cross-hub-workflow-e2e 的分工）:

- H-M1 验收门用**真 loopback A2A server over 真 socket**——证机制对真 HTTP 成立。
- H-M4 示例用**注入的 `fetchImpl`** 扮外部 A2A agent（不起 socket，同 `@aipehub/a2a` 单测
  手法）——确定性、可见、教学。`fetchImpl` **解析出站 JSON-RPC body 并断言协议形状**
  （method `message/send`、bearer、`metadata.skill`），所以 demo 同时是一个 **A2A 协议冒烟**。

工作流 `workflows/translate-and-file.yaml`: `translate`（外部 A2A 能力 `external.translate`）→
`archive`（**本地**能力 `docs.archive`）——**YAML 里没有 agent 端点 / token**。

8 条自断言全绿（demo 即冒烟测试）: 外部步**不挂起**（无闸立即外发）/ 外部 agent 经 wire
被调（两 run 都外发）/ payload 完整到达 / 出站带 `metadata.skill` / 出站带 bearer / 译文回流
进本地 archive 步 / archive 只跑 happy 那次 / 外部失败时 run fail-closed。

### 5.2 数据流（端到端 ASCII）

```
 本 hub workflow              A2aRemoteParticipant          外部 A2A agent
   │                              (本地参与者)               (第三方 HTTP)
   │ ① dispatch translate          │                            │
   │   cap[external.translate]     │                            │
   │──────────────────────────────►│ ② handleTask:              │
   │                               │   a2aSend(url,token,text) ──►│ ③ message/send
   │                               │       (立即外发, 无闸)       │   (鉴权 + 翻译)
   │                               │  ◄──── agent Message ───────│
   │  ◄── ok output {text} ────────│   reply → {text}            │
   │ ④ archive 步 (本地 cap)                                     │
   │   payload.translation = $translate.output.text             │
   │ run DONE (一步到底, 从不挂起)                                │
```

失败路径: ③ 外部返回 JSON-RPC error（或 401）→ `a2aSend` 抛 → ② `handleTask` 抛 →
`AgentParticipant` 转 `failed` → `translate` 步 failed → 工作流在 archive 前 halt → run failed。

---

## 六、测试矩阵（Stream H 全量）

| 包 / 文件 | 测 | 证什么 |
|---|---|---|
| `host/tests/a2a-workflow-step-e2e.test.ts` (H-M1) | 2 | workflow 步 → 外部 A2A agent（真 loopback HTTP）→ 回流本地步（happy）;错 bearer → 步 failed + run fail-closed |
| `host/tests/cross-hub-steps.test.ts` (H-M2) | 10（+2） | 新增: A2A 外部步标 `kind:'a2a'`;同一能力 mesh peer + A2A 双通告时归 mesh peer（peers 排前）。原 8 测加 `kind:'peer'` 断言 |
| `host/tests/workflow-controller.test.ts` (H-M2) | 34 | G2-M3 断言加 `kind:'peer'` |
| `examples/a2a-workflow-step` (H-M4) | 8 断言 | host-free 确定性 demo + A2A 协议冒烟 |

host 全量套件 712（Stream G day-2 收尾）→ **719** passed（+2 H-M1 + 既有测扩 kind），零回归；
web 818 passed（H-M3 鸭子字段 verbatim echo + UI 渲染 + bundle 重建，零回归）。

---

## 七、显式推迟（保持精简）

- **A2A task 生命周期作为工作流步**: 若外部 A2A agent 是会**挂起**的 AipeHub（返回 Task 而非
  Message），当前 `A2aRemoteParticipant` 用 blocking `a2aSend`（拿到 Task 会抛带 `.taskId`
  的错）。让工作流步等一个会挂起的远端 A2A agent（`a2aSendRaw` + `a2aGetTask` 轮询 + 工作流
  侧 suspend/resume）是独立路径，本 Stream 只做 blocking。
- **出站 A2A agent 的 per-step 数据分类 / 配额闸**: `A2aRemoteParticipant` 是裸出站边，不像
  mesh peer 那样过 P4-M4 出站 data-class / per-link 配额 chokepoint。给外部 A2A 出站也叠这些
  闸是后续（identity `a2a_outbound_agents` 已是持久配置面，可挂策略列）。
- **外部 A2A 步的审批闸**: 本 Stream 的诚实结论是「外部 A2A 步**无**审批闸，立即外发」。若要给
  它**可选**加一个出站审批（复用 Phase 16 inbox，类比 mesh peer 的 `ApprovalGatedParticipant`），
  那是一个独立决策——本 Stream 只**如实呈现**当前行为（H-M3 的诚实提示），不改行为。

---

## 八、约定守则 / 边界

- 一里程碑一小 commit；H-M1 `test`、H-M2 `feat`、H-M3 `feat`、H-M4 `docs(examples)`，括号列
  包名 + `(Stream H-M<n>)`，末尾固定 `Co-Authored-By: Claude Opus 4.8 (1M context)
  <noreply@anthropic.com>`。
- 纯本地 `main`，**不 push**；显式 `git add` 具体文件，从不 `git add -A`，4 个 scratchpad
  永不 commit。
- 无新 schema、无新 workflow YAML 关键字——Stream H 是「把 Phase 18 C-M4 已 ship 的出站 A2A
  边接成『工作流的一步』的完整故事」，并诚实呈现它和 mesh peer 步的行为差异。

**一句话**: 工作流的一步可以调一个**外部 A2A agent**——跟调本地能力、调 mesh peer 是**同一套
capability dispatch**，runner / YAML 零改。差别只在目的地行为: mesh peer **可能**挂起等审批，
外部 A2A agent **无审批闸、立即外发**——而这个差别，admin 在点「开始」**之前**就看得见
（H-M3）。Stream G 的姊妹收口。

---

## 九、Stream H2 — 一个**会挂起**的外部 A2A agent 当工作流步

> 状态: **H2 完**。commit: H2-M1 `1681db8` · H2-M2 `4aa5c71` · H2-M3 本提交。

### 9.1 为什么做（Stream H 自己列的「显式推迟」）

Stream H 只做了**阻塞**情形: 外部 A2A agent 一轮 `message/send` 就回一个 Message（§七第一条
推迟）。但一个外部 A2A agent 可能**会花时间**——它是个会**挂起**的远端（长计算，或它自己的
HITL），对 `message/send` 答一个 `working` **Task** 而非立即 Message（这正是 Route B P1-M8
给 A2A 加的任务生命周期）。让**工作流的一步**等这样一个会挂起的远端，是 Stream H 明说的
**独立路径**:

> 让工作流步等一个会挂起的远端 A2A agent（`a2aSendRaw` + `a2aGetTask` 轮询 + 工作流侧
> suspend/resume）是独立路径，本 Stream 只做 blocking。

**Stream H2 就是那条独立路径。** 而它的核心发现和 Stream H 一样: **机制几乎不需要改**——
只给出站 A2A 边补一个 **opt-in 的 lifecycle 轮询**，工作流侧的 suspend/resume **早就会自动咬合**。

### 9.2 关键: 长任务的工作流集成是「自动的」(host / runner / YAML 零改)

让一个**会挂起**的外部 A2A 步把整个 run 也挂起、醒来续跑，靠两块**已经 ship** 的拼图自动咬合:

1. **lifecycle `A2aRemoteParticipant`（H2-M1，opt-in）**: 传 `lifecycle: {pollIntervalMs,
   maxAttempts}` 后，远端返回 `working` Task 时它不再当失败抛，而是**用一个有限 `resumeAt`
   挂起自己**（`SuspendTaskError`），carried state 记 `peerTaskId` + 轮询计数。`handleResume`
   醒来 `a2aGetTask` 轮询一次: 仍 `working` → 再挂起（+1，到 `maxAttempts` 就 **fail-closed**）;
   `completed` → 返 ok; `failed`/`canceled` → 抛。**override `handleResume`** 正是 L11 守卫要求的
   （默认 `handleResume` 再挂起会 loud fail；override 后 re-park 是合法的「心跳」语义）。
2. **工作流 runner 早就会「继承子步的 resumeAt」**: 一步 dispatch 返
   `{kind:'suspended', resumeAt}` 时，`step-executors.ts` 抓 `record.resumeAt`，`runner.ts`
   用**那个 resumeAt** 挂起**整个 run**（`suspendWorkflow(state, record.resumeAt ?? NEVER)`）。
   醒来时 `refreshSuspended` **重读子任务结果**: 仍挂起 → 用子任务**新** resumeAt 再挂起 run;
   终态 → 折进 run 续跑下一步。

所以 host 的**普通 Phase 11 suspend/resume sweep** **同时**把「子任务行」和「run 行」推向收敛——
**零新机制**。一个 `{kind: capability}` 步路由到 lifecycle participant，跟路由到任何本地能力
一模一样——「外部 agent 会挂起」对工作流作者**不可见**。

#### 有限 `resumeAt` vs `NEVER_RESUME_AT`——和审批闸的关键分水岭

| | 长任务 A2A 步（H2） | 出站审批闸（Stream G）/ inbox（Phase 16） |
|---|---|---|
| 挂起 `resumeAt` | **有限值**（`now + pollIntervalMs`） | `NEVER_RESUME_AT`（9_999_999_999_000） |
| sweep 会唤醒它吗 | **会**——到点自动轮询 | **不会**——sweep 永远取不到 |
| 谁恢复 | **sweep**（自动轮询远端） | **一个人**在 `/me` 收件箱点批准 |
| 工作流侧两步恢复 | **不要**（同一条 sweep 收敛 run+子任务） | **要**（子 broker 先于父 run，host inbox-service 编排） |

一句话: **会挂起的「机器」用有限 resumeAt（自动轮询）；要「人」拍板的用 NEVER（等收件箱）。**
H2 是前者，所以它比跨 hub 审批步**简单**——不碰 inbox、不要两步恢复，纯靠 Phase 11 sweep。

### 9.3 H2-M1 — lifecycle `A2aRemoteParticipant`（`packages/a2a`，commit `1681db8`）

`A2aRemoteParticipant` 加一个 opt-in `lifecycle?: A2aLifecycleOptions`:

- **不传**: 行为零变化——拿到 Task 仍硬失败（阻塞姊妹的 legacy 路径，opt-in 边界）。
- **传**: `handleTask` 改用 `a2aSendRaw`（拿 `Message | Task`）; 是 Message → 立即返 `{text}`;
  是 Task → `settleOrPark`。`pollIntervalMs` 默认 3000（下限 250），`maxAttempts` 默认 20
  （下限 1，**恰好** maxAttempts 次轮询后 fail-closed）。
- carried state（`__a2aLifecycle:1` 版本化 + `peerTaskId` + `attempt`）通过 `SuspendTaskError`
  的 `state` 走 Phase 11 持久化，`handleResume` 读回续轮询——**无漂移**（子任务 id 钉死）。

opt-in 的姿态对齐全仓既有约定（`share_summary` / `share_transcript` / `escalateDanger`）:
**默认行为不变，新能力显式开启。** +8 单测（`packages/a2a/tests/participant.test.ts`）。

### 9.4 H2-M2 — 验收门（真 socket + 真 sweep，`packages/host`，commit `4aa5c71`）

`packages/host/tests/a2a-long-running-step-e2e.test.ts`——**整个 H2 的理由那一个测**。组合三套真
harness: 真 `WorkflowController` 在 hubA; 真 `A2aServer` 架 `http.createServer` loopback 背靠
hubB（**真 socket**）; 真 lifecycle `A2aRemoteParticipant`; **生产形态的 `suspendNotifier`** →
真 `IdentityStore`。一个 hubB 上的 `ExternalLongReviewAgent` 先挂起（NEVER）、resume 时才答
`reviewed: <text>`，模拟会花时间的远端。

| 剧情 | 断言 |
|---|---|
| **happy** | dispatch → `fired.kind==='suspended'`; **两行**挂起（run + 子任务）都带**有限 resumeAt**（< NEVER）; 真 sweep 轮询期间远端仍 working（无进展）; `hubB.resumeTask` settle 远端; 有界 sweep 收敛 → run done; `review.output==={text:'reviewed: hello'}`; `archive.filed==={note:'reviewed: hello'}`; 挂起行清零。 |
| **fail-closed** | `maxAttempts=2`，永不 settle hubB; 有界 sweep → run **failed**，`review.status` failed 含 `/failing closed/`; archive 空; 挂起行清零。 |

### 9.5 H2-M3 — 示例 + 本节（commit 本提交）

`examples/a2a-long-running-step/`（host-free，同 cross-hub-workflow / a2a-workflow-step 先例）:
一个 hub 上的工作流 `review`（外部 A2A 能力，**会挂起**）→ `archive`（本地能力）。只依赖
`@aipehub/core` + `@aipehub/workflow` + `@aipehub/a2a`。

**和验收门的分工**（同 Stream H）: 验收门用真 socket + 真 sweep; 示例用注入 `fetchImpl`（扮一个
`message/send`→working、`tasks/get`→几拍后才 completed 的远端）+ **一个内联 sweep 循环镜像 host
的 resume sweep**（确定性、可见、教学，无真定时器/无 socket）。11 条自断言: 远端挂起 → 整个 run
挂起 / **两行都带有限 resumeAt**（H2 使能点）/ 外部经 wire 被调一次 / payload 完整 / 出站带
`metadata.skill` / `tasks/get` 被轮询到 settle / settle 后 run done / 裁决回流本地 archive 步 /
archive **只在 settle 后跑一次** / 挂起行清零。`pnpm demo:a2a-long-running-step`。

### 9.6 显式推迟（H2）

- ~~**per-agent lifecycle 的 admin-UI 配置**~~ **→ 已做实（§十 H2-OUT）**: 把
  `lifecycle:{pollIntervalMs,maxAttempts}` 落 identity `a2a_outbound_agents`（v32 加策略列）+
  admin「联邦」tab 出站 A2A agent 面板的「模式」开关。H2 当时是 example-first / `main.ts` 零改;
  H2-OUT 把它折进**生产配置路径**（`A2aOutboundManager` 物化时穿 lifecycle，列即开关）。
- **per-step 数据分类 / 配额闸**: lifecycle `A2aRemoteParticipant` 仍是裸出站边，不过 P4-M4
  出站 data-class / per-link 配额 chokepoint（同 Stream H 的推迟，长任务不改变这条）。
- **跨重启的轮询恢复**: 内存 `fetchImpl` 注入是 demo 手法; 生产用 `global fetch` + identity
  持久化 carried state，sweep 跨重启续轮询本就成立——但**在飞**的单次 `tasks/get`（进程内
  Promise）不跨重启，重启后由下一拍 sweep 重发，**幂等**（`tasks/get` 是只读轮询）。

**一句话**: Stream H 做了「外部 A2A agent 一轮回完」的工作流步; H2 做了「外部 A2A agent **会
挂起**」的——而后者**几乎不需要新机制**: lifecycle participant 用**有限 resumeAt** 挂起，整个
run 继承它、被 Phase 11 sweep 自动唤醒轮询 `tasks/get` 直到 settle，再喂给下一步。**和审批步的
分水岭就是那个 resumeAt**: 有限 = 机器自动轮询，NEVER = 等人在收件箱拍板。Stream H 的长任务收口。

---

## 十、Stream H2-OUT — 把 lifecycle 折进生产 `a2a_outbound_agents` 配置路径

> 状态: **H2-OUT 完**。commit: H2-OUT-M1 `030618e` · M2 `d63dc34` · M3 `8ab7ffc` · M4 本提交。

### 10.1 为什么做（H2 自己列的「显式推迟」之首）

§9.6 第一条推迟写的是「per-agent lifecycle 的 admin-UI 配置」。H2 的验收门
（§9.4）**手工构造** lifecycle `A2aRemoteParticipant`，证明了**机制**——但生产里运维**从不**
手写这个 participant: 他们往 `a2a_outbound_agents`（Route B P1-M11a 的 identity 表）加一行，
`A2aOutboundManager`（M11b）把它物化到 hub 上。H2 的 lifecycle 只活在 example / 验收门里，
管理员**够不着**。H2-OUT 把这条独立路径接通: lifecycle 由**存储的配置**驱动，不再是测试里的
字面量，且**那一列就是开关**。

### 10.2 改了什么（四个加性里程碑，纵切一条）

| M | 层 | 改动 | commit |
|---|---|---|---|
| M1 | identity | **v32** 加可空 `lifecycle TEXT` 列（JSON）+ `A2aOutboundLifecycle{pollIntervalMs?,maxAttempts?}` 类型 + `parseLifecycle`（读容忍）/`normLifecycle`（写 fail-visible）+ 8 测 | `030618e` |
| M2 | host | `A2aOutboundManager.tryRegister` 构造 participant 时穿 `...(agent.lifecycle ? { lifecycle: agent.lifecycle } : {})` + 4 测（读 floored 私有字段证穿线） | `d63dc34` |
| M3 | web + host | web 鸭子 `A2aLifecycleInput` + `coerceLifecycle`（CRUD 收）+ host `toView` 投影 `lifecycle` + admin UI「模式」列/表单 checkbox+两数字输入/逐行「改长任务·改阻塞」切换 + 5 测 | `8ab7ffc` |
| M4 | host | 生产路径 e2e（**本节**）+ 本文档 | 本提交 |

**三态语义钉死（列即开关，与 participant 的 `lifecycle?` 选项 1:1）**:

- **`NULL`**（缺省）= **阻塞**（legacy 默认）。未迁移的旧行天然保留旧行为——返回 `working`
  Task 即硬失败。
- **`'{}'`** = lifecycle **开**，用 participant 的 floored 默认（`pollIntervalMs:3000` /
  `maxAttempts:20`）。
- **`'{...}'`** = 调过的具体值（participant 构造时仍 floor: `max(250,·)` / `max(1,floor(·))`）。

`parseLifecycle` 读容忍（坏 JSON / 非对象 → `null` 当阻塞，**绝不**炸 boot）;`normLifecycle`
写 fail-visible（非正数字段 → `invalid_input` 抛）。这跟同表 `capabilities` JSON 列同纪律。

### 10.3 M4 验收门 — `packages/host/tests/a2a-long-running-outbound-e2e.test.ts`（生产路径）

H2-M2（§9.4）证的是机制（手构 participant）;M4 证的是**生产配置边界**——lifecycle 全程由
`identity.addA2aAgent({... lifecycle ...})` 驱动，`A2aOutboundManager.registerAllFromStore()`
物化，没有一行测试代码碰 participant 构造。全真栈: 真 `WorkflowController`@hubA + 真 `A2aServer`
背靠 hubB over loopback http（"外部"agent）+ 真 `IdentityStore`（tmp sqlite）存出站配置 + 真
`A2aOutboundManager` 注册 + 两 hub 生产形态 `suspendNotifier`。sweep 手工驱动（无 30s timer）确定性。

**两条剧情，都钉在存储边界**:

1. **带 `lifecycle` 的行 → 全链路 park→poll→settle**（每个旋钮来自 store）: 触发 → review
   步路由到 store 注册的 A2A participant → `message/send` → 远端**挂起**（`working` Task）→
   participant 挂起 → runner 继承挂起整个 run。断言**两行**挂起（run + lifecycle 子任务）都
   带**有限** `resumeAt`（< `NEVER`，sweep-eligible）→ 远端仍 working 时 sweep 无进展、archive
   不跑 → `hubB.resumeTask` settle → sweep 收敛 → run `done`、`reviewed: hello` 回流喂下游本地
   archive 步。
2. **同一个挂起的远端，经一行 WITHOUT `lifecycle`，硬失败**（**列是开关**）: 完全一样的行只是
   去掉 `lifecycle` → NULL 列 → legacy 阻塞。manager 注册一个阻塞 participant; 对返回 `working`
   Task 的远端，`a2aSend` 抛、步 `failed`、run `failed`（默认 `onFailure=halt`）。断言远端**确实**
   在 hubB 挂起了（它总挂起），但阻塞的调用方放弃了——hubA 上**没有**挂起、下游步**从不**跑。

第 2 条是 M4 相对 H2-M2 的真正增量: 它证明**那一列（不是代码路径）**才是把出站 agent 切进
长任务模式的开关。一个阻塞 agent 对返回的 `working` Task **fail closed**。

### 10.4 对比 H2-M2（机制 vs 生产路径）

| | H2-M2（§9.4，机制） | H2-OUT-M4（§10.3，生产路径） |
|---|---|---|
| lifecycle 来源 | 测试里 `new A2aRemoteParticipant({lifecycle:{…}})` 字面量 | `identity.addA2aAgent({…lifecycle})` 存储行 |
| 注册者 | 测试 `hub.register(…)` | 真 `A2aOutboundManager.registerAllFromStore()` |
| 证明 | 机制能 park/poll/settle | **存储的列**驱动同一行为 + **列即开关**（无列 → 阻塞 fail-closed） |
| `now` 注入 | 注 `now:()=>1_000_000` 确定 resumeAt | manager 不注入 → 真 `Date.now()`（resumeAt 仍有限，sweep 手工驱动只断言 `<NEVER`） |

### 10.5 显式推迟（H2-OUT 后仍未做，承自 §9.6）

- **per-step 数据分类 / 配额闸**: 同 H2——lifecycle 出站边仍不过 P4-M4 chokepoint。
- **跨重启在飞轮询**: 同 H2——单次 `tasks/get` 不跨重启，下拍 sweep 幂等重发。
- **admin UI 内联精调 poll 字段**: M3 的逐行切换是「阻塞 ↔ 长任务（默认）」二态翻转;精确
  `pollIntervalMs`/`maxAttempts` 调值走**重新注册**（同 caps/url，表格无内联字段编辑），添加
  表单已能填初值。

**一句话**: H2 证了「会挂起的外部 A2A agent 当工作流步」的**机制**;H2-OUT 把那个 lifecycle 从
example-only 折进**生产 `a2a_outbound_agents` 配置路径**——运维在 admin「联邦」tab 勾一下「长任务
模式」，那一行的 `lifecycle` 列就成了出站 agent 是否轮询远端 `tasks/get` 的**开关**。机制 → 可配置。

---

## 十一、Item 2 — A2A 出站边过 P4-M4 闸（per-step data-class + 配额 + 可选出站审批）

> 用户「做这两项，一项一项做」的**第二项**（第一项 = 管家 SW-M9 A→D）。本节记 A2A 那半；
> ACP 那半记在 [`V5-ACP-ADAPTER.md`](./V5-ACP-ADAPTER.md)「ACP 出站闸」节。一里程碑一小 commit
> （`f7a772a`→`5812d85`，9 个）。

### 11.1 为什么做（缺口 = 结构上够不着，不是没做）

联邦的**信任契约/隔离**层（data-class 闸 / capability allowlist / 入站配额）早做实且过真 socket
验收（P4-M4 + P1-M9）。但那套闸**全部住在 `RemoteHubViaLink.onTask`**（mesh peer wrapper，
`core/src/participants/remote-hub.ts`）——任务跨 `HubLink` 前最后一道关。

**核实于真实代码的缺口**: `A2aRemoteParticipant`（`packages/a2a/src/participant.ts`）和
`AcpParticipant`（`packages/acp-agent/src/acp-participant.ts`）都 `extends AgentParticipant`，是
**本地参与者**——直接注册在 Hub 某 capability 下，被派发时**就地**转发到外部（A2A=HTTP
`message/send`;ACP=本地子进程 stdio）。它们**永不经过 `RemoteHubViaLink`**，所以 P4-M4 那道
chokepoint 对它们**结构上够不着**。结果: 一个工作流步派到外部 A2A 能力时，runner 已在
`runner.ts:571` 盖好的 `task.dataClasses` **无人校验**，也没有出站配额闸。这正是用户点名的「裸出站
边目前不过 P4-M4 chokepoint」。

### 11.2 做法 = 在叶参与者自己的出站边复用同一组纯函数（防漂移）

不把它们改成「跨 RemoteHubViaLink」（那会改信任模型）。而是**在 A2A/ACP 参与者自己的出站边，
复用同一个 core 纯函数**施加同样的闸——这正是 `RemoteHubViaLink` 自己立的先例（data-class 闸就写
在**发送方参与者**里，不是单独装饰器）。

```
checkOutboundDataClasses(task, allowed)   ← packages/core/src/peer-acl.ts:94
  allowed = null/undefined → 放行（legacy accept-all）
  allowed = []             → 锁死（deny-all）
  allowed = [classes]      → task.dataClasses 逐个比，命中越界即拒
```

mesh 边、A2A 边、（下文）ACP 边用**同一个** `checkOutboundDataClasses`——未来加新
`DispatchStrategy`/新语义三边一起学，**零漂移**（R4 缓解）。

### 11.3 改了什么（A2A 半，5+2+2 里程碑）

- **X-M1**（`f7a772a`，`@aipehub/a2a`）`A2aRemoteParticipant` 构造加
  `allowedDataClasses?: readonly string[] | null` + `outboundQuotaGate?:(task)=>boolean`。
  `handleTask` 顶部（blocking 与 lifecycle 两路**共用入口**，`participant.ts:146`）先
  `checkOutboundDataClasses` → `!ok` 抛 `outbound_data_class_denied:<class>`;再
  `outboundQuotaGate?.(task)` → false 抛 `outbound_quota_exceeded`。闸在 dispatch 时跑一次
  （park 之前）;resume/poll **不重闸**（任务已过关，正确）。**是闸非 redaction**（叶包无 redactor）。

- **X-M3**（`3d4ff18`，identity **v34**）加性 ALTER `a2a_outbound_agents`:
  `allowed_data_classes_json TEXT`（NULL=无契约 / `[]`=锁死 / `[列表]`=白名单）+
  `outbound_quota_budget INTEGER`（NULL/0=无配额 / >0=每窗口最大 send 数）+
  `require_approval_outbound INTEGER NOT NULL DEFAULT 0`。镜像 `lifecycle` 列纪律
  （`parseDataClasses`/`normQuota`: undefined-保留 / null-清空 / 坏值降级 inert）。**无密钥列**。

- **X-M4**（`4c944f3`，host）`A2aOutboundManager` 持
  `Map<id,{limiter:FixedWindowLimiter, budget}>`——复用 peer-registry `linkQuota` 纪律: 一 agent
  一 limiter，**跨 `refresh()` 保留**、仅 budget 变才重建（防 toggle/编辑刷掉配额窗，R3 缓解）;
  把 `allowedDataClasses` + `outboundQuotaGate`（闭包查 limiter）穿进参与者构造。窗口 env
  `AIPE_A2A_OUTBOUND_QUOTA_WINDOW_MS`（镜像 `AIPE_PEER_LINK_QUOTA_WINDOW_MS`）。

- **Y-M1**（`749585f`，host，**最高风险**）A2A 出站审批 = 直接复用 `ApprovalGatedParticipant` 包
  `A2aRemoteParticipant`（其 `GatedOutboundInner` 接口 `{id,capabilities,onTask,onMessage?}` 天然
  满足，是「包一层」不是重写）。`require_approval_outbound=1` 时 `tryRegister` 用 gate 包再
  `hub.register`;approver 缺（无 inbox/owner）→ 持久化但 `approval_unconfigured` **fail-closed**
  不激活（诚实态，admin 红徽章）。⚠️ **D4 lifecycle×审批 resume 碰撞修复**:
  `GatedOutboundInner` 加 `onResume?`;gate `onResume` 里 `extractApproval(state)===null &&
  inner.onResume` → **委托** `inner.onResume(task,state)` 而非盲 re-park——否则一个带 lifecycle 的
  A2A agent 包审批后、批准→外部返 working Task→`inner` 抛 lifecycle suspend（state
  `{__a2aLifecycle}`）→sweep 叫 **wrapper.onResume**→`extractApproval` 取不到→**re-park
  NEVER_RESUME_AT**→轮询永远丢失。对 blocking A2A 无害（无第二次 park）。

- **X-M5 / Y-M2 验收门**（`338b851` / `8488f0e`，确定性 e2e，CI 可跑）:
  - `a2a-outbound-gate-e2e.test.ts`: 真 `WorkflowController`@hubA + 真 loopback `A2aServer` + 真
    `IdentityStore` + 真 manager + **注入捕获 fetch**。禁类任务→fail-closed + 外部端点**从未命中**
    （闸真挡住，非只报错）;放行类→过;配额超预算→fail-closed + budget 跨调用保留。
  - `a2a-outbound-approval-e2e.test.ts`: suspendNotifier→IdentityStore + 两步恢复 + a2a loopback。
    审批 row 派发→park（NEVER_RESUME_AT）+ inbox item + 外部**从未命中**;approve→外部恰一次 +
    结果回流;reject→fail-closed `outbound_approval_denied` + 外部从未命中。**加一条
    lifecycle+审批组合**剧情钉死 D4（批准后第二次 lifecycle resume 委托 inner 不被 gate 吞）。

- **Z-M1/Z-M2**（`caa94ed` / `5812d85`，web）admin「联邦」tab A2A 面板加字段: 单列紧凑「出站闸」
  摘要（data-class 锁死/列表 · 配额预算 · 审批徽章 · `approval_unconfigured` 诚实态）+ 表单 3 输入
  + 行内「改审批/改直发」切换钮（PATCH `requireApprovalOutbound` 翻转;data-class/配额精调走重新
  注册，同 caps/url/poll）;i18n zh/en parity + 重建 static-assets。

### 11.4 A2A vs ACP 的诚实不对称（D6）

| | **A2A 出站** | **ACP 出站** |
|---|---|---|
| 出口性质 | 真·网络（HTTP 到外部端点，可能跨组织/计费） | 本地子进程（Claude Code/Codex 走自己登录态，**非**组织出口） |
| data-class 闸 | ✓（X-M1） | ✓（X-M2，**治理**控制: 约束喂给第三方编码 agent 的上下文类别） |
| 出站配额 | ✓（per-task send 计数） | ✓（跑飞护栏） |
| 出站审批 | ✓ opt-in（Y-M1，复用 `ApprovalGatedParticipant`） | ✗ **已有 per-tool** `dangerousToolGate`→escalate→收件箱（不叠装饰器，D5） |

用户原话点名「A2A/ACP」，故两者都做 data-class+配额，按字面交付;不对称只在文档/注释如实说明。

### 11.5 显式推迟（Item 2 后仍未做）

- **A2A/ACP 出站边的 redaction hook**（P1-M10 `OutboundRedactor` 只接在 `RemoteHubViaLink`;这两边
  先做 fail-closed 闸，redaction 是独立增量）。
- **ACP per-tool 级配额**（现配额是 per-task send 计数，非 per-tool-call）。
- **per-step 粒度的审批**（现审批是 per-agent opt-in，非按工作流步）。
- **A2A 出站 data-class 闸接审批升级链**（现 data-class 违规直接 fail-closed，不转人审批）。
- **peer-summary/账本对这些出站边的 per-agent 计费维度**（沿用现有账本，不加新维度）。

**一句话**: 北极星「工作流跨边界但凭证/数据/计费各归各家」此前只对 **mesh 边**成立;Item 2 把
**同一个 `checkOutboundDataClasses` 纯函数**铺到 A2A/ACP 这两条**裸出站边**，外部 A2A/ACP 步现也受
per-step data-class 闸 + per-agent 出站配额（fail-closed）约束，外部 **A2A** 步可 opt-in 出站审批
（复用 Phase 16/18 收件箱两步恢复）。**对所有出站边成立，不只 mesh。**
