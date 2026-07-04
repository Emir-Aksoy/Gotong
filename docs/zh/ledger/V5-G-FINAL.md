# v5 · Stream G — 跨 hub 工作流编排（北极星 第 2 层收口）小结

> 状态: **G 完**（M1 peer wrapper 通告可编排能力 `remoteCapabilities ← outboundCaps`;
> M2 双 hub 跨 hub 工作流编排 E2E 验收门（走出站审批闸）;M3 `examples/cross-hub-workflow`
> 示例 + 本文档 + CLAUDE.md）。
>
> 用户在 Stream F 收口边界拍板下一方向 = **「跨 hub 工作流编排」**，直接服务北极星
> 第 2 层「跨组织协作」，走 Phase 18 B 出站审批闸路径。
>
> commit: G-M1 `1242e91` · G-M2 `db2650f` · G-M3 `81... (示例+文档)`
>
> **day-2 (G2) 完**（启动**前**可见性: G2-M1 host 检测跨 hub 步骤 `crossHubSteps`;
> G2-M2 admin UI 卡片 + 启动对话框指示; G2-M3 走真 controller 路径的验收测试; G2-M4 本文档）。
> commit: G2-M1 `d27bc5b` · G2-M2 `13dd96c` · G2-M3 `2c3f49c` · G2-M4 本提交。详见 §八。
>
> **day-3 (G2 续) 完**（启动**后**确认: M1 workflow 步记 `executedBy`; M2 host `readRun`
> 用 peer view 解出 `crossHub`; M3 admin 运行详情 step 徽章; M4 扩 cross-hub E2E 验收门;
> M5 本节）。commit: M1 `fa0a06d` · M2 `06ee512` · M3 `29ce654` · M4 `2c2f6cb` · M5 `9396a93`。详见 §九。
>
> **day-4 (G2 续) 完**（启动**后审批闭环**可见性: 一个跨 hub 工作流停在出站审批闸时，运行
> 详情按 step 标「⏸ 等待你批准 → peer X / 去收件箱」，因 run 级 status 仍是 `running`、否则
> 跟还在跑的 run 无从区分。M1 admin run-detail 闭环可见性 + i18n + CSS + 重建 + host e2e
> 契约钉死;M2 本节）。commit: M1 `ba35bb9` · M2 本提交。详见 §十。
>
> Last updated: 2026-06-06

---

## 一、为什么做（北极星 第 2 层的最后一块拼图）

北极星三层:

```
   第 1 层  人 ↔ 自己的 AI / agent              ← 个人 AI 桌面 (已厚)
   第 2 层  人 / agent ↔ 别的人 / agent / 机构   ← 跨组织协作 (本 Stream 收口)
   第 3 层  框架本身                            ← clean / 稳定 / 适配 (一直在守)
```

第 2 层的承诺是「**工作流可跨边界，但凭证/数据/计费各归各家**」。到 Stream F 为止，跨组织
的**底座**全都 ship 了——federation 链路（Phase 4）、per-link 信任契约（Phase 18 / P4 /
Stream C）、出站审批闸（Phase 18 B）、能力 manifest（Phase 18 A）——但有一个**从没被当作
一个完整故事验证过**的缺口:

> 一个 hub 上的**声明式工作流**，能不能把其中**一步**编排到**另一个 hub** 的能力，
> 并且这次跨界要**经过人的批准**？

把代码翻一遍发现两件事:

1. **跨 hub 调度其实「差一点点就能用」**。工作流 runner 派步骤时只是调
   `hub.dispatch({strategy, origin, ancestry, dataClasses})`；`installPeerLink` 把 peer
   （可选审批包装）注册成一个**本地** participant。所以一个 `{kind:capability}` 步骤**本来
   就会**路由到 peer wrapper——**只要 wrapper 通告了那个能力**。

2. **但 wrapper 什么都不通告**。`peer-registry.dialOne` + `installInboundLink` 从来没把
   `remoteCapabilities` 传给 `installPeerLink`，所以 peer wrapper 通告的能力集是空的 →
   任何工作流的能力调度都**永远选不中 peer**。（显式跨 hub 调度则被 P4-M1 出站白名单拒
   ——当 `outboundCaps` 已设。）

所以 Stream G **不是从零造**，而是: **(G-M1)** 接上 `remoteCapabilities` 这根线，
**(G-M2)** 把「工作流父 + 审批闸」这个组合端到端证一遍，**(G-M3)** 示例 + 文档。
**无新 schema，无新 workflow YAML 关键字。**

### 北极星红线（一寸不让）

- **Hub 网络是自由图，不是层级树**: org A 编排 org B 的能力，**不等于** org A 拥有 org B。
  每条 link 独立 trust/policy/capability 契约；个人 hub 可同时连多组织且权限互不串线。
- **人是 Participant，不是「审批 tool」**: 出站审批复用 Phase 16 inbox（cap
  `gotong.human/v1` 的孪生），不发明新的审批原语。
- **框架不跑 LLM / 不存知识**: 工作流 runner 仍是纯声明式，跨 hub 那一步对它只是「一个
  capability dispatch」，它根本不知道能力在远端。

---

## 二、G-M1 — peer wrapper 通告可编排能力（`remoteCapabilities ← outboundCaps`）

**一句话**: per-link 策划的 `outboundCaps` **出站白名单**，**同时**是 peer wrapper 对外
**通告**的能力集——**通告 = 授权**。

### 2.1 改动（`packages/host/src/peer-registry.ts`，commit `1242e91`）

`dialOne` 和 `installInboundLink` 两处，在已有的

```ts
...(row.outboundCaps ? { outboundCaps: row.outboundCaps } : {}),
```

旁边各加一行:

```ts
...(row.outboundCaps ? { remoteCapabilities: row.outboundCaps } : {}),
```

就这一行（×2）。`remoteCapabilities` 是 `installPeerLink` 早就有的入参（peer wrapper
对外通告的能力），此前从 peer-registry 这条路**从没被穿进去**。

### 2.2 设计决策: 通告 = 授权（advertise = authorize）

为什么用**同一份** `outboundCaps` 既当通告又当授权，而不是引入第二个「advertised caps」
字段？

| 选项 | 取舍 |
|---|---|
| **A. 同一份白名单兼任两职（选中）** | `outboundCaps ['X']` → wrapper 通告 `['X']` → 工作流 `{kind:capability, capabilities:['X']}` **路由**到 peer，**且**同一份白名单**授权**这次跨界。零新字段、零漂移面、安全默认（`null`/未设 → 通告空 → legacy peer 行为零变化）。 |
| B. 独立 advertised-caps 字段 | 多一个要维护、要校验、可能和 `outboundCaps` 打架的字段。「我通告了但没授权」或「授权了但没通告」都是 bug 温床。 |

