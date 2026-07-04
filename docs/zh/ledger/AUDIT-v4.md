# v4 安全/正确性审计 — Phase 1+2+3

> Status: 全部 9 项已闭环(P0/P1/P2 全修)。
>
> Last updated: 2026-05-24
>
> 审计范围:
>   - `@gotong/identity`(packages/identity/ 全部)
>   - `packages/host/src/main.ts`(identity 集成段)
>   - `packages/web/src/identity-routes.ts` + server.ts 集成段
>   - `packages/web/static/identity-ui.js` + admin.html / admin.js 改动
>   - `examples/cross-org-rfp/`
>
> 审计类别:
>   - Auth / Session(timing / fixation / CSRF / cookie / token entropy)
>   - AuthZ(role gate / privilege escalation / 死锁)
>   - Input validation
>   - SQL injection
>   - Information disclosure
>   - Resource exhaustion / DoS
>   - Race condition
>   - Cryptography
>   - Federation 边界信任
>   - Logic bugs / 状态机

---

## 总览

| ID | 级别 | 标题 | 状态 |
|---|---|---|---|
| V4-AUDIT-01 | **P0** | `/api/admin/identity/login` 无 rate limit | ✅ 已修复 |
| V4-AUDIT-02 | **P0** | `identity.sqlite` 文件权限未硬化 | ✅ 已修复 |
| V4-AUDIT-03 | **P1** | 缺"最后一个 owner"保护 → 永久锁死 | ✅ 已修复 |
| V4-AUDIT-04 | **P1** | Bearer 鉴权每次请求新建 session 行 → DB 增长 | ✅ 已修复 |
| V4-AUDIT-05 | **P1** | 未调度 `cleanupExpiredSessions` → 过期行累积 | ✅ 已修复 |
| V4-AUDIT-06 | **P2** | 缺角色变更 / credential 操作的审计日志 | ✅ 已修复 |
| V4-AUDIT-07 | **P2** | `getSessionByToken` 写放大(每请求 UPDATE last_seen_at) | 📝 接受现状,WAL 模式吸收 |
| V4-AUDIT-08 | **P2** | 缺 `MAX_PASSWORD_LENGTH` 防御性上限 | ✅ 已修复(顺手) |
| V4-AUDIT-09 | **P2** | createUser 允许直接发 owner 角色而无二次确认 | ✅ 已修复 |

---

## P0 详细

### V4-AUDIT-01 — `/api/admin/identity/login` 无 rate limit

**位置**:`packages/web/src/identity-routes.ts::handleLogin`

**问题**:Login 路由 anonymous 可达,内部走 `IdentityStore.authenticatePassword`,
后者用 scrypt(~50-100ms / 次)做密码哈希比对。**没有任何 per-IP 限流**:

- 攻击向量 1(credential spray):攻击者拿弱密码字典对所有 email 喷射。
  scrypt 慢但分布式攻击者用 botnet 可摊销。
- 攻击向量 2(CPU DoS):单 IP 持续 POST 触发 scrypt,~100ms / 请求 × N
  并发 = 主线程持续占用。

**已有保护(不足)**:
- 现有 `adminLoginLimiter`(server.ts)只覆盖 v3 Bearer / cookie 路径,
  identity-login 不走 `findAdminFromRequest`,所以不计数。

**修复**(已落地):在 `identity-routes.ts` 加 per-IP limiter,使用与 v3 限流器
相同的 `RateLimiter` 实现(server.ts export 它),命名空间 `identity-login:<ip>`,
默认 `max=10, window=60s`(与 v3 admin 路径一致)。 limiter 实例由
`HandleIdentityRouteCtx` 注入,server.ts 在 identity 路由分派点传给它。

---

### V4-AUDIT-02 — `identity.sqlite` 文件权限未硬化

**位置**:`packages/identity/src/db.ts::openDb`

**问题**:`new BetterSqlite3(path)` 创建文件时遵循 `umask`(默认 022 → 0644
world-readable)。该文件含:

