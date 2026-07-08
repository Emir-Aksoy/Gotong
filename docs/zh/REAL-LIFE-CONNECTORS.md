# 接入现实生活 track(C)—— 让 AI 真能碰你的日常工具

> 北极星第 1 层「我的 AI 桌面:不写代码,AI 帮我做**实际**的事」的抓手。深度辅助
> 生活/工作的天花板,取决于 agent 能不能触达你**真实的**日历 / 邮件 / 消息 / 笔记 /
> 任务 / 记账。本 track 就是把这条触达面做宽、做可信。
>
> Last updated: 2026-07-08 · C-M1 done · **C-M2 出站 OAuth 全完**:M1 纯核 + M2 存储层 + M3 连接流 + M4a 活令牌注入 + M4b 自动刷新 + M5a admin CRUD 后端 + M5b 目录预设(Google 日历 + Gmail)+ M5c「连接现实生活」面板 + M5d capstone(`reallife-oauth` demo)(Notion-OAuth 待 M1 加 basic 认证仍显式推迟)。

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
| **C-M2** | 出站 OAuth 连接器接入:日历 / 邮件 / 记账(Google / Microsoft / Notion-OAuth / Todoist-hosted)—— 「用 X 登录」按钮,令牌进 vault + 自动刷新,注入远程 MCP 的 bearer header | OAuth 2.1(出站) | ✅ M1–M5 全完 |
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

### C-M2 —— 出站 OAuth 连接器接入(全完)

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
| **C-M2-M4b** | 过期自动刷新(后台 refresh grant 计时器,保活令牌不过期) | ✅ `98ad265` |
| **C-M2-M5a** | admin OAuth 连接器 CRUD 后端(`/api/admin/oauth/connectors[/:id[/disconnect]]`,镜像 oidc-admin) | ✅ `97a5a76` |
| **C-M2-M5b** | OAuth 连接器目录预设(Google 日历 + Gmail:端点/scope/托管 MCP 内置,admin 只填三件套 + `GET /catalog` 路由;Notion-OAuth 待 M1 加 basic 认证) | ✅ `10bd55f` |
| **C-M2-M5c** | admin 新「连接现实生活」标签页(镜像 MCP 目录):目录卡 + 连接表单 + 已装连接器表 + 连接/断开打 M3b start + M5a 路由 | ✅ `0efd890` |
| **C-M2-M5d** | capstone `examples/reallife-oauth`(整条链一个确定性脚本:begin→换码进 vault→注入→刷新→注入新;真 M1+M2,只 mock 网络)+ 文档收尾 | ✅ `6b5ea8c` |

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
identity **654** 全绿 + tsc 干净 + 四门 PASS(旋钮仍 **106**,无新 env)。刷新计时器见下方 M4b。

#### C-M2-M4b —— 过期自动刷新:后台 refresh grant 计时器 `98ad265`

M4a 让令牌**流进**,M4b 让令牌**不死**。access token 短命(Google ~1h),没有刷新则一小时后连
接器作废、用户得重跑整个 OAuth 流。`packages/host/src/oauth-token-refresh.ts` 的 `OAuthTokenRefresher`
是个后台计时器,用 **refresh_token grant** 保活**已存**令牌 —— 用户连一次 Google,以后永续:每次
新 / 重生的 MCP toolset(M4a 在 `buildToolset` 注入)都拿到有效 bearer,连接器长活。

**不解密就分诊**:哪些连接器「到期该刷」直接读**非密**的 `accessTokenExpiresAt` 投影列(M2 特意留
在 vault 外就为这)——只有真到期的才解密(refresh token + client secret)去 POST grant。默认 60s 一
tick、到期前 5min 窗口内刷(刷成功后过期戳前移故一个周期只刷一次;失败则留 due 下 tick 重试);
`start()` 除装 interval 还**立即补一 tick**(令牌若在 host 停机期间过期,开机即恢复不等一整轮);
`unref()` 不因刷新节律吊住事件循环。**逐连接器 fail-soft**:坏 blob / 无 refresh token(warn **一次**
非每 tick)/ HTTP 非 2xx / 传输错都 log + 跳过,**绝不**因一个连接器中断整轮 sweep 或抛出;刷新响应
缺新 refresh token 时前推旧的(RFC 6749 §6)。

