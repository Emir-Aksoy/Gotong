# Route B P1-M5 — SAML 2.0 单点登录 (SSO) 收口

> 企业治理三件套 (SSO / 审计 / 细粒度 RBAC) 里 **SSO 的第二刀 = SAML 2.0**。
> 接 M4 (OIDC) 之后, 把「接受外部 IdP 单点登录」补上企业老栈仍大量在用的 SAML
> 2.0 协议。同一条「外部断言 → 已存在本地用户 → 铸同一 `ses_` session」骨架,
> 换 SAML wire, 但 XML 签名带来一组 OIDC 没有的攻击面 (XSW)。
>
> 拆 9 个里程碑 (M5a→M5f-3) 落地, 一个里程碑一个小 commit。本文是 M5f-4 收口。
> Last updated: 2026-06-03

---

## 一句话

AipeHub 当 **SAML 2.0 Service Provider (SP)**: 把外部 IdP (Okta / Entra /
ADFS / Keycloak …) **签名断言**里的 `(idpEntityId, NameID)` 映射到一个**已存在**
的本地用户, 铸出**和密码登录完全一样**的 `ses_` 会话。登录页多了「用 X 登录」
按钮 (和 OIDC 共用那一排), owner 在「SAML」标签页注册它信任的 IdP。**框架不跑
身份服务器, 只做 SP**; 危险的 XML 数字签名数学委托给成熟库 (`xml-crypto`),
自己只写 SP 协议胶水 + 围绕它的 XSW 防护。

## 北极星对齐

- **凭证只在本机**: SAML 的信任根是 IdP 的 `idp_cert` (X.509 验证公钥)。**它是
  公开的**, 不是 secret —— 所以**不进 vault** (这正是 SAML 配置存储与 OIDC 最大
  的结构差异: OIDC 的 `client_secret` 可重放, SAML 的 cert 只能验签不能伪造)。
- **人和 agent 同一个 Participant**: SAML SSO 只是给「人」多开一个认证通道, 铸的
  是同一个 `Session`, 进门后和密码/OIDC 登录的用户走完全一样的 dispatch /
  transcript 路径。
- **Hub is dumb on purpose**: SP 只验签名断言 + 查本地用户, 决策权 (谁能登录) 在
  IdP (认证) + 本地用户表 (授权) 手里, hub 自己不发明身份。

---

## 二、关键决策

### 成熟 DSig 库 + 自写 SP 胶水 (M5a 用户拍板)

XML 规范化 (C14N) + 签名验证是出了名的易错且攻击面大。**不自己实现**: 新包
`@aipehub/saml` 依赖 `xml-crypto` + `@xmldom/xmldom` + `xpath`, 危险的 C14N+签名
数学全委托 xml-crypto; 本包只写 xml-crypto **不做**的 SP 协议流程 (AuthnRequest
生成 / SAMLResponse 解码 / 断言取值) + 围绕它的 XSW 防护。

### 独立小包隔离 XML 依赖 (M5a)

`@aipehub/saml` 是第 30 个包, 故意**独立**而非塞进 identity —— identity 刻意
dep-light (只 `node:crypto`), 这正是 OIDC 的 `oidc.ts` 能住 identity 而 SAML 的
XML 协议核**不能**的原因。镜像 `@aipehub/a2a` / `@aipehub/inbox` 的小聚焦包先例。
**但账号联结 + provider 存储仍住 identity** (纯映射 / 纯 SQL, 零 XML)。

### 不自动开户 — JIT-link-by-asserted-email (M5d)

SAML SSO **只放已存在的本地用户进门**, 绝不给「任何有 Okta 账号的人」铸本地账号:

- 已联结过 `(idpEntityId, NameID)` → 直接用那个用户;
- 否则: 仅当签名断言里的 email 匹配一个**现有**本地用户 → 自动 link (写一条
  `kind='saml'` 凭证) 后放行;
- 无匹配用户 → 拒 (`saml_no_account`)。

**与 OIDC 的关键差异: SAML 断言没有独立的 `email_verified` flag。** 断言里的
email 由 IdP 的签名背书 —— **签了就是验证了**。所以「签名断言里的 email」本身
即可信, 不需要也没有一个单独的「已验证」布尔。

### idp_cert 是公钥, provider 存储无 vault (M5c)