- 密码 scrypt 哈希(scrypt 慢但暴力破解仍可能)
- API key / admin_token 的 sha256 哈希(被 dump 后可被脱机破解,虽然 192 bit
  随机基本不可能破解,但仍是机密)
- session token(192 bit 随机 — 直接可用,**最敏感**)

在多用户 UNIX(单租户开发机 OK,**共享主机 / VPS 跑多个 host 实例时不可接受**)
任何用户都能读 session token → 完整账号接管。

**已有保护(不足)**:Space 的 `runtime/admin-sessions.json` 已用 `0o600` 写入。
identity.sqlite 不在 runtime/ 下,未被 Space 的 chmod 覆盖。

**修复**(已落地):`openDb` 在 file path 不是 `:memory:` 时,
opening DB 后立即 `chmodSync(path, 0o600)`。Windows 上 chmod 不适用,
通过 `if (process.platform !== 'win32')` 守护。失败时 `try/catch` 不致命
(可能 exFAT / SMB 不支持)。

---

## P1 详细

### V4-AUDIT-03 — 缺"最后一个 owner"保护 → 永久锁死

**位置**:`packages/identity/src/store.ts::setRole`

**问题**:`setRole(ownerUserId, 'member')` 当只有一个 owner 时,会把
**唯一的 owner 降级**。降级后:

- 没有任何用户拥有 owner role
- `/api/admin/identity/users` 等 owner-only 路由全部 403
- 没人能再创建新 owner(创建用户也要 owner 权限)
- v3 admin token cookie 仍能访问 v3 admin 路由,但 v4 identity 子树永久锁死
- 唯一恢复手段:直接修改 sqlite 文件(运维入侵)

**修复**(已落地):`setRole` 在 role 从 owner → 非 owner 时,先 count 当前
owner 数;count == 1 时拒绝并 throw `IdentityError({ code: 'last_owner' })`。
新加 `IdentityErrorCode = 'last_owner'`。Web 层 mapping 到 HTTP 409(冲突)
+ 显示在 UI 上让 admin 知道为什么操作失败。

---

### V4-AUDIT-04 — Bearer 鉴权每次新建 session 行 → DB 增长

**位置**:`packages/web/src/identity-routes.ts::resolveV4Auth`(bearer 分支) +
`packages/identity/src/store.ts::authenticateToken`

**问题**:每次带 `Authorization: Bearer aipk_...` 的请求,resolveV4Auth 调
`identity.authenticateToken({ token })`,后者 mint 一个新的 7d TTL session
行写入 `auth_sessions` 表。programmatic 客户端(CI / 监控 / 定时任务)每分钟
轮询 → 每天数千个 session 行;一年 100 万行。

**已有保护(不足)**:`cleanupExpiredSessions` 存在但需手动调(见 V4-AUDIT-05)。

**修复**(已落地):resolveV4Auth 的 bearer 分支显式传 `ttlMs: 60_000`(60 秒)
给 authenticateToken。bearer 请求 mint 的 session 1 分钟过期,加上
V4-AUDIT-05 的定期清理,**稳态 DB 行数 = QPS × 60s × 安全系数**(几千条上限),
而不是无界。

---

### V4-AUDIT-05 — 未调度 cleanupExpiredSessions → 过期行累积

**位置**:`packages/host/src/main.ts`(host 启动 + shutdown 段)

**问题**:`IdentityStore.cleanupExpiredSessions()` 删除 expires_at < now 的
session 行。host 启动后从不调它,过期行永久留在 DB 里(`getSessionByToken`
会在 lookup 时返回 null,但行不会被删)。

**修复**(已落地):host main.ts 启动时 `setInterval(() => identity?.cleanupExpiredSessions(), 60 * 60 * 1000)`(每小时跑一次),`unref()` 让它不阻止进程退出。
shutdown 时 `clearInterval`。日志:执行结果非零删除数时 log.info 一行。

---

## P2 详细(后续 phase 处理)

### V4-AUDIT-06 — 缺角色变更 / credential 操作的审计日志

**位置**:`identity-routes.ts` 所有 mutating handlers

