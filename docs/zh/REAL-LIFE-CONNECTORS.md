# 接入现实生活 track(C)—— 让 AI 真能碰你的日常工具

> 北极星第 1 层「我的 AI 桌面:不写代码,AI 帮我做**实际**的事」的抓手。深度辅助
> 生活/工作的天花板,取决于 agent 能不能触达你**真实的**日历 / 邮件 / 消息 / 笔记 /
> 任务 / 记账。本 track 就是把这条触达面做宽、做可信。
>
> Last updated: 2026-07-08 · C-M1 done · C-M2 出站 OAuth:M1 纯核 + M2 存储层 + M3 连接流 + M4a 活令牌注入 done。

---

## 一、为什么(缺口)

框架早有完整的 MCP 连接器机制(见 [MCP-CONNECTOR-DIRECTORY.md](MCP-CONNECTOR-DIRECTORY.md)):
内置目录 + 一键装 + 架构师优先推荐已装组件。但目录里**一条现实生活工具都没有** ——
5 条内置全是知识 / 文件 / 检索类(fetch / chroma / obsidian / elasticsearch /
filesystem),分类里连 `calendar` / `email` / `tasks` 都不存在。一个普通人想让 AI
「看我今天的日程」「读我 Notion 里的笔记」「把这件事加进 Todoist」,**无从下手**。

用户在「还差多少」的战略盘点里拍板走 **C(接入现实生活)**:不是再加框架功能,而是
把触达现实生活的连接器面**做宽 + 做可信**,直接抬高「深度辅助」的天花板。

## 二、市场真相(先查市面的关键发现)

开工前按纪律核了官方 MCP 注册站(`registry.modelcontextprotocol.io`),一条**改变
路线的发现**:

- **现代生活连接器生态已整体迁到「托管远程 HTTP + OAuth」**。Notion 官方 = 托管
  `mcp.notion.com`(OAuth)、Todoist 官方 = 托管 `ai.todoist.net`(OAuth)、GitHub /
  Linear / Google / Microsoft 同理。**静态 token 的 stdio server 正在退场。**
- **日历**在注册站按 `google calendar` 搜**空** —— 没有干净的静态 token 日历 server。
  **日历 / 邮件 / 记账铁定是 OAuth 域(C-M2)。**
- 但生态里仍有**厂商官方 + 静态 token**的少数干净选择(Notion 自家 npm、Doist 自家
  npm 的本地 stdio 模式),配 Gotong 现成的 `${ENV}` 占位今天就能装能用。

**好消息**:出站连接的**管道已经通** —— `host/src/mcp-config.ts` 早已支持 http/sse
远程传输并把 `headers` 里的 `${TOKEN}` 从 host 环境 / vault 展开成 bearer。整个 track
唯一缺的硬件是 **出站 OAuth 的令牌获取流**(C-M2);OAuth2 原语(`oidc-client.exchangeCode`
+ `buildAuthorizationUrl`)也已存在(现只用于入站登录),搭出站不用从零起。

## 三、三条不可破边界

1. **全走 MCP,框架不存数据、不碰服务**。连接器 spec 只是「spawn 什么子进程 / 连哪个
   URL」的配方;hub 不存你的日历 / 邮件 / 笔记,全经 MCP 子进程或远程端点(同 RAG /
   KB 一脉)。搬走 `.gotong/` = 搬走全部,连接器不留数据尾巴。

2. **凭证纪律**。密钥只以 `${NAME}` 占位进 spec(C-M1,spawn 时对 host 环境展开)、
   或 OAuth 令牌进 **vault**(C-M2);**绝不**在目录 / 配置 / UI 表单里写明文。防腐测试
   钉死每个 `needsEnv` 只能是 `${NAME}` 占位。

3. **接入 ≠ 授权行动**(发现≠信任 在生活域的延伸)。装上连接器 = 给 agent 一件工具;
   但**高风险动作**(替你发邮件 / 花钱 / 删除)仍过既有 governed 审批闸(`personal-butler`
   的 allow/approve/refuse + 出站审批)。连上你的 Todoist **不等于** agent 能悄悄重排你
   的人生。这条让「深度辅助」可信,是本 track 与「随便挂个能干一切的 agent」的分界。

## 四、路线图