理由全在「**Hub is dumb / capability 是通用的 / 节点尽量轻量 / fail-closed 默认**」。
策划一条 link 的出站能力，**就是**在说「这条 link 上这些能力可被编排」——通告和授权是
**同一个意图**，不该拆成两个旋钮。

### 2.3 验收（`packages/host/tests/peer-capability-advertise.test.ts`，2 测）

照 `peer-policy-acl.test.ts` 的「逐字镜像 peer-registry 穿线」屋规，over inproc HubLink pair:

- `outboundCaps ['greet']` → `from:'workflow:demo-flow'` 的 `{kind:capability,
  capabilities:['greet']}` 调度 → `r.kind==='ok'`，真的跨链路到 receiver 的 agent。
- 无 `outboundCaps`（未设行）→ wrapper 通告空 → 同样调度 → `r.kind==='no_participant'`
  （安全默认: 你没策划的 peer 不可被能力编排）。

---

## 三、G-M2 — 跨 hub 工作流编排验收门（走出站审批闸）

**这是整个 Stream 存在的理由那一个测试**: `packages/host/tests/cross-hub-workflow-e2e.test.ts`
（3 测，commit `db2650f`）。

之前没有任何一个测试覆盖这个**组合**:

- `outbound-approval-e2e.test.ts` 证了**直接 admin 调度**的审批闸（`parentKind='none'`）
  ——从没有 workflow 父。
- `inbox-e2e.test.ts` 证了工作流 `human:` 步的两步恢复——但 broker 返回决定，**不跨 hub
  边界**。
- **G-M2 是两者合一**: 工作流步骤 → 被审批闸挡住的 peer → 跨 hub → 两步 `resumeParent`。
  它能成立**只因为 G-M1 让 peer wrapper 通告了能力**，那一步才路由得过去。

### 3.1 全真栈

- 两个真 `Hub`（over inproc HubLink pair）；
- hubA 经 `installPeerLink` 的 `wrapOutbound` 钩子装真 `ApprovalGatedParticipant`（over 真
  `FileInboxStore`）；
- 生产形状的 `suspendNotifier` 把 park 落到真 `IdentityStore`（tmp sqlite）；
- 真 `WorkflowController` → versioning → 文件 revision/lifecycle store；
- 真 `HostInboxService` 做两步恢复。

工作流是一个普通 `dispatch` 步，它的 capability 恰好解析到一个被审批闸包住的 peer wrapper。
**跨 hub 编排 = 能力住在 peer 上的能力调度**，无新 schema。

### 3.2 三条剧情（全绿）

| 剧情 | 断言 |
|---|---|
| **approve** | fire trigger → `fired.kind==='suspended'`，provider **未**被调；inbox item `kind='approval'` `parentKind='workflow'`；child + parent 两行都钉 `NEVER_RESUME_AT`，sweep 取不到；run `running` + review 步 `suspended`。resolve(approve) → provider 被调**恰好一次**且 payload `{doc:'NDA.txt'}` 完整；run `done`，review 步 output 是跨 hub 结果；parked 行清干净。 |
| **reject** | resolve(reject) → provider **从未**被调；run `failed`，review 步 `failed` 且 `error` 含 `outbound_approval_denied`；两行清干净。 |
| **no approval** | `installCrossHubPeer(false)`（不装闸）→ fire trigger → `fired.kind==='ok'`，无 inbox item，provider 调一次，run `done`。 |

### 3.3 两步恢复的三不变量（从 Phase 16 继承，钉死）

跨 hub 那一步**也**会让工作流自己的 run 挂起（runner 派出 gated 出站任务 → 闸抛
`SuspendTaskError(NEVER_RESUME_AT)` → run 继承挂起），所以 resolve 必须跑**两步恢复**:

1. **`NEVER_RESUME_AT`**: 否则 30s resume sweep 会自动唤醒——只有 `/me` resolve 是唯一恢复者。
2. **子闸严格先于父 workflow**: 父先恢复只会空转重挂（它对子结果的 `taskResult` 查询还是
   `suspended`）。
3. **`parentKind` 从 ancestry 算**（非硬编码）: workflow runner 的 id 前缀是 `workflow:`，
   `ApprovalGatedParticipant.onTask` 据 `task.ancestry.at(-1).by.startsWith('workflow:')`
   判出 `'workflow'` → resolve 跑两步；直接/agent 派发无 workflow 祖先 → `'none'`/`'agent'`
   → 只恢复 wrapper。（这纠正了 Phase 18 plan 草稿「父永不需要恢复」的假设。）

---

## 四、G-M3 — `examples/cross-hub-workflow` 示例 + 文档

### 4.1 示例（host-free，同 cafe-ops / warband-club 先例）

`examples/cross-hub-workflow/`: 两个 in-proc hub，消费 hub 上一个声明式工作流编排一步到
provider hub 的 agent，带出站审批闸。只依赖 `@gotong/core` + `@gotong/workflow` +
`@gotong/inbox`，把宿主机两个组件**内联成可见的 ~40 行**:

- `OutboundApprovalGate` = `host/src/outbound-approval.ts` `ApprovalGatedParticipant` 的最小
  镜像（park inbox item + 抛 `SuspendTaskError(NEVER_RESUME_AT)`；`onResume` 批准→
  `inner.onTask` 跨界，拒绝→`failed(outbound_approval_denied)`）。
- `resolveApproval` = `host/src/inbox-service.ts` `HostInboxService.resolve` 两步恢复的手写
  镜像（与 cafe-ops 的 `resolveHumanStep` **逐行同形**，唯一区别是子 broker 是出站审批闸，
  其批准恢复**跨 hub 边界**而非返回决定）。

真正的跨 hub 链路是真的: `createInprocHubLinkPair` + `installPeerLink`（都来自 core），
真 `parseWorkflow` + `WorkflowRunner`。工作流 `workflows/contract-review.yaml`:
`review`（跨 hub 能力 `legal.contract-review`）→ `archive`（**本地**能力 `legal.archive`）
——**YAML 里没有任何 peer 的名字**。

11 条自断言全绿（demo 即冒烟测试）: 挂起在闸 / parent=workflow / 批准后跑完 / org B 恰好
被调一次且只在批准后 / payload 完整跨界 / 裁决回流到本地 archive 步 / 拒绝 fail-closed /
拒绝从未跨界 / 拒绝在 archive 步前就停 / 两条 inbox item 都已解决。

