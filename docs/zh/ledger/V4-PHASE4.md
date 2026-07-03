# AipeHub v4 Phase 4 ——「跨组织 federation」

> Status: 5/5 milestone(FED-M1..M5) 已落地。
>
> Last updated: 2026-05-24
>
> Previous reading: `docs/zh/ledger/V4-ARCH.md`(v4 整体架构) +
> `docs/zh/HUB-MESH.md`(v3 hub mesh / capability routing) +
> `docs/zh/FEDERATION.md`(v3 federation 老文档,本期更新)。

## 一、为什么需要 Phase 4

v4 Phase 1-3 把单 host 内部做扎实了:identity / 多用户 / 邀请 / 审计
全部到位。但 v4 的承诺是「单 host = 单 organization」,所以**真正的
组织协同必然跨 host**。Phase 4 就是把 v3 时代的 hub-mesh(传 task /
message / feedback)升级成「**跨信任域**安全可用」的 federation 层。

v3 hub-mesh 解决的是「两个 hub 之间能通话」;Phase 4 要解决的是:

1. **谁是谁** —— 两端怎么互证身份(不是 TCP 接通就算可信)。
2. **谁让你来的** —— 一个跨组织 task,接收方怎么知道发起方组织里的
   哪个 user / role 推动了它?(没这层信息 audit / 计费 / 限流都做不了)
3. **你能做什么** —— 接收方有没有办法说"vendor-quote capability 对外
   开放,但 admin-only;其他 capability 一律内部独享"?

这就是 FED-M1 / M2 / M3。M4 把上述事件按 v4 audit log 的「`'federated'`
actorSource」约定打进识别栈。M5 是落例子 + 写本文。

## 二、信任模型

```
   组织 acme.local             组织 widgets.local
   ┌─────────────────┐         ┌─────────────────┐
   │  aipehub-host   │         │  aipehub-host   │
   │  ─ identity DB  │         │  ─ identity DB  │
   │  ─ Hub          │ ◀══WS══▶│  ─ Hub          │
   │  ─ peerToken X  │         │  ─ peerToken X  │
   │                 │         │  ─ ACL: only    │
   │                 │         │     vendor-quote│
   │                 │         │     for admin+  │
   └─────────────────┘         └─────────────────┘
        ↑ alice (admin)             ↑ bob (admin)
        ↑ intern (viewer) — 同 RFP 但被对面 ACL 拒
```

### 决策 1:per-peer 共享 secret(`peerToken`)做 mutual auth

不引入 mTLS / PKI 的运维复杂度,先做最朴素的**对称共享秘密**:两个 org
的 owner 私下协商一个长随机字符串(192-bit+ 推荐),双方都在 host 配置
里填进去,启动后 HubLink HELLO/HELLO_ACK 时双向 verify。

- **anti-enumeration**:接收方 verify 失败后**关 socket,不告诉发起方
  原因**。发起方只看到 `peer_disconnected` 类的 opaque close。不让攻击者
  通过"试错信号"探测合法 token 形状。
- **constant-time compare**:`timingSafeEqual` 比较,防远程 timing
  attack(虽然 token 是高熵随机 192-bit,timing 攻击实操不可行,但成本
  零、加上)。
- **同步 reject 空串**:`peerToken: ''` 是典型的"undefined env var
  fallback 到空字符串"配置 bug,构造器 / `connectHubLink` 入口同步抛
  `Error`,不进入 socket 流程。

**不在 Phase 4 做**:per-call signing / JWT / OAuth-style RP-IdP 交互。
peerToken 不是普通"密码"——它本身就是两个 org 之间的整体凭证,泄漏后
就是「换 token + 改两边配置 + 重启」的级别。等真有规模再上 PKI。

### 决策 2:`Task.origin` 由发起方 hub **代填**,接收方**信任**

跨 hub task 的"是谁发的"信息载入 `Task.origin`:

```ts
interface TaskOrigin {
  orgId: string          // 发起方 hub 的对外 id(== peer 寻址用的 self id)
  userId: string         // 发起方 hub 内部的 user id
  userRole?: string      // 'owner' | 'admin' | 'member' | 'viewer' | ...
  userEmail?: string     // 显示用
}
```