| 里程碑 | 交付 | 认证 | 状态 |
|---|---|---|---|
| **C-M1** | 现实生活连接器目录:笔记(Notion)/ 任务(Todoist)进内置目录,一键发现 + 装 | 静态 token(stdio) | ✅ done |
| **C-M2** | 出站 OAuth 连接器接入:日历 / 邮件 / 记账(Google / Microsoft / Notion-OAuth / Todoist-hosted)—— 「用 X 登录」按钮,令牌进 vault + 自动刷新,注入远程 MCP 的 bearer header | OAuth 2.1(出站) | M1–M3 ✅ · M4–M5 在途 |
| **C-M3** | 动作安全加固(按需):agent 真发邮件 / 改日历 / 花钱时的审批闸打磨,复用既有 governed 闸 | — | 观察 |

## 五、里程碑记录

### C-M1 —— 现实生活连接器目录首批(静态 token)`6cd0a17`

`packages/web/src/builtin-mcp-connectors.ts` 加两条**厂商官方 + 静态 token**的生活域
连接器,并加 `tasks` 分类:

- **`notion-notes`**(分类 `notes`)—— Notion 官方 `@notionhq/notion-mcp-server`
  (`npx -y`,stdio),`needsEnv: NOTION_TOKEN`(内部集成密钥 `ntn_…`,在 Notion 开发者
  门户建 internal integration 拿,**非 OAuth**);whatFor 显式提示「要把页面/数据库
  共享给该集成,否则看不到」这个 Notion 特有前置。
- **`todoist-tasks`**(分类 `tasks`,新增)—— Doist 官方 `@doist/todoist-mcp`
  (`npx -y`,stdio),`needsEnv: TODOIST_API_KEY`(账号 Settings→Integrations 的个人
  API token);注记本地 stdio 走静态 token、托管版才 OAuth(留 C-M2)。

两条都对**官方 GitHub 仓库 README** 逐字核了命令与 token 环境变量(先查市面纪律,
不硬编造)。带凭证故显式带 `PATH: '${PATH}'`(env 一设子进程只继承列出的 key)。

零后端 / 路由 / schema 改动:一键装走既有 `POST /api/admin/mcp-servers`,catalog 路由
`GET /api/admin/mcp-connectors/catalog` 从常量派生,面板 `admin-src/mcp.js` 通用循环
渲染 —— 新条目自动出卡。爆炸半径锁在 web 常量 + 防腐测试 + 文档。

**验收**:防腐测试 `builtin-mcp-connectors.test.ts` 扩到 15 例(两条新 spec 各自过真
`validateMcpServersArray` + 无明文密钥 + id/名唯一 + 分类合法);catalog 路由测试
(真 HTTP)绿;web 全绿。

### C-M2 —— 出站 OAuth 连接器接入(进行中)

**目标**:普通人「用 Google / Notion 登录」把日历 / 邮件 / 托管笔记接上;令牌进 vault +
自动刷新,注入远程 MCP 的 bearer header。**opt-in 边界(用户法则)**:未配任何 OAuth
provider 时,回调路由不挂、v36 表空、MCP 连接器与 C-M1 逐字节一致 —— **能力 ≠ 行为分叉**,
只有 admin 显式加了 OAuth 连接器配置,「用 X 登录」才存在。

**复用地图**(侦察结论,不重造):PKCE / state ← 复用 `@gotong/identity` `generatePkce`
/ `randomState`;令牌加密存储 ← 复用 `VaultStore`(DEK 信封);注入 MCP header ← 复用
`mcp-config.ts` 可插拔 `SecretSource`(注释明写「可换 vault 后端不动调用方」);回调路由
← 镜像 `oidc-login-service`。**新建仅**:出站授权 URL / 交换 / 刷新(`oidc-client.exchangeCode`
末尾**强制要 id_token**、`buildAuthorizationUrl` **强塞 openid + nonce**,纯 OAuth2 都不要)
+ refresh grant(入站登录从不刷新)+ v36 配置表。

