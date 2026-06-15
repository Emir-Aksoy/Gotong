# Hub Steward（管家）— 用大白话管理 hub 设置的智能体

> OpenClaw / Hermes 式体验，落在 AipeHub 北极星上：**框架只提议，人审阅 / 执行；
> 危险 + 跨 hub 动作走 Phase 16 收件箱二次确认**。
>
> 里程碑 SW-M1 → SW-M8 全清。一里程碑一小 commit。Last updated: 2026-06-14。

---

## 一句话

成员在 `/me` 成员 SPA 里用大白话跟一个智能体说话（「给我建一个总结邮件的助手」
「把处理工单那个工作流改得更礼貌些」「删掉那个助手」），管家把意图解析成**一个结构化
提议**，host 服务端**重新分级**后执行：安全的内联跑，**危险（删 agent）/ 跨 hub（改跨 hub
工作流）进收件箱等人二次确认**，敏感的（凭证 / peer / 安全 / RBAC）拒绝并指路。管家**不
自己执行写**、不跑工具循环、绝不静默自改——执行**完全复用**已有的成员服务
（`HostMeAgentService` + `MeWorkflowEditService`），它们自带 RBAC + 成员限制 + 跨 hub 出入口锁，
所以管家在**构造上**做不到「成员自己点那两个面板做不到的事」。

---

## 二、为什么做

用户要的是 OpenClaw / Hermes 那种「在浏览器里用大白话跟一个智能体说话，它就帮你把 hub
的各种设置配好」的体验。现状缺口：仓库已有

- `WorkflowAssistantAgent`（自然语言 → 工作流 YAML，Phase 13）
- `MeWorkflowEditService`（大白话改工作流，含出入口锁，v5 WFEDIT）
- `HostMeAgentService`（成员自助建 / 管 agent，v5 A-M2）

但**没有一个统一的对话入口**把它们串起来——成员得自己点进不同面板填表单。管家把这些
**已有的成员服务**包成一个聊天框。

### 北极星对齐（管家区别于 OpenClaw「Developer Mode 自己写自己存」的地方）

1. **框架不跑自治决策。** 管家**提议**（draft），人**审阅并执行**；危险 / 跨 hub 动作走
   Phase 16 收件箱**二次确认**。管家绝不静默自改。
2. **人是 `Participant`。** 二次确认 = 派一个 Task 给审批 broker → 挂起 → 人在 `/me` 收件箱
   拍板 → 恢复执行，复用既有 inbox，不发明新「审批 tool」。
3. **聊天输入是不可信的「数据」不是「权威」（ClawWorm 教训）。** 管家解析意图 → **分级** →
   对每个副作用都过闸：安全的内联执行，危险 / 跨 hub 的进收件箱，敏感的拒绝并指路。
4. **结构上不越权。** 管家执行**完全复用** `HostMeAgentService` / `MeWorkflowEditService`——
   这两个服务自带 `resource_grants` RBAC（viewer < editor < owner）+ 成员限制（无内联 key、
   provider 必须有 key、每人上限 20、跨 hub 出入口锁）。纵深防御天然成立。

### 用户拍板的两条硬约束（逐字，已落地）

> 「但是要注意**跨 hub 间的工作流需要再次确认，危险动作都再次确认**。」

它们落在 `dangerous`（delete_agent）+ `cross_hub`（改跨 hub 工作流）两个 tier，**必走收件箱
二次确认**。SW-M8 的 e2e 验收门**就是**这两条的回归门。

### 用户拍板的范围

- **入口 = 先浏览器**（IM 后补）。
- **MVP = 档 1：agent + 工作流**（管家可读 / 建 / 改成员 agent + 复用 WFEDIT 改工作流；
  凭证 / peer / 安全这类敏感项管家**只读 + 建议**，所有写都交人确认 → `refuse`）。

---

## 三、动了什么（SW-M1 → SW-M8）