填写时机:发起方 hub 的 `RemoteHubViaLink` 在 `onTask` 即将转发前,用
**host 注入的** `OriginResolver` 把本地 `task.from`(internal participant id)
翻成 `TaskOrigin`(去掉 `orgId`,因为 wrapper 自己知道 `selfHubId`)。

**为什么发起方填,而不是接收方"自己查"**:

- 接收方根本不认识发起方组织的 user。
- 发起方 host 持有 IdentityStore,翻译是 O(1) 单次 SQL。
- 这也是 v3-admin / system-internal flow 自然「无 origin」的关键 ——
  resolver 返回 `null` ⇒ wrapper 不打 origin,接收方 ACL 自己决定收不收。

**信任假设**:既然两端已经用 peerToken 互认了,发起方 host 写什么 origin
接收方就**信什么**(发起方 host 没动力骗自己的 admin 是 viewer)。
这降低了协议复杂度。如果未来需要不信任假设(host 被攻破),要走 per-user
签名,**那是 v5 议题**。

### 决策 3:接收方 ACL(`PeerLinkAcl`)是**默认空开放,选择性收紧**

为了**向后兼容** v3 hub-mesh 用户,`installPeerLink` 不传 ACL 时 = 全收
(legacy 行为,既有测试不回归)。要收紧时用三段独立 gate:

| 字段 | 类型 | 作用 | 不设时 |
|---|---|---|---|
| `capabilities` | `string[]` | capability 白名单,task 需要的 capability 必须全部在白名单 | 不查 capability |
| `requireOrigin` | `boolean` | 拒绝无 `origin` claim 的 task | 接受无 origin |
| `requireOriginRole` | `string[]` | 限定 origin 的 `userRole` 值 | 不查 role |

**注意**:`broadcast` 无 capability 过滤的 task 会被 ACL 拒(全网喷),
`explicit` 跨 org dispatch 也会被拒(漏组织内部 id 结构)。要这些行为
的人自己关掉 ACL 即可。

ACL **在 re-dispatch 之前**判定 —— 被拒 task 不进 local hub,不写
transcript,不占 scheduler 时间。错误用 `cross_org_acl_denied (<reason>)`
透回,`reason` 取自:`origin_required` / `origin_role_denied` /
`strategy_not_allowlisted` / `capability_denied:<name>`。

### 决策 4:audit log 用 `'federated'` 作为 actorSource,`metadata.origin` 存全量

```ts
type AuditActorSource =
  | 'v3-admin'    // v3 admin token,无 v4 user
  | 'v4-session'  // 走 web session cookie
  | 'v4-bearer'   // 走 api_key / admin_token
  | 'anonymous'   // 登录失败等无身份动作
  | 'system'      // host 内部 job
  | 'federated'   // ← FED-M4 新增:task 来自 peer hub
```

写 audit row 时,`actorSource: 'federated'` + `metadata.origin: task.origin`,
后续 audit reader 能完整看到「哪个 org 的哪个 user 在 N 时间发起了什么」。
**不试图把 federated user 塞进本 host 的 `users` 表** —— 那会污染身份
模型(他不是这个 org 的人)。

## 三、Phase 4 落地清单

### FED-M1 — HubLink mutual auth(`peerToken`)

**改了哪里**:`packages/transport-ws/src/hub-link.ts`

- `WebSocketHubLinkOptions` 加 `peerToken?: string`
- `connectHubLink` 同名参数,`acceptHubLinks` 同名参数
- MESH_HELLO / MESH_HELLO_ACK 两个 frame 可选携带 `peerToken`
- `verifyPeerToken(received)`:
  - 本地未配置 → 接受任何 token(legacy)
  - 本地配置了但对方没传 → 拒绝(`mutual auth required`)
  - 都配置了但不同 → `timingSafeEqual` 拒绝(`mutual auth failed`)
- 构造时 / `connectHubLink` 入口同步拒 `peerToken === ''`(防 undefined
  env var 这种典型配置 bug)
- verify 失败:接收方 reject handshake + `transitionToClosed('peer_token_invalid')`,
  socket 直接关。发起方那边只感知到一个 opaque close —— 不告诉它"是
  token 不对"还是"网络断了"(防探测)。
- `connectHubLink` 早期 reject 改成在 `new WebSocket()` **之前** 同步抛,
  避免 socket 已开但还没 await 时 emit 的 'error' 变成 unhandled。

**新增测试**(`packages/transport-ws/tests/hub-link.test.ts` +6):

