# v4 Phase 18 / Sprint 5+6 —— 联邦能力 manifest + 跨组织 policy + A2A 闭环（A/B/C 三 track + 验收门）

> 把 federation 从「可连通」推到「**可发现 + 可授权 + 可互操作**」。三条 track，
> 严格顺序一个里程碑一个小 commit（plan→dev→test→commit→next），纯本地 main。
>
> 验收门：① admin 能刷新看到 peer 能力清单（online/stale/unknown）；② per-peer
> 信任契约可编辑并真正生效（入站 ACL + 出站审批走 Phase 16 inbox）；③ 两个 Gotong
> hub 通过 A2A HTTP/JSON-RPC 跑通一个确定性往返 smoke。三个全绿。
>
> Last updated: 2026-05-31

---

## 一、动了什么

| Track | 缺口 | 落地 |
|---|---|---|
| **A 能力 manifest** | peer 表只有 id/url/token/label/enabled，HELLO 帧 auth-only，admin 看不到「对面能干什么」 | host `peer.manifest` RPC provider（多路复用现有 `rpcResponder`）+ in-mem cache（online/stale/unknown 三态）+ admin 联邦 tab 浏览/刷新 |
| **B 跨组织 policy** | `PeerLinkAcl` 写死在代码、PeerRegistry 根本没把它传进 `installPeerLink`、无出站管控 | identity v12 加 4 列 per-peer 信任契约（kind/acl/outboundCaps/requireApprovalOutbound）→ 入站 ACL 真正生效 + 出站审批闸复用 Phase 16 inbox |
| **C A2A 闭环** | R1/R3 只到「声明 auth scheme + agent card」，card 故意 `skills:[]`，没有真正的 message API | agent card skills opt-in 翻 honest + 新包 `@gotong/a2a`（wire 类型 + client）+ 入站 `message/send`→`hub.dispatch` + 出站 `A2aRemoteParticipant` + 双 hub 验收门 |

合计 13 个里程碑 commit（A-M1→A-M3、B-M1→B-M3b、C-M1→C-M5）+ 本文档。新增第 29 个
workspace 包 `@gotong/a2a`。

---

## 二、为什么这么做（北极星对齐）

- **Hub 网络是自由图，不是层级树**：每条 link 独立 trust/policy/capability 契约，个人
  hub 可同时连多组织且权限互不串线 → policy **存 per-peer**（identity 表的 4 列），不存
  全局配置。
- **人是 Participant，不是审批 tool**：出站跨组织 task 命中 `requireApprovalOutbound`
  的 peer → 抛 `SuspendTaskError` 停在成员 inbox（cap `gotong.human/v1` 同源的复用），
  人在 `/me` 批准后才真正发出。**零新挂起设施**——全靠 Phase 11 suspend/resume + Phase
  16 inbox 两步恢复拼出来。
- **mesh 留高信任自有通路，A2A 拿生态可达性**：manifest 走 mesh RPC（Gotong↔Gotong，
  on-demand `link.rpc`），agent card skills 走 A2A（对外生态的 well-known 发现）。两条
  路径不混。

---

## 三、Track A —— 能力 manifest（`d7a2842` / `f995197` / `3e278d4`）

### 3.1 存储决策：in-memory，不加表

online/stale/unknown 三态由 `peerRegistry.status()`（connected）+ host 内
`Map<peerId,{manifest,lastFetchedAt}>` 完全可导出；与 stateless 的 MCP-federation 先例
一致。**持久 cache 重启后会「端上陈旧谎言」，而「未刷新前 unknown」更诚实。**（policy
必须持久——那是 Track B 的表；manifest 是观测快照，不是契约。）

### 3.2 RPC provider 多路复用（A-M1）

`packages/host/src/peer-manifest.ts`：
- `buildLocalManifest(hub, selfHubId, peerWrapperIds)` 聚合 `hub.participants()` 的
  `.capabilities`（去重排序），**排除 peer wrapper**——别把别人的能力当自己的广播，用
  `peerRegistry.status()` 的 peer id 集合过滤。
- `PeerManifest = { hubId, capabilities[], protocolVersion }`（workflow trigger caps
  这版不做）。
- `PeerManifestHost.respond(call)` 跟 `McpProxyHost.respond` 同形状的 method switch。
- 复用器在 `main.ts`：`rpcResponder = (call) => call.method.startsWith('mcp.') ?
  mcpProxy.respond(call) : peerManifestHost.respond(call)`——一根 RPC 管子上挂两个
  provider，零新 transport。

### 3.3 federation surface + 路由（A-M2/A-M3）

