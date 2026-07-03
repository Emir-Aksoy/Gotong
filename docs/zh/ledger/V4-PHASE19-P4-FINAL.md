# v4 Phase 19 / P4 — 联邦信任契约收口（FINAL）

> 接 Phase 18（联邦能力 manifest + 跨组织 policy + A2A 闭环）。Phase 18 把
> federation 推到「可发现 + 可授权 + 可互操作」，但留了几个**真缺口**：出站
> allowlist 持久化了却零强制、多组织记账混账、manifest 只有裸 capability 名、
> per-link 数据/配额/撤销边界全无。P4 把这些补齐，让一个**个人 hub 同时连多个
> 组织、各组织的权限/配额/审计/数据边界互不污染**——这是北极星第 2 层「跨组织
> 协作，但凭证/数据/计费各归各家」的硬约束。
>
> 一个里程碑一个小 commit（plan→dev→test→commit→next），纯本地 `main`。
>
> Last updated: 2026-06-01

---

## 一、缺口（开工前已用真代码核实）

1. 🔴 **出站 allowlist 零强制**：`outboundCaps` 自 Phase 18（schema v12）就持久化，
   但 `RemoteHubViaLink.onTask` **从不校验** → 一条 link 上 peer 能调任意能力，
   配置的白名单是摆设。
2. **用量账本混账**：`usage_ledger`（v11）按 org/user 记，但没有 peer 维度 →
   一个 hub 连多个组织时，跨组织来的 LLM 调用无法按对端拆账。
3. **manifest 太瘦**：`PeerManifest.capabilities` 只是 `string[]`，admin 看不到
   能力的版本/成本/数据分类 —— 无从判断「该不该把敏感任务发给这个对端」。
4. **per-link 契约缺位**：peer 行没有数据分类边界、没有 per-link 配额、没有撤销
   开关。一条信任出了问题只能整个 disable，做不到「限制这一条，别的不受影响」。
5. **无多组织隔离测试**：自由图「每条 link 独立契约」的不变量没有验收门兜底。

---

## 二、各里程碑

### P4-M1 — 出站 capability allowlist 强制（`0c8c26f`，安全）

把 Phase 18 持久化但没接线的 `outboundCaps` 真正变成闸：

- 新 `packages/core/src/peer-acl.ts` —— **入站/出站共用一套「这个 task 要哪些
  能力」的语义**（`extractRequiredCapabilities(strategy)`）。入站 `evaluateAcl`
  与出站 `checkOutboundCapabilities` 引同一个函数，将来加新 `DispatchStrategy`
  kind 两个闸一起学会怎么 allowlist，不会漂移。
- `RemoteHubViaLink.onTask` 在**碰链路之前**校验 task 的 required caps ⊆
  `outboundCaps`；不过返 `failed('outbound_capability_denied:<cap>')`。这是 link
  前的最后一个 chokepoint，任何装饰器（如 Phase 18 审批闸）都绕不过去。
- 语义：`null`/`undefined` → 不设白名单 = 全放（兼容老行）；`[]` → 显式锁死全拒；
  `explicit` / 无过滤 `broadcast` 在设了白名单时一律拒（放过去等于偷偷绕过白名单）。
- `peer-registry` 两个 install 点都把 `row.outboundCaps` 传进 `installPeerLink`。
- **测** +14（`outbound-allowlist.test.ts`）：纯 verdict + 真 inproc mesh 边
  （被拒能力本地短路、远端 agent 零调用）。

### P4-M2 — peer-aware 用量账本归属（`a635e69`，identity v14）⚠️ schema

> **决策点（用户本会话拍板）= 轻量 + 仅 `peer_id`**。计划原本要加 4 列
> （`peer_id/link_id/origin_org_id/origin_user_id`），但 `usage_ledger` 的
> `org_id`/`user_id` 已经从 `task.origin` 捕获了发起方组织/用户，`origin_*` 冗余；
> link 由 peer 行 id 唯一标识，`link_id` 冗余。只加 `peer_id` 一列就够拆账。

- identity 迁移 **v14**（`ledger-peer-id`）：`usage_ledger ADD COLUMN peer_id TEXT`
  + 索引。`LedgerStore` 加 `peerId`（append/query/aggregate/rowToEntry），
  `LEDGER_GROUP_BY` 白名单加 `peer`。
- host `resolveLedgerPeerId(identity, task)`：`task.origin.orgId` → `getPeerByPeerId`
  → 该 peer 行 id；本地任务（无 peer 来源）→ null。`usageSink` 落账时带上。
- web `usage-routes` + admin `用量` 看板加 `peer` 维度（DTO/query/aggregate/导出
  列 + `usage-ui.js` GROUP_OPTIONS「联邦对端」）。
- **测** +3（`ledger.test.ts`）：带 peerId 的行 round-trip、按 peer 聚合、本地任务
  peerId 为 null。

### P4-M3 — rich manifest capability schema（`58d03a2`）

- `PeerManifest.capabilities`：`string[]` → `PeerCapability[]`
  （`{id, version?, costHint?, dataClasses?}`）；`PEER_MANIFEST_VERSION='2'`；
  `buildLocalManifest` 发 `{id}`（这版先发 id，富元数据是派生接缝）。