- matching tokens ⇒ handshake OK,task 走通
- mismatched tokens ⇒ OUT 只看到 opaque close(防探测)
- server-requires + client-omits ⇒ 拒
- client-requires + server-none ⇒ 拒
- 都不配 ⇒ legacy 通(回归保护)
- 空串 ⇒ 同步抛(typo defense)

### FED-M2 — `Task.origin` + `OriginResolver`

**改了哪里**:

- `packages/core/src/types.ts`:加 `TaskOrigin` interface + `Task.origin?` 字段
- `packages/core/src/hub.ts`:`dispatch()` opts 接受 `origin?: TaskOrigin`
- `packages/core/src/participants/remote-hub.ts`:加 `OriginResolver` 类型 +
  `selfHubId` / `originResolver` 两个 option;`onTask` 转发前按规则填 origin
  - 规则 1:`task.origin` 已存在 ⇒ 透传(多跳保留原始 claim,不覆盖)
  - 规则 2:resolver 返回非 null ⇒ `{ orgId: selfHubId, ...partial }` 注入
  - 规则 3:resolver 返回 null / 异常 ⇒ 不打 origin(发出去由对面 ACL 决定收不收)
- `packages/core/src/peer-link-install.ts`:`installPeerLink` 把 `selfHubId` /
  `originResolver` 透传给 wrapper;**inbound** 也保留 `task.origin` 字段
  re-dispatch 到 local hub(让本地 audit log 看得到)
- `packages/core/src/index.ts`:导出 `TaskOrigin` / `OriginResolver`

**新增测试**(`peer-link-mesh.test.ts` +6):

- resolver 提供 ⇒ 接收端 task.origin 完整
- resolver 返 null ⇒ task.origin 缺失
- resolver 异常 ⇒ 仍转发但缺 origin(不影响业务)
- 多跳保留(已有 origin 不被覆盖)
- 无 resolver ⇒ 无 origin(回归)
- selfHubId 但无 resolver ⇒ 无 origin(单独配 selfHubId 无意义,但不 crash)

### FED-M3 — 接收方 ACL

**改了哪里**:`packages/core/src/peer-link-install.ts`

- 新增 `PeerLinkAcl` interface(capabilities / requireOrigin / requireOriginRole)
- 新增 `evaluateAcl()` 纯函数(给单 task 出 verdict)
- 新增 `extractRequiredCapabilities(strategy)`:
  - `capability` ⇒ 返回 capabilities 列表
  - `broadcast` 带 capabilities ⇒ 返回 capabilities;不带 ⇒ `null`(拒)
  - `explicit` ⇒ `null`(拒,见上方决策 3 注解)
- `installPeerLink` 在 inbound `'task'` handler 最前面跑 ACL,失败直接返回
  `{ kind: 'failed', error: 'cross_org_acl_denied (<reason>)', by: aclRefusalBy }`
- `aclRefusalBy` 用 `selfHubId` 优先(让发起方日志里看到的是 org 标识,
  而非内部 wrapper id),fallback 到 wrapper id

**新增测试**(`peer-link-mesh.test.ts` +8):

- 无 ACL ⇒ 全收(回归)
- ACL 但 capability 列表里 ⇒ 通
- ACL 但 capability 列表外 ⇒ 拒(error 带 reason)
- `requireOrigin: true` 且无 origin ⇒ 拒
- `requireOrigin: true` 且有 origin ⇒ 通
- `requireOriginRole: ['owner','admin']` 且 role=viewer ⇒ 拒
- `requireOriginRole` 且 role=admin ⇒ 通
- `explicit` strategy 一律被 ACL 拒(防漏组织内部 id)

### FED-M4 — `'federated'` audit actor source

**改了哪里**:

- `packages/identity/src/types.ts`:`AuditActorSource` enum 加 `'federated'`,
  写文档注释("写者应同时把 `task.origin` 塞 `metadata.origin`")
- `packages/identity/src/store.ts`:`AUDIT_ACTOR_SOURCES` 常量加同值;
  `listAuditLog` SQL 加 `, rowid DESC` tie-breaker(同 ms 写入排序稳定)
- `packages/web/src/identity-routes.ts`:`IdentityAuditActorSource` mirror 加值
- `packages/identity/tests/store.test.ts` +1:`'federated'` source round-trip
  + `metadata.origin` 整 JSON 还原测