host `peerFederation` surface：`list()`（`status()` join cache）+ `refresh(peerId?)`
（对 connected peer `fetchPeerManifest`→cache.set；offline/throw 降级保留旧 cache 标
stale）。web 鸭子 `PeerManifestFederationSurface`（`peer-routes.ts`，零 host dep）+
`GET /api/admin/peer-manifests` / `POST /api/admin/peer-manifests/refresh`（requireAdmin
+ 503-when-unwired，镜像 mcp-routes）。admin「联邦」tab：per-peer label + online/stale
徽章 + capability chips + lastFetchedAt + 刷新按钮。

---

## 四、Track B —— 跨组织 policy（`ded20c8` → `0fccd68`）

### 4.1 identity v12：per-peer 信任契约（B-M1）

加性 `ALTER TABLE peers ADD COLUMN`（逐列、可空、不破坏现有行）：

| 列 | 含义 | NULL/默认语义 |
|---|---|---|
| `kind` | personal/organization/project/service | 默认 `'service'` |
| `acl_json` | 入站 `PeerLinkAcl` JSON | NULL = accept-all（兼容现状） |
| `outbound_caps_json` | 出站能力白名单 `string[]` | NULL = 全放 |
| `require_approval_outbound` | 出站需审批 | 默认 `0` |

`PeerStore` 沿用 `label`/`enabled` 已有的「undefined→保留」targeted write；
`rowToPeerRegistration` 的 `JSON.parse` try/catch → corrupt 返 null 不抛；token 轮换不碰
这些列。

### 4.2 入站 ACL 真正生效（B-M2a）

`peer-registry.ts` 的 `dialOne` + `installInboundLink` 各加一行把 `acl: row.acl`
传进 `installPeerLink`（此前 ACL 类型存在但**根本没接线**）。受限 ACL → 入站 task
`failed` + `cross_org_acl_denied`。新 `refreshPolicy(rowId)` = 拆链重连该 peer（已连 peer
改 ACL 不会被 `invalidate()` 自动重装——它只 dial-new/drop-gone；避免「我保存了但没变」）。
web peer CRUD 路由收+校验 4 个新字段（B-M2b）。

### 4.3 出站审批闸（B-M3，最高风险，拆 a/b）

- **B-M3a**（`d2f36be`）：`packages/host/src/outbound-approval.ts` 的
  `ApprovalGatedParticipant` 装饰内层 `RemoteHubViaLink`，`id`/`capabilities` 委托给内层
  使 capability dispatch 仍选中它。`onTask`：写 `approval` inbox item（itemId=task.id）+
  `throw SuspendTaskError({resumeAt: NEVER_RESUME_AT, state})`；`onResume`：批准→
  `inner.onTask(task)` 实发，拒绝→`{kind:'failed', error:'outbound_approval_denied'}`。
  `peer-link-install.ts` 加 `wrapOutbound?:(inner)=>Participant` hook（3 行加性，在
  `hub.register` 前应用）。纯单测（fake decision，无 inbox）。
- **B-M3b**（`0fccd68`）：peer-registry `outboundApprovalGate` 接真 `InboxStore`；main.ts
  `findOwnerUserId` 定默认 approver，**`inboxStore` 构造提到 peer-registry 块之前**（构造
  顺序 gotcha——闭包要拿到它）。真两-hub e2e（inproc link pair + 真 FileInboxStore + 真
  HostInboxService）。

**三个钉死的不变量**（对抗式评审）：① `NEVER_RESUME_AT` 否则 30s sweep 会自动唤醒；
② **必须实现 `onResume`**（不能靠 `onTask` 重跑，否则恢复=再次入闸死循环）；③ item 的
`parentKind` 从 `ancestry.at(-1)` 算——**纠正了 plan 草稿的错误**：派发它的 workflow
步骤本身也挂在 `NEVER_RESUME_AT`（`suspendWorkflow` 抛 SuspendTaskError 停住整个 run），
所以 workflow 派发的出站 task 批准后**确实需要**两步恢复（parentKind='workflow'），
直接派发才是 `'none'`。读 runner 源码而非信 plan 拍的脑袋。

---

## 五、Track C —— A2A 闭环（`ebafdab` → `f43d61f`）

### 5.1 agent card 翻 honest（C-M1，`ebafdab`）

`agent-card.ts` 加 `skills?: AgentCardSkill[]`（`{id,name,description?,tags?}`，A2A 0.2.5
skill 子集，默认 `[]`）+ **显式 opt-in 才枚举**（该文件铁律：public 端点非显式不枚举）。
`main.ts` 从 `buildLocalManifest`（A-M1）派生 skills，但 `GOTONG_A2A_ADVERTISE_SKILLS`
默认关。capabilities 三 flag **仍全 false**——我们只做 blocking `message/send`，不做
streaming / pushNotifications / stateTransitionHistory，诚实不吹。