`saml_providers` 表 (迁移 **v21**) 整行明文: `idp_entity_id` UNIQUE (= 钉死的
断言 Issuer) / `sso_url` / `idp_cert` (PEM) / `sp_entity_id` / enabled / label。
**无 vault 注入 / 无 readSecret / 无孤儿清理** —— 因为 cert 是公开验证钥, 公开它
不泄密。**没配 master key 的 hub 也能注册 SAML IdP** (测试故意无 masterKey 开
store 钉死)。`idpEntityId` 不可变 (换 IdP = 重加, 镜像 OIDC issuer)。

### 自建 session, 复用 D-3 (M5b)

照 M4a 拍板的 D-3: SAML 登录成功后**只 bootstrap 本地 `ses_` session**, 不把 IdP
的任何 token 当请求级凭证往后透传。一种会话格式、一处改; 进门后所有授权走本地
RBAC, 与 IdP 无关。`kind='saml'` 凭证与 `kind='oidc'` 并列, `samlLinkIdentifier
(idpEntityId, nameId)=sha256(JSON([idpEntityId, nameId]))`, 跨 kind 永不相撞。

---

## 三、9 个里程碑

| M | commit | 包 | 做了什么 |
|---|---|---|---|
| **M5a** | `f37d225` | saml (新) | SP **协议纯核**。新包 `@aipehub/saml` (xml-crypto+@xmldom/xmldom+xpath): `generateAuthnRequest` (HTTP-Redirect deflate+base64, 返 @ID 供 InResponseTo) / `decodeSamlPostResponse` (POST base64) / `validateSamlResponse` (**签名先于取值**→Issuer/Audience/时窗/Recipient/InResponseTo) / `buildSpMetadata`。承重: ① 验签 key 钉死配置 cert (noop `getCertFromKeyInfo` 绝不取文档 KeyInfo); ② 取值只从 `getSignedReferences()`; ③ 已签 @ID 文档唯一; ④ DOCTYPE 拒; ⑤ 失败全抛 `SamlError`。22 测试 (含 XSW 旁挂/重复 ID/签后篡改/错 key/未签/DOCTYPE 攻击 fixture)。 |
| **M5b** | `10e7abc` | identity | 账号联结 + `authenticateSaml`。`credentials.kind` 加 `'saml'`; `samlLinkIdentifier` 内部 helper; 复用 `credentials` 表 (revoke/CASCADE/审计全免费), `secret_hash=''` (无可重放 secret)。`linkSaml`/`findUserBySaml`/`authenticateSaml` 铸**同一 `ses_` session** (D-3)。store mechanism-only (`saml_not_linked` 让调用方定策略)。11 测试 (含同 NameID 不同 IdP 不撞 / SAML-vs-OIDC kind 隔离)。 |
| **M5c** | `7fb81ce` | identity | provider **配置存储** (表 v21, **无 vault**)。OIDC M4d 的孪生但去掉 vault 注入/readSecret/孤儿清理 (cert 是公钥)。`SamlProviderStore` (add/get/getByEntityId/list/update/remove, idpEntityId 不可变); IdentityStore facade 6 方法。8 测试 (无 masterKey 开 store 钉死「公钥不需密钥库」)。 |
| **M5d** | `c1a5218` | host, web | 登录**编排** `saml-login-service.ts` (OIDC M4e 的孪生)。`begin()`→AuthnRequest + 按新 RelayState 暂存 + IdP 重定向 URL; `complete()`→查暂存 (RelayState 验签**前**消费, 验签失败也消费防重放) + 对钉死 cert 验签 + `expectedInResponseTo` 钉 @ID + JIT-link-by-asserted-email + 铸 session。纯 SAML 函数注入 (默认真) → 编排用 fake 单测。8 测试。 |
| **M5e** | `f5b24f1` | web, host | 浏览器侧**公开**路由 (住 pre-CSRF 区): `/api/auth/saml/providers` (登录页读它) / `/metadata?provider=` (SP 元数据 XML) / `/start?provider=` (302→IdP) / `/acs` (**跨站 POST** SAMLResponse+RelayState → 成功铸**同一身份 cookie**+302 `/`, 失败 bounce `/?saml_error=<code>`)。ACS URL 从 `AIPE_PUBLIC_URL` 取 (稳定绝对 URL, 烤进 AuthnRequest 回程复核)。12 测试。 |
| **M5f-1** | `fdc2f29` | web, host | 管理侧 CRUD `/api/admin/saml/providers` (list/add/PATCH/DELETE, requireAdmin)。**vs OIDC: cert 是公钥**, view 出完整行含 cert (owner 审计钉的哪张), 无 secret 藏。idpEntityId 不可变。11 测试。 |
| **M5f-2** | `d5552a0` | web | 登录屏 SAML 按钮: 扩 `renderSsoButtons()` 同时拉 OIDC+SAML 两 provider 列表, 任一出按钮即露分隔符。SAML 按钮顶层导航 `/api/auth/saml/start`。`?saml_error=` 并进既有 `?oidc_error=` 处理。 |
| **M5f-3** | `be5211e` | web | admin「SAML」tab + 自包含 `saml-ui.js` (CRUD 面板, cert 预览+title 全值, 轮换证书/启停/删 + 每行 SP 元数据链接)。`ADMIN_TABS` 加 `'saml'`; i18n `tabSaml`; +2 c1-app-shell 哨兵。 |