**作用域边界(冻结头)**:MCP http/sse 传输在**连接时**把 bearer 焊进 `requestInit.headers`,故刷新
已存令牌**不更新*运行中* toolset 的活头** —— 会话若活过令牌寿命会 mid-session 401(`server-stderr`
可见),在 agent 下次重生时自愈。把新令牌推进活连接(经 pool 的 install/uninstall 机器热替 / 或
per-request 动态头)是**显式推迟**:M4a/M4b 已让「连一次永续 + 重生即新鲜」这个 90% 的赢落地,活
连接热替是叠加精修,联邦 / 常驻管家规模逼出需求时再按 pool 现成机器接。**opt-in**:零连接器时每 tick
遍历空、什么都不做(同 CARE 巡检计时器),**无新 env 旋钮**。

接线守预算:计时器类自带 interval,main.ts 仅 construct+start(2 行)+ shutdown drain stop(1 行,同
sweeper 家族),按 gate 认可的「显式+justified」把棘轮 2980→2986。验收:`oauth-token-refresh.test`
**10 例**(due 连接器真刷:grant 体+客户端密钥+新令牌+绝对过期戳 / 仍新鲜跳过 / 禁用跳过 / 未连接跳
过 / 无寿命跳过 / 无 refresh token warn 一次不动令牌 / 缺新 refresh 前推旧的 / 非 2xx 不动不抛 / 传
输错不动不抛 / `start()` 补 tick 恢复开机即过期令牌 + `stop()` 清计时器)+ host **1911** 全绿 +
tsc 干净 + 四门 PASS(旋钮仍 **106**,无新 env)。**C-M2 出站 OAuth 令牌全链路(M1 纯核 → M2 存储 →
M3 连接流 → M4a 注入 → M4b 保活)至此打通**;M5(连接器目录 +「用 X 登录」UI + capstone)收尾。

#### C-M2-M5a —— admin OAuth 连接器 CRUD 后端 `97a5a76`

M1–M4 把令牌管道打通了,但连接器本身还只能靠 `IdentityStore` 直接建(测试里手搓)。M5 要把
「用 X 登录」端到端做出来,先从**后端 CRUD** 起手 —— 令牌管道之上,给 admin 一条注册 / 列举 /
改 / 删连接器 + 撤销连接的 HTTP 面。**逐字镜像 `oidc-admin-routes.ts`**(同一 SSO 家族的成熟
形状):`packages/web/src/oauth-connector-admin-routes.ts` 新增

- `GET /api/admin/oauth/connectors` —— 列全部(投影 `OAuthConnectorView`)
- `POST /api/admin/oauth/connectors` —— 注册(201)
- `PATCH /api/admin/oauth/connectors/:id` —— 改
- `DELETE /api/admin/oauth/connectors/:id` —— 删(不存在 404)
- `POST /api/admin/oauth/connectors/:id/disconnect` —— 撤销连接(清 vault 里的令牌集,连接器本
  身留着;返回 `{ok, wasConnected}`)

**守边界②(凭证纪律)结构性成立**:`OAuthConnectorView` 投影**根本没有** `clientSecret` /
token 字段 —— 只有 `hasClientSecret`(布尔)+ `connected` + 非密的 `accessTokenExpiresAt`。
client_secret 是**只写**:POST/PATCH 收它塞进 vault,GET 永远看不到(和 OIDC 客户端密钥同姿态)。
校验:必填(id / 授权端点 / 令牌端点 / client_id / redirect / scope)缺一 400 且 surface **不被
调**(不浪费一次写)、`extraAuthParams` 只收扁平 `string→string`(非串值 400)、typed store error
→ 状态码(`oauth_connector_exists` 409 / `oauth_connector_not_found` 404 / `invalid_input` 400);
requireAdmin 先行(无 admin bearer 401),再 `!oauthConnectorAdmin` 时 503。

host 侧 `packages/host/src/oauth-connector-admin.ts` 工厂 `createOAuthConnectorAdminSurface` 从
`IdentityStore` 的 OAuth 连接器面直传到 web surface —— 薄到只是转发,但**注解返回类型
`OAuthConnectorAdminSurface` 是承重的**:web 契约和 identity facade 一旦漂移,这里当场编译失败
(同 `createOAuthConnectSurface` 的移法)。main.ts 只 +1 行 construct + serveWeb opt 里 +1 条件展开。