### 5.2 `@gotong/a2a` 共享包（C-M2，`e1a9d18`）

第 29 个 workspace 包，仿 `@gotong/inbox` 的小聚焦包：
- `types.ts`：0.2.5 `message/send` 请求/结果 + skill 子集 + `A2A_ERROR` 码表
  （PARSE/INVALID_REQUEST/METHOD_NOT_FOUND/INVALID_PARAMS/INTERNAL + 自定义
  SUSPENDED `-32001`/NO_PARTICIPANT `-32002`）+ builders（`textPart`/`userMessage`/
  `agentMessage`/`buildSendRequest`/`messageText`）。
- `client.ts`：`a2aSend(url, token, text, opts)`——fetch POST，`fetchImpl` 可注入做确定性
  测试；`A2aClientError`（带 `.code`）把非 2xx / 非 JSON / JSON-RPC error 统一成可分支
  的 typed 异常。
- **先落类型/client**，让 C-M3 inbound server 与 C-M4 outbound participant 都消费它，避免
  一次性类型重复。

### 5.3 入站 `message/send` → `hub.dispatch`（C-M3，`87b21e0`）

`packages/host/src/a2a-server.ts` 的 `A2aServer.handle(req, res)`：
- **认证（自有 bearer 域，不走浏览器 admin session/CSRF）**：caller 带
  `X-Gotong-Peer-Id` + `Authorization: Bearer <pre-shared token>`，host 侧
  `buildPeerTokenResolver` 取该 peer 期望 token，`timingSafeEqual` 常量时间比 → 401
  fail-closed（unknown/disabled/tokenless peer 全 resolve 成 null → 401）。
- **dispatch 映射（刻意收窄）**：capability 策略 **ONLY**，绝不 explicit participant id
  （跨组织 explicit 泄内部命名且被入站 ACL 拒）；capability = `message.metadata.skill` ??
  配置的 `defaultCapability`，都没有 → invalid_params；`origin = { orgId: <验证过的
  peer>, userId: <messageId> }` 让接收侧 ACL（B-M2）+ 审计看到 who-from-which-org。
- **结果映射**：ok→`agentMessage`（output 的 `{text}` 形状直接取）；failed→`-32603`；
  no_participant→`-32002`；suspended→`-32001`（本版无 task lifecycle 可 poll，parked 跨
  组织调用是 error 而非可 follow 的 Task）。
- web 路由 `/a2a` + `/a2a/message` 在 agent-card 之后、**CSRF 闸之前**（自有 bearer 域），
  鸭子 `A2aServerSurface` 注入（web 零 identity dep）。`GOTONG_A2A_INBOUND_ENABLED` 默认关。

### 5.4 出站 `A2aRemoteParticipant`（C-M4，`31430c9`）

`packages/a2a/src/participant.ts`：`extends AgentParticipant`，`handleTask` 从 payload 抽
text → `a2aSend(url, token, text, {peerId, metadata:{skill: targetSkill}})` → 返
`{text: reply}` 当 ok 输出。**靠基类把 throw 转 `failed`**（A2aClientError → failed），
无 bespoke error plumbing。main.ts `registerOutboundA2aAgents` 从 `GOTONG_A2A_AGENTS` JSON
`[{id,capabilities,url,tokenEnv,peerId?,targetSkill?}]` 程序化注册——bearer 从
`process.env[tokenEnv]` 读（**绝不内联在 blob 里**，secrets 留在 env 通道）；坏 JSON 降级
为「不注册」，坏 entry / 缺 token 只跳过自己。

### 5.5 双 hub A2A smoke（C-M5，`f43d61f`，= 验收门）

`packages/host/tests/a2a-double-hub.test.ts`：两个真 `Hub` 走真 A2A HTTP/JSON-RPC
（loopback `http.createServer` 临时端口 + global fetch），无 LLM、无外网、确定性。

```
Hub A: dispatch capability `translate`
  → A2aRemoteParticipant（出站）
    → POST http://127.0.0.1:<port>/a2a  （真 socket）
      → Hub B A2aServer（入站）—— bearer + X-Gotong-Peer-Id 验证
        → hub.dispatch capability `echo`（来自 metadata.skill）
          → EchoAgent → { text: "echo: hello" }
…文本一路传回成 Hub A 的 task ok 输出。
```