为什么 host-free: 这是**机制**演示（同 long-running-agent / architect-team / cross-hub-mcp
先例），把它放进 host 会为一个 demo 拓宽 host 的 public API 面（`ApprovalGatedParticipant`
/ `HostInboxService` 都不导出）。内联镜像让机制可见，生产里它们是真 host 组件由
`installPeerLink({wrapOutbound})` + `/me` 点一下批准驱动。

### 4.2 数据流（端到端 ASCII）

```
 org A workflow                peer wrapper (gated)         owner /me            org B
   │                                 │                         │                  │
   │ ① dispatch review               │                         │                  │
   │   cap[legal.contract-review]    │                         │                  │
   │────────────────────────────────►│ ② onTask:               │                  │
   │                                 │   write approval item ──►│ (inbox: pending) │
   │  ◄── SuspendTaskError ──────────│   throw NEVER_RESUME_AT  │                  │
   │ run PARKS (workflow 也挂起)      │                         │                  │
   │                                 │                         │ ③ 批准            │
   │                                 │  ◄── resumeChild ────────│ (两步恢复)        │
   │                                 │ ④ onResume(approved):    │                  │
   │                                 │   inner.onTask ─────────────────────────────►│ ⑤ 处理
   │                                 │  ◄──────────────── org B 裁决 ───────────────│
   │  ◄── resumeParent ──────────────┘    (review.output = 裁决)                    │
   │ ⑥ archive 步 (本地 cap)                                                         │
   │   payload.verdict = $review.output.verdict                                     │
   │ run DONE                                                                        │
```

拒绝路径: ④ `onResume(approved:false)` → `failed(outbound_approval_denied)`，⑤ 永不发生，
parent run 在 review 步 halt → run failed，archive 步永不跑。

---

## 五、测试矩阵（Stream G 全量）

| 包 / 文件 | 测 | 证什么 |
|---|---|---|
| `host/tests/peer-capability-advertise.test.ts` (G-M1) | 2 | `outboundCaps` 通告 wrapper → 能力调度跨 hub 路由 + 授权；无则 `no_participant`（安全默认） |
| `host/tests/cross-hub-workflow-e2e.test.ts` (G-M2) | 3 | 工作流步 → gated peer → 跨 hub → 两步 resumeParent（approve/reject/no-approval 三剧情，全真栈） |
| `examples/cross-hub-workflow` (G-M3) | 11 断言 | host-free 确定性 demo，机制可见 |

host 全量套件 699 → **704** passed（+5：2 G-M1 + 3 G-M2），零回归。

---

## 六、显式推迟（保持精简）

- **per-workflow-step 粒度审批**: 闸在 peer/wrapper 级（整个出站 task），不做「这一步要批、
  那一步不用」的中途 strategy/origin 检查（兔子洞，沿用 Phase 18 B 决策）。
- ~~**启动**后**那一跳的 transcript chain（事后的跨 hub 链路渲染）**~~ — **day-3 已补，见 §九**。
  跑完一个跨 hub 工作流后，运行详情现在按 step 标出它**实际**派到了哪个 peer（从持久化的
  `executedBy` 解析），= 启动**前**预测（`crossHubSteps`）的事后**确认**。
- ~~**跨 hub 工作流的 admin-UI 启动器闭环**~~ — **day-2/3/4 已补齐**。启动器表单本身一直在
  （工作流卡片「开始」→ `openWorkflowStart` → 按能力 `/api/admin/dispatch`，跨 hub 工作流不过
  是「能力恰好住在 peer 上」的普通能力派发）。day-2 加**启动前**预测（哪些步会跨 hub）、day-3
  加**启动后确认**（哪步实际去了哪个 peer）、day-4 加**启动后审批闭环可见性**（停在出站审批闸
  时标「⏸ 等待你批准 → peer X / 去收件箱」，见 §十）。剩下的是**可选打磨**、非正确性缺口:
  ① 在运行详情里直接放一个「批准」按钮（而不是深链跳到收件箱 tab）——出站审批本质是 owner 的
  **成员**动作（北极星「人是 Participant」），故现在落在 `/me` 收件箱而非 admin 复制一份审批
  动作;② 一个更显眼的「一键发起跨 hub 工作流」专用入口（现走通用工作流卡片）。两者都不影响
  「能不能发起 / 看不看得见结果」，只是顺手程度。
- **节点级数据分类 / per-link 配额叠加**: demo 里故意不叠（C-M2 `dataClasses` 出站闸、
  P4-M4 `perLinkQuotaBudget`、C-M1 KB 白名单都能叠在同一个 chokepoint，README §进阶列了）。
- **真实外部 A2A agent 的跨 hub 编排**: 本 Stream 走 mesh link（Gotong↔Gotong）；编排一个
  **A2A** 外部 agent（`A2aRemoteParticipant`）作为工作流步骤是独立路径。

---

## 七、约定守则 / 边界

- 一里程碑一小 commit；G-M1 `feat`、G-M2 `test`、G-M3 `docs(examples)`，括号列包名 +
  `(v5 Stream G-M<n>)`，末尾固定 `Co-Authored-By: Claude Opus 4.8 (1M context)
  <noreply@anthropic.com>`。
- 纯本地 `main`，**不 push**；显式 `git add` 具体文件，从不 `git add -A`，4 个 scratchpad
  永不 commit。
- 无新 schema、无新 workflow YAML 关键字——Stream G 是「把已 ship 的零件接成一个完整故事」，
  不是新功能面。

**一句话**: 跨 hub 工作流编排 = **能力调度，只是那个能力住在另一个 hub 上**。G-M1 让 peer
通告能力（通告=授权），G-M2 证「工作流父 + 出站审批闸」端到端，G-M3 给一个 host-free 可跑
的故事。第 2 层「跨组织协作」——工作流跨得了边界，凭证/数据/计费各归各家——收口。

---

## 八、day-2（G2）— 启动**前**可见性

### 8.1 为什么做（机制能跑 ≠ 人看得见）

Stream G（M1-M3）让跨 hub 工作流编排**能跑**: 一个 `{kind:capability}` 步骤的能力恰好住在
peer 上时，会跨联邦边界、过出站审批闸。但**从 admin 视角看，这件事是隐形的**——admin 在
点「开始」**之前**，无从知道:

> 这个工作流里**哪些步骤会离开本 hub**？派到**哪个 peer**？如果对方设了审批闸，我点
> 「开始」后会不会**卡在收件箱**等批准？

G-M2 的验收门证了机制正确，但那是测试代码里的断言，不是 admin 屏幕上的信息。day-2 补的就是
这块**启动前的可见性**——不是新机制，是把 G-M1 已经在用的那份**真实路由依据**（peer wrapper
通告的能力集 = 工作流调度真正会查的同一个源）投影到 UI。