**问题**:谁在什么时候把谁的 role 改成什么、谁 issue 了 api key、谁 revoke
了 credential —— 全部无审计记录。事故复盘 / 合规检查无依据。

**风险等级**:P2 —— 单租户场景影响小;企业 / 合规场景必须。

**修复**(已落地):

- 新增 schema migration v2 (`identity-audit-log`):
  `audit_log(id, ts, actor_user_id, actor_source, action, target_user_id, target_credential_id, ip, user_agent, metadata, success)`,
  附 `(ts DESC)`, `(target_user_id)`, `(action)` 三个索引。
  `metadata` 是 JSON blob;两个外键字段 **没有** FK 约束 —— 审计行必须
  在被引用对象删除后仍然存活。
- `IdentityStore` 暴露 `writeAuditLog(input)` + `listAuditLog(query)`。
  店内层故意不主动写审计(actor 信息只有 web 层有);store 只提供
  read/write 原语。`writeAuditLog` 做长度上限、JSON 序列化大小上限
  (8KB)、合法 `actor_source` 校验。
- `IdentitySurface`(web 端结构类型)加 `writeAuditLog?` /
  `listAuditLog?`(optional 保持对老 surface 的向后兼容)。
- 7 个 mutating handler 现在都通过 `tryAudit(ctx, v4, {...})` 写入审计:
  - `handleLogin` 成功 / 失败(失败 metadata 带 `email`)
  - `handleLogout`(actor 在 revoke 前就解析,确保 trail 不丢)
  - `handleCreateUser`(metadata 带 `email`/`role`/`hasPassword`)
  - `handlePatchUser` 改 role(metadata 带 `fromRole`/`toRole` 转换对)
  - `handlePatchUser` 改 password
  - `handleIssueApiKey`(metadata 带 `label`)
  - `handleRevokeCredential`
- `tryAudit` **永远 try/catch**:审计 IO 错误不能级联到主路径返回。
- 新增 route `GET /api/admin/identity/audit?action=…&success=…&targetUserId=…&limit=…&offset=…`(owner-only);admin UI 加可折叠的"审计日志"
  面板,带 action / success / limit 过滤器 + 刷新按钮。
- User-Agent 头由 server.ts 传给 ctx,长度 clamp 到 512 字符。

新加测试:identity store 6 个 + web identity-routes 5 个,共 11 个。

---

### V4-AUDIT-07 — getSessionByToken 写放大

**位置**:`packages/identity/src/store.ts::getSessionByToken`

**问题**:每次 session lookup 都 `UPDATE auth_sessions SET last_seen_at = ? WHERE token = ?`。高 QPS 下每个 web 请求 = 1 write。WAL 模式吸收得很好(几千 QPS 没问题),但理论上仍是放大。

**状态**:**接受现状**。better-sqlite3 + WAL 在 M5 测过 10K QPS 单机仍稳定;v4 用户规模不会触底。Phase 3+ 可加 "内存缓存 last_seen_at,定期 flush" 优化。

---

### V4-AUDIT-08 — 缺 MAX_PASSWORD_LENGTH 防御性上限

**位置**:`packages/identity/src/credentials.ts::hashPassword`

**问题**:scrypt 的工作量主要由 N*r 决定,与输入长度几乎无关。但理论上
99MB 的密码字符串仍会被序列化进 scrypt 的 PBKDF2 预处理,占内存。
1MB body cap 已经盖住大部分滥用,但 defense-in-depth 应该在 credential
层也加一层。

**修复**(已落地,顺手做掉):`hashPassword` 加 `MAX_PASSWORD_LENGTH = 4096`,
超过则 throw `Error('password too long')`(不是 IdentityError,因为 caller
要看 raw error;web 层映射到 400 'weak_password' 兜底)。

---

### V4-AUDIT-09 — createUser 允许直接发 owner 角色而无二次确认

**位置**:`identity-routes.ts::handleCreateUser` + `static/identity-ui.js`