- **向后兼容**：`normalizePeerCapabilities(raw)` 同时接受老 peer 的 `string[]`
  和新 peer 的富对象 —— 版本不一的 peer 都能解析。
- web `peer-routes` 镜像 `PeerCapability`；admin 联邦 tab `renderCap` 渲染 id chip
  + 内联 `v<版本> · 成本:<hint> · 数据:<class/...>`。
- **测**（`peer-manifest.test.ts` +4）：富字段 round-trip、老 `string[]` 仍解析。

### P4-M4 — per-link 信任契约：data class + 配额 + 撤销（重）⚠️ schema

> **决策点（用户本会话拍板）= 全做**：数据分类 + per-link 配额 + 撤销 + 多组织
> 隔离验收门，一次到位。拆成 M4a（schema+store）/ M4b（core 接缝）/ M4c（host 接线
> + 隔离 E2E + admin）。

**M4a — identity v15 契约列 + store（`7af9488`）**
- 迁移 **v15**（`peer-link-contract`）：`peers` 加性 ALTER 三列
  `revocation_state TEXT NOT NULL DEFAULT 'active'`、`per_link_quota_budget INTEGER`、
  `allowed_data_classes_json TEXT`。
- `PeerStore` round-trip + `updatePeer` 语义：`undefined` 保留、`null` 清空
  （quota/classes 回到无限/全放）、`revocationState` 无 null（永远 active|revoked）。
- **测** +4（`peers.test.ts`）：契约 round-trip、默认值、清空、撤销不动 token。

**M4b — 出站 data-class 闸 + 入站 policy 接缝（`15735fa`，protocol/core）**
- protocol `Task.dataClasses?: readonly string[]`（任务自带数据分类标签）。
- core `checkOutboundDataClasses(task, allowed)` —— 与 capability 闸同一个
  chokepoint：task 声明了白名单外的数据类 → `outbound_data_class_denied:<class>`，
  payload 永不改写（是闸不是 redaction；redaction 是后续接缝，目前安全默认=拒不漏）。
- `RemoteHubViaLink.allowedDataClasses` + `installPeerLink({ inboundGate })` 接缝
  （入站任务跑完 ACL 再跑 gate，拒则 `cross_org_policy_denied (<reason>)`）。
- `Hub.dispatch` 加 `dataClasses` 选项。**测** +6。

**M4c — host 接线 + 隔离验收门 + admin（`d0f0d38`，host/web）**
- **撤销三闸**（`revocationState === 'revoked'` 等同 disabled）：
  ① tick —— 不拨号 + 拆活链；② `installInboundLink` —— 拒收在途入站连接；
  ③ `buildPeerTokenResolver` —— HELLO 在**线缆层**就拒（link 根本不分配，最早的闸）。
- **per-link 配额** `inboundQuotaGate(row)`：每 peer 一个 `FixedWindowLimiter`
  （复用 registry 自己那个类），按 row id **跨重连保留**（peer 不能靠掉线重连刷新
  预算），仅当 operator 改预算值才重建；越界 fail-closed `per_link_quota_exceeded`。
  in-memory、重启归零 —— 跟入站 HELLO 限流同姿态，是安全兜底不是计费账本。
- 把 `allowedDataClasses` + 配额 `inboundGate` 像 acl/outboundCaps 一样穿进**两个**
  install 点；row 整个消失时丢弃配额计数器（`policy_changed` 拆链刻意保留）。
- `main.ts`：`AIPE_PEER_LINK_QUOTA_WINDOW_MS`（默认 60s）→ `perLinkQuotaWindowMs`。
- web `identity-routes`：契约三件套（revocationState/perLinkQuotaBudget/
  allowedDataClasses）走既有 peer CRUD 路由 —— DTO 投影 + addPeer/updatePeer 面
  + 校验（撤销枚举、预算非负整数或 null 清空、数据类 string[] 或 null 清空）。
- **多组织隔离验收门**（`peer-isolation-e2e.test.ts`）：一个 home hub 连两个对端
  orgX（夹紧：只放 `public` 数据 + 1 个入站配额）与 orgY（全开）。断言 ——
  同一个 `pii` 任务**发给 orgX 被拒、发给 orgY 通过**；orgX 第 2 个入站任务
  fail-closed，orgY 的入站流不受限（home agent 共见 1+3=4 个任务）。这正是 P4 的
  自由图不变量：**夹紧一条 link 绝不外溢到另一条**。
- **测** +9：host 隔离 E2E 1 + 撤销 resolver 1 + web 契约三件套 7。

---

## 三、关键设计决策（横切）

1. **入站/出站共用 capability 语义**（M1 `peer-acl.ts`）——两个方向的闸引同一个
   `extractRequiredCapabilities`，杜绝「入站认这个能力、出站不认」的漂移。
2. **记账要 ungated，执行才 gated**（沿用 Phase 17 教训）——M2 的 peer 归属只是
   给账本多一个观测维度，不是闸；配额闸（M4c）是其上的执行层，二者分开。