**严守边界**: 只做**启动前**的「哪些步骤跨 hub / 去哪个 peer」可见性。启动**后**那一跳的
transcript chain（事后渲染跨 hub 链路）仍显式推迟（见 §六）。

### 8.2 G2-M1 — host 检测跨 hub 步骤（`crossHubSteps`，commit `d27bc5b`）

**核心: 复用而非重造。** 检测「一个步骤会不会跨 hub」必须用**和真实路由完全相同的语义**，
否则 UI 提示会和实际行为漂移。两个关键复用:

1. **能力提取**: `extractRequiredCapabilities(strategy)`（`packages/core/src/peer-acl.ts`）
   是入站/出站 peer ACL 共用的「策略 → 所需能力」提取器（capability→其能力集，broadcast→
   其 filter 或 `null`，**explicit→`null`**）。day-2 把它从 core index **re-export**（不是
   复制），让 host 的跨 hub 检测和 ACL 闸**共享同一份语义** → 提示永不偏离真实白名单行为。

2. **peer 通告的能力**: `hub.registry.get(peerId).capabilities` 返回 peer wrapper 通告的
   出站能力集——**正是 G-M1 接通的那根线**（`remoteCapabilities ← outboundCaps`），也**正是
   工作流能力调度真正会查的源**。

`packages/host/src/workflow-controller.ts` 加:

- `WorkflowSummary.crossHubSteps?: CrossHubStep[]`（`{stepId, capability, peer, peerLabel}`）；
- 鸭子注入口 `PeerCapabilityView`（`peerCapabilities()` 返 `[{peer,label,capabilities}]`）——
  host 侧 `main.ts` 在 `createWorkflowController` 注入一个闭包，从 `peerRegistryRef.status()`
  取 **connected** peer，`hub.registry.get(peerId).capabilities` 取其通告能力；
- 纯函数 `crossHubStepsOf(def, localCapabilities, peerEntries)`（module-level，独立可测）:
  遍历每步的 dispatch 能力，**本地有人能干的跳过**（关键: 一个能力本地+peer 都满足时会路由到
  本地，标成「跨 hub」是假警报），peer 通告里命中的标出来（首个通告该能力的 peer 胜）。
- `computeCrossHubSteps` 构 `localCaps` 时**排除 peer wrapper participant**（id ∈ peerIds），
  否则 peer 通告的能力会被误当「本地满足」而漏标。

`ParallelStep` 的分支 stepId 记为 `${step.id}/${branch.id}`；explicit 策略（`{kind:'explicit',
to}`）`extractRequiredCapabilities` 返 `null` → 不参与跨 hub 检测（显式调度有它自己的 P4-M1
出站白名单闸）。

**测**: `packages/host/tests/cross-hub-steps.test.ts`（8 测，纯 `crossHubStepsOf`）+
`workflow-controller.test.ts` 加 3 测走**真 controller 路径**（见 G2-M3）。

### 8.3 G2-M2 — admin UI 卡片 + 启动对话框指示（commit `13dd96c`）

web 沿用**鸭子类型镜像 + verbatim echo** 屋规（admin workflows 路由原样回 summary，新可选
字段自然流通，零路由改动，同 Phase 19 P5 governance 风险徽章先例）:

- `server.ts` `WorkflowSummary` 加 `crossHubSteps?: CrossHubStepView[]`；
- `admin-src/workflows.js` 卡片渲染 `crossHubPanel(steps)`——蓝色 `<details>`（`🔗 跨 hub
  步骤 (N)`），逐行 `stepId → capability → 对等 hub: <peerLabel||peer>`；放在 governance
  风险面板**之前**；
- `admin-src/main.js` `openWorkflowStart` 在启动对话框描述区追加一行 `wf-xhub-note`:
  「本工作流有 N 个步骤会派到对等 hub (peers)。若对方设了审批闸，需在收件箱批准后才真正发出。」
  ——**启动前**就告诉 admin 会发生什么；
- `styles.css` `.wf-xhub` 用**蓝色**（`#f4f9ff`/`#1d5fa8`），刻意区别于 governance 的**琥珀
  色**——语义是「**离开本 hub**」而非「风险」；
- i18n（zh/en）入 `static/app-core.js`（`workflowCrossHubSummary/Peer/Note`）；
- `pnpm -C packages/web build:assets` 重建并 commit git-tracked `static/admin.js` +
  `src/static-assets.ts`。

### 8.4 G2-M3 — 走真 controller 路径的验收测试（commit `2c3f49c`）

不另起重型 transcript-chain（那仍推迟），而是一个**右尺寸**的集成测试，跑**真**的
controller 路径（`importFromText → versioning → summaryFromView → computeCrossHubSteps`），
peer view 当 stub 注入（这个 view 本就是为注入设计的鸭子缝；transport 级双 hub link 已被
`cross-hub-workflow-e2e.test.ts` 覆盖，不重复）:

`workflow-controller.test.ts` 加 3 测（`SUPPLY` 工作流: 本地 `draft-order` 步 + peer-only
`supplier.confirm-order` 步）:

1. 标出 peer 步、不标本地步 → `crossHubSteps == [{stepId:'place', capability:
   'supplier.confirm-order', peer:'supplier-hub', peerLabel:'供货商'}]`；
2. 同一能力**本地也注册**（`local-supplier`）→ `crossHubSteps` undefined（本地满足不算跨 hub）；
3. 无 peer view → `crossHubSteps` undefined（优雅降级，无注入即无指示）。

### 8.5 测试矩阵（day-2 增量）

| 包 / 文件 | 测 | 证什么 |
|---|---|---|
| `core` index re-export `extractRequiredCapabilities` (G2-M1) | — | 共享语义防漂移（已被现有 peer-acl 测覆盖） |
| `host/tests/cross-hub-steps.test.ts` (G2-M1) | 8 | 纯 `crossHubStepsOf`: peer 步标出带 peer+label / 本地步不标 / 本地+peer 双满足不标 / explicit 忽略 / parallel 分支 `${id}/${branch}` / 首 peer 胜 / 空 peerEntries→[] / null label |
| `host/tests/workflow-controller.test.ts` (G2-M3) | +3 | 走真 controller 路径: 标 peer 步不标本地 / 本地满足→undefined / 无 view→undefined |
| `web` (G2-M2) | 零回归 | 鸭子字段 verbatim echo + UI 渲染 + bundle 重建 |

host 全量 712 passed（+8 cross-hub-steps）；workflow-controller 套件 34 passed（+3）；
web 818 passed。零回归。

### 8.6 day-2 一句话

