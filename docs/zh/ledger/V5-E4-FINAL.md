# v5 · Stream E4 — agent 资源 RBAC 收口（admin 路由对齐 workflow）小结

> 状态: **E4 完**（E4-M1 admin agent 路由 enforce + grant CRUD + 16 测试;E4-M2 admin
> UI 访问控制面板;E4-M3 跨表面验收门 + 本文档）。
> Stream A 立了归属底座（`resource_grants` 一张表 + owner-as-grant），Route B P1-M1 把
> agent 的 **/me 成员自助** 路径做实了 viewer/editor/owner enforce;E4 补上的是**最后一块
> 对称缺口**——**admin agent 路由**之前只 `requireAdmin`，没接 grant ladder。
>
> Last updated: 2026-06-03

---

## 一、为什么做（缺口定位）

Stream E 是「交付力五缺口，按杠杆排序逐个做」。E4 的标题是「组织 RBAC viewer/editor +
agent/peer grant 真 enforce」，但**真正缺的不是整套 RBAC**——盘一下 v5 + Route B 之后
「viewer/editor/owner 对 USER 主体到底在哪生效」的真实状态:

| 资源 | admin 路由 | `/me` 成员表面 | 缺口 |
|---|---|---|---|
| workflow | ✓ P2-M5b/c（owner-as-grant + operator 绕过） | ✓ published 闸 | — |
| agent | ✗ **只 `requireAdmin`** | ✓ Route B P1-M1（editor 改 / owner 删 / viewer 读） | **admin 路由** |
| credential | — | vault `ownerKind` | （见 §五，不走 ladder） |

也就是说: **agent 的 `/me` 路径已经分得清 viewer/editor/owner（P1-M1），但 admin 路径
（`/api/admin/agents/*`）还停在「任何 admin 都能改任何 agent」**。这就是 E4 的非冗余面——
**让 admin agent 路由跟 workflow 路由（P2-M5）一样接 `resource_grants` ladder**，不是重造
一套新机制。

> 北极星对齐: 第 2 层「跨组织协作」要求「凭证/数据/各归各家」。一个 role=`admin` 的 v4
> 用户不该能改别人拥有的 agent;但 operator（org owner / v3 host admin）必须零回归——
> 个人模式 + 现存部署一行不变。

---

## 二、E4-M1 — admin agent 路由 enforce + grant CRUD（`3765f55`）

镜像 workflow RBAC（`workflow-routes.ts` 的 `denyIfNoWorkflowPerm`）一比一搬到 agents:

- **identity facade**（`store.ts`）: 5 个薄封装 `setAgentGrant` / `hasAgentGrant(id,userId,min)`
  / `listAgentGrants`（只投 `principal.kind==='user'`）/ `removeAgentGrant` / `removeAllAgentGrants`，
  全部委托 `resourceGrants.*`，钉死 `resourceKind:'agent'` + `userPrincipal(userId)`——
  web 层拿到的是「裸 userId」facade，**零 identity 运行时依赖**。`AgentGrant` / `SetAgentGrantInput`
  类型镜像 `WorkflowGrant`。
- **路由 enforce**（`agents-routes.ts`）: `denyIfNoAgentPerm(ctx,req,res,id,min)` ——
  `if (!ctx.agentGrants || !ctx.resolveActor) return false`（RBAC 未接线=零行为变化）→
  operator 绕过 → `hasAgentGrant` 检查 → 否则 403 `{code:'agent_forbidden'}`。挂点:
  **PUT** 要 `editor`、**DELETE** 要 `owner`（且清 `removeAllAgentGrants`）、**export GET** 要 `viewer`。
- **owner 播种** `seedAgentOwner`: 创建后把创建者（若有 `actor.userId`）种成 owner 行——
  3 条 import 路径 + 单建路径都种;best-effort try/catch。
- **grant CRUD 路由**（匹配在 catch-all `/:id` 之前）: `GET/POST /api/admin/agents/:id/grants`
  + `DELETE /api/admin/agents/:id/grants/:userId`，全部 owner-gated;`!ctx.agentGrants`→404
  防探测;POST 校验 perm ∈ {owner,editor,viewer} + 非空 userId。
- **server.ts 接线**: 提一个共享闭包 `resolveResourceActor`（v4 owner→operator / v3 admin→
  `{userId:null,isOperator:true}` / role='admin'→`{userId,isOperator:false}`），workflow 块
  和 agents 块**复用同一个**;agents 块鸭子探测 `typeof ctx.identity.hasAgentGrant==='function'`
  决定 `agentGrants` 是否注入。
- **16 测试**（`agents-rbac-route.test.ts`，真 Space+Hub+IdentityStore+serveWeb，mock provider
  无 key）: operator 绕过 / v4 admin 受限 ladder（no-grant→403、viewer→export-ok、editor→PUT-ok、
  owner→DELETE-ok）/ 创建种 owner / grant CRUD / RBAC-off。

---

## 三、E4-M2 — admin UI 访问控制面板（`d2f91fd`）

镜像 workflow grant 面板（P2-M5c），让 owner 不必 curl 也能管 grant:

- `managed-agents.js`: 每张**托管 agent** 卡片加「管理访问」按钮 + 全套 grant 逻辑
  （开/关 modal、拉取/渲染/加/删 grant、403→owner-only 提示、404→不可用提示）。
- `app.html`: `#ma-access-modal`（目标 code + grant 列表 + 加 grant 行），复用 `wf-grant-*` CSS。
- `app-core.js`: 3 个新 i18n key（`agentAccessManage`/`agentAccessTitle`/`agentGrantsOwnerOnly`）
  zh+en，其余复用通用 `workflowGrants*` key。