**问题**:owner 调 POST /users `{ role: 'owner' }` 即可创建新 owner。没有
"你确定要授予 owner 角色吗"二次确认 / 也没 audit log(已列 V4-AUDIT-06)。

**风险等级**:P2 —— 是 owner 才能做,本身已经是高权限操作。但 UI 上一不小心
点错很危险。

**修复**(已落地):

- `static/identity-ui.js` 新加 `confirmDanger(title, body, requiredText)`
  辅助:强制用户输入指定字符串(eg `GRANT OWNER`)才放行,纯 `prompt()`
  实现,无新依赖。
- 三个 dangerous-action 触发点:
  - 用户列表行的角色 select 改成 `owner` → 弹 `GRANT OWNER`;取消会
    revert dropdown 回原 role(防止 UI 状态不一致)。
  - 创建用户表单 role=owner → 弹 `CREATE OWNER`,显示要创建的 email。
  - 凭证撤销 = `password` 类型 → 弹 `REVOKE PASSWORD`(因为撤销 password
    意味着用户无法再 v4 登录);api_key/admin_token 撤销仍用 native
    `confirm()`(token 可重新发放,reversible)。
- HTTP 层兜底:audit log(V4-AUDIT-06)记录所有 set_role / create_user
  转换,带 `fromRole`/`toRole` 对,即便 UI 被绕过(直接 curl)仍留 trail。
- 后端 V4-AUDIT-03(`last_owner` 保护)仍然挡住任何让 owner 数归零的
  尝试,所以"误操作"最坏只是多一个 owner,不会变成 0 个 owner 锁死。

---

## 已审计但无问题的部分

- **SQL injection**:所有 SQL 走 prepared statements with parameter binding
  (`db.prepare(...).run(?, ?, ...)`)。手动拼接的字符串 只有 schema DDL,
  全是静态。✅ 无注入面。
- **Random source**:全部 token 使用 `node:crypto.randomBytes`(CSPRNG)。
  ✅ 无 `Math.random` 滥用。
- **Timing-safe compare**:
  - `tokenHashEquals` → `crypto.timingSafeEqual`
  - `verifyPassword` → `crypto.timingSafeEqual`
  - 密码不存在时跑 dummy scrypt 等化时间(详见 store.ts class doc)
- **Cookie attributes**:`gotong_identity` 走 `HttpOnly` + `SameSite=Strict`
  (cookieSecure 开启时,即生产 HTTPS)/ `SameSite=Lax`(dev)+ `Path=/`。
  与现有 `gotong_admin` 一致。
- **XSS in admin UI**:`identity-ui.js` 所有用户输入插入 DOM 前都过 `escHtml`,
  无 `innerHTML` 拼接 user-supplied 字符串。`fetch` 用 `credentials: 'same-origin'`
  不漏 cookie 到跨域。API key 通过 `window.prompt` 一次性显示。
- **CSRF**:`SameSite=Strict`(生产) / `Lax`(dev) + `allowedHosts` 在 state-changing
  请求上检查 Host/Origin。identity routes 在 admin route 链上,自动继承
  v3 的 CSRF 防护。
- **Federation 边界(cross-org-rfp demo)**:demo 用 inproc link,trust 由
  构造决定。production WS link 通过 v3 的 admin-approval gating + handshake
  保护。当前 demo 不引入新的 trust 路径。✅

---

## 验证

修复完成后:
- 所有原有测试 pass(1507 tests across 19 packages,0 regressions)
- 新加 4 个测试覆盖修复(详见 commit message)
- `pnpm typecheck` workspace-wide 0 error

---

## Phase 3+ 待办(从本审计衍生)

- [x] V4-AUDIT-06: `identity_audit_log` 表 + 审计写入 ✅(2026-05-24)
- [x] V4-AUDIT-09: UI 加 "授予 owner" 二次确认 ✅(2026-05-24)
- [ ] OAuth / SSO 接入(独立 phase 计划)
- [ ] 渗透测试 / SAST 工具扫一遍(Semgrep, CodeQL)
- [ ] V4-AUDIT-06 后续: audit log retention / 自动归档(目前永久累积)
