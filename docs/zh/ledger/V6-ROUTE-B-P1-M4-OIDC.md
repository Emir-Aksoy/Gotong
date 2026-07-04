# Route B P1-M4 — OIDC 单点登录 (SSO) 收口

> 企业治理三件套 (SSO / 审计 / 细粒度 RBAC) 里的 **SSO 第一刀 = OIDC**。
> 从「只有本地邮箱+密码登录」推到「**接受外部 IdP 单点登录**」, 同时严守
> 「Hub is dumb / 凭证只在本机 / 不自动开户」三条边界。
>
> 拆 9 个里程碑 (M4a→M4f-3) 落地, 一个里程碑一个小 commit。本文是 M4f-4 收口。
> Last updated: 2026-06-02

---

## 一句话

Gotong 当 **OpenID Connect Relying Party (RP)**: 把外部 IdP (Google /
Entra / Authentik / Keycloak …) 断言的 `(issuer, sub)` 映射到一个**已存在**
的本地用户, 铸出**和密码登录完全一样**的 `ses_` 会话。登录页多了「用 X 登录」
按钮, owner 在「SSO」标签页注册它信任的 IdP。**框架不跑 OAuth 服务器, 只做 RP**。

## 北极星对齐

- **凭证只在本机**: IdP 的 `client_secret` 进 vault (信封加密 + master key 轮换
  自动覆盖), 绝不明文落库、绝不进 env、绝不回显给前端。
- **人和 agent 同一个 Participant**: SSO 只是给「人」多开一个认证通道, 铸的是同
  一个 `Session`, 进门后和密码登录的用户走完全一样的 dispatch / transcript 路径。
- **Hub is dumb on purpose**: RP 只验 `id_token` + 查本地用户, 决策权 (谁能登录)
  在 IdP (认证) + 本地用户表 (授权) 手里, hub 自己不发明身份。

---

## 二、关键决策

### D-3 — 自建 session, 不做 per-request token 透传 (M4a 拍板)

Gotong 早有完整 `Session` 模型 (`ses_` 前缀, 7 天 cookie, MFA 闸都铸它)。OIDC
登录成功后**只 bootstrap 这个 session**, 不把 IdP 的 access_token 当请求级凭证
往后透传。理由: ① 一种会话格式、一处改; ② IdP token 生命周期/刷新与本地会话解
耦; ③ 进门后所有授权走本地 RBAC, 与 IdP 无关。照 MFA 闸「密码对了再铸 session」
的先例。

### 不自动开户 — JIT-link-by-verified-email (M4e-1)

SSO **只放已存在的本地用户进门**, 绝不给「任何有 Google 账号的人」铸本地账号:

- 已联结过 `(issuer, sub)` → 直接用那个用户;
- 否则: **仅当** IdP 断言 `email_verified` 且该邮箱匹配一个**现有**本地用户 →
  自动 link (写一条 `kind='oidc'` 凭证) 后放行;
- 未验证邮箱 / 无匹配用户 → 拒 (`oidc_no_account`)。

owner 先在「用户」标签页建好账号 (或发邀请), 用户才能用 SSO 登。

### secret 进 vault, 复用 TotpStore(v19) 同款拆分 (M4d)

`oidc_providers` 表 (迁移 **v20**) 只存非密配置 (issuer UNIQUE / client_id /
redirect_uri / scope / enabled / label)。机密 `client_secret` 走 vault (新
`VaultKind 'oidc_client_secret'`, `ownerKind 'org'` = hub 自己拥有) → DEK 信封
加密 + master-key 在线轮换**免费覆盖**, 绝不另起第二套密钥存储。公开 (PKCE-only)
客户端无 secret → 无 vault 条目 → 没配 master key 的 hub 也能注册。

### capability 表先不动

`message/send`-only。本版只做浏览器 authorization-code + PKCE 登录闭环, 不做
token refresh / 单点登出 (SLO) / group→role 映射 (见 §六 推迟)。

---

## 三、9 个里程碑

