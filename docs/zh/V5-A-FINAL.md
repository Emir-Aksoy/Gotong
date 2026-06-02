# v5 · Stream A — 归属泛化（resource_grants）小结

> 状态: **Stream A 完**（A-M1 通用 `resource_grants` 表 + store;A-M2 agent 归属 + `/me`
> 自助 CRUD;A-M3 凭证归属 + per-user key;A-M4 授权 UI——owner 把资源共享给别的 principal）。
> Stream 0 立了**词汇 + 策略**（四类 Principal + agent-owner 闸），Stream A 把它**接成运行时
> 真东西**:一张表、一个 owner gate、一个 per-user key 回退、一个共享面板。
>
> Last updated: 2026-06-01

---

## 一、为什么做（北极星缺口）

Stream 0 承认了「org 不是实体、hub 才是节点」，并给出统一的 `Principal`（hub/user/agent/peer）
词汇——但那是**纯词汇 + 纯策略，零运行时 enforce**。盘一下 v5 之前「谁拥有什么」的真实状态:

| 资源 | v4 归属机制 | 问题 |
|---|---|---|
| workflow | `workflow_grants`（**仅 user_id** 主体，identity v13） | 主体只能是人;agent / peer 拥有不了 |
| agent | **无归属**——admin 建、所有人共享 | 成员不能「拥有」自己的助手 |
| 凭证（LLM key） | vault `ownerKind='org'`（hub 级）/ `'user'` | per-user key 存得下但**没人读** |

北极星第 1 层（「我的 AI 桌面」:一个人的 hub、私人 workflow、凭证只在本机）要求一件事:
**成员能真正拥有、管理、共享自己的资源**。而这要求一个**统一的归属底座**——否则每加一类
可拥有的资源就得新建一张 grant 表，每个 `/me` 自助面板就得自己发明一套 owner gate。

Stream A 就是把 Stream 0 的 Principal 词汇**接成那张底座**:决策点 #3 拍板——
**一张通用 `resource_grants` 表，不是每资源一张。**

---

## 二、A-M1 — 通用 `resource_grants` 表（决策 #3 的地基）

新 `packages/identity/src/resource-grant-store.ts`(migration **v16**)。把 `workflow_grants`
从「user → workflow」泛化成「**Principal → 任意资源**」:

```sql
resource_grants(resource_kind, resource_id, principal, perm, granted_by, granted_at)
PRIMARY KEY (resource_kind, resource_id, principal)
```

- **owner-as-grant**:没有单独的 owner 列——**owner 就是那条 `perm='owner'` 行**。归属和共享
  是同一个模型、同一张表。
- **principal 是统一主体**:`principal` 列存 Stream 0 的 `principalKey()`（`"<kind>:<id>"`），
  一个 TEXT 列装下 hub/user/agent/peer 任意主体。读回时 `parsePrincipalKey` 对畸形行**抛错**
  （fail-visible——坏 grant 宁可炸也不静默授权给错误主体）。
- **perm 梯子泛化**:`WorkflowPerm`（viewer<editor<owner）正式升格为通用 `GrantPerm`,
  按 rank 比较（不是 SQL CHECK，梯子能长不用迁移）。
- **`RESOURCE_KINDS = ['workflow', 'agent', 'credential']`**——随资源获得归属而增长。
- `workflow_grants` **折叠进来**:workflow 专属的 IdentityStore 方法现在是这张表上的**薄 facade**
  （`resourceGrantToWorkflowGrant` 投影回老形状），零行为变化。

API:`setResourceGrant`/`getResourceGrant`/`hasResourceGrant`（热路径 enforce 检查，fail-closed）
/`listResourceGrants`（按资源）/`listPrincipalGrants`（按主体，撑 `/me` + owner 视图）
/`removeResourceGrant`/`removeAllResourceGrants`。

---

## 三、A-M2 — agent 归属 + `/me` 自助 CRUD

`packages/host/src/me-agent-service.ts`(`HostMeAgentService`)。让成员**建 + 管自己的助手**
（不只是看只读目录）。归属是一条 `resource_grants` 行（`kind='agent', perm='owner',
principal=user:<id>`）——**不是 agent 记录上的字段**,一张表通吃。

agent 本体走**和 admin 建的 agent 完全相同**的机器（`space.upsertAgent` 持久化 + `lifecycle.start`
spawn）。成员拿到的是一扇**受限的门**:

- 参与者 id 由 host 合成 `me.<userId>.<handle>`——成员不能蹲别人命名空间（「作用域从 session
  来，绝不取客户端值」,同 uploads 面板）;
