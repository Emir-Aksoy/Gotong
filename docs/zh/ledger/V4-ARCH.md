# AipeHub v4 架构 ——「灵活组织级 agent 框架」

> Status: **historical** —— 本文是 v4 启动 (Phase 1) 时的架构设计文档,
> 记录"为什么这么决策"。最新进度看项目根 `CLAUDE.md` 第二节(Phase 表)
> + 各 phase 的 `docs/zh/V4-PHASEXX-FINAL.md` release notes。如果想知
> 道"现在框架什么样", 别从这里读 —— 这里只解释"v4 当初为什么这样设计"。
>
> 历史 Last updated: 2026-05-24
>
> Previous reading: `docs/zh/HITL-GLOSSARY.md` (HITL 四模式词典),
> v3 examples `federated-team` / `open-space` (federation 基础)。

## 一、为什么需要 v4

v3.1 是一个**单 admin 的工作流引擎**:

- 一个 host 进程 = 一个 `.aipehub/` workspace
- 启动时 mint **一个** admin token,所有 web/api 访问都靠它
- 没有用户概念,没有角色,没有审计单位

这套模型对"个人 / solo dev"够用,但满足不了用户的目标:

> 每一个人、每一个小组织都可以灵活的和 ai 连接,整个组织的工作流和 ai 高效绑定。

所以 v4 的目标是把"agent 框架"扩展成"**组织级** agent 框架"。

## 二、核心架构选择

### 选择 A:**单 host = 单 organization,federation 跨 org**

```
   组织 acme.local          组织 widgets.local        组织 personal.bob
   ┌──────────────┐         ┌──────────────┐         ┌──────────────┐
   │ aipehub-host │ ◀──HubLink──▶ │ aipehub-host │ ◀──▶ │ aipehub-host │
   │  ( m users ) │         │   ( n users ) │         │   ( 1 user ) │
   │  .aipehub/   │         │   .aipehub/   │         │   .aipehub/  │
   └──────────────┘         └──────────────┘         └──────────────┘
```

每个组织起一个 host 实例。组织内有多个 user + role。组织间通过 v3 已经
做好的 `HubLink` / `Capability mesh routing` / `Feedback ledger` 互联。

**为什么不走 SaaS multi-tenant 单进程多 org?**

| 维度 | 单 host = 单 org(A) | 单 host = 多 org(B) |
|---|---|---|
| 数据隔离 | 物理隔离(各自 `.sqlite`) | 逻辑隔离(`org_id` 渗透每条 SQL) |
| 备份恢复 | 单文件 tar 即可 | 必须按 org 切片,运维麻烦 |
| 跨 org 协作 | HubLink(v3 已做) | 单进程内部调用,但 federation 还是要做才能跨进程 |
| Noisy neighbor | 不存在 | 一个 org 的爆量 prompt 拖累所有 org |
| 改动量 | 加 user/role 表 + auth 中间件 | 重写 v3 几十处 data path,加 tenant scoping |
| SaaS 模式 | hosted control plane + 每 org 一个隔离的 host runtime | 一个进程跑 N 个 org |

A 路线代码改动可控,复用 v3 federation,符合"代码尽量简化、节点尽量轻量"。
SaaS 部署模式仍然可以构建在 A 之上 —— 控制面给每个新签约组织开一个
host 容器即可。

### 选择 B:credential 模型「password + admin_token + api_key」三合一

不引入 OAuth/SSO 的复杂度,先做最朴实的三种凭证:

- `password` — 用户密码,scrypt 哈希(node 内置 `crypto`,零外部依赖)
- `admin_token` — owner 级 bearer 令牌(v3 的 admin URL 就是这个 kind,
  迁移后保持兼容)
- `api_key` — 程序级 bearer 令牌(`aipk_<24 字节 base64url>`)

三者共用一张 `credentials` 表,通过 `kind` 字段区分。后续 Phase 2+ 可以
新增 `kind = 'oauth_google'` / `'sso_lark'` 等,**不需要改 schema**,只需要
新插件按约定生成 `identifier` + `secret_hash`。

### 选择 C:**Session 与 Credential 解耦**