| M | commit | 包 | 做了什么 |
|---|---|---|---|
| **M4a** | `f9b4192` | identity, web | 账号联结 + `authenticateOidc`。`oidcLinkIdentifier(issuer,sub)=sha256(JSON.stringify([issuer,sub]))` (分隔符安全, issuer 是满冒号 URL)。复用 `credentials` 表 (`kind='oidc'`), revoke/CASCADE/审计全免费。MFA 豁免 (IdP 是认证权威)。 |
| **M4b** | `d047738` | identity | 协议纯核 `oidc.ts`: PKCE (S256 challenge)、`state`/`nonce` 生成、`id_token` JWT 验证 (RS256 via JWKS, iss/aud/exp/nonce 校验)。零 IO、零网络, 可单测的纯函数层。 |
| **M4c** | `a020ef2` | host | client 胶水 `oidc-client.ts`: discovery (`.well-known/openid-configuration`) + JWKS 拉取 + authorization-code → token 交换。`fetchImpl` 可注入做确定性测试。 |
| **M4d** | `3d95d0e` | identity | provider 配置存储 (表 v20, secret 进 vault)。公开投影 `OidcProvider` **永不带 secret**, 只 `readOidcClientSecret` 返回 (callback 唯一调用方)。轮换/清空 secret 先重指行再撤旧条目 (崩溃留孤儿不留悬指针)。 |
| **M4e-1** | `4210135` | host | 登录编排 `oidc-login-service.ts`: `begin()`→discover + state/nonce/PKCE + 内存 stash + 授权 URL; `complete()`→校验 single-use state → 读 secret → `client.completeLogin` → `resolveLocalUser` (JIT) → `authenticateOidc` 铸 session。state→{nonce,verifier} 内存单用 + 10min TTL, **绝不持久化**。 |
| **M4e-2** | `d532118` | web, host | 浏览器侧三条**公开** GET 路由 (住 pre-CSRF 区, 顶层 IdP 重定向无 Origin 头): `/api/auth/oidc/providers` (登录页读它渲染按钮) / `/start?provider=` (302→IdP) / `/callback` (成功铸**同一身份 cookie**+302 `/`, 失败 bounce `/?oidc_error=<code>`)。host 在 OidcLoginService 上组装 surface 注入。 |
| **M4f-1** | `e957429` | web, host | 管理侧 CRUD `/api/admin/oidc/providers` (list/add/PATCH/DELETE, requireAdmin)。`client_secret` **write-only** (入参收、永不回显, view 只带 `hasClientSecret`)。住 CSRF 闸内 admin 区。 |
| **M4f-2** | `83def50` | web | 登录屏 SSO 按钮: `renderSsoButtons()` 拉 providers, 每个 enabled IdP 渲染「用 X 登录」按钮 (顶层导航到 `/start`)。空/404→隐藏。`?oidc_error=` 复用 login-status 行。 |
| **M4f-3** | `7add322` | web | admin 「SSO」tab + 自包含 `oidc-ui.js` (CRUD 面板, secret write-only badge, 轮换/启停/删)。顺带修 `ADMIN_TABS` 漏注册 mcp/usage/federation 的路由 bug。 |

---

## 四、数据流 — 一次浏览器 SSO 往返

```
 浏览器                      Gotong (RP)                         外部 IdP
   │                            │                                   │
   │ 1. GET /login 页           │                                   │
   │   renderSsoButtons()       │                                   │
   │   → GET /api/auth/oidc/providers (公开, 无 secret)             │
   │ ◀──── [{id,label,issuer}]  │                                   │
   │                            │                                   │
   │ 2. 点「用 X 登录」          │                                   │
   │   → GET /start?provider=X  │                                   │
   │                       begin(X): discover + state/nonce/PKCE    │
   │                       内存 stash {state→{nonce,verifier}}      │
   │ ◀── 302 到 IdP authorize ──┤                                   │
   │ ────────────────────────── 3. 登录 + 同意 ──────────────────▶ │
   │ ◀───────────── 302 /callback?code=…&state=… ───────────────── │
   │                            │                                   │
   │ 4. GET /callback?code&state│                                   │
   │                       complete(): 校验 single-use state        │
   │                       readOidcClientSecret (vault)             │
   │                       ──── code+verifier 换 token ───────────▶ │
   │                       ◀──────── id_token (JWT) ─────────────── │
   │                       验 RS256/iss/aud/exp/nonce (JWKS)        │
   │                       resolveLocalUser: JIT-link-by-email      │
   │                       authenticateOidc → 铸 ses_ session       │
   │ ◀── 302 / + Set-Cookie ────┤                                   │
   │     (与密码登录同一 cookie) │                                   │
   │ 5. 进门, 走本地 RBAC        │                                   │
```

失败任一步 → `/callback` bounce `302 /?oidc_error=<code>`, 登录页 `login-status`
行展示 (顶层 tab 里裸 JSON 错 = 敌意 UX)。

---

## 五、安全不变量 (各有测试钉死)

1. **state single-use + 10min TTL**: `complete()` 一进来就 `delete`, 重放/过期/
   未知 → `oidc_state_invalid`。state/nonce/verifier **绝不持久化** (重启=用户重试,
   不留可恢复的半登录态)。