| 子里程碑 | 交付 | 状态 |
|---|---|---|
| **C-M2-M1** | 出站 OAuth2 纯核 `identity/oauth-outbound.ts` | ✅ `ea6b106` |
| **C-M2-M2** | schema v36 `oauth_connectors` 表(非密元数据)+ 令牌进 vault + CRUD | ✅ `7bbabe0` |
| **C-M2-M3** | web「连接」begin + callback(镜像 oidc-login-service),换码存 vault | ✅ `0e5b4e4`·`5648f2a` |
| **C-M2-M4a** | oauth 背书 `SecretSource`:活令牌喂 `resolveMcpServerConfig`(`${OAUTH_ACCESS_TOKEN}` → 连接器活令牌) | ✅ `64aaf98` |
| **C-M2-M4b** | 过期自动刷新(后台 refresh grant 计时器,保活令牌不过期) | 计划 |
| **C-M2-M5** | OAuth 连接器目录(Google 日历 / Notion 托管)+「用 X 登录」UI + capstone + 文档 | 计划 |

#### C-M2-M1 —— 出站 OAuth2 纯核 `ea6b106`

`packages/identity/src/oauth-outbound.ts`(零网络零状态,同 `oidc.ts` 姿态;为什么单独成
模块而非给 OIDC 核加开关:两向在**要害处**不同 —— 无 id_token / nonce、原生 scope 不塞
openid、要 refresh grant):

- `buildOutboundAuthorizationUrl` —— `response_type=code` + S256 PKCE,**provider 原生 scope
  照用**、无 openid 注入、无 nonce;`extraAuthParams` 供 Google 的 `access_type=offline`
  (不给它 Google 不返 refresh_token);**安全关键参数覆盖 extras**(有人从 extras 塞
  `response_type=token` 也被我方 `code` 盖掉)。
- `buildTokenExchangeBody` / `buildTokenRefreshBody` —— 纯 urlencoded 体;PKCE 用 verifier
  (非 challenge)证明;`client_secret` 仅机密客户端带;refresh grant 是入站没有的新面。
- `parseTokenResponse` —— 规范化令牌响应,**必须有 `access_token` 否则当场抛**(不像 OIDC
  强制 id_token);`refresh_token` 缺失 = 刷新响应正常(调用方留旧的);`expires_in`
  字符串→数。

无人调用 = 零行为变。验收:`oauth-outbound.test.ts` **19 例**(scope 不含 openid / 无
nonce / extras 不能越权覆盖 / verifier 非 challenge / 无 access_token 即抛 / 非对象即抛)+
tsc + identity **635** 全绿 + 四门 PASS(旋钮仍 106)。

#### C-M2-M2 —— schema v36 `oauth_connectors` 表 + 令牌进 vault + CRUD `7bbabe0`

出站连接器的**存储层**,直接镜像入站 `OidcProviderStore`(见 `oidc-provider-store.ts`)的
「非密配置进表 + 机密进 vault」纪律,并加出站独有的**令牌集**面:

- **schema v36 `oauth_connectors` 表**(additive,`schema.ts`):非密配置(授权/令牌端点、
  client_id、redirect_uri、原生 scope、`extra_auth_params` JSON、`mcp_server_name`)+ 两个
  vault 指针 + 一个**非密**的 `access_token_expires_at` 列。`id` = admin 提供的稳定连接器
  主键;`mcp_server_name` = 「这个连接器喂哪个 MCP server 的 bearer」（可空）。
  （M4a 定案:注入按 `mcp_server_name` **承重连接键**解析 —— 那个 server 的固定 ref
  `${OAUTH_ACCESS_TOKEN}` 取此连接器活令牌;`id` 保持稳定主键。M2 时曾设想过 `${OAUTH:<id>}`
  按 id 引用,M4a 改用 `mcp_server_name` 链路,详见下方 M4a 记录。)
- **两类 vault 机密**(`types.ts` 加 `oauth_client_secret` / `oauth_token` 两个 `VaultKind`,
  ownerKind `org`):client_secret 同 OIDC(公客户端=无密无 vault 条目,无 master key 也能注册);
  **令牌集**(access + refresh + type + scope)作**单个 JSON blob** 存 `oauth_token` 条目 ——
  令牌是活凭证,信封加密 + master-key 轮换免费覆盖;过期时间戳留列里(非密),好让 M4 的
  SecretSource **不解密**就能判「令牌过期没」。