机制（G-M1/M2/M3）让跨 hub 编排**能跑**；day-2（G2）让 admin 在点「开始」**之前**就看见
**哪些步骤会离开本 hub、去哪个 peer、会不会卡审批**——而且这份可见性**复用工作流真正路由
依据的同一个源**（`extractRequiredCapabilities` + peer wrapper 通告能力），所以**提示永不
撒谎**。启动**后**的跨 hub transcript chain 在 day-3 补上（见 §九）。

---

## 九、day-3（G2 续）— 启动**后**确认（哪一步实际去了哪个 peer）

### 9.1 为什么做（预测 ≠ 确认）

day-2 给的是**预测**：对一个工作流定义做静态分析（`crossHubSteps`），在点「开始」前告诉你
「这一步**会**跨 hub、**会**去 peer X」。但跑完之后，运行详情里只有每步的 `status` /
`output` / `subTaskIds`——**看不出某一步到底有没有真的离开本 hub、去了谁**。你只能去翻
transcript 自己推断。day-3 补的就是这块**确认**：把「这一步**实际**在哪个 off-hub 目的地上
跑的」直接记进 run 文件，运行详情按 step 标出来。

一句话对照：**day-2 是发车前的「这趟会经过 X」预告，day-3 是到站后的「这趟确实停了 X」回执。**

### 9.2 设计决策: record-at-dispatch（写进 run 文件），不是 enrich-on-read（读 transcript 推断）

两条路:

1. **读时从 transcript 推断**（enrich-on-read）: 渲染运行详情时去翻 transcript 找跨 hub 帧。
   缺点: transcript 是易失的观测流（会归档/裁剪），事后重建脆;且每次读都要重算。
2. **派发时写进 run（record-at-dispatch）**（**采用**）: workflow runner 在每个简单步拿到
   `TaskResult` 时，把 `result.by`（执行者的 participant id）原样记到 `StepRecord.executedBy`，
   随 run 文件持久化。**状态都是磁盘文件**（北极星第 3 条）: 重启透明、不依赖 transcript、
   一次写多次读。

**关键: `executedBy` 是 peer-AGNOSTIC 的**——它只是个 participant id，workflow 包**永不**知道
联邦的存在。「这个 id 是不是一个 peer（= 一次跨 hub 跳）」由 **host** 在 serve 运行详情时
（`readRun`）拿**当前**的 off-hub 能力视图（`PeerCapabilityView`）去解析。所以同一条 run
可以因联邦视图变化而读成「本地跳」或「peer 跳」，而 workflow 包保持联邦无关。

**为什么 `result.by` 就是 peer id**: 跨 hub 步的能力 dispatch 解析到 peer wrapper
（`RemoteHubViaLink`，id = peer id）。`relabel()` 把回流结果的 `by` 重新盖成 `wrapperId`
（ok / failed / suspended 三种都盖）;出站审批闸 `ApprovalGatedParticipant` 的 `get id()`
又委托给 `inner.id`。所以无论**门控挂起**还是**直达**，跨 hub 步的 `result.by` 都 = peer id。

### 9.3 改动（一里程碑一小 commit）

| M | 包 / 文件 | 改了什么 | commit |
|---|---|---|---|
| M1 | `workflow/src/types.ts` + `runner.ts` | `StepRecord.executedBy?: string`;`runSimpleStep` 在 **ok + suspended** 两分支 `record.executedBy = result.by`（挂起也记，所以停在出站审批闸的 run 立刻就显示目的地）。parallel 分支当时显式推迟，后由 **PB 系列补齐（§十二）** | `fa0a06d` |
| M2 | `host/src/workflow-controller.ts` | `readRun` 用 `PeerCapabilityView` 把每步 `executedBy` 解析成 `crossHub:{peer,peerLabel,kind}`;**读时**派生不回写 run 文件，`enrichRunCrossHub` 只克隆被标注的步（不改 RunStore 读出的 state）;单 hub（无 view）原样返回零成本。新类型 `CrossHubStepRef`/`EnrichedStepRecord`/`EnrichedRunState` | `06ee512` |
| M3 | `web/admin-src/workflows.js` + `static/app-core.js` | 运行详情 step header 加 `🔗 在对等 hub X 上执行` / `🔗 由外部 A2A agent X 执行` 徽章（新 i18n `workflowRunCrossHub(dest,kind)` zh+en，措辞是**确认**「执行」非预测「会去」）;复用 `.wf-xhub-peer` 样式;鸭子 verbatim echo 零路由改;重建 admin.js + static-assets.ts | `29ce654` |
| M4 | `host/tests/cross-hub-workflow-e2e.test.ts` | 扩 G-M2 验收门: controller 挂生产形态 `peerCapabilities` view，三剧情都断言 `executedBy==='hubB'` + `readRun` 解出 `crossHub`（approve: **挂起在闸时**就有 + 完成后仍有;no-approval: ok 分支同步记） | `2c2f6cb` |
| M5 | `docs/zh/ledger/V5-G-FINAL.md` + `CLAUDE.md` | 本节 + §六 把「启动后 transcript chain」从推迟移到已做 + 登记 | 本提交 |

### 9.4 测试矩阵（day-3 增量）

| 包 / 文件 | 测 | 证什么 |
|---|---|---|
| `workflow/tests/runner.test.ts` (M1) | +1 | 简单步从 `TaskResult.by` 记 `executedBy` |
| `host/tests/workflow-controller.test.ts` (M2) | +3 | `readRun` 标 peer 步 / 带 `kind:a2a` / 无 off-hub view 原样不标 |
| `host/tests/cross-hub-workflow-e2e.test.ts` (M4) | 3（强化） | 真跨 hub run 持久化 `executedBy===peer` 且 `readRun` 浮出 `crossHub`（门控挂起 + 同步两路） |

workflow 239 passed（+1）;host 748 passed（+3 controller，e2e 强化）;web 832 passed。零回归。

### 9.5 day-3 一句话

day-2 让你**发车前**看见「这趟会经过哪些 peer」;day-3 让你**到站后**看见「这趟确实停了
哪些 peer」——而且这份回执**写在 run 文件里**（不靠易失的 transcript），peer 身份在**读时**
用当前联邦视图解析，所以 workflow 包始终联邦无关、重启透明。北极星第 3 条「状态都是磁盘文件」
在「谁执行了这一步」这件事上也站住了。

---

## 十、day-4（G2 续）— 启动**后审批闭环**可见性（停在闸上的那一步要人批）

### 10.1 为什么做（「能跑、看得见结果」≠「知道它在等我」）

day-2/3 把跨 hub 工作流的**可见性**补到了：启动前预测哪些步会跨 hub，启动后确认哪步实际去了
哪个 peer。但有一类跨 hub 步会**停下来等人**——目的 peer 设了**出站审批闸**
（`requireApprovalOutbound`，Phase 18 B / Stream G §三）。这时：