**opt-in / 无连接器时字节不变**:surface 只在 `identity` 存在时构造,不接则路由整体 503(同 M3
的 `oauthConnect`);全 track 挂在 identity 存在这一既有前提上,**零新 env 旋钮**。验收:
`oauth-connector-admin-routes.test` **13 例**(401 无 admin / 503 未接线 / GET 列举无密钥泄漏 /
POST 201 且只写密钥透传 / 缺必填 400 surface 不调 / 非串 extraAuthParams 400 / 重复 id → 409 /
PATCH 改 / PATCH 空白必填形 400 / DELETE 删 / DELETE 不存在 404 / disconnect 报 wasConnected /
非法方法 405)+ web **1302** / host **1911** / identity **654** 全绿 + tsc 干净 + 四门 PASS
(server.ts 棘轮 2370→2381,同 OIDC/SAML 派发家族;旋钮仍 **106**,无新 env)。下一步 **M5b**
目录预设(Google 日历 / Notion 托管端点内置,admin 只填 client_id/secret/redirect)→ **M5c** 面板
「用 X 登录」UI → **M5d** capstone + 文档。

#### C-M2-M5b —— 出站 OAuth 连接器目录预设 `10bd55f`

M5a 给了 CRUD,但每接一个 provider,admin 还得自己去查四样东西:授权端点、令牌端点、填哪个
scope、以及「为什么拿不到 refresh_token」。M5b 把这些**市场真相**烤进预设,admin 只需填自己注册
的 OAuth 应用三件套(client_id / client_secret / 回调 URI)。

**动工前先查市面(C-track 铁律),抓到两条决定形状的真相:**

1. **Google Workspace 全系已上「托管远程 MCP」**(`developers.google.com`,2026-06 核):日历
   `calendarmcp.googleapis.com/mcp/v1`、Gmail `gmailmcp.googleapis.com/mcp/v1`、Drive
   `drivemcp.googleapis.com/mcp/v1`,统一 OAuth 2.0 + `Authorization: Bearer` 头 + 1h 令牌 + 刷新
   —— **正是 M4a `${OAUTH_ACCESS_TOKEN}` bearer 注入 + M4b 保活这条管道**。
2. **「我们自己有没有」排第一**(C-M1 教训):重核 M1 核 `oauth-outbound.ts` 发现令牌交换只做
   `client_secret_post`(密钥进 body)。Google 收 body 密钥 ✓;但 **Notion 令牌端点要 HTTP Basic
   认证**,M1 不做 —— 硬塞 Notion-OAuth 预设 = 交换必 401 的**坏卡**。

故 M5b **诚实收窄**:只发**两条对着 M1 核端到端可信的 Google 预设**(日历 + Gmail,正好填「日历
/ 邮件铁定是 OAuth 域」两个明确缺口),**Notion-OAuth 显式推迟**(要 OAuth 版先给 M1 加
`client_secret_basic`;笔记域 C-M1 静态 token `notion-notes` 已覆盖)。宁缺毋滥,不铺不能用的卡。

`packages/web/src/builtin-oauth-connectors.ts`(手写框架级常量,镜像 `builtin-mcp-connectors.ts`):
每条预设烤入 `authorizationEndpoint` / `tokenEndpoint` / `scope` / `extraAuthParams` + 该连接器活
令牌喂给的 `mcpServer`(`McpHttpServerSpec`:托管 URL + `Authorization: Bearer ${OAUTH_ACCESS_TOKEN}`
固定注入头)。**三边界结构性成立**:①全走 MCP 不存数据;②预设里**没有** client_id/secret 字段
(admin 三件套永不烤入)、bearer 头是**固定 ref** 绝不明文(M4a 按 `mcpServer.name`=连接器
`mcpServerName` 解析成活令牌);③接入≠授权(`gmail.modify` 能读能发,但真发信仍过 personal-butler
governed 闸)。**Google 刷新坑烤死**:`extraAuthParams: {access_type: offline, prompt: consent}`
—— 没它 Google 不发 refresh_token,M4b 无从保活,连接器一小时后就断(防腐测试钉死每条都带)。

`GET /api/admin/oauth/catalog` **折进 M5a 既有 handler**、且在 surface 闸**之前**应答:目录是纯
web 常量,像 MCP 连接器目录一样**永不 503**(不接 identity 也能浏览预设,装才需 CRUD)。故 M5b
**纯 web**:零 host / main.ts / server.ts 改、零新 env、零预算动(server.ts 仍 2381/2381)。安装一条
预设 = M5c UI 打 M5a `POST /connectors`(OAuth 连接器,mcpServerName 取 `mcpServer.name`)+ 既有
`POST /mcp-servers`(那个托管 server),两创建由承重连接键对齐。