Session 在 `auth_sessions` 表,独立于 `credentials`。一次成功 auth → mint 一个
session token(`ses_<24 字节 base64url>`,默认 7d TTL)。Session 可以单独
revoke,credential 也可以单独 revoke,两者互不影响。

这避免了 v3 里 admin token 同时承担"凭证 + 会话"两个角色的耦合问题。

## 三、Phase 1 已落地(本提交)

### 新增 package:`@aipehub/identity` (v0.1.0)

- 零 workspace 依赖(纯领域库,host/web 来 import 它,不反过来)
- 唯一外部依赖:`better-sqlite3`(peer dep,与 `@aipehub/service-datastore-sqlite`
  共用)
- 51 个单元测试全 pass

### Schema(SQLite,`.aipehub/identity.sqlite`)

```
users           id PK, email UNIQUE COLLATE NOCASE, display_name, created_at, last_login_at
credentials     id PK, user_id FK CASCADE, kind, identifier, secret_hash,
                label, created_at, last_used_at  (UNIQUE on (kind, identifier))
memberships     id PK, user_id FK CASCADE UNIQUE, role, created_at
auth_sessions   token PK, user_id FK CASCADE, expires_at, created_at, last_seen_at
schema_migrations  version PK, name, applied_at
```

(单 host = 单 org 模型下,`memberships` 表里没有 `org_id` —— 隐含的 org 就是
本 host。当未来需要"一个 host 服务多 org"时,这就是要加 `org_id` 列的地方。
其他三张表保持 org-agnostic。)

### 公共 API(`@aipehub/identity` 导出)

```ts
openIdentityStore({ dbPath, defaultSessionTtlMs? }) → IdentityStore

class IdentityStore {
  // 初始化
  bootstrap({ adminToken?, ownerEmail?, ownerDisplayName? }) → BootstrapResult

  // 用户
  createUser({ email, displayName?, password?, role? }) → User
  getUserById(id) / getUserByEmail(email) / listUsers() / countUsers()

  // 角色
  getMembership(userId) / setRole(userId, role)

  // 凭证
  setPassword(userId, password)
  issueAdminToken({ userId, label? }) → { token, credentialId }   // 仅展示一次
  issueApiKey({ userId, label? }) → { key, credentialId }          // 仅展示一次
  listCredentials(userId) / revokeCredential(credentialId)

  // 鉴权 → mint Session
  authenticatePassword({ email, password, ttlMs? }) → Session
  authenticateToken({ token, ttlMs? }) → Session

  // Session 查询(hot path)
  getSessionByToken(token) → { user, role, session } | null
  revokeSession(token) / revokeAllSessionsForUser(userId) / cleanupExpiredSessions()

  close()
}
```

### 安全决策

| 决策 | 选择 | 理由 |
|---|---|---|
| 密码哈希 | scrypt(node 内置) | 零依赖、~50-100ms/次,适合交互登录 |
| token 哈希 | sha256 | token 已经是 192-bit 高熵随机,sha256 防 db dump 即可 |
| timing attack | `authenticatePassword` 在 email 找不到时仍跑一次 dummy scrypt | 不让"用户不存在"通过响应时间泄漏 |
| Compare | 全部走 `timingSafeEqual` | 防远程 timing 攻击 hash 比较 |
| TTL | 默认 7d,可 per-call override | session revoke 用 `revokeSession`,不靠 TTL 兜底 |
| FK 行为 | `ON DELETE CASCADE` 用户删 → 凭证 + 会话连带删 | 避免悬挂引用 |

### 兼容 v3 admin token 迁移

v3 host 启动时 mint 的 admin token 通过 `bootstrap({ adminToken: <现有 token> })`
迁移成新模型下的 `admin_token` credential,绑定到新建的 owner user `admin@local`。
**Idempotent** —— 二次启动不会重复创建。这意味着:升级到 v4 后,**旧的
admin URL 继续工作**,用户不需要重新登录。

## 四、Phase 2 计划(下一刀)

集成 `@aipehub/identity` 到 host / web:

1. **host 启动序列**
   - `packages/host/src/index.ts` 加载 `openIdentityStore({ dbPath: <space>/identity.sqlite })`
   - 调用 `store.bootstrap({ adminToken: <v3 mint 的 admin token> })`
   - admin URL 仍打印一次(向后兼容)