- **`OAuthConnectorStore`**(`oauth-connector-store.ts`):`register`(重复 id → `oauth_connector_exists`,
  拒插时撤销刚写的机密不留孤儿)/ `get` / `list` / `readClientSecret`(公客户端返 `''`、未知 id
  抛不静默返空)/ `update`(id 不可变,机密轮换=写新 vault 条目、行改指后才撤旧,崩溃至多留孤儿
  不留悬指针,`''` 清成公客户端)/ `remove`(删行 + 撤机密 + 撤令牌)。**出站独有三方法**:
  `setTokenSet`(令牌进新 vault 条目、过期戳进行、旧条目改指后撤 —— 同机密轮换的崩溃安全序;
  刷新缺 refresh_token 时由调用方前推旧的,store 只存所给)/ `getTokenSet`(null=未连接;坏 blob
  抛 `malformed_token_blob` 不返半个凭证)/ `clearTokenSet`(断连=撤令牌留配置,幂等)。
- **opt-in 边界坐实**:空 registry = 与今天逐字节一致;本里程碑纯存储,**无任何路由读它**
  (回调路由 M3、注入 M4)。IdentityStore facade 8 方法委派(`registerOAuthConnector` …
  `getOAuthTokenSet`),仅 `readOAuthClientSecret` / `getOAuthTokenSet` 碰明文。

验收:`oauth-connector-store.test.ts` **19 例**(配置 round-trip + 机密不入投影 / vault kind+owner
正确 / 公客户端无 vault / 重复 id 不留孤儿 / 空必填即拒 / 机密轮换+清除 / 令牌集存取/刷新缺
refresh 存 null/轮换撤旧/断连留密幂等/删撤双 vault / 未知 id 抛 not_found)+ migration-double-apply
过(v36 幂等)+ tsc + identity **654** 全绿 + host tsc 干净(依赖方零 ripple)+ 四门 PASS(旋钮仍 106)。

#### C-M2-M3 —— web「连接」begin + callback `0e5b4e4`(M3a 服务)·`5648f2a`(M3b 路由)

把浏览器接上出站 connect 流,分两个干净单元交付(热文件 main.ts/server.ts 逼近行数上限,
故拆开且 web 接线走 factory 抽出)。

**M3a —— host 编排服务** `oauth-connect-service.ts`(`0e5b4e4`):镜像 `OidcLoginService` 但**反
方向**(不是登入 hub,是拿 access token 替用户调外部 API):`begin(connectorId)` mint state +
PKCE、in-memory 暂存(短 TTL + 单用,同 OIDC **不持久化半连接**——重启=重点一下)、用 M1 纯
函数出授权 URL;`complete(state,code)` 验 state(未知/过期/已用 → `oauth_state_invalid`)后**单个
POST** 换码、`parseTokenResponse` 规范化 + 从 `expires_in` 算绝对过期戳、`setOAuthTokenSet` 落库。
**无 discovery/JWKS/id_token**(端点在连接器配置里显式),故网络胶水就一个 POST、`fetchImpl` 直接
注入本服务,不像 OIDC 要独立 client 类。验收:`oauth-connect-service.test` **10 例**(真 IdentityStore
令牌**真进 vault** + 假 fetch 捕获请求体)。

**M3b —— web 路由 + 接线** `oauth-connect-routes.ts`(`5648f2a`):两端点**故意分处不同 auth 区**
(与 OIDC login 全公开相反):

- `POST /api/admin/oauth/start` —— **管理员门控**(连我的 Google 是 owner 动作非公开登录),过
  `requireAdmin` + CSRF,返 `authorizationUrl` JSON,panel 顶层导航过去。**门控 begin 是防令牌固定
  攻击的控制点** —— 不门控则任何人能把自己的 provider 账号绑到 hub 连接器。
- `GET /api/oauth/callback` —— **公开 + pre-CSRF**(provider 顶层跳转回来无 Origin/cookie 保证),
  唯一 CSRF 绑定是 host 层**单用 server-mint 的 state**;成功落令牌 + 302 到 `?oauth_connected=<id>`,
  失败/provider 报错/缺参/未接线一律 302 到 `?oauth_error=<code>`。token 端点是 admin 注册的(非
  每请求用户输入),**无新 SSRF 面**。