验收:`builtin-oauth-connectors.test` **11 例**(curated id 定序 + 每条 `mcpServer` 过真
`validateMcpServersArray` + bearer 是固定 ref 无明文 + 不烤 client_id/secret + 每条带
access_type=offline + sourceRef 引 Google 官方)+ catalog 路由 **4 例**(并进 M5a 测试,GET 列举 /
未接 surface 仍 200 不 503 / 401 无 admin / 405 非 GET),M5a 路由测试增至 **17 例**;web **1317** 全绿
+ tsc 干净 + 四门 PASS(旋钮仍 **106**,无新 env,预算未动)。下一步 **M5c** 面板「用 X 登录」UI
(列连接器 + 目录卡 + 连接/断开按钮打 M3b start + M5a 路由)→ **M5d** capstone + 文档。

#### C-M2-M5c —— admin「连接现实生活」面板 `0efd890`

M5a/M5b 给了 CRUD 后端 + 目录预设,但成员还只能靠 curl 打路由 —— 缺一张脸。M5c 补的就是「用 X
登录」这个动作面。**形态由用户拍板**:摆「塞进 MCP 标签页 / 新标签页(镜像 MCP)」两选项,用户选
**新标签页** —— 现实生活连接器(OAuth「登录」)与 MCP 连接器(装子进程/填 `${ENV}`)是两种心智,
各占一屏比挤一起清楚。

`packages/web/admin-src/oauth-connect.js`(新工厂 `createOAuthConnect()`,镜像 `mcp.js` 的结构)接
三段 UI:①**目录卡**(`GET /catalog` → 每条预设一张卡,分类徽章 + `whatFor` + Homepage;已装的显
「已添加」不给连接钮);②**连接表单**(卡内内联展开,只三个输入 —— client_id / client_secret /
回调 URI,回调**预填** `${origin}/api/oauth/callback` 省得成员抄错;提交 = M5a `POST /connectors`
[端点/scope/extraAuthParams 由预设烤入,mcpServerName 取 `mcpServer.name`] + `POST /mcp-servers`
[那个托管 server] + M3b `POST /api/admin/oauth/start` → 跳 `authorizationUrl`);③**已装连接器表**
(连接态徽章 + 令牌到期分钟数 + 重连/断开/移除)。回跳后 `?oauth_connected` / `?oauth_error` 由
`checkConnectBanner()` 转成横幅并抹掉 query。

**纯 UI,零逻辑改**:动的全是静态资产(`app.html` 加标签钮 + section、`app-core.js` 加 zh+en 两套
`reallife*` 文案、`app.js` 把 `reallife` 加进 `ADMIN_TABS` 白名单、`styles.css` 加卡/表/表单样式、
`main.js` 接线 tab-change 刷新 + 回跳落地)+ 重新 bundle 的 `static/admin.js` + 重嵌的
`src/static-assets.ts`。**零 host / 路由 `.ts` / main.ts / server.ts 改、零新 env、零预算动、零新单
测**(底层三条路由 M5a CRUD / M5b catalog / M3b start 各自已测;UI 是静态资产,验证走真浏览器)。
三边界在 UI 层也守住:表单里 client_secret 只 POST 进后端存 vault、页面不回显;卡上「接上只是能读
写,真发信 / 改日程仍过审批闸」的话术把「接入≠授权」写给成员看。

验收:真浏览器(serveWeb + stub OAuth surface)双语过一遍 —— 标签注册进 `ADMIN_TABS`、目录两卡
(Google 日历 Calendar / Gmail 邮件 Email)+ 已装表渲染、连接表单展开且回调预填、**连接→回跳→横幅
整条 round-trip 走通**(重连 → `/start` → 跳桩回调 → `complete` → `?oauth_connected` → 重载自动切
到本标签 + 打「✓ 已连接」横幅 + 抹 query)、zh/en 切换即时重渲染、控制台无本面板报错;web **1317**
全绿(无新测)+ tsc 干净 + 四门 PASS(旋钮仍 **106**)。下一步 **M5d** capstone + 文档收尾。

#### C-M2-M5d —— capstone `examples/reallife-oauth` + 文档收尾 `6b5ea8c`

M1–M5c 每一环各有单测,但**没有一张把整条链串成一个故事的图**。M5d 补的就是这张图:一个确定性
脚本把出站 OAuth 全链路(注册 → begin → 换码进 vault → 注入 MCP 头 → 到期刷新 → 再注入)跑通,
**self-assert + exit 0/1 即冒烟门**。