- **无** inline API key / baseURL / services / MCP——那些是 admin 基建或凭证（A-M3）;成员 agent
  吃 org / workspace key 池,花的钱照样被 Phase 17 配额按 `task.origin` gate;
- provider 必须是 host 已有 key 的;
- per-member 数量上限（默认 20，反 DoS）。

每个特权检查都在 host;「不是你的」报 **404 而非 403**（防枚举）。前端是 `/me` 工作台的
「打造我的助手」表单 + owned-agent 卡片（A-M2b）。

---

## 四、A-M3 — 凭证归属 + per-user key（BYO key）

让成员**带自己的 LLM key**——A-M2 的成员 agent 缺 org key 时的回退。三层:

1. **后端回退**（A-M3a,`org-api-pool.ts` + `local-agent-pool.ts`）:`OrgApiPool.resolveUserLlmKey`
   读 vault `ownerKind='user'` 行;`selectLlmApiKey` 解析优先级补一档——
   **per-agent → org-pool → **user-pool（新）** → workspace → env**。org 主、user 回退
   （「读 org 行的同时支持 user 行回退」）;**只对成员拥有的 agent**生效（owner 从 `resource_grants`
   在 spawn 时算 `ownerUserIdOf`）。operator agent 无 owner → 跳过 user 档 → 逐字节零回归。
2. **凭证 surface**（A-M3b,`me-credentials-service.ts` + `/api/me/credentials`）:
   `HostMeCredentialsService` 把 key 写 vault（`ownerKind='user'`/`ownerId=<caller>`/`metadata={provider}`）;
   delete 按「这是你自己的 llm_provider key」gate → 404 防枚举;**secret 永不返回**,只投影 metadata;
   provider 限 `anthropic`/`openai`(raw bearer key 的两家)。
3. **成员 UI**（A-M3c）:`/me`「我的 API 密钥」面板,create + delete（轮换 = 删 + 重加,无编辑态）。

**缓存自洽零接线**:`createVaultEntry`/`revokeVaultEntry` 触发 IdentityStore 的 vault-mutation
钩子,`OrgApiPool` 早已订阅 → 成员轮换 key 自动 flush org+user 两份 resolved-key 缓存。

---

## 五、A-M4 — 授权 UI（owner 把资源共享给别的 principal）

`packages/host/src/me-agent-grants-service.ts`(`HostMeAgentGrantsService`) + `/api/me/agents/:id/grants`。
agent 的 **owner** 把它共享给别的 principal（user / agent / peer-hub），授 viewer / editor / owner,
走 A-M1 通用 grant。这是 Stream A 的**授权半边**:A-M2 给了归属,A-M4 让归属能**往外授**。

**真正 enforce 的回报是「共同所有者」**:给另一个 **user** 授 `owner` = 协同所有——对方在自己
`/me` 看到这个 agent 并能管它（`HostMeAgentService.assertOwns` 检查的**正是同一条 owner grant**）。
viewer / editor 是**为将来更细的 agent 级 enforce 预留的记录**;今天全栈只 enforce `owner`,所以
低档位是诚实的前瞻数据,不是悄悄的空头承诺。

受限的门(同 A-M2/A-M3):

- **owner gate**:调用者必须已拥有该 agent,否则 404(不是 403),防枚举别人的 agent id;
- principal + perm 按真 identity 枚举校验(web 只 shape-check 字符串,零 identity dep);
- **孤儿守卫(orphan guard)**:任何会让 agent **零 owner** 的 set/remove 都拒(成员永远锁不死
  一个 agent,包括撕掉自己最后一条 owner grant);
- best-effort 审计(`resource_grant_set`/`_revoke`)记「谁把什么共享给了谁」。

前端(A-M4b):每张 owned-agent 卡片加「管理访问」折叠面板——列当前 grant（perm chip + 主体
类型/id + 「（你）」标自己）各带撤销键,加一行「类型选择 + id 输入 + 权限选择 + 授权」。delegated
click 复用 A-M2b 的 `onOwnAgentsClick` 容器,面板首次展开懒加载、每次增删原地重渲染。

---

## 六、关键设计决策（贯穿 Stream A）