**注意**:本 milestone **只加了 source 维度,没强制让任何 handler 写
federated 行**。具体哪个 handler 调 `writeAuditLog` 时填 `'federated'` 是
host 自由 —— v4 host 当前只用 'federated' 写跨 org dispatch 端点,后续
出现新的 federated 触发点(如 cross-org HITL request)时由对应 handler
按需写。这是设计 —— 把"federated 是 audit 一等公民"的事实记进 schema,
而 emit 时机交给业务层。

### FED-M5 — examples + docs + 全量测试

**改了哪里**(本 commit):

- `examples/cross-org-rfp/src/demo.ts`:加 `ToyUser` 表,
  `resolveOrgAUser()`(toy `OriginResolver`);Org A 侧
  `installPeerLink` 配 `selfHubId: 'acme-hub'` + `originResolver`;
  Org B 侧配 `selfHubId: 'widgets-hub'` + `acl: { requireOrigin, requireOriginRole: ['owner','admin'], capabilities: ['vendor-quote'] }`;
  `VendorQuoteAgent.handleTask` 打印 `task.origin` 内容;新增「Counter-example:
  intern attempts the same RFP」段(`acme-intern` role=viewer 被 ACL 拒)
- `docs/zh/ledger/V4-PHASE4.md`:本文

## 四、安全决策汇总表

| 维度 | 决策 | 理由 |
|---|---|---|
| Mutual auth | 共享 `peerToken`(192-bit+ 推荐) | 零依赖 / 运维简单;泄漏处理是"换 token 重启"级 |
| Token compare | `timingSafeEqual` | timing 攻击实操虽不可行,但成本零、加上 |
| Token wire format | HELLO/HELLO_ACK 顶层字段 | 不混在 payload,framer 一步取出来 verify |
| Anti-enumeration | verify 失败 socket 关闭,不回错 | 不让 attacker 通过"被拒的形状"探测 |
| 空串拒绝 | 构造同步抛 | 典型 undefined env var fallback bug,失败要早 |
| Origin 信任 | 发起方填,接收方信 | 两端已 mutual auth;不重复 trust 链 |
| Origin 时机 | wrapper.onTask 转发前 | 不污染发起方 hub 内部 dispatch(本地仍按 from 路由) |
| Origin 多跳 | 已有 origin 透传不覆盖 | 多跳场景下原始 claim 是 source of truth |
| ACL 默认 | 全开 | v3 老用户升级到 Phase 4 不破坏现有 mesh |
| ACL 时机 | re-dispatch 之前 | 被拒不进 local hub,不污染 transcript / 不占 scheduler |
| ACL 错误码 | `cross_org_acl_denied (<reason>)` | reason 可机器解析、人也看得懂 |
| `explicit` ACL | 一律拒 | 跨 org 用 explicit id 漏组织内部命名结构 |
| `broadcast` ACL | 无 capability 过滤一律拒 | 跨 org 全网喷几乎必然是 bug |
| audit `'federated'` | actorSource 新值 + `metadata.origin` | 不把 federated user 塞本 host users 表 |

## 五、向后兼容性

**全部 opt-in**:

- 不传 `peerToken` ⇒ legacy hub-link 行为(只要双方都不传)
- 不传 `selfHubId` / `originResolver` ⇒ task 无 origin(legacy)
- 不传 `acl` ⇒ 全收(v3 hub-mesh 行为)
- audit `actorSource` 列没加约束,旧的 `'v4-session'` 等仍合法

既有测试(包括 v3 时代的 hub-mesh E2E)无修改通过。从 v3 → v4 Phase 4
升级:启动后跑;要打开 federation gate 自己改配置加 3 个字段。

## 六、不在 Phase 4 里的事情

| 项 | 为什么 |
|---|---|
| mTLS / PKI | 当前规模 peerToken 够用,PKI 是 v5 议题 |
| per-call user-level signing | 信任假设是「peer host 本身可信」,不需要 |
| OAuth-style cross-org IdP exchange | 同上 |
| `Task.origin` 在 broadcast / message 上的语义 | broadcast 被 ACL 默认拒;message 不带 origin(message 是 pub/sub fan-out,不是 1:1 dispatch) |
| 配额 / 计费 per-org | 等真用起来再做,审计行已经够算 |
| cross-org HITL approval | 在 backlog,需要把 `requestHumanInput` 跨 hub 转发 + 应答路径 |
| federated user 也能登 admin UI | 不做 —— 他不是本 org 的人,登 UI 在哲学上就错了。要做也是 host federation 控制面的事 |
| peer 列表的动态发现 | 现在是 host config 写死。等真有 N peer 再做 registry |

