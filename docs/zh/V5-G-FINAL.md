# v5 · Stream G — 跨 hub 工作流编排（北极星 第 2 层收口）小结

> 状态: **G 完**（M1 peer wrapper 通告可编排能力 `remoteCapabilities ← outboundCaps`;
> M2 双 hub 跨 hub 工作流编排 E2E 验收门（走出站审批闸）;M3 `examples/cross-hub-workflow`
> 示例 + 本文档 + CLAUDE.md）。
>
> 用户在 Stream F 收口边界拍板下一方向 = **「跨 hub 工作流编排」**，直接服务北极星
> 第 2 层「跨组织协作」，走 Phase 18 B 出站审批闸路径。
>
> commit: G-M1 `1242e91` · G-M2 `db2650f` · G-M3 本提交
>
> Last updated: 2026-06-04

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
  `aipehub.human/v1` 的孪生），不发明新的审批原语。
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
provider hub 的 agent，带出站审批闸。只依赖 `@aipehub/core` + `@aipehub/workflow` +
`@aipehub/inbox`，把宿主机两个组件**内联成可见的 ~40 行**:

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
- **跨 hub 工作流的 admin-UI 启动器**: 本 Stream 只证机制；从 admin UI 点一个跨 hub 工作流、
  看跨 hub 步骤的 transcript chain，是后续 UI 工作。
- **节点级数据分类 / per-link 配额叠加**: demo 里故意不叠（C-M2 `dataClasses` 出站闸、
  P4-M4 `perLinkQuotaBudget`、C-M1 KB 白名单都能叠在同一个 chokepoint，README §进阶列了）。
- **真实外部 A2A agent 的跨 hub 编排**: 本 Stream 走 mesh link（AipeHub↔AipeHub）；编排一个
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