1. **一张通用表,不是每资源一张**(决策 #3)。`resource_grants` 一张表覆盖 workflow/agent/credential
   及未来资源;`workflow_grants` 折叠成 facade。加一类可拥有资源 = 往 `RESOURCE_KINDS` 加一个字面量,
   **不建表、不迁移、不发明新 owner gate**。

2. **owner-as-grant**。归属**就是** `perm='owner'` 行,没有单独 owner 列——所以「共享」和「转让」
   和「协同所有」都是同一个 upsert,免去「owner 字段 vs grant 表」的双真相源。

3. **principal-keyed**。grant 主体是 Stream 0 的统一 `Principal`,所以 A-M4 的共享对象天然能是
   user / agent / peer——不是又一个「仅 user」的局部主体。

4. **`/me` 鸭子类型缝**。每个成员 surface(agent CRUD / 凭证 / grant)都是一个 host service 经
   `serveWeb` opts 注入;web 对 identity / host 零运行时依赖,host 持有全部特权决策。undefined →
   503(空列表 on GET)。

5. **受限的门 + 404-非-403**。host 合成 id(`me.<userId>.<handle>`)、scope 从 session 来、
   「不是你的」一律 404 防枚举——三个成员 surface 同一套姿势。

6. **org 主、user 回退,且只对成员 agent**。per-user key 是回退不是覆盖;operator agent（无 owner
   grant）走旧路径逐字节不变 → 零回归。

7. **诚实的 enforce 边界**。今天只 `owner` 被 enforce(CRUD gate)。A-M4 的 viewer/editor、
   agent/peer 主体 grant 都是**记录在案、enforce 待来**——文档和注释都说清,不假装已经生效。

---

## 七、测试 / 验证

- **A-M1**:`resource-grants.test.ts` + `workflow-grants.test.ts`(facade 回归)——principal 往返、
  perm rank、owner-as-grant、upsert、按资源/按主体列举、v13→v16 迁移老 workflow_grants 行。
- **A-M2**:host `HostMeAgentService` 测(id 合成 / owner gate / provider 校验 / grant 写清)+ web
  `/api/me/agents` CRUD 路由测(强制 session userId、404 防枚举)。
- **A-M3**:host `me-credentials-service.test.ts`(9,真 vault:归属 scope / provider 闸 /
  secret 不漏 / 跨用户 404 / 审计)+ web `me-credentials-routes.test.ts`(6)+ host
  `select-llm-api-key`/`org-api-pool`/`auth-failure` 共 +13(org 胜 user / user 回退 / 无 owner 跳过 /
  per-user 隔离 / 401 撤 user 行)。
- **A-M4**:host `me-agent-grants-service.test.ts`(15,真 store:owner gate / 共同所有 / 孤儿守卫
  set+remove / 坏 principal / 跨用户 404 / 审计)+ web `me-agent-grants-routes.test.ts`(7)。
- 全量绿:identity 348 / host 505 / web 569;`pnpm -C packages/{identity,web,host} build` clean;
  静态资产重建(`build:assets`)。

---

## 八、不做 / 后续（保持精简）

- **viewer/editor 在 agent 上的真 enforce**:今天只 owner 被检查;agent 级读/编辑 enforce 是后续
  (A-M4 立 grant 数据底座,enforce 接线另算)。
- **admin 侧通用 grant UI**:A-M4 落在 `/me`(成员共享自己拥有的 agent)。admin 给 admin 管的资源
  授权、全面 i18n 是单独 retrofit(workflow grant 的 admin 面板 Phase 19 P2-M5c 已有)。
- **credential / workflow 的 `/me` 共享面板**:A-M4 只做 agent 共享(成员当前唯一用 resource_grants
  拥有的资源;凭证用 vault ownerKind 不是 resource_grants)。同形状可照搬。
- **agent-owner 敏感动作经 inbox 审批的真接线**:Stream 0-M2 立了 `authorizeAgentAction` 闸 +
  `requires_human` 清单;真正「agent 改 owner grant → 挂起等人类批」的接线随 agent 真做 owner 操作时落地。
- **全 `/me` i18n**:沿用既有 `/me` 硬编码中文约定。

---

## 九、一句话

**Stream 0 说「谁能拥有」,Stream A 让「拥有」变成能建、能管、能共享的真东西。** 一张通用
`resource_grants` 表(owner 就是 `perm='owner'` 行)+ 三个同构的 `/me` 成员 surface(agent CRUD /
BYO key / 授权共享),每个都把特权决策关在 host、用 404 防枚举、用孤儿守卫防锁死。最实质的一步是
**成员第一次在浏览器里就拥有、并能把所有权往外授**——「我的 AI 桌面」从「能跑别人配的工作流」
变成「能搭、能管、能分享我自己的助手」。

详见 `packages/identity/src/resource-grant-store.ts` + `packages/host/src/me-agent-service.ts`
/ `me-credentials-service.ts` / `me-agent-grants-service.ts`。