接线守预算:main.ts 走 `createOAuthConnectSurface` 工厂(仅 +5 行,2978/2980)同 STD-M1 名片 surface
手法;server.ts 出站 OAuth 路由对按 gate 认可的「显式+justified」把棘轮 2350→2370。**opt-in**:未接
identity 时 surface 缺席 → start 503 / callback bounce `not_enabled`,逐字节不变。验收:`oauth-connect-
routes.test` **11 例**(begin 401 无 auth/503 未接线/400 空 id/200 带 URL/400 surface 错/405 非 POST;
callback 302 成功/bounce 各失败/缺参/provider 错/未接线)+ web **1289** 全绿 + host **1892** 全绿 +
web/host tsc 干净 + 四门 PASS(旋钮仍 106)。

#### C-M2-M4a —— oauth 背书 `SecretSource`:活令牌喂 MCP `64aaf98`

令牌**真正流进** MCP 的一步:连接好的连接器,其 access token 进远程 MCP 服务的 `Authorization`
头。`packages/host/src/oauth-secret-source.ts` 是出站版的 `mcp-config.ts` `${ENV}` 展开——不读
`process.env`,而是把**一个保留 ref** `${OAUTH_ACCESS_TOKEN}` 解析成「喂给*该* MCP 服务的连接器」
的活令牌,其余 ref 一律回落 base 源(env)。

**为什么 per-server 而非单一全局源**:连接器经 M2 的 `mcpServerName` 列绑定到**恰好一个** MCP
服务,故 ref 是**固定哨兵**、「指哪个令牌」由正在解析的服务决定——spec 作者不管连接器 id 都写
同一句 `Bearer ${OAUTH_ACCESS_TOKEN}`,两个 oauth 服务永不撞名。**为什么 sync**:`SecretSource`
契约同步,本源只**读**已存令牌(同步 vault 解密);保活令牌新鲜(refresh grant,异步)是独立后台
事(M4b)。存的令牌若已过期照样注入 → MCP 用它 401,和今天错 `${ENV}` 凭证一样在 `server-stderr`
**响亮失败**(不静默)。单个坏令牌 blob **fail-soft** 返 undefined(回落 base),绝不因一个连接器
连累整个 agent spawn。

**ref 名不带 `GOTONG_` 前缀**:它是凭证占位符不是 `process.env` 控制旋钮(且 env 门扫 `GOTONG_*`
字面量,旋钮形的名字会误报)。**pool 对 oauth 完全无感**:注入 `mcpSecretSource?: (serverName)
=> SecretSource`,`buildToolset` / `resolveRegistryConfig` 都走 `secretSourceFor(name)`,省缺则
`envSecretSource`——**代码级逐字节今天的行为**;main.ts 折进既有 `identity` spread(net +1 行,
2980/2980)。**opt-in 结构性成立**:零连接器 → 每个 ref 回落 base → 逐字节不变。**边界(接入 ≠
授权行动)**:活令牌只让 agent 的 MCP toolset **能调**厂商,发/花钱仍过管家 governed 审批闸——这缝
给触达,不给自主。验收:`oauth-secret-source.test` **8 例**(真 IdentityStore 令牌真进 vault:活令牌
解析 / 不泄漏给别的服务 / 未连接·禁用·非 oauth ref 回落 / 零连接器全回落 / resolve 端到端注头 /
轮换即时反映)+ pool `mcpSecretSource` 穿线 1 例(spawn 时按服务名问源)+ host **1901** 全绿 +
identity **654** 全绿 + tsc 干净 + 四门 PASS(旋钮仍 **106**,无新 env)。M4b(刷新计时器)在途。

## 六、相关文档

| 想知道什么 | 读哪 |
|---|---|
| 连接器目录机制(内置目录 + 一键装 + 架构师优先推荐 + fetch 搜索配方) | [MCP-CONNECTOR-DIRECTORY.md](MCP-CONNECTOR-DIRECTORY.md) |
| MCP 接入(client + server)总览 | [MCP.md](MCP.md) |
| 凭证 / vault / 出站审批 | [SETTING-OPS-CONSOLE.md](SETTING-OPS-CONSOLE.md) |
| 有界治理 tool-loop(allow/approve/refuse,高风险动作过闸) | [ledger/PERSONAL-BUTLER-FINAL.md](ledger/PERSONAL-BUTLER-FINAL.md) |