| M | 交付 | commit |
|---|---|---|
| SW-M1 | `@aipehub/hub-steward` 包脚手架 + 提议 / 动作类型（`StewardAction` 判别联合）+ 纯分类器 `classifyStewardAction` | `d36dd80` |
| SW-M2 | `HubStewardAgent extends LlmAgent`（cap `hub:steward`）+ 系统 prompt（内嵌 action schema + 两条硬规则）+ `parseProposal`（JSON 三级降级抽取）| `eaf0663` |
| SW-M3 | host `HostStewardService.plan()` + `HubStewardSurface` + 包注册（`resolveStewardConfig` 读 env，缺 key 跳过注册 → web 503）| `af88b7d` |
| SW-M4 | `HostStewardService.apply()` 安全路径执行器 + `performStewardAction()` 单一执行 chokepoint | `daf2a7d` |
| SW-M5 | `StewardApprovalBroker`（cap `aipehub.steward.exec/v1`）+ 危险 / 跨 hub → 收件箱审批（**两条硬约束**）| `daf2a7d` |
| SW-M6 | web 鸭子 `MeHubStewardSurface` + 路由 `POST /api/me/steward/plan` + `/apply`（userId 服务端强制）| `934b414` |
| SW-M7 | 统一 SPA「管家」面板（home tab，tier 徽章 safe 绿 / dangerous 红 / cross_hub 琥珀 / forbidden 灰）+ 重建 static-assets + 24 个 i18n key zh/en parity | `934b414` |
| SW-M8 | host e2e 验收门 `hub-steward-e2e.test.ts`（真 Hub + 生产 suspendNotifier→真 IdentityStore + 真 FileInboxStore + 真 `HostMeAgentService` + 真 `MeWorkflowEditService` + 真 broker）+ main.ts 接线 + 本文档 + CLAUDE.md | 本提交 |

---

## 四、关键设计决策

### D1 — 管家 = 「结构化提议」分类器，不是 tool-loop agent

仿 `WorkflowAssistantAgent`（emit 结构化输出）而非 `DispatchToolset`（tool 循环）。
`HubStewardAgent extends LlmAgent` 吃【大白话指令 + host 注入的用户资产快照（owned agents +
workflow catalog，含 `crossHub`）】→ 输出**一个 `StewardProposal`**（JSON：一句回话 + 一组
`StewardAction`）。**不自己执行写**，不跑工具循环——最简、可用 mock provider 确定性测、与
WorkflowAssistantAgent 同源。

改工作流**不**让管家自己写 YAML：它只产出 `{kind:'edit_workflow', workflowId, instruction}`，
执行时转交 `MeWorkflowEditService.edit()`（那里面已有自己的 WorkflowAssistantAgent + 出入口锁）。

### D2 — propose → apply 两调用，分级二次确认

`plan`（LLM 解析，**零副作用**）返回提议供人**预览**；`apply`（纯 host 逻辑，**不**碰 LLM）
对**服务端重新分级**后执行。**永不信客户端传来的 tier**——`apply` 内 `validateStewardAction`
+ `classifyStewardAction` 是权威。

### D3 — 四级分类（服务端权威，保守默认）

| tier | 哪些动作 | 确认强度 |
|---|---|---|
| `safe` | create_agent / edit_agent / 改**纯本地**工作流 / inspect（只读答疑）| 一次（预览 → apply）|
| `dangerous` | **delete_agent** | **二次**（预览 → apply → 收件箱审批）|
| `cross_hub` | 改**跨 hub** 工作流（snapshot 的 `crossHub===true`）| **二次**（同上）|
| `forbidden` | 凭证 / peer / 安全 / RBAC grant 等（LLM 应 emit `refuse`）| 拒绝执行，指路 |

两条硬约束就落在 `dangerous` + `cross_hub` 必走收件箱二次确认。跨 hub 判定来自 snapshot 的
`crossHub`，而 snapshot 的 `crossHub` 来自 `WorkflowSummary.crossHubSteps`——**与 WFEDIT 编辑器
的出入口锁 + admin「离开本 hub」启动前可见性同源不漂移**。

### D4 — 危险 / 跨 hub 走「审批 broker」复用既有两步恢复

`StewardApprovalBroker`（cap `aipehub.steward.exec/v1`，id `aipehub:steward-exec`，仿
`ApprovalGatedParticipant`）：`apply` 把 action 派给它 → `onTask` 写 approval `InboxItem` +
抛 `SuspendTaskError(NEVER_RESUME_AT, state={inboxItemId})` 挂起 → 人在既有 `/me/inbox` 批 / 拒 →
`HostInboxService.resolve` → `resumeChild` 注入 `{answer}` → broker `onResume`：**批准 → 走同一个
`performStewardAction()` 执行；拒绝 → fail-closed 啥也不做**。

parentKind = `'none'`（直接派发非工作流），故只 `resumeChild` 无 `resumeParent`。安全的内联
执行和审批后执行**共用同一个 `performStewardAction()` 执行 chokepoint**——每个写都从那一处
委托到成员服务，RBAC + 限制只在一处兜底。