---

## 四、数据流 — 一次浏览器 SAML 往返

```
 浏览器                      AipeHub (SP)                         外部 IdP
   │                            │                                   │
   │ 1. GET /login 页           │                                   │
   │   renderSsoButtons()       │                                   │
   │   → GET /api/auth/saml/providers (公开, 只 {id,label})         │
   │ ◀──── [{id,label}]         │                                   │
   │                            │                                   │
   │ 2. 点「用 X 登录」          │                                   │
   │   → GET /start?provider=X  │                                   │
   │                       begin(X): generateAuthnRequest (@ID)     │
   │                       按新 RelayState 内存 stash {@ID}          │
   │ ◀── 302 到 IdP SSO URL ────┤  (deflate+base64 AuthnRequest)    │
   │ ────────────────────────── 3. 登录 + 同意 ──────────────────▶ │
   │ ◀──────── 自动提交表单 (SAMLResponse + RelayState) ─────────── │
   │                            │                                   │
   │ 4. POST /acs (跨站表单)    │                                   │
   │    SAMLResponse+RelayState │                                   │
   │                       complete(): 消费 single-use RelayState   │
   │                       验签 (钉死 idp_cert, 只读 signed refs)   │
   │                       校验 Issuer/Audience/时窗/Recipient      │
   │                       + InResponseTo === 暂存 @ID              │
   │                       resolveLocalUser: JIT-link-by-email      │
   │                       authenticateSaml → 铸 ses_ session       │
   │ ◀── 302 / + Set-Cookie ────┤                                   │
   │     (与密码/OIDC 登录同一 cookie)                              │
   │ 5. 进门, 走本地 RBAC        │                                   │
```

**ACS 是跨站 POST** (IdP 的自动提交页发来, 无 Origin 头无 CSRF token) → 必须住
CSRF 闸**之前**。真实性来自**签名断言** (钉死 cert 验), RelayState 服务端单次是
重放/CSRF 防护。失败任一步 → bounce `302 /?saml_error=<code>`。

---

## 五、安全不变量 (各有测试钉死)

1. **验签 key 钉死配置 cert**: noop `getCertFromKeyInfo: () => null`, 绝不取文档
   自带 KeyInfo → cert-substitution 攻击 (拿自己的 key 签自己的断言) 失效。
2. **取值只从 `getSignedReferences()`**: 只读实际被签名覆盖的字节, 绝不读原始
   文档 → XSW (旁挂一个伪造未签 assertion) 永不被读, 哪怕它排在真断言**之前**。
3. **已签 assertion @ID 文档内唯一**: 重复 ID 是 XSW 的另一种形态, 直接拒。
4. **DOCTYPE 直接拒**: 防 XXE / 实体展开。
5. **RelayState single-use, 验签前消费**: `complete()` 一进来先消费 (10min TTL /
   纯内存 / 绝不持久化); 验签失败也已消费 → 抓到的 response 不能对同一 state 重放。
6. **InResponseTo 钉死**: 断言的 `InResponseTo` 必须等于本 SP 签发的 AuthnRequest
   @ID → 防响应注入 / 未经请求的断言。
7. **Recipient/Audience/时窗**: Recipient 必须是本 SP 的 ACS URL, Audience 必须是
   本 SP entityID, NotBefore/NotOnOrAfter 时窗校验 (含时钟偏移容忍)。
8. **不自动开户**: 无匹配本地用户 → 拒, 绝不 `createUser`。
9. **idp_cert 是公钥不进 vault**: 无密钥库依赖, 没配 master key 的 hub 也能用 SAML。
10. **ACS 住 pre-CSRF 区**: 跨站 POST 无 Origin 头, 必须在 CSRF 闸之前; admin CRUD
    反之住闸内 (变更类 + 浏览器 session)。
11. **缺 identity 降级不崩**: host 未接 identity → 登录路由返空表/`not_enabled`,
    admin 路由 503, 前端隐藏按钮/内联提示。