- **关键 wiring 决策**: main.js 的 document click handler 在 `if (!act || !id) return`
  （line 2118）丢掉「无 data-id」的 action。grant 变更钮（刷新/加/删）**故意不带 data-id**
  （它们作用于「当前打开的 agent」），所以必须在那个 guard **之前** pre-guard 接线;
  `manage-agent-access`（带 data-id）留在 guard 之后。

> ⚠️ 顺手发现的既存 bug（**未在 E4 修，避免越界**）: **workflow** 的同类 grant 变更钮
> （refresh/add/remove-workflow-grant）在 main.js 里是接在 `!id` guard **之后**的，却也不带
> data-id → 实际**够不到、是死代码**。E4 对 agent 用 pre-guard 绕开了同一个坑;workflow
> 那侧的修复是独立的小任务（见 §六）。

---

## 四、E4-M3 — 跨表面验收门（`a89e965`）+ 本文档

admin 路由（E4-M1）和 `/me` 成员 grant 服务（P1-M1）**各自**都被单测覆盖了，但**没有任何
测试覆盖那条缝**: 两者操作的是**同一张 `resource_grants` 源**。要是哪天有人改了一侧的
grant key 形状，会悄悄脑裂——admin 种的 owner 在 `/me` 看不见，或 `/me` 的 grant admin 路由
不认。

`agent-rbac-cross-surface-e2e.test.ts`（真 Space+Hub+IdentityStore+serveWeb + 同一个 store 上
构造 `HostMeAgentGrantsService`）双向驱动一条 grant 过缝:

1. **admin 建** → 种的 owner `/me` 看得见（同一行）。
2. **`/me` 授 editor** → admin 路由认: editor 可 PUT、DELETE 仍 owner-gated 403。
3. **admin 授 owner** → `/me` 看得见且可管（共同所有）。
4. **admin 删 agent** → grant 清空 → `/me` 404（同 id 重建从干净起步）。

mock provider 无 key → 验收门不用 LLM。+4 测试;host 全套 **645 绿**，零回归。

---

## 五、关键设计决策

1. **非冗余面 = admin 路由对齐，不是整套 RBAC**。viewer/editor/owner 对 **USER 主体**早已
   在 workflow（P2-M5）+ agent `/me`（P1-M1）做实;E4 只补 agent admin 路由这块对称缺口。
   不重造、不发明新表——`resource_grants`（identity v16）就是底座。
2. **operator 永远绕过**。RBAC 仅当 `ctx.agentGrants` + `ctx.resolveActor` 同时接线才 ON;
   v3 host admin + v4 org owner 一律 operator。受限的唯一主体是 role=`admin` 的 v4 用户。
   个人模式 / 现存部署 = 零回归（16 测试里专门钉死）。
3. **owner-as-grant，无单独 owner 列**。owner 就是 `perm='owner'` 行;删 agent 清全部 grant;
   孤儿守卫（`/me` 服务）拒绝任何让资源零 owner 的 set/remove。
4. **facade 让 web 保持 identity-free**。web 拿裸-userId 的 `AgentGrantSink` 鸭子;真 identity
   store 满足它，但 web 编译期不依赖 identity。

---

## 六、不做 / 后续（保持精简，诚实边界）

E4 把 **USER 主体**的 agent RBAC 收口了。**显式推迟、记录在案**:

- **agent / peer 主体的 grant enforce**: `resource_grants` 能存 `principal.kind='agent'|'peer'`
  的行（A-M4 的 UI 也能写），但这些行**不作为资源 grant 被 enforce**——这是**有意的非冗余**:
  - **agent → agent** 授权 = **dispatch allow-list**（`ManagedAgentSpec.dispatch.{agents,
    capabilities}` + ancestry/cycle gate，Phase 10），不是 `resource_grants` overlay。
  - **peer-hub → 资源** 授权 = **`PeerLinkAcl`** + per-link 信任契约（capabilities /
    outboundCaps / dataClasses / KB allowlist，Phase 18 + P4 + C-M1），不是 `resource_grants` overlay。
  - 给这两条再叠一层 `resource_grants` viewer/editor/owner 判定，是**冗余且会和既有闸打架**。
    所以 `listAgentGrants` 只投 `kind='user'` 行，admin/me 的 ladder 只判 user。
- **credential 资源 grant**: 凭证归属用 vault `ownerKind`（A-M3），**不走 viewer/editor/owner
  ladder**——凭证要么你拥有（能用/能删），要么看不见，没有「viewer 凭证」语义。
- **workflow grant 变更钮死代码**（§三 ⚠️）: 独立小修——把 main.js 里 workflow 的
  refresh/add/remove-workflow-grant 也挪到 `!id` guard 之前的 pre-guard 块（同 E4-M2 对 agent
  的做法）。不阻塞 E4。
- **E5 中央多 hub 控制面**（task #210，最大、排末）: org-wide 资产/审计聚合 + 跨 hub 工作流。

---

## 七、一句话

> **E4 不是「做 RBAC」，是「把 agent admin 路由接进早就铺好的 `resource_grants` ladder」**——
> 让 admin 路由和 `/me` 成员表面在同一张表上对 USER 主体一致 enforce viewer/editor/owner;
> agent/peer 主体的授权**故意**留给 dispatch allow-list 和 PeerLinkAcl，不叠冗余 overlay。

---

## 提交

| 里程碑 | commit | 内容 |
|---|---|---|
| E4-M1 | `3765f55` | identity agent grant facade + admin 路由 enforce + grant CRUD + 16 测试 |
| E4-M2 | `d2f91fd` | admin UI 访问控制面板（卡片「管理访问」+ modal + i18n + 重建） |
| E4-M3 | `a89e965` + 本提交 | 跨表面验收门（4 测试）+ V5-E4-FINAL 文档 |