### D5 — 入口 = 统一成员 SPA `app.html`（浏览器优先的天然家）

管家面板放进 `app.html` / `app.js`（home tab，紧挨「我的 AI 助手」+「最近运行」），危险 /
跨 hub 审批落**同一 SPA 的收件箱 tab**（深链 `#home` 直达，复用 Phase 16/19 inbox）。operator
用成员 SPA 时见到**同一面板**（operator 也有 session userId + 自己的成员 agent）。

**显式诚实边界**：MVP 管家管的是**调用者自己拥有的**成员 agent / 工作流；「operator 经
admin.js 控制台用管家管全站资产」需要 operator 执行器（走 `LocalAgentPool` + admin 工作流
路由，另一套执行器）= **SW-M9 快速跟进**，不在 MVP。

---

## 五、数据流端到端

```
成员在 /me 输入「删掉那个总结邮件的助手」
  │
  ▼  POST /api/me/steward/plan { instruction }            （userId 服务端强制）
host HostStewardService.plan(userId, instruction)
  │   ├─ 建快照: meAgents.listOwned(userId) + workflows.listForUser(userId)
  │   ├─ dispatch hub:steward → HubStewardAgent（LLM）
  │   └─ parseProposal → StewardProposal { reply, actions:[{kind:'delete_agent', agentId}] }
  │       每个 action 附 host 算的 tier（这里 = dangerous）
  ▼  200 { proposal }
SPA 渲染提议: 红色 dangerous 徽章 + 「提交审批」钮（非「执行」）
  │
  ▼  POST /api/me/steward/apply { action }                （tier 不信客户端）
host HostStewardService.apply(userId, action)
  │   ├─ validateStewardAction(action) → 合法
  │   ├─ classifyStewardAction → dangerous
  │   └─ 有 inbox → dispatch aipehub.steward.exec/v1 给 broker
  │         broker.onTask: 写 approval InboxItem(parentKind='none')
  │                        + 抛 SuspendTaskError(NEVER_RESUME_AT)
  │         suspendNotifier → identity.persistSuspendedTask（NEVER → sweep 永远取不到）
  ▼  200 { status:'pending_approval', inboxItemId }
SPA: 「已送你的收件箱待确认」+ 深链 #home（收件箱 tab）
  │
  ▼  人在 /me 收件箱点「批准」: POST /api/me/inbox/:id/resolve {decision:{kind:'approval',approved:true}}
HostInboxService.resolve
  │   ├─ validateDecision（approval 必须 {kind:'approval', approved:boolean}）
  │   ├─ markResolved（pending→resolved race 守卫）
  │   ├─ resumeChild: hub.resumeTask(broker, task, {...state, answer:decision})
  │   │     broker.onResume: answer.approved → performStewardAction(userId, action)
  │   │                       → meAgents.remove(userId, agentId)   ★ agent 真没了
  │   └─ resumeParent: parentKind='none' → no-op
  ▼  done
```

**拒绝路径**：`approved:false` → broker `onResume` fail-closed，`performStewardAction` 从不调用，
agent 仍在（e2e 钉死）。

---

## 六、复用的现成件（没重造）

| 需要 | 复用 | 路径 |
|---|---|---|
| LLM agent 基类 + 结构化输出 + provider/key 解析 | `WorkflowAssistantAgent` + host wiring | `packages/workflow-assistant/*`, `host/src/workflow-assist-agent.ts` |
| 成员 agent 执行器（create/update/remove + listOwned + RBAC + 限制）| `HostMeAgentService` | `host/src/me-agent-service.ts` |
| 工作流大白话编辑执行器（含出入口锁 + 行 diff + `crossHub` 判定）| `MeWorkflowEditService.edit()` / `.editableView()` | `host/src/me-workflow-edit-service.ts` |
| 审批 broker 形状（写 inbox item + 挂起 + onResume 执行）| `ApprovalGatedParticipant` | `host/src/outbound-approval.ts` |
| 两步恢复（子 broker，race 守卫，注入 `{answer}`）| `HostInboxService.resolve` / `FileInboxStore` | `host/src/inbox-service.ts`, `packages/inbox/*` |
| 挂起控制流 + 持久化 + 恢复入口 | `SuspendTaskError` / `SuspendNotifier` / `Hub.resumeTask` | `packages/core/src/{suspend,scheduler,hub}.ts` |
| 跨 hub 检测（与启动前可见性同源不漂移）| `WorkflowSummary.crossHubSteps` | `host/src/workflow-controller.ts` |
| web 鸭子 surface 注入 + `/me` 路由 + 服务端强制 userId | `handleMeRoute` / `resolveV4Auth` | `packages/web/src/me-routes.ts` |