2. **nonce 绑 id_token**: stash 的 nonce 必须等于 `id_token.nonce`, 防注入。
3. **PKCE S256**: code 交换带 `code_verifier`, 防授权码拦截。
4. **client_secret write-only**: 公开投影/list/admin view **永不带** secret; 只
   `readOidcClientSecret` (callback 内) 能读; 前端只见 `hasClientSecret` 布尔。
5. **不自动开户**: 未验证邮箱 / 无匹配用户 → 拒, 绝不 `createUser`。
6. **MFA 豁免**: IdP 是认证权威跑自己的 MFA, `authenticateOidc` 照 `authenticateToken`
   豁免先例 (不再叠本地 TOTP 闸)。
7. **公开路由住 pre-CSRF 区**: callback 是顶层 IdP 重定向 GET, 无 Origin 头无
   session, 必须在 CSRF 闸**之前**; admin CRUD 反之住闸内 (变更类 + 浏览器 session)。
8. **缺 identity 降级不崩**: host 未接 identity store → 登录路由返空表/`not_enabled`,
   admin 路由 503, 前端隐藏按钮/内联提示。

---

## 六、测试矩阵

| 包 | 文件 | 覆盖 |
|---|---|---|
| identity | `oidc-link.test.ts` | 联结 round-trip / session 真可用 / 幂等 / 跨用户冲突 / 分隔符安全 / MFA 豁免 |
| identity | `oidc-protocol.test.ts` | PKCE / state / nonce / id_token RS256+iss+aud+exp+nonce 校验 (含各拒绝分支) |
| identity | `oidc-provider-store.test.ts` | 投影无密 / secret 落 vault / 公开客户端无条目 / 重复 issuer 不留孤儿 / 轮换撤旧 |
| host | `oidc-client.test.ts` | discovery / JWKS / code→token 交换 (注入 fetchImpl) |
| host | `oidc-login-service.test.ts` | begin 建 URL+single-use state / JIT 联结 / 拒未知身份 / 重放+过期拒 |
| web | `oidc-routes.test.ts` | 11 — provider 列表无密 / IdP 302 / 成功铸 cookie / 每条失败 bounce |
| web | `oidc-admin-routes.test.ts` | 11 — auth 闸 / 校验 / 增改删 / write-only secret / 错码映射 |
| web | `c1-app-shell.test.ts` | SSO tab/panel/login-sso 标记在 served shell / `/oidc-ui.js` 可服务 |

全链路绿: identity 500 / host 606 / web 700。

---

## 七、运维须知

- **无需 env**: provider 走 admin「SSO」标签页 (DB) 配置, 不读 env 开关。host 只要
  接了 identity store, 登录/管理路由自动接线。
- **回调地址**: 在 IdP 和本 hub 两边都登记 `https://<你的域名>/api/auth/oidc/callback`。
  admin 面板内联提示这个路径。
- **公开 vs 机密客户端**: 留空 `client_secret` = 公开/PKCE 客户端 (推荐, 无需 master
  key); 填了 = 机密客户端, secret 进 vault (需 master key, 受轮换覆盖)。
- **撤销**: admin 面板删 IdP, 或停用 (enabled=false 立刻从登录页消失)。已联结用户的
  凭证留在 `credentials` 表 (`kind='oidc'`), owner 可在用户详情单独 revoke。
- **生产 HTTPS**: 登录 cookie 走现有 `cookieSecure` 开关 (HTTPS 必开)。

---

## 八、显式推迟 (保持精简)

- **SAML** = M5 (企业老栈仍大量用 SAML 2.0, 单列一个里程碑)。
- **SCIM** 自动 provisioning = M6 (可选; 本版坚持「不自动开户」, SCIM 是另一条显式
  授权通道)。
- token refresh / 单点登出 (SLO / back-channel logout) / `prompt`/`max_age` 等
  高级 OIDC 参数。
- group / role claim → 本地 RBAC 角色映射 (本版只认「已存在用户」, 角色还是本地管)。
- 一个用户多邮箱 / 多 IdP 同邮箱的合并策略 (本版一邮箱一用户)。
- dynamic client registration / IdP 元数据自动刷新 (本版 discovery 一次性)。
- 出站 (Gotong 当 IdP 给别人) — 不在 RP 范围, A2A/federation 是另一套信任。

---

## 九、下一步

M5 = SAML SP (同样的「外部断言 → 已存在本地用户 → 铸同一 session」骨架, 换 SAML
2.0 wire); 之后企业治理还剩**审计日志增强**与**细粒度 RBAC** (task #22 umbrella)。