3. **配额闸 in-memory、跨重连保留、重启归零**（M4c）——与既有入站 HELLO 限流同
   姿态。不进 SQLite：per-link 安全兜底而非计费，重启诚实归零比「端上陈旧配额」好；
   跨重连保留则堵了「掉线重连刷新预算」的绕过。
4. **撤销在最早的闸短路**（M4c）——三个连接点都认 `revoked`，其中线缆层
   （token resolver）让被撤销的 peer 连 link 都分配不到，最省资源也最难绕。
5. **闸不做 redaction**（M4b）——data-class 命中就整个拒，payload 永不改写。
   「剥掉敏感字段发缩减版」是显式推迟的接缝；在那之前安全默认是拒不漏。
6. **admin = API 配置，沿用 B-M2 先例**——契约三件套走既有 peer CRUD 路由 +
   校验 + 测试。B-M1 的 kind/acl/outboundCaps/requireApprovalOutbound 至今也都是
   API 配置（没有专门编辑器 UI），M4 的三件套与它们同列；专门的 peer-policy 编辑器
   显式推迟，不为一个里程碑凭空造一个大 UI surface。

---

## 四、测试矩阵（+36，零回归）

| 包 | 新增 | 覆盖 |
|---|---|---|
| core | +20 | M1 出站 cap allowlist 14（verdict + mesh 边）；M4b data-class 闸 + 入站 gate 6 |
| identity | +7 | M2 ledger peerId 3；M4a 契约 store round-trip/默认/清空/撤销 4 |
| host | +6 | M3 manifest normalize 4；M4c 隔离 E2E 1 + 撤销 resolver 1 |
| web | +7 | M4c 契约三件套持久/校验/refreshPolicy 7 |
| **合计** | **+40** | — |

收尾全量：**core 308 / identity 315 / host 434 / web 537**，零回归。

---

## 五、运维须知

- **新 env**：`AIPE_PEER_LINK_QUOTA_WINDOW_MS`（默认 60000）—— per-link 入站配额的
  滚动窗口。配额本身是 peer 行的 `perLinkQuotaBudget`（每窗口最多几个入站任务）。
- **schema 迁移**：v14（`usage_ledger.peer_id`）、v15（`peers` 加三契约列），均加性
  ALTER、可空/有默认，老行平滑取默认，符合「不破坏现有行」。
- **配额计数器重启归零**：不是计费账本；要审计跨组织真实用量看 `usage_ledger`
  （现已带 `peer_id`，可按对端拆账/导出）。
- **撤销 vs 禁用**：`revocationState='revoked'` 与 `enabled=false` 在三个连接闸上
  行为一致（不拨号/拒入站/线缆层拒）。语义区别留给运维表达意图（撤销=信任作废，
  禁用=临时下线）；admin PATCH 任一契约字段都会 `refreshPolicy` 立即重新评估活链。
- **契约配置**：`POST/PATCH /api/admin/identity/peers` 收
  `revocationState`/`perLinkQuotaBudget`/`allowedDataClasses`（owner 闸后）；
  `null` 清空 quota/classes，撤销态只在 `active`/`revoked` 间切。

---

## 六、显式推迟（保持精简）

- **出站 redaction hook**：data-class 命中目前整拒；「剥字段发缩减版」是 M4b 留的
  接缝，未实现。
- **per-peer peer-policy 编辑器 UI**：契约（含 B-M1 的 acl/outboundCaps）全是 API
  配置；专门的可视化编辑器未做。
- **配额持久化 / 真实计费**：配额计数器 in-memory；跨重启的用量真相在 ledger。
- **manifest 富元数据派生**：`buildLocalManifest` 这版只发 capability id；version/
  cost/dataClasses 从 workflow/agent 元数据自动派生是后续。
- **link_id 维度记账**：M2 决定只加 peer_id；若将来一个 peer 多条并发 link 需要
  更细拆账，再加列。

---

## 七、验收对照

| P4 验收项 | 状态 |
|---|---|
| 出站 task 能被 outboundCaps / 审批 / data-class / revocation 任一挡下 | ✓ M1（cap）+ Phase 18（审批）+ M4b/M4c（data-class）+ M4c（revocation） |
| 个人 hub 同连两组织，权限/配额/数据边界互不污染（有验收门） | ✓ `peer-isolation-e2e.test.ts` |
| manifest 能显示能力 schema/version/cost，标 stale/unknown | ✓ M3 rich schema + Phase 18 三态缓存 |
| 多组织用量可按对端拆账 | ✓ M2 `usage_ledger.peer_id` + admin 看板 peer 维度 |

「机构可用」总验收第 10 条（个人 hub 同连多组织，权限/quota/audit/数据边界互不
污染）—— **P4 闭合**。

---

## 八、commit 链

`0c8c26f`（M1）→ `a635e69`（M2）→ `58d03a2`（M3）→ `7af9488`（M4a）→
`15735fa`（M4b）→ `d0f0d38`（M4c）→ 本文档（M5）。

下一段：**P5 生态接入与行业模板**（agent-framework adapter + automation bridge +
行业模板包 + 模板治理元数据）。未启动，等用户点名。