三 case：happy 往返断言确切文本；错 bearer → dispatch `failed`（auth 真在线上闸，不是
静默成功）；metadata.skill 指向 remote 没有的 agent → `failed`（证明 skill 路由被尊重，
不是被某个默认吞掉）。**这一个测试绿 = C 整条链闭环成立。**

---

## 六、测试矩阵（零回归）

| 包 | 总数 | 本 phase 新增 |
|---|---|---|
| `@gotong/a2a`（新） | 15 | 10 client + 5 participant |
| `@gotong/host` | 419 | peer-manifest / outbound-approval(+e2e) / a2a-server / a2a-double-hub |
| `@gotong/web` | 483 | peer-routes / identity-routes-peers policy / a2a route |
| `@gotong/identity` | — | peer-store policy round-trip + v11→v12 迁移 |
| `@gotong/core` | 294 | wrapOutbound hook |

全量 `pnpm -r test` 绿（含 27 个其它包）。host typecheck clean。

---

## 七、运维须知（env 开关一览）

| env | 默认 | 作用 |
|---|---|---|
| `GOTONG_A2A_INBOUND_ENABLED` | `false` | 开入站 A2A `message/send` 端点（暴露 hub 给外部 A2A caller，**默认关**） |
| `GOTONG_A2A_INBOUND_CAPABILITY` | （无） | 入站消息无 `metadata.skill` 时的 fallback 派发 capability |
| `GOTONG_A2A_ADVERTISE_SKILLS` | `false` | agent card 是否枚举本地能力为 skills（public 端点，默认不枚举） |
| `GOTONG_A2A_AGENTS` | （无） | 出站 A2A agents 的 JSON 配置，token 从各 entry 的 `tokenEnv` 指向的环境变量读 |

认证模型：A2A 端点是**自有 bearer 域**——复用 per-peer vault token，跟浏览器 admin
session / CSRF 完全分开。入站 fail-closed（验不过一律 401）。出站 token 永远走 env，不入
配置 blob、不入库、不 commit。

---

## 八、未做 / 显式推迟（保持精简）

- 数据分类标记 + 出站 redaction hook（policy MVP 只做入站 ACL + 出站审批闸，按用户拍板）。
- A2A streaming/SSE + `tasks/get` lifecycle + push notifications（只做 blocking
  `message/send`；suspended 现在直接回 `-32001`）。
- manifest 持久化（peers 加 `last_manifest_json` 列，需要时再加；当前 on-demand RPC +
  in-mem cache）+ manifest 经 WS-HELLO 协商。
- 出站 A2A agent 的 admin-UI 持久化配置（当前 env-only）；出站审批的 per-workflow-step
  粒度（当前 peer/wrapper 级整个出站 task）。
- per-link quota budget；对真实外部（非 Gotong）A2A agent 的 wire 级互操作测试。

---

## 九、commit 清单（13 里程碑 + 本文档）

| M | commit | 摘要 |
|---|---|---|
| A-M1 | `d7a2842` | peer.manifest RPC provider + buildLocalManifest（排除 wrapper） |
| A-M2 | `f995197` | peerFederation surface（in-mem cache）+ admin route |
| A-M3 | `3e278d4` | admin 联邦 tab 浏览/刷新 + i18n |
| B-M1 | `ded20c8` | identity v12 per-peer policy 4 列 + PeerStore + 类型 |
| B-M2a | `8ee9695` | peer-registry 把持久 ACL 传进 installPeerLink（入站生效） |
| B-M2b | `d41cfe9` | web peer CRUD 收/校验 policy 字段 + refreshPolicy |
| B-M3a | `d2f36be` | ApprovalGatedParticipant 装饰器 + wrapOutbound hook + 单测 |
| B-M3b | `0fccd68` | 接真 InboxStore + boot 接线 + 真两-hub e2e |
| C-M1 | `ebafdab` | agent card skills opt-in（翻 honest，capability flags 仍 false） |
| C-M2 | `e1a9d18` | 新包 `@gotong/a2a` —— message/send wire 类型 + client |
| C-M3 | `87b21e0` | 入站 `message/send` HTTP 端点 → hub.dispatch（fail-closed 认证） |
| C-M4 | `31430c9` | 出站 A2aRemoteParticipant + GOTONG_A2A_AGENTS 接线 |
| C-M5 | `f43d61f` | 双 hub A2A smoke（确定性，loopback HTTP，= 验收门） |

一句话：**manifest 是观测层（in-mem，诚实地 unknown），policy 是契约层（per-peer 持久，
入站 ACL + 出站审批闸），A2A 是互操作层（自有 bearer 域，capability-only dispatch，双
hub 确定性闭环）——三层各归各家，互不串线。**