- 那一步 `status` 变 `'suspended'`，工作流的 run 跟着挂起（runner 派出 gated 出站任务 → 闸抛
  `SuspendTaskError(NEVER_RESUME_AT)`），**审批 item 落在 owner 的 `/me` 收件箱**，等人点
  「批准 / 拒绝」才两步恢复（Stream G §三）;
- 但 admin 在「工作流」tab 看这条 run，只看到一个干巴巴的 `suspended` step——**没有任何信号
  说「这在等你去收件箱拍板」，也没说去哪拍**。

更刁的是 run 级状态:`RunStatus = 'running' | 'done' | 'failed' | 'cancelled'`，**根本没有
`suspended`**。`suspendWorkflow` 只抛控制流异常、不改 `state.status`，所以一条**停在出站审批
闸上的 run，磁盘上的 run 级状态仍是 `running`**——在运行历史列表里跟一条**还在真跑**的 run
长得**一模一样**。于是「这条 run 其实在等我」这件事，**只有打开运行详情、逐 step 看才可能看出
来**，而且 day-3 之前连 step 级也只标了「去了哪」没标「在等批」。day-4 补的就是这块**审批闭环
的可见性**。

### 10.2 诚实信号: `status==='suspended'` **且** `crossHub` 在 = 停在出站审批闸

不发明新字段、不加新 schema——day-3 的数据已经够判:

> 一个 step **同时** `status === 'suspended'` **且**带 `crossHub`（day-3 从持久化的
> `executedBy` = peer wrapper id 解析出来的），就**无歧义地**是停在出站审批闸上。

（普通本地 HITL `human:` 步也会 `suspended`，但它**没有** `crossHub`;一个跑完的跨 hub 步有
`crossHub` 但**不是** `suspended`。两者**与**起来才是「跨 hub 且在等批」。）这对字段
`cross-hub-workflow-e2e.test.ts` 的挂起剧情**早就两条都断言了**（`parkedReview.status===
'suspended'` + `parkedReview.crossHub` 等于 `{peer:'hubB',…}`），day-4 在那里加了一句注释把
**这对字段钉成 UI 契约**，重构不能悄悄改坏徽章。

### 10.3 改了什么（M1，纯 web UI + 一句 e2e 契约注释）

| 处 | 改动 | commit |
|---|---|---|
| `web/admin-src/workflows.js` `renderWorkflowRunDetail` | **逐 step**: `suspended` + `crossHub` → 琥珀色「⏸ 等待你批准 — 出站到对等 hub X 需在收件箱确认」+ `#home` 收件箱深链（取代 day-3 那枚蓝色「在 X 上执行」徽章——它只在步**离开** suspended 后才诚实）。**run 级**: 任一步在等批 → 顶部琥珀 banner（因 run 级 status 仍是 `running`、扛不住这信号，从 step 记录派生）。 | `ba35bb9` |
| `web/static/app-core.js` | 新 i18n（zh/en）`workflowRunAwaitingApproval(dest)` / `workflowRunGoToInbox` / `workflowRunParkedApproval(dests)` | `ba35bb9` |
| `web/static/styles.css` | `.wf-xhub-await` / `.wf-run-parked-banner` **琥珀色**（= 「需你处理」，对齐 governance 风险琥珀;蓝色留给 cross-hub「离开本 hub / 在 X 上执行」中性信号）+ `build:assets` 重建 `static/admin.js` + `src/static-assets.ts` | `ba35bb9` |
| `host/tests/cross-hub-workflow-e2e.test.ts` | 挂起剧情既有的 `status:'suspended'` + `crossHub` 两断言上加注释，钉成 day-4 徽章的 UI 契约 | `ba35bb9` |

**收件箱深链是 in-app hash 导航**: admin 与 `/me` 收件箱住**同一个 unified SPA**（`app.html`），
收件箱在 `home` tab，运行详情在 `workflows` tab，所以「去收件箱批准」就是 `<a href="#home">`
——同页换 tab，不跨页、不开新窗。

**故意不做（§六「可选打磨」）**: 没在运行详情里直接塞「批准」按钮。出站审批本质是 owner 的
**成员**动作（北极星「人是 `Participant`」）——它该落在 `/me` 收件箱，而不是 admin 面板复制
一份审批权。深链把人送到那个**唯一**的审批处，而非另造一个。

### 10.4 测试矩阵（day-4 增量）

| 包 / 文件 | 测 | 证什么 |
|---|---|---|
| `host/tests/cross-hub-workflow-e2e.test.ts` | 3（注释强化） | 挂起剧情同时断言 `status:'suspended'` + `crossHub`——day-4 徽章正是据这对字段渲染 |
| `web`（M1 UI + 重建） | 832 passed | 鸭子 verbatim echo 零路由改 + i18n/CSS/bundle 重建零回归 |

web 832 passed;host cross-hub-workflow-e2e 3 passed。零回归。无新 schema / 路由 / 运行时依赖
——纯 day-3 数据上的一层 UI。

### 10.5 day-4 一句话

day-2 预告「会经过哪些 peer」、day-3 回执「确实停了哪些 peer」、day-4 把**停在出站审批闸上**
那一种「停」从一个看不出名堂的 `suspended` 升级成「**⏸ 在等你去收件箱拍板 → peer X**」——
因为 run 级状态压根没有 `suspended`，这条 step 级信号是**唯一**能把「在等我」和「还在跑」分开
的依据。跨 hub 工作流的**发起 → 看见会跨 → 看见去了哪 → 看见在等我批 → 去批**这条闭环，到此
admin 侧全程可见。

---

## 十一、day-5（G2 续）— 启动**后执行轨迹**链（对方那一跳里到底干了什么）

### 11.1 为什么做（确认「去了哪」≠ 看见「在那干了什么」）

day-3 让你看见跨 hub 步**实际去了哪个 peer**（`executedBy` → `crossHub` 徽章）、day-4 让你看见
它**停在出站审批闸上等你批**。但这一步真正在对方 hub 上**执行起来之后**——它的 task、result、
agent 的真实 LLM 流、resume 标记——在发起方这边仍是一个**黑盒**:你只拿到最终 `output`（result
回流当步输出），看不到对方那一跳的**执行轨迹**。day-5 补的就是这最后一环:**按需**把对方 hub
里那**一个** task 的 transcript 拉回来，把跨 hub 那一跳的执行过程**接**进本地运行详情，而不是
停在结果上。

这是整个 Stream G「可见性」叙事的收尾:**发起 → 会跨谁（day-2）→ 去了哪（day-3）→ 在等我批
（day-4）→ 对方那跳干了什么（day-5）**。