2. **web 中间件**
   - 新增 `requireAuth(store)`:从 cookie / Authorization header 取 token,
     调 `store.getSessionByToken`,把 `{user, role}` 挂到 `req.locals`
   - 每个 admin 路由加 `requireRole('admin' | 'owner')` gate
   - 每个 worker 路由保持现状(worker token 是另一套,Phase 3 再迁)

3. **admin UI 增「用户管理」页**
   - 列表 / 创建 / 改角色 / revoke session / 重置密码 / issue api key
   - 用现成的 admin SPA 框架,新增一个路由 `/admin/users`

4. **PG 工作流迁移成 per-user**
   - 现在 PG 的所有 7 agents + caseId 是 admin 级共享的
   - Phase 2 在 caseId 上加 `owner_user_id`,UI 上每个 user 只看到自己的 case

5. **industry-consultation 的 reviewer 角色化**
   - HITL human-review 步骤的 reviewer 不再是「任意 admin」,而是被
     分配到某个 user / role(approver 字段)

### Phase 2 已落地 — `/me` member-facing surface(2026-05-24)

PG / industry-consultation 的"多用户化"原本是 Phase 2 计划。落地形式如下:

**新增路由**(`packages/web/src/me-routes.ts`):

- `POST /api/me/dispatch` —— body `{ workflowId, payload }`,任何 v4
  session 用户(member+ 任意角色)可调。route handler 做三件事:
  1. 校验 `workflowId` 在 `ALLOWED_WORKFLOWS` 允许列表里(目前只有
     `personal-growth-flow` → capability `plan-personal-growth`)
  2. 从 body.payload 里只拿允许列表声明的字段(白名单);未声明的
     字段全部丢弃
  3. **强制** `from = userId`,**强制** `payload.case_id = userId`
     —— member 无法 spoof 他人 caseId
- `GET /api/me/growth-reports` —— 只返回 `caseId === userId` 的报告
- `GET /api/me/growth-reports/download?path=…` —— 解析 path 里的
  caseId 段,严格等值才放行(否则 403 `cross_user_forbidden`)
- `GET /api/me/allowed-workflows` —— 暴露允许列表,UI 用它渲染表单
- `GET /me` —— 独立静态页(`static/me.html` + `static/me.js`),
  vanilla DOM,登录 / 触发 / 报告三段式

**v3-admin Bearer/cookie 故意不被 /me 接受** —— v3 admin 没有 v4 user id
可绑定 caseId,所以走 /admin。owner 想跑 /me 工作流时,以自己的 v4
user 身份登录(`admin@local` + 设过的密码)即可。

**安全契约**:case_id 由后端拍板,member 哪怕 curl 直接构造
`{payload: {case_id: 'someone-else'}}` 也会被丢弃。报告路径里的
caseId 段是 path-traversal 防线的最后一道(不只是
`..` 拦截,还要等值校验)。15 个新加的 HTTP 测试把这套契约全部钉死。

**PG agent 改动**:`personal-growth-context.ts` 的注释从「caseId = admin
id」更新为「caseId = userId,由 /me 路由强制」。agent 本身的 `pickCaseId`
已经从 `task.payload.case_id` 读,无需代码改动 —— 也就是说,从 PG
agent 的角度看,/me/dispatch 跟 owner 手填 case_id 在 /admin/dispatch
是同一码事。

**industry-consultation** 无代码改动 —— 该 example 本来就是 programmatic
+ payload.caseId-driven 的多 case 设计,可以作为参考模板。

**未覆盖**(后续):
- `/me` 上没有"查看 / 重启某次 workflow run"的 UI(暂只是触发 + 看报告)
- 报告 markdown 还是直接下载,没在 /me 页面里渲染
- 没加 `/me/whoami` 别名(目前仍走 `/api/admin/identity/me`,该路由已
  被搬到 owner gate 之上,member 也能调)

### Phase 14 addendum — `/me` 通用化(2026-05-31)