## 七、参考实现:`examples/cross-org-rfp`

最小可跑 demo,单进程双 hub + inproc HubLink:

```bash
pnpm --filter @aipehub/example-cross-org-rfp start
```

跑完会看到:

1. Org A 的 `acme-procurement`(admin)派 RFP → Org B 的 `vendor-quote-agent`
   收到带 origin 的 task → 出 quote 回 Org A,完整端到端。
2. 同 RFP 但发起方换成 `acme-intern`(viewer)→ Org B 的 ACL **不让
   task 进入 local hub**,直接 `cross_org_acl_denied (origin_role_denied)`
   回到 Org A。日志里看不到任何 `[org-b/vendor-quote]` 行,证明 vendor
   agent 完全没被调用。

代码 ~200 行,federation 配线集中在 `installPeerLink` 两个调用。把
`originResolver` / `acl` 改成 production 版(对接 IdentityStore)就是
真实跨 org 部署的最小模板。

## 八、配置参考(production-ish)

```ts
// org A 侧 — 发起方
import { openIdentityStore } from '@aipehub/identity'
import { installPeerLink, Hub } from '@aipehub/core'
import { connectHubLink } from '@aipehub/transport-ws'

const identity = openIdentityStore({ dbPath: '.aipehub/identity.sqlite' })
const hub = Hub.inMemory()
await hub.start()

const link = await connectHubLink({
  url: 'wss://widgets.example.com/peer',
  selfId: 'acme-hub',
  peerId: 'widgets-hub',
  peerToken: process.env.WIDGETS_PEER_TOKEN!, // 长随机字符串,运维侧管理
})

installPeerLink({
  hub,
  link,
  remoteCapabilities: ['vendor-quote'],
  selfHubId: 'acme-hub',
  originResolver: (from) => {
    const u = identity.getUserById(from)
    if (!u) return null
    const m = identity.getMembership(from)
    return {
      userId: u.id,
      ...(m ? { userRole: m.role } : {}),
      userEmail: u.email,
    }
  },
})
```

```ts
// org B 侧 — 接收方
const identity = openIdentityStore({ dbPath: '.aipehub/identity.sqlite' })
const hub = Hub.inMemory()
await hub.start()

const link = await acceptHubLinks({
  port: 8443,
  selfId: 'widgets-hub',
  peerId: 'acme-hub',
  peerToken: process.env.ACME_PEER_TOKEN!, // 与 acme 那边运维同步同一个值
})

installPeerLink({
  hub,
  link,
  selfHubId: 'widgets-hub',
  acl: {
    requireOrigin: true,                       // 拒匿名跨 org task
    requireOriginRole: ['owner', 'admin'],     // 只接 admin+ 角色
    capabilities: ['vendor-quote'],            // 只开 vendor-quote 这一面
  },
  // 接收方一般不需要 originResolver(它不发起 task)
})

// vendor-quote-agent 内部写 audit:
identity.writeAuditLog({
  actorSource: 'federated',
  actorUserId: null,
  action: 'vendor_quote_drafted',
  metadata: { origin: task.origin, totalUsd, leadTimeWeeks },
})
```

## 九、未来工作 backlog

- **cross-org HITL approval**:跨 org task 走到 vendor 侧的 HITL gate
  时,把 `requestHumanInput` 的应答也跨 link 回传(目前 HITL 仅本 hub 内)。
- **peer registry**:多 peer 时不再写死 config,做 host 启动注入 + 运行
  时热加载。
- **per-org 配额**:基于 audit 行的 token 用量统计,软上限触发后 ACL
  自动 fail-open / fail-close 可配置。
- **HubLink TLS pinning**:`peerToken` 之外加固定证书指纹,防 MITM。
- **Origin per-user signing**:host 持有 master key,resolver 出 origin
  时签名,接收方用 host 公钥 verify。把信任假设从「peer host 整体」
  收紧到「peer host 没被攻破的具体 user 上下文」。
