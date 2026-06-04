# v5 · Stream H — A2A 外部 agent 当工作流步小结

> 状态: **H 完**（M1 验收门: workflow 步 → 外部 A2A agent，真 loopback HTTP；M2 扩
> 「离开本 hub」检测覆盖 A2A 外部步骤（`kind:'peer'|'a2a'` 判别）;M3 admin UI 区分目的地
> + 诚实「无审批闸」提示;M4 `examples/a2a-workflow-step` 示例 + 本文档 + CLAUDE.md）。
>
> Stream G 收口时 §六显式列出 deferred:「编排一个 **A2A** 外部 agent
> （`A2aRemoteParticipant`）作为工作流步骤是独立路径」。Stream H 就是把这条独立路径做实。
>
> commit: H-M1 `0994295` · H-M2 `54c9cff` · H-M3 `de3e308` · H-M4 本提交
>
> Last updated: 2026-06-04

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