---

## 六、测试矩阵

| 包 | 文件 | 覆盖 |
|---|---|---|
| saml | `validate.test.ts` 等 | 22 — AuthnRequest 生成 / 解码 / 验签 + **XSW 攻击 fixture** (旁挂/重复 ID/签后篡改/错 key/未签/DOCTYPE 全拒) |
| identity | `saml-link.test.ts` | 11 — 联结 round-trip / session 真可用 / 幂等 / not_linked / 同 NameID 跨 IdP 不撞 / SAML-vs-OIDC kind 隔离 |
| identity | `saml-provider-store.test.ts` | 8 — 全配置 round-trip 含 cert / 无 masterKey 开 store / dup entityID / 不可变 entityID / 部分更新 / 幂等 remove |
| host | `saml-login-service.test.ts` | 8 — begin 重定向+暂存 / pre-linked 完成+钉 InResponseTo / JIT-link by email / 拒未知 / 单次 RelayState / 过期 / 验签失败仍消费 state |
| web | `saml-routes.test.ts` | 12 — providers 列表无 cert / metadata 显式+单默认+多 400 / start 302 / ACS 铸 cookie / 每条失败 bounce |
| web | `saml-admin-routes.test.ts` | 11 — auth 闸 / 校验 / 增改删 / cert 在 list (公钥) / 错码映射 |
| web | `c1-app-shell.test.ts` | SAML tab/panel 标记在 served shell / `/saml-ui.js` 可服务 |

全链路绿: saml 22 / identity 519 / host 614 / web 725。

---

## 七、运维须知

- **无需 env (除 ACS base)**: provider 走 admin「SAML」标签页 (DB) 配置。唯一 env
  是 `AIPE_PUBLIC_URL` —— ACS URL 必须是 IdP 能 POST 回来的稳定绝对 URL (烤进
  AuthnRequest 且回程对 Recipient 复核), 不能像 agent card 那样按请求派生。
  **生产 (反代/TLS 后) 必须设 `AIPE_PUBLIC_URL`**; 本地 dev 回退 `host:port`。
- **SP 元数据**: admin 面板每行有「SP 元数据」链接 (`/api/auth/saml/metadata?
  provider=<id>`) → 把 SP entityID + ACS 交给 IdP 管理员导入。
- **IdP 配置**: 在 IdP 处登记本 SP 的 entityID (= 你填的 spEntityId) + ACS URL
  (`<AIPE_PUBLIC_URL>/api/auth/saml/acs`), 把 IdP 的签名证书 (X.509 PEM) 粘进面板。
- **证书轮换**: IdP 换签名证书时, admin 面板「轮换证书」粘新 PEM 即可 (PATCH
  idpCert), 无需重建 provider。
- **撤销**: admin 面板删 IdP, 或停用 (enabled=false 立刻从登录页消失)。已联结用户
  的凭证留在 `credentials` 表 (`kind='saml'`), owner 可单独 revoke。
- **MVP 范围**: SP-initiated SSO, RS256 + exclusive-c14n。AuthnRequestsSigned=false
  (本 SP 不签请求 → 无 SP 私钥), 不做加密断言。

---

## 八、显式推迟 (保持精简)

- **SP 签名的 AuthnRequest** (AuthnRequestsSigned) + **加密断言** (EncryptedAssertion)
  —— 需要 SP 自己的私钥 → 那才需要 vault, 本版不引入。
- **artifact binding** (本版只 HTTP-Redirect 出 + HTTP-POST 入)。
- **单点登出** (SLO, front/back-channel)。
- **IdP-initiated SSO** (本版只 SP-initiated; IdP-initiated 无 InResponseTo 可钉,
  是更大的 CSRF 面, 显式不做)。
- **SCIM** 自动 provisioning (同 OIDC, 坚持「不自动开户」)。
- group / role 属性 → 本地 RBAC 角色映射 (本版只认「已存在用户」)。
- 一个用户多 IdP / 多 NameID 合并策略 (本版一邮箱一用户)。
- IdP 元数据自动刷新 (本版 cert/URL 手填, 手动轮换)。

---

## 九、下一步

M5 (SAML SP) **9 刀全完**。企业治理三件套里 **SSO 两刀 (OIDC + SAML) 落地**,
还剩**审计日志增强**与**细粒度 RBAC** (task #22 umbrella)。SSO 骨架已被两种
协议验证: 「外部断言 → 已存在本地用户 → 铸同一 `ses_` session / 不自动开户」是
稳定接缝, 第三种协议 (若有) 照此再来一遍即可。