钉死：`HostMeAgentService` 只有 `create/update/remove`（无独立 start/stop——成员 agent 建即活），
故 MVP agent 动作 = create / edit / delete（delete = 唯一危险成员 agent 动作）；用户口述的
「启停」不映射成员服务，**显式推迟**。`MeWorkflowEditService.edit()` 对跨 hub 出入口本就抛
`boundary_locked`——管家改跨 hub 工作流即使过了收件箱审批，出入口仍被字节级锁住 = 双重保护。

---

## 七、main.ts 接线（SW-M8，加性）

`hubSteward` 在 `serveWeb` 之前构造，gated on `stewardConfig && meAgentAdmin && meWorkflowEdit
&& identity`（缺任一 → null → `/api/me/steward/*` 503）：

```ts
const stewardConfig = resolveStewardConfig()
const hubSteward = stewardConfig && meAgentAdmin && meWorkflowEdit && identity
  ? createHubStewardService({
      hub,
      config: stewardConfig,
      agents: meAgentAdmin,                 // HostMeAgentService（满足 StewardAgentDirectory）
      workflows: stewardWorkflows,          // listAll() 过 editor-grant 过滤 + crossHub from crossHubSteps
      workflowEditor: meWorkflowEdit,       // MeWorkflowEditService
      inbox: inboxStore,                    // 有 → 危险/跨 hub park 在 broker；无 → needs_approval
      orgApiPool,
      logger: log,
    })
  : null
// serveWeb({ ...(hubSteward ? { hubSteward } : {}) })
```

`stewardWorkflows` 适配器把 `WorkflowController.listAll()` 过 `identity.hasResourceGrant('workflow',
id, userPrincipal(userId), 'editor')` 过滤，`crossHub` 从 `(s.crossHubSteps?.length ?? 0) > 0` 派生
——和 WFEDIT 编辑器锁的、admin「离开本 hub」预览标的是**同一个** `crossHubSteps`。

---

## 八、运维须知（env）

| env | 默认 | 作用 |
|---|---|---|
| `AIPE_STEWARD_PROVIDER` | `anthropic` | 管家 LLM provider（`anthropic` / `openai` / `mock`）|
| `AIPE_STEWARD_MODEL` | provider default | 管家模型 |
| `AIPE_STEWARD_MAX_TOKENS` | provider default | 单次提议最大 token |
| `AIPE_STEWARD_DISABLED` | `false` | 设 `1` 关停管家（不注册，路由 503）|

key 走 `orgApiPool → env` 链；缺 key 就**跳过注册** → web 在 `/api/me/steward/*` 返 503，
SPA 管家面板优雅隐藏。配额：成员经 `/me` 调用有 `task.origin` → 照 Phase 17 计账；
operator free-ride（同 WorkflowAssistantAgent「admins are operators」）。

---

## 九、测试矩阵

| 包 / 文件 | 数 | 覆盖 |
|---|---|---|
| `hub-steward/tests/classify.test.ts` | — | 四级分类表 + `authorizeAgentAction` 兜底 |
| `hub-steward/tests/agent.test.ts` | — | parseProposal happy / garbage / refusal + round-trip |
| `host/tests/steward-plan.test.ts` | 5 | mock provider 跑通快照 → 提议 |
| `host/tests/steward-apply-safe.test.ts` | 8 | 安全建 / 改执行、forbidden 拒、危险返 needs_approval |
| `host/tests/steward-apply-gated.test.ts` | 6 | 危险 delete 挂起在 NEVER_RESUME_AT + 不在 due-list；批准 → 执行；拒绝 → 未执行 |
| `host/tests/hub-steward-e2e.test.ts` | 6 | **SW-M8 验收门**（见下）|
| `web/tests/steward-routes.test.ts` | 18 | plan / apply、401 未授权、status → HTTP 映射 |

### SW-M8 e2e 验收门（两条硬约束的回归门）