### 11.2 设计: opt-in + fail-closed + 隐私范围按构造收窄

轨迹比 day-3 的「去了哪」**敏感得多**——它是 agent 在一个 task 上的**实际工作**，不只是个目的地
名。所以共享是**每链路 opt-in、默认关、fail-closed**，**镜像 `peer.summary`**（E5）而非像
`peer.manifest`（公开能力名）那样开放:

> `peer.transcript { taskId } → PeerTranscriptSlice`，由 `denyPeerTranscriptRpc`（peer-registry
> 装上）把守:对端 peer 行的 `share_transcript`（identity **v27**）没置位就**拒**。一个从不翻这开关
> 的 hub，对外**一点轨迹都不漏**。

**隐私范围按构造收窄，不靠运行时过滤的善意**:slice 只携**调用方派出的那一个 task** 的事件
（`task` / `task_result` / `llm_stream_chunk` / `task_resumed` / `evaluation`，按 id 匹配）。对方
hub **自己的子派发**跑在**不同的 task id** 下，按单一 `taskId` 过滤就把它们**排除在外**——slice
里**根本没有地方**放邻居更深的那一跳。调用方本来就发了 payload、收了 result;**新增的只是那段
轨迹**。

关联键是 **`peerTaskId`**:对方 hub 在**它自己的** transcript 里记这个 task 用的 id。跨 hub 步
派出去时（M1）在 **relabel 之前**盖到结果上、（M2）记进 workflow `StepRecord.peerTaskId`，查轨迹
时（M4 consumer）把它原样递回去。

### 11.3 改了什么（一里程碑一小 commit）

**后端（M1-M5、M7，day-5 早先做完）:**

| 处 | 改动 | commit |
|---|---|---|
| `protocol` + `core` peer-link-install | 跨 hub 结果携 `peerTaskId` 关联句柄（relabel 前盖上） | `a1cfecf` |
| `workflow` runner | `StepRecord.peerTaskId` 记录该句柄（ok + suspended 两分支都记） | `9f5c876` |
| `identity` | `peers.share_transcript` opt-in 列（**v27**，加性默认 0 = fail-closed） | `04d9758` |
| `host/src/peer-transcript.ts` | `peer.transcript` RPC：producer（`buildTranscriptSlice` 按单 taskId 过滤 + 事件上限 + `truncated`）+ `denyPeerTranscriptRpc` opt-in 闸 + consumer（`fetchPeerTranscript`） | `990440e` |
| `host` `WorkflowController.fetchPeerStepTranscript` + `web` 路由 | `GET /api/admin/workflows/runs/:run/steps/:step/peer-transcript`（host 从持久化的 `executedBy`+`peerTaskId` 解析链路、调 opt-in RPC，回鸭子判别 `{ok,slice}` / `{ok:false,code}`）+ peer CRUD 收 `share_transcript` | `8be361a` |
| `host/tests/...transcript-chain...e2e` | 端到端拉对方 transcript（真链路 + opt-in 闸） | `2f9b972` |

**UI（M6，本次——把链「看得见」的最后一环）:**

| 处 | 改动 | commit |
|---|---|---|
| `web/admin-src/workflows.js` `renderWorkflowRunDetail` | 跑在 **mesh peer**（非外部 A2A——那种无 `peer.transcript` RPC）且**已不再 parked** 的跨 hub 步加「查看对方执行轨迹」按钮;点击**懒**拉路由，把对方 `PeerTranscriptSlice` 内联渲染（按时序逐事件、`data` 原样），或渲染本地化的 fail-closed 原因（对端没开共享 → `fetch_failed` / `no_link` / `not_cross_hub`）。懒触发保运行详情轻、绝不替用户扇出没要的 RPC。 | `3c67ca7` |
| `web/static/peer-admin-ui.js` 信任契约编辑器 | `share_transcript` opt-in 勾选框（镜像 `share_summary`，默认关 fail-closed）——同一条链的**生产者**侧;后端 M5 早就解析/回传了这字段，这里补上**缺的那个开关** | `3c67ca7` |
| `web/static/app-core.js` + `styles.css` | 新 i18n（zh/en）`workflowRunPeerTranscript*`;**中性蓝** CSS（= 同一跳的链，不是告警——区别于 day-4 审批的琥珀色）+ `build:assets` 重建 `static/admin.js` + `src/static-assets.ts` | `3c67ca7` |

**接线细节**:查看器按钮带 `data-run-id`+`data-step-id`（**无** `data-id`），故接在第一个点击委托
的 **id-less 段**（在 `!id` 守卫**之前**，同 `add-agent-grant` 先例）;按钮**纯文本**让
`e.target`（该委托直读 `dataset` 不走 `closest`）正好落在按钮上。输出 div 是按钮的兄弟
`.wf-peer-tx-out`，按 `parentElement.querySelector` 取到，**无需** stepId 选择器转义。

### 11.4 测试矩阵（day-5）

| 包 / 文件 | 测 | 证什么 |
|---|---|---|
| `host/tests/...transcript-chain...e2e`（M7 `2f9b972`） | 端到端 | 真链路上 opt-in 闸放行 → consumer 按 `peerTaskId` 拉回那一个 task 的 slice |
| `host/tests/cross-hub-transcript-chain-ws-e2e.test.ts`（P1-M2 `1cb49db`） | 2 | 同一条链跑在**真 WebSocket** 上（opt-in 闸 + 真 socket） |
| `web`（M6 UI + 重建 `3c67ca7`） | 845 passed | 鸭子 verbatim echo 零路由改 + i18n/CSS/bundle 重建零回归;typecheck 干净 |

web 845 passed、typecheck 干净。M6 **零路由 / 零 host / 零 schema 改**——纯把 day-5 早先做完的
后端链**接到 admin UI 上看得见**。

### 11.5 day-5 一句话

day-3 说「这步去了 peer X」、day-4 说「它停在 X 的审批闸等你批」、day-5 说「**点开看 X 在这步上
到底干了什么**」——按需把对方 hub 里那一个 task 的执行轨迹（task / result / LLM 流 / resume 标记）
拉回来内联进运行详情。共享**每链路 opt-in、默认关、fail-closed**，slice **按构造**只含那一个
task 的事件（邻居更深的跳在不同 task id 下，没地方塞）。跨 hub 工作流的**发起 → 会跨谁 → 去了哪
→ 在等我批 → 去批 → 对方那跳干了什么**这条可见性闭环，到此**全程**走通。

---

## 十二、PB（G2 续）— parallel 分支的 per-branch 执行者记录（扇出的每一路去了哪）

### 12.1 为什么做（一个值标不了一次扇出）