**为什么是「镜像薄编排」而非直接调 host 真件**:`@gotong/host` 的「.」导出会**跑起整个 host**
(index.ts → main.js),且其顶注明写「host 内件不是公共 API,程序化嵌入请直接用底层包」。故照
`butler-cross-hub` 镜像 `personal-butler-ask-peer.ts` 的先例:demo 只引**公共包**
`@gotong/identity`——真 M1 核(`generatePkce`/`buildOutboundAuthorizationUrl`/`buildTokenExchangeBody`/
`buildTokenRefreshBody`/`parseTokenResponse`)+ 真 M2 vault(`openIdentityStore` 信封加密)在底下跑,
只把三段薄编排(M3 换码存 / M4a 注入解析 / M4b 到期刷新)摊平在一个文件里,每段带指回 host 真件的
注释。薄到不可能与 host 跑偏;host 真件另有单测把关。**唯一被 mock 的是那一个网络跳**(一个假的
Google 令牌端点,按 `grant_type` 分流 authorization_code 首发 / refresh_token 换新)。

**端到端证的四件事**(全是硬断言):① 授权 URL 是**出站**形状(原生日历 scope、**无 openid**、
S256 PKCE、`access_type=offline`);② 令牌**明文不落盘**——换码后把原始 DB 字节(含 WAL 旁文件)
全抓出来,断言首发 / 刷新后 access_token、refresh_token、client_secret **一个字节都不在盘上**
(vault 信封加密);③ 注入是 **per-server 固定占位**——`${OAUTH_ACCESS_TOKEN}` 解析成
`google_calendar` 的活令牌,别的 server 名 / 别的 ref 一律穿透到 base(**opt-in:零连接器时注入层
字节不变**也是硬断言);④ **连一次、永续、重生即新鲜**——时钟跳过到期,refresh grant 换新存回
(旧 refresh_token 前推),同一条注入缝现在吐新令牌。三条不可破边界在脚本尾部逐条回收(①②代码已证,
③接入≠授权 narrated 指回 personal-butler governed 闸)。

文档收尾:`examples/reallife-oauth/README.md`(故事 + 「它证明什么」+ 对照生产件映射表)、
`EXAMPLES.md` 加行(第 ② 档零前置)、根 `package.json` 加 `demo:reallife-oauth`。验收:
`pnpm demo:reallife-oauth` **exit 0**(全断言过)+ 例子 `tsc --noEmit` 干净 + host/web 全绿未动
(纯新增 example + 文档,零包代码改)+ 四门 PASS(旋钮仍 **106**,无新 env)。**C-M2 出站 OAuth 至此
全完** —— 普通人能在面板里「用 Google 登录」把日历 / 邮件接给自己的 AI,令牌进 vault 自动保鲜,而
真发信 / 改日程仍过审批闸。

**C-M2 显式推迟(不预造)**:① **Notion-OAuth** —— 要 OAuth 版先给 M1 核加 `client_secret_basic`
(Notion 令牌端点要 HTTP Basic;笔记域 C-M1 静态 token `notion-notes` 已覆盖);② **活连接热替
令牌** —— 刷新只更新**存储**令牌,运行中 toolset 的活头是连接时焊死的(冻结头边界),会话活过令牌
就 mid-session 401 + 下次 spawn 自愈;把新令牌推进活连接(pool install/uninstall 热替 或 per-request
动态头)显式推迟;③ **Microsoft / Todoist-hosted 等更多 provider 预设** —— 管道已通(M5b 加一条
预设常量即可),按需再加,不铺不能用的卡。

## 六、相关文档

| 想知道什么 | 读哪 |
|---|---|
| 连接器目录机制(内置目录 + 一键装 + 架构师优先推荐 + fetch 搜索配方) | [MCP-CONNECTOR-DIRECTORY.md](MCP-CONNECTOR-DIRECTORY.md) |
| MCP 接入(client + server)总览 | [MCP.md](MCP.md) |
| 凭证 / vault / 出站审批 | [SETTING-OPS-CONSOLE.md](SETTING-OPS-CONSOLE.md) |
| 有界治理 tool-loop(allow/approve/refuse,高风险动作过闸) | [ledger/PERSONAL-BUTLER-FINAL.md](ledger/PERSONAL-BUTLER-FINAL.md) |