真 Hub（真 Space）+ 生产 suspendNotifier → 真 IdentityStore tmp sqlite + 真 FileInboxStore +
真 `HostMeAgentService`（FakeLifecycle for spawn）+ 真 `MeWorkflowEditService`（真
WorkflowController + 真 WorkflowAssistantAgent with mock LLM）+ 真 `StewardApprovalBroker` +
真 `HostInboxService` 两步恢复。六个剧情：

1. plan → safe create_agent → `apply` 真建出 owned agent（space.agents + owner grant + lifecycle.started）。
2. ★ plan → delete_agent → `apply` **挂起在 NEVER_RESUME_AT** + sweep 取不到 + 写了 inbox approval
   item（parentKind='none'）+ agent 仍在。
3. ★ **批准** → agent 真没了（space.agents false + grant 清 + lifecycle.removed + 行清干净）。
4. ★ **拒绝** → agent 仍在（fail-closed）。
5. ★ 跨 hub 工作流 edit → `apply` 挂起 tier=cross_hub（仍 rev1）→ **批准** → 落 rev2，出口
   `supplier.confirm-order` 字节不变（出入口锁双重保护）。
6. forbidden（改 peer 信任策略）→ refused，啥也没 park。

全量：**host 954 passed | 1 skipped**（live 测无 key 跳过），零回归。

---

## 十、显式推迟（MVP / SW-M8 当时）