day-3/day-5 的 `executedBy` / `peerTaskId` 是 **step 级单值**——简单步恰好一个执行者，够用。
但 `parallel:` 步把一步扇出给 N 个参与者：有的留本地、有的跨 hub，「这一步去了哪」对扇出
**没有**一个诚实答案。day-3 当时显式推迟（彼时已交付的跨 hub 工作流都是简单步）；PB 把同一套
「去了哪 + 那跳干了什么」叙事补到**每一路分支**上——否则一条混合扇出的 run 里，跨 hub 那路
分支既不显示目的地、也拉不回对方轨迹，day-2~5 的可见性闭环对 parallel 步是断的。

### 12.2 设计：镜像简单步那对字段，按 branch id keyed

- workflow 包仍 **peer-agnostic**：`StepRecord.branchExecutedBy?: Record<branchId,string>` /
  `branchPeerTaskIds?: Record<branchId,string>` 只是裸 participant id + 不透明句柄；「哪个 id
  是 peer」照旧由 host 在**读时**解析（PB-M2 `branchCrossHub`，只含 off-hub 分支——本地分支
  **缺席**而非塞 null 条目）。
- 三个记录点 = 分支结果落地的三条路（`step-executors.ts` 共享 helper `recordBranchExecutor`）：
  ① `applyBranchOutcome` ok（同步完成）② 同函数 suspended 分支（**停在出站审批闸的分支
  parked 时就已写 executor**——跟 day-3 简单步「挂起也记」同语义，run 一挂起 UI 就能标
  目的地）③ `refreshSuspended` 恢复折叠 ok（审批通过后折回的真结果才带 `peerTaskId`——
  闸在**跨界之前** park，对方 task 尚不存在，句柄 parked 期间诚实缺席）。
- step 级 `executedBy`/`crossHub` 对 parallel 步**保持 undefined**——一个值标不了扇出，
  不写比写个误导值诚实。
- 轨迹链按分支收窄：`fetchPeerStepTranscript(runId, stepId, branchId?)` 第三参指名一路分支，
  读它自己的 executor + handle；web 路由 `?branch=` 透传；admin 运行详情每个跨 hub 分支
  一枚徽章 + 各自的「查看对方执行轨迹」按钮（`data-branch-id`）。

### 12.3 改动（一里程碑一小 commit）

| M | 包 / 文件 | 改了什么 | commit |
|---|---|---|---|
| PB-M1 | `workflow/src/types.ts` + `step-executors.ts` | `StepRecord.branchExecutedBy?` / `branchPeerTaskIds?`（按 branch id keyed，全可选加性）+ `recordBranchExecutor` 在三个落地点记录（ok / parked / resume-fold） | `e3b5973` |
| PB-M2 | `host/src/workflow-controller.ts` | `enrichRunCrossHub` 逐分支解析出 `EnrichedStepRecord.branchCrossHub`（只含 off-hub 分支）；`fetchPeerStepTranscript` 加 `branchId?` 第三参（named branch 读 per-branch maps，未给沿用 step 级字段；未跨的/不存在的分支→`not_cross_hub` 软判） | `85009ac` |
| PB-M3 | `web/src/workflow-routes.ts` + `admin-src/workflows.js` + `main.js` + `app-core.js` + `styles.css` | 路由读 `?branch=`（URL-decoded）当第三参透传；运行详情 parallel 步逐分支渲染跨 hub 徽章（i18n `workflowRunBranchCrossHub` zh+en）+ per-branch 轨迹查看器；`.wf-xhub-branches`/`.wf-xhub-branch` CSS + 重建 admin.js/static-assets.ts | `e9d3584` |
| PB-M4 | `host/tests/parallel-branch-cross-hub-e2e.test.ts` | 验收门（见 12.4）+ 本节登记 + CLAUDE.md G 行更新 | 本提交 |

### 12.4 验收门（PB-M4）+ 测试矩阵

`parallel-branch-cross-hub-e2e.test.ts` —— 整个 PB track 存在就为过的那一个测：真双 Hub +
inproc link + 真 `ApprovalGatedParticipant` + 生产形态 `suspendNotifier`→真 IdentityStore +
真 `WorkflowController`/`HostInboxService`/`peer.transcript` RPC，一个 parallel 步两路分支
（`local` 留本地、`remote` 只有 peer 能服务），三剧情把三个记录点一次钉死：

1. **gated**：fire→run 挂起；**parked 时**断言 `branchExecutedBy=={local:'a-archivist',
   remote:'hubB'}`（suspend-path 记录点——没跨界就已标目的地）+ `branchCrossHub` 只含
   `remote` + step 级 `executedBy`/`crossHub` undefined + `branchPeerTaskIds.remote`
   undefined（对方 task 还不存在）；批准→两步恢复→run done，resume-fold 记录点把
   `peerTaskId` 折进来（非空 string），`fetchPeerStepTranscript(runId,'fan','remote')` 经真
   链路拉回 slice 且 `slice.taskId === branchPeerTaskIds.remote`；`'local'`/`'nope'`/
   `undefined` 三种目标全部 `not_cross_hub` 软判。
2. **un-gated**：同步 ok 一次过（ok-path 记录点），同样的 per-branch stamps + 轨迹拉取。
3. **reject**：拒绝→provider **从未**被调（fail-closed）、run failed 带
   `outbound_approval_denied`，**而 local 分支已成的输出 + 归属保留**——拒一路不抹别路。

| 包 / 文件 | 测 | 证什么 |
|---|---|---|
| `workflow/tests/runner.test.ts`（PB-M1） | +1 | 扇出一路跨界：per-branch 归属分裂、句柄只在跨 hub 分支、step 级 executedBy 缺席 |
| `host/tests/workflow-controller.test.ts`（PB-M2） | +2 | 逐分支 enrichment + per-branch 轨迹定位 |
| `web/tests/workflow-peer-transcript-route.test.ts`（PB-M3） | +2 | `?branch=` URL-decoded 透传 / 缺省 undefined |
| `host/tests/parallel-branch-cross-hub-e2e.test.ts`（PB-M4） | 3 | 三记录点端到端（parked 标目的地 / fold 带句柄 / 拒一路不抹别路）+ per-branch 轨迹链 |

workflow 244 / host 907+3 / web 889。零回归。

### 12.5 PB 一句话

简单步的「去了哪 + 那跳干了什么」是一对 step 级单值；parallel 步是一次扇出，PB 把同一对
字段按 branch id 复数化（记录在 workflow 包、解析在 host 读时、呈现在 admin 逐分支徽章 +
逐分支轨迹查看器），**停在出站审批闸的那路分支 parked 时就标出目的地**，跨 hub 可见性闭环
从「每一步」细化到「每一路」。