> 上面的 Phase 2 快照按 append-only 约定保留。下面是 Phase 14 对它的更新:
> 凡涉及「单工作流 / 硬编码 allowlist / `/allowed-workflows`」的描述都已被
> 通用化取代。

Phase 2 的 `/me` 只对**单一**工作流(`personal-growth-flow`)开放,allowlist
是 `me-routes.ts` 里硬编码的 `ALLOWED_WORKFLOWS` 表。Phase 14 把它泛化成
**工作流声明驱动**:

- **删** `GET /api/me/allowed-workflows`(上面那条)、硬编码
  `ALLOWED_WORKFLOWS`、`listAllowedWorkflowsForMe`。
- **改** `GET /api/me/workflows` —— 请求时从 `WorkflowSurface.list()` 派生
  catalog,只保留声明了 `surface.me.enabled` 且 `allowedRoles` 含调用者 role
  的工作流;只投影 `{id,label,description,inputSchema}`(故意不暴露
  `capability` / `userScopeField` 等内部强制细节,暴露 = 送探测面)。
- **泛化** `POST /api/me/dispatch` —— 对**任意** member-facing 工作流生效,
  归属键不再写死 `case_id`,改用工作流声明的 `surface.me.userScopeField`
  (缺省仍 `case_id`);`payload[userScopeField] = userId` 强制覆盖逻辑不变。
- **新安全边界**:没声明 `surface.me.enabled` 的工作流从 `/me` 调用一律 403
  —— `enabled` 门**就是**安全边界(`resolveMeWorkflow` fail-closed)。授权
  信任从「改 TS 的提交者」位移到「import YAML 的 admin」(`/api/admin/
  workflows/import` 本就 admin-gated)。

上面「安全契约」那段(case_id 由后端拍板、报告路径等值校验)**不变**,只是
「case_id」现在泛化为「`userScopeField`」。growth-reports 的过滤 + 下载 ACL
完全没碰。详见 `docs/zh/ledger/V4-PHASE14-FINAL.md`。

## 五、Phase 3 + 计划(更远)

- **federation 与 identity 衔接** —— HubLink 跨 org 调用时,带上发起方
  org + user 的 verifiable claim(可能需要简单的 JWT 签名,共用 host 的
  master key)
- **OAuth / SSO 插件** —— `@aipehub/identity-oauth-google` / `-lark` /
  `-azure-ad`,通过新增 `credentials.kind` 接入
- **审计日志** —— `audit_log` 表,记录每次"谁 / 什么时候 / 对谁 / 做了什么"
- **配额 / 计费** —— per-user / per-org 的 token 用量统计 + 软上限

## 六、不在 v4 里的事情

| 项 | 为什么 |
|---|---|
| 多 org 单进程 | 见上方"选择 A" |
| 可视化 workflow 编辑器 | 需要前端栈大改,放进 Phase 3+(或独立产品决策) |
| RAG / 文档上传 / 知识库 | 独立的 Phase 3+ track,和身份正交 |
| 邮件发送(密码重置 / 邀请通知) | 等真正有多用户场景再做,Phase 2 用 admin 直接 issue 临时密码 |
| MFA / 2FA | Phase 3,先把单因子打磨稳 |

## 七、Migration 注意事项

升级到 v4 时,host 启动序列需要:

1. 跑 `applyMigrations(db)` —— 自动幂等
2. 读取现有 admin token(从 `<space>/runtime/admin-token` 或环境变量)
3. 调 `store.bootstrap({ adminToken: <token> })`
4. 第一次:owner user `admin@local` + 该 token 作为 admin_token credential
5. 之后:no-op(`bootstrapped: false`)

这意味着:**没有数据迁移脚本,没有破坏性变更,旧用户的 admin URL 在
v4 上继续工作。**

如果用户想升级到「真正的用户名 + 密码」登录:

```ts
// 用现有 admin token 登录 → 获得 session token → 拿 session token 创建新用户
const session = store.authenticateToken({ token: oldAdminToken })
const me = store.createUser({
  email: 'real-name@company.com',
  password: '<chosen-pw>',
  role: 'owner',
})
store.setPassword(me.id, '<chosen-pw>')
```

(后续 admin UI 会把上面这套包装成一个「初始化我的账户」向导。)