> 下面 1 / 4 / 5 已由 **SW-M9 能力扩展**（Phase A / B / C，见[§十二](#十二能力扩展sw-m9--operator-全站执行器--敏感写--结果感知多步)）落地；保留原文以记录「MVP 推迟 → 后续交付」的弧线。

1. ✓ **已交付（Phase A）** — admin 控制台管家 + operator 全站执行器（**走现有 admin 写路径**，非裸
   `LocalAgentPool`）。
2. **IM 入口**（管家 transport-agnostic，IM 桥后补，复用 Phase 12 bridge）= **Phase D（example-first，待做）**。
3. 成员 agent「启停 / 暂停」（成员服务无此动作）。
4. ✓ **部分交付（Phase B）** — 凭证 / peer / 安全的**写**已做实（operator-only，每写必过收件箱，
   永不携明文密钥）；**RBAC grant 的写**仍推迟。
5. ✓ **已交付（Phase C，语义收窄）** — **结构化多步 + 结果感知**（非自治循环）已做实；**自治 tool-loop**
   仍明确**不做**（北极星：框架不跑自治决策）。
6. 工作流 lifecycle 转移（publish / deprecate / archive）经管家——MVP 只 create / edit agent +
   edit workflow，lifecycle 留 admin 面板。

---

## 十一、风险与缓解

- **R1 LLM 幻觉一个「安全」动作其实有害**：分类器服务端权威且保守（非 safe 默认升危险 /
  forbidden）+ 成员服务自身 RBAC / 限制兜底（碰不到没授权的 agent、无内联 key、每人上限）+
  危险 / 跨 hub 必过收件箱人审。纵深防御。
- **R2 聊天输入即注入面（ClawWorm）**：管家从不把指令当权威——只解析 → 提议 → 分级 → 过闸；
  每个写都人确认（safe 一次 / 危险二次）；prompt 显式「你只能提议危险动作」。
- **R3 L11 防 re-suspend**：broker 永远 override `onResume` 消费 `{answer}`，缺决策 → fail 非 re-park。
- **R4 两条硬约束回归**：SW-M8 e2e **就是**那两条的验收门 + 分类器单测双层钉死，改坏即红。

---

## 十二、能力扩展（SW-M9）— operator 全站执行器 + 敏感写 + 结果感知多步

> MVP（SW-M1→M8）是 member-facing「成员用大白话管**自己**的资源」。能力扩展把它推到三件事：
> operator **用大白话管全站** + 最高危**敏感写** + **结果感知多步**。三条决策（用户锁定）：① 范围
> = 四项全做，按 **A → B → C → D** 杠杆+依赖顺序；② 多步语义 = **结构化多步 + 结果感知，绝不
> 自治执行循环**；③ 敏感写 = 凭证 + peer + 安全三族**全开**，但**仅 operator**、当**最高 tier
> 每个写必过收件箱**（比 `delete_agent` 更严）。Phase D（IM 入口）是 example-first transport，单独做。

### Phase A — operator 控制台管家 + 全站执行器（A-M1 → A-M8）

**operator 管家 = 复用 `createHubStewardService` + 参数化 id**，**不是** payload 标志。privilege 边界
必须是「**注册的 participant 身份 + 建它的 host surface**」，绝非成员可伪造的聊天/payload 字段
（聊天输入不可信）。两实例 id 隔离、逐字节不撞：

| | agent id | capability | broker id |
|---|---|---|---|
| 成员 | `hub-steward` | `hub:steward` | `aipehub:steward-exec` |
| operator | `hub-steward-operator` | `hub:steward:operator` | `aipehub:steward-exec:operator` |

**执行器走现有 admin 写路径**（非裸 `LocalAgentPool`、非成员 `MeWorkflowEditService`），三个新 host 件：

- `host/src/operator-agent-service.ts` `HostOperatorAgentService` — 满足 `StewardAgentDirectory`：全
  operator provider 集（`lifecycle.availableProviders()`）、站点级 id（admin 给、按 `agents-routes.ts`
  校验）、列 `space.agents()` **全部**托管 agent。结构上满足目录契约 → 直接掉进 `performStewardAction`
  **零改**。建/删复用 `space.upsertAgent`/`removeAgent` + `lifecycle.start`/`stop`/`onAgentRemoved` +
  `seedAgentOwner`/`removeAllAgentGrants`（即 `agents-routes.ts` 那几个调用）。
- `host/src/operator-workflow-edit-service.ts` — 复用 `MeWorkflowEditService.edit` 管线**只去掉 RBAC
  那一行**（`hasWorkflowGrant`），**保留 `enforceEditBoundary`**：跨 hub 出入口锁是**治理契约非成员
  专属**，operator 也**不能静默重指向 egress**。
- `host/src/operator-workflow-directory.ts` — 站点级 `WorkflowController.listAll()` 标
  `crossHub:(crossHubSteps?.length??0)>0`，**去掉** per-member grant 过滤。

**审批落 operator 自己的 `/me` 收件箱（跨 SPA 深链）**。admin 控制台**零** `/api/me/inbox` 渲染机制，
自建内联审批 = 重造两步恢复 UI。北极星「人是 Participant」→ 二次确认属于**人的收件箱**，不论哪个
SPA 发起。`StewardApprovalBroker.onTask` 按 `payload.userId` 写 item，operator surface 强制 userId =
认证的 operator → 落他自己收件箱；admin 控制台渲染「已送你的 /me 收件箱二次确认 →」深链。

web `admin-steward-routes.ts`：`POST /api/admin/steward/{plan,apply}`，`requireAdmin` +
`resolveActor(req).userId` **服务端强制** operator userId（绝不取 body）。**v3-only Space admin 无 user
row** → gate 在 `resolveActor(req).userId` 存在，否则 503 清晰提示（无收件箱可 park）。

A-M7 e2e（`host/tests/operator-steward-e2e.test.ts`）+ main.ts 在成员管家旁构造 operator 管家、注入
operator surface。剧情：站点级 `create_agent` 内联建 / ★站点级 `delete_agent` park 进 **operator 的
/me 收件箱**（operator broker id 恢复它自己的 broker）批/拒 / ★跨 hub 工作流 edit park 批准落新修订、
egress 字节不变。**= SW-M9 落地。**

### Phase B — 敏感写 operator-only 必过审批（B-M1 → B-M4）

**最关键安全决策：敏感写永不携带明文密钥——动作只带环境变量名**（照 `tokenEnv` / `headerEnv` 先例）。
四族动作词汇（`hub-steward/src/types.ts`）：

```
{ kind: 'set_credential_ref',  provider, envVarName, label? }   // 注册 provider 凭证，密钥读 env
{ kind: 'revoke_credential',   credentialId }                   // 删一条已存凭证
{ kind: 'set_peer_policy',     peerId, allowedDataClasses?, perLinkQuotaBudget?, shareSummary?, ... }
{ kind: 'set_security_quota',  scope, metric, period, limit }
```

链路：管家提议「注册 provider X，密钥读 env `FOO_KEY`」→ operator 在主机环境**带外**设 `FOO_KEY` →
**执行器**（`host/src/steward-sensitive.ts`，唯一持明文者）apply 时解析 `process.env[envVarName]` →
`identity.createVaultEntry({ secret })`。**提议 JSON / apply body / 收件箱 item / transcript /
`history[]` 永不含明文——只有 env 名。** `validateStewardAction` 对这些 kind **拒任何形似密钥字段**
（`secret`/`apiKey`/`token` 直接 drop）。peer / 安全动作**天然无密钥**（peer policy 列是非密 JSON；
quota 是数值）。

**分级（双闸：分类器 + 依赖注入纵深）**：敏感 kind 在 **member ctx 分 `forbidden`**、**operator ctx
分最高 tier**（每个写**永远走 broker**，绝不内联）。接 `authorizeAgentAction` 兜底（`authorityVerbFor`
把每个敏感 kind 映射 `modify_owner_grant`/`change_security` 让 `AGENT_HUMAN_CONFIRM_ACTIONS` 升级）。
成员管家**从不注入**这三族敏感依赖 → 即便分级漏了也**碰不到**（纵深防御）。

### Phase C — 结构化多步 + 结果感知（C-M1 → C-M3，非自治）

语义 = 「**propose → 人 applies → echo OUTCOME 回 → propose next**」，**绝不自治执行循环**（守北极星）。
**零新 transport**——复用 SPA 已持的 `history[]`（WFEDIT-D3 先例，stateless across HTTP）。

- **C-M1** — `StewardTurn` 加可选净化 `result?`。host `plan` 时 `sanitizeStewardHistory` 把**白名单**
  结果折成**确定性一行**：`[执行结果] <kind> <mark> <label> → <subject>`。**host 是渲染权威**——client
  只供白名单 `{kind,status,subject}`，**绝不**渲染自由文本。label 表：`done` = `✓ 已执行` /
  `pending_approval` = `⏳ 已送收件箱待确认` / `refused` = `✗ 已拒绝(超出范围)` / `invalid` =
  `✗ 动作无效`。保留**最后 8 turns**，content 裁 2000 / subject 裁 200；折完是 `{role,content}` 普通
  turn（result 已折进 content）→ **agent 零改**，它只读 role+content。
- **C-M2** — SPA（成员 `app.js` + operator 面板）`apply` 后追加 `result` 进 `history[]`；web 共享
  `coerceStewardHistory`（`me-routes.ts` + `admin-steward-routes.ts` 同一「丢未知」纪律）。
- **C-M3** — e2e 两步链条（`hub-steward-e2e.test.ts` +2）：① **create ✓ → 下一 plan 携上一步 done
  结果 → 提议 `edit_agent` 接它**（确定性断言链条 + 真改 `managed.system`）；★② **负向**：history
  **无** outcome turn → 管家**拒绝链接、提议 NOTHING**（不假设自己提的步骤真跑了 = 北极星不自治）。
  mock provider 的哨兵 = host 对 done 结果渲的**确切串** `create_agent ✓ 已执行`（**区别于** prompt
  里教格式用的示例 `create_agent ✓ → mailer`，无 `已执行`）→ 证明**只在 host 真折了执行结果时才链**，
  而非匹配到 prompt 自己的格式说明。

### 测试矩阵（SW-M9 增量）

| 文件 | 覆盖 |
|---|---|
| `host/tests/operator-steward-e2e.test.ts` | Phase A 验收门 — 站点级 create 内联 / delete park 进 operator 收件箱批拒 / 跨 hub edit park 批准落修订 egress 不变 |
| `host/tests/hub-steward-e2e.test.ts`（+2） | Phase C 链条 — create ✓ → 携结果 → 提议 edit_agent；★无结果 → 拒绝链接（不自治） |
| `hub-steward/tests/classify.test.ts`（扩） | Phase B 分级 — 敏感 kind member→forbidden / operator→最高 tier；`authorityVerbFor` 兜底 |
| `web/tests/{steward-routes,admin-steward-routes}.test.ts` | A 路由 gate + C 共享 `coerceStewardHistory` shape-coerce |

全量回归：**host 1014 passed | 1 skipped**（live 测无 key 跳过），零回归。

### SW-M9 后仍显式推迟

- **Phase D — IM 入口**（example-first，复制 `examples/im-bridge-host/`，host main.ts 不动）：`/steward
  <text>`→plan、`/apply <n>`→apply，审批 park 异步通知回 IM。**待做。**
- **RBAC grant 的写**经管家（Phase B 只做凭证 / peer / 安全三族）。
- 工作流 lifecycle 转移（publish / deprecate / archive）经管家——仍留 admin 面板。
- **自治 tool-loop 管家**——**明确不做**（北极星：框架不跑自治决策）。
- admin 控制台**内联**收件箱 / 审批视图（Phase A 用深链到 `/me`）。
