# v4 Phase 3 安全审计 — /me + invitations

> Status: 7/7 已闭环(P1 + 5×P2 + 1×P3 全修)。
>
> Last updated: 2026-05-24
>
> 审计范围:
>   - `/api/me/*`(`packages/web/src/me-routes.ts` + me.html / me.js)— Phase 2 member 面向 surface,顺带回顾
>   - 邀请流程(`packages/identity/src/store.ts` invitation 段 + `types.ts` + `schema.ts` v3 migration + `errors.ts` 5 个新码 + `tokens.ts` newInvitationToken)
>   - 邀请路由(`packages/web/src/identity-routes.ts` invitation handlers + `server.ts` /api/invites/* + /invite/<token> 静态路由)
>   - 邀请 UI(`packages/web/static/identity-ui.js` invitation panel + `invite.html` + `invite.js`)
>
> 审计方法:Phase 3 改动由 AI 撰写后,独立 AI 审计员重新通读所有文件,按
> Auth/AuthZ/Input validation/SQL injection/Information disclosure/DoS/
> Race/Crypto/Logic/CSRF 十个维度系统扫描。本文是审计员发现 + 作者评估
> 后的汇总,每项注明决策(修 / 接受现状 / nit 不修)。

---

## 总览

| ID | 级别 | 标题 | 状态 |
|---|---|---|---|
| AUDIT-P3-01 | **P1** | `/api/me/dispatch` 无速率限制 → member 可耗尽 LLM 配额 | ✅ 已修复 |
| AUDIT-P3-02 | **P2** | `/api/me/growth-reports` list 无速率限制 + 全量扫盘 | ✅ 已修复 |
| AUDIT-P3-03 | **P2** | `createInvitation` 路由无 owner-mutation 限流 → owner 凭据泄漏后可塞爆 DB | ✅ 已修复 |
| AUDIT-P3-04 | **P2** | `hashPassword` 抛 plain Error,accept 路由 fallback 到 "internal error",真原因被吞 | ✅ 已修复 |
| AUDIT-P3-05 | **P2** | `/invite/<token>` 把 secret 放 URL path → 浏览器 history / 截图 / 未来 referrer 泄漏风险 | ✅ 已修复 |
| AUDIT-P3-06 | **P2** | 注释声称 RateLimiter 跨 namespace "共享 budget",实际是独立 bucket | ✅ 已修复(只改注释,行为不动) |
| AUDIT-P3-07 | **P3** | invite.html / me.html / admin.html 缺 `X-Frame-Options` / `Referrer-Policy` / CSP | ✅ 已修复 |

---

## P1 详细

### AUDIT-P3-01 — `/api/me/dispatch` 无速率限制

**位置**:`packages/web/src/me-routes.ts::handleMeDispatch`(L193-289)

**问题**:`/api/me/dispatch` 的 auth gate 只检查"是任意 v4 user",一旦
通过就直接 `hub.dispatch(...)` —— personal-growth-flow 工作流派一次
就跑 7 个 LLM agent(coach × 7),消耗 owner 配在 host 上的 DeepSeek /
OpenAI / Anthropic API 额度。**没有 per-user 速率限制**。

**攻击向量**:

1. 一个 invitee 接受邀请后(完全合法的低权限 member),写脚本循环
   POST `/api/me/dispatch` → 每秒数十次派发 → 烧光 host 的 LLM API
   额度 + agent pool 资源耗尽 + audit log 增长。
2. 同样适用于普通 member 账号被 phish 后被劫持。
3. 注意:Phase 2 写这个路由时只想着"member 自助",没考虑 invitee
   信任度的问题(invitee 是 owner 主动加进来的没错,但邀请被拦截 /
   被泄漏 / 内部叛变都是真实威胁)。

**修复**:在 `handleMeDispatch` 入口加 per-userId 限流。复用现有
`adminLoginLimiter` 的 `RateLimiter` 实现,key 用 `me-dispatch:<userId>`,
默认 `max=10, window=60s`(personal-growth 一次跑 5-15 分钟,每分钟 10 次
对真实使用绰绰有余,对脚本喷射是硬上限)。over 直接 429 with retry-after。

---

## P2 详细

### AUDIT-P3-02 — `/api/me/growth-reports` 无速率限制 + 内存 filter

**位置**:`packages/web/src/me-routes.ts::handleMeListReports`(L295-319)

**问题**:`growthReports.list()` 返回 host 上**所有**报告(注释自承
"every report on the host (designed for owner-gated UI)"),然后在
JS 内存里 `filter(r => r.caseId === userId)`。报告多时单次请求耗
IO + CPU + 内存。也无限流。

**攻击向量**:invitee 写循环 GET `/api/me/growth-reports` → host 每次
全表扫 → 单 IP 即可拖慢 host。

**修复**:

1. **本轮修**:加 per-userId 限流,`me-reports:<userId>`,
   `max=30, window=60s`(列报告是轻读,额度可以宽松)。
2. **下轮做**:把 caseId filter 推到 `growthReports` surface 层
   (新增 `list({ caseId })` 签名),避免 IO 浪费。这是 surface 接口
   改动,不在本审计范围,记进 backlog。

---

### AUDIT-P3-03 — `createInvitation` 无 owner-mutation 限流

**位置**:`packages/web/src/identity-routes.ts::handleCreateInvite`
(L1021-1110)

**问题**:`POST /api/admin/identity/invites` 只受 owner gate 保护,无
速率限制。owner cookie / admin-token 泄漏的攻击者(P1 假设外的二线场景)
可循环创建 N 万级邀请记录,撑爆 `invitations` 表 + `audit_log`(每次
create_invitation 也写一行 audit)。store 端 `createInvitation` 的
"同 email 只允许一个 pending" 检查只是单 email 防滥用,不限**总数**。

**攻击向量**:泄漏的 owner credential 调 createInvite 循环 → DB 无界
增长 → 磁盘耗尽 → host 崩。

**修复**:

1. 加 per-owner mutation budget:key `owner-mutation:<userId>`(v3-admin
   走 `owner-mutation:v3-admin:<ip>`),`max=60, window=60s`。
2. **不在本轮做**(记 backlog):邀请总数硬上限,如同时 pending ≤ 100。
   理由:对正常 org 太局促(50 人公司搞 onboarding wave 就触发),需要
   配置项,改动面大。

---

### AUDIT-P3-04 — `hashPassword` 错误未携带 IdentityError code

**位置**:`packages/identity/src/credentials.ts::hashPassword` + 调用方
`packages/web/src/identity-routes.ts::handleAcceptInvite` 1352-1366

**问题**:`hashPassword` 在密码不满足强度时抛 plain `Error`,不是
`IdentityError({code: 'weak_password'})`. handleAcceptInvite 的 catch
走 `sendIdentityError(res, err, 400)` → `asErrorWithCode` 返回 null
(因为没有 `.code` 字段)→ 用户看到 `{error: 'internal error'}` 状态
500,真实"密码太短"信息被吞。

**影响**:UX bug,不是安全 issue。但效果是:

- accept 页用户反复试都不知道为什么失败 → 反复 POST → 触发 limiter
  → 401 之后无法重试(直到 60s 后)。
- 运维看 log 也是 "internal error",误以为后端故障。

**修复**:

1. 改 `hashPassword` 抛 `IdentityError({code: 'weak_password',
   message: '...'})`. 这是 identity 包内的纯重构,不破坏 API
   (调用方原来 catch 的都是 `Error` 父类)。
2. 同时 audit `sendIdentityError` 默认 fallback:把 unknown error 的
   `err.message` 也带进 response 而非吞为 "internal error" —— 但要
   防泄漏堆栈,只取 `.message`。

---

### AUDIT-P3-05 — `/invite/<token>` token 在 URL path 中

**位置**:`packages/web/src/server.ts::handleAdminOrWorker`(/invite
静态路由)+ `packages/web/static/invite.html`

**问题**:邀请 token 是**机密**(任何人持有就可创建账号),但当前在
URL 路径里:

- 浏览器 history / 自动同步 (Chrome Sync, Safari iCloud, Firefox
  Account) 会带它
- 用户截图 / 转发 URL 会带它
- tab title 通常带 URL
- 若 invite.html **未来**加任何外部资源(头像、analytics、字体 CDN),
  Referer 头会泄漏完整 token
- 反向代理 access log 会记录完整 URL

**当前不漏的部分**:invite.html 现在零外链,所以 Referer 没机会泄漏。
但这是定时炸弹 —— 谁知道下次哪位 PR 加个 Google Fonts 就炸。

**攻击向量**:用户截图发邀请页给同事问"这是什么",截图带 token →
同事或上下文窃听者可以抢先 accept 这个邀请,接管账号。

**修复**:

1. **本轮修(最便宜)**:invite.html 加 `<meta name="referrer"
   content="no-referrer">`. 阻止任何 outbound 请求把 token 当 Referer
   送出去。
2. **本轮修(便宜)**:invite.js 在 lookup 成功后立即
   `history.replaceState({}, '', '/invite')` 把 URL 清成 `/invite`
   (token 已在内存里),浏览器 history / 同步看到的是干净 URL。token
   只在前两秒钟出现在 URL,大幅缩短窗口。
3. **不本轮做**(评估):用 fragment(`/invite#token=...`)。fragment
   不上 Referer 也不进 proxy log。但 fragment 不能自然分享(用户复制
   URL 经常丢 fragment),需要重大 UX 调整。延后到 backlog。

---

### AUDIT-P3-06 — RateLimiter namespace 注释误导

**位置**:`packages/web/src/server.ts` ~L1054 的注释 + 多处复用注释

**问题**:server.ts 的注释说"share the v3 limiter so an attacker
cannot get extra budget by switching ... both consume the same per-IP
slot, just under different namespaces"。**实际不是**。`RateLimiter`
以完整 key string 作 bucket key,所以 `identity-login:<ip>` 与
`bearer:<ip>` / `cookie:<ip>` / `invite-accept:<ip>` 是 4 个独立
bucket,每个独立 10/min,总共 40 次/min。每面单独保护没错,但跨面
切换可达 4× budget,违背注释意图。

**评估**:这是注释误导,不是 budget 设计问题。每面单独 budget 反而
更合理(login fail 不应 punish 后续 invite accept,反之亦然)。

**修复**:把注释从"共享 budget"改成"复用 RateLimiter 实例(避免
再起一个),budget 跨 namespace 独立 by design"。**不动行为**。

---

## P3 详细

### AUDIT-P3-07 — 静态页缺安全 header

**位置**:`packages/web/static/{admin,me,invite}.html` 由
`packages/web/src/server.ts::serveStatic` 服务

**问题**:三个页面都没有:

- `X-Frame-Options: DENY`(clickjacking 防御)
- `Referrer-Policy: no-referrer`(referrer 控制)
- 任何 CSP header

**攻击向量(理论)**:恶意网站 iframe 这些页面叠加诱骗 click。
当前 admin 是 owner cookie 保护(iframe 拿不到 cookie,真实点击也
会被 SameSite=Strict 拦),所以利用面窄,但不是零。

**修复**:在 `serveStatic` 给所有 HTML response 默认加:

```
X-Frame-Options: DENY
Referrer-Policy: no-referrer
X-Content-Type-Options: nosniff
```

CSP 暂不加 —— admin.js inline event handler 多,加严格 CSP 会破坏
现有功能,需要专项重构。

---

## 通过审计未发现问题的项(为完整性)

- **A. token 生成熵**:`newInvitationToken()` 用 `randomBytes(24)` →
  192-bit base64url,远超 OWASP 128-bit 推荐,brute-force 不可行。
- **B. SQL injection**:`listAuditLog` / `listInvitations` 动态 SQL
  仅拼接静态字段名片段,所有 user input 走 prepared statement `?`
  bind。Clean。
- **C. owner gate 覆盖**:invite 三个 owner-only endpoints
  (POST/GET/DELETE)都在 `handleIdentityRoute` 的 owner 闸**之后**
  分派,gate 完整。
- **D. owner 拒绝**:route + store 双重拒绝 `role='owner'`,任何一层
  独立失败都拦得住。
- **E. acceptInvitation 原子性**:整个流程在单 SQLite transaction 内,
  status guard UPDATE 用 `WHERE status='pending'` 防并发抢用。
- **F. invitedBy 剥离**:anonymous lookup endpoint(`GET /api/invites/
  :token`)显式构造 response,不包含 invitedBy 字段。
- **G. case_id 强制**:`/me/dispatch` 在 server 端 `payload.case_id =
  userId`,覆盖任何 client 传入的值;同时 ALLOWED_WORKFLOWS 的
  payloadFields 白名单本来就不含 case_id,双重保险。
- **H. session fixation**:accept 后由 store 内 `beginSession` 风格
  inline 代码 mint 新 token,与 invite token 完全无关。
- **I. CSRF on accept**:invite token 本身即唯一 secret,无第三方网站
  能伪造请求(它不知道 token),CSRF token 保护无意义。

---

## 修复执行顺序

P1 → P2 批 → P3。每项一条 test。完成后跑 `pnpm -r test` 验证全绿,
本地 commit(按"github 额度超" 约束不 push)。

---

## 落地总结(回填)

每条修复对应的代码位置 + 新增测试:

| ID | 代码改动 | 新增测试 |
|---|---|---|
| AUDIT-P3-01 | `me-routes.ts::handleMeDispatch` 入口加 `loginLimiter.check('me-dispatch:'+userId)` | `me-routes.test.ts` "returns 429 after the per-user budget is exhausted" |
| AUDIT-P3-02 | `me-routes.ts::handleMeListReports` 入口加 `loginLimiter.check('me-reports:'+userId)` | `me-routes.test.ts` "returns 429 after the per-user budget is exhausted" + "dispatch budget and reports budget are independent buckets" |
| AUDIT-P3-03 | `identity-routes.ts::handleCreateInvite` 入口加 `loginLimiter.check('owner-mutation:'+actorKey)`(actorKey=v4 userId 或 `v3-admin:`+ip) | `identity-routes.test.ts` "returns 429 after the per-actor budget is exhausted" |
| AUDIT-P3-04 | `credentials.ts::hashPassword` 改抛 `IdentityError({code:'weak_password'})` | `identity-routes.test.ts` "responds 400 with code=weak_password" |
| AUDIT-P3-05 | `invite.html` 加 `<meta name="referrer" content="no-referrer">`;`invite.js::init` 立即 `history.replaceState('/invite')` | `me-routes.test.ts` "invite.html includes <meta ...>" |
| AUDIT-P3-06 | `server.ts` 1054 附近注释改为"独立 buckets by design",行为不变 | (注释不改逻辑,无 test) |
| AUDIT-P3-07 | `serveStatic` 给所有静态响应加 `X-Frame-Options: DENY` / `X-Content-Type-Options: nosniff` / `Referrer-Policy: no-referrer` | `me-routes.test.ts` "GET /me ships X-Frame-Options..." + "GET /invite ships the same baseline headers" |

跑 `pnpm -r test` 验证:全 19 个包通过(1678 个测试 + 2 skipped LLM
provider 测试需要网络凭据,与本审计无关)。新增 8 个测试,无回归。

未在本轮做的事项(记入 backlog):

1. **growthReports.list({ caseId })** 接口下沉,避免内存 filter(目前
   只在 /me 路由层 rate-limit,真实优化需要 surface 改造)。
2. **invitations 总数硬上限**(同时 pending ≤ 100),需要配置项,
   改动面大。
3. **严格 CSP**: admin.js inline event handler 多,加严格 CSP 需要专项
   重构(目前只加了基线三件套)。
4. **invite token 用 fragment 而非 path**: 大幅 UX 调整(用户复制 URL
   常丢 fragment),延后到下一轮 UX 设计。
