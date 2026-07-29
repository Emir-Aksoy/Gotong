# SHELL 真壳 — 独立客户端连自有 VPS(M0 计划)

> **一句话**:把 `packages/web/static/` 那套界面**装进设备本地**,通过一层
> base URL 与一次设备配对连上**你自己那台 VPS 上的 hub**;界面形态仍由
> file-first 配置决定,但客户端不再是「那台 VPS 的浏览器」,而是一个能独立
> 发版、有原生推送、装了就在的 app。
>
> Track 代号:**SHELL**。Status: **M0 计划(2026-07-28)**,M1 起未动工。
> 本 track 是 [`SDUI-PANEL.md`](SDUI-PANEL.md) 里程碑表 M5 那一格的展开——
> 侦察后确认它装不进一格(见 §四)。
> 形态拍板:**真壳**(本地资源 + `CapacitorHttp` 走原生请求),而非瘦壳
> (壳里包一个远端 URL)。理由见 §三。
> 岔口拍板(2026-07-28):**A1** 大陆推送先不做只轮询 / **B2 骨架配置化画到全部
> 17 个页签**(未取推荐的 B1 三页签,理由见 §七)/ **C2+C1** 二维码编码
> 「地址 + 一次性码」、6 位码兜底。
> Last updated: 2026-07-28

---

## 一、缘起:原话里的三个词

SDUI track 的源头是这句(逐字保留,[`SDUI-PANEL.md:32-33`](SDUI-PANEL.md#L32)):

> **app 本身要有极大可变性:内置大量组件,由设置文件自由编排,对不同的人不同
> 形态;固定的是连接 VPS 的格式规范**

SDUI M1–M4 + C1 把「内置大量组件 + 自由编排」做实了:13 个可摆组件全部接真
数据,配置文件落 `<space>/butler/ui/user/<userId>/panel.json`,管家能改、
改不坏、瞒不住、退得回。

但把这句话逐字对现状,三个词各有各的距离:

| 原话 | 今天的成色 | 差在哪 |
|---|---|---|
| **app 本身**要有极大可变性 | 只有 `#sdui-panel` **一个页签内部**由配置驱动;tabbar 17 个页签硬编码 | app 骨架不可配置 |
| 固定的是**连接 VPS 的格式规范** | `schemaVersion` 字段在场,但服务端硬编码回填、客户端从不读 | 有版本号,没有协商 |
| **连接 VPS** | SPA 结构性绑死同源,52 处硬编码路径,零注入点 | 没有「输地址」这条动线 |

SHELL track 就是补这三条。

---

## 二、先查市面(2026-07-28 核)

| 事实 | 对我们的意义 | 出处 |
|---|---|---|
| `CapacitorHttp` 设 `plugins.CapacitorHttp.enabled: true` 会 patch `window.fetch` 与 `XMLHttpRequest` **走原生 HTTP 库** | **CORS 整个问题域消失**——原生请求不发 `Origin`、不做 preflight,而我们的 `checkOrigin` 在无 Origin 时放行 | [capacitor/core/http.md](https://github.com/ionic-team/capacitor/blob/main/core/http.md) · [Capacitor Http API](https://capacitorjs.com/docs/apis/http) |
| `webDir` 指向编译好的 web 资产目录,内含 `index.html` | 我们的 `static/` 是普通目录且 `package.json` 的 `files` 已含它,`cp -r` 即可 | [Capacitor Config](https://capacitorjs.com/docs/config) |
| `@capacitor/push-notifications` 走 FCM(Android)+ APNs(iOS);iOS 需付费开发者账号 + APNs 密钥 + Xcode 能力开关 | 原生推送是**独立一套**,不是 Web Push 换传输(见 §四 第四档) | [Push Notifications API](https://capacitorjs.com/docs/apis/push-notifications) |
| **FCM 在中国大陆不可用**(无 Google Play 服务);替代路线是厂商推送(小米/华为 HMS/OPPO/vivo)或自建 MQTT 长连接 | 「全球商店 + 大陆 APK」两条腿**必须分叉**,不能共用一套推送 | [Pushy: China](https://pushy.me/china) · [21cloudbox](https://www.21cloudbox.com/accessing-chinas-mobile-app-market-overcoming-the-fcm-firewall.html) |
| 苹果 4.2 官方文本:*"Your app should include features, content, and UI that elevate it beyond a repackaged website."* | 官方规则本身只说「要超越重新打包的网站」 | [App Store Review Guidelines 4.2](https://developer.apple.com/app-store/review/guidelines/#minimum-functionality) |
| **社区经验(非官方)**:有 Capacitor 混合应用**已带原生插件仍被 4.2 拒**的报告 | 「加个原生推送就能过审」不成立;演示形态怎么设计是 M7 之后真正难的部分 | 开发者论坛与第三方博客,**二手来源**,真上架前需以苹果实际回复为准 |

> **纪律注**:上表最后一行刻意标了「二手来源」。按 WX-M0 的教训(逐字核官方
> 源纠社区讹传三处),凡影响路线的外部事实都要标明成色——苹果的**规则原文**
> 是官方的,「Capacitor 一定被拒」是社区观感,两者不可混为一谈。

---

## 三、为什么是真壳(岔口拍板记录)

2026-07-28 摆给用户的岔口与拍板:

**瘦壳**(Capacitor 只包一个远端 URL,页面仍从 VPS 加载)——base URL 层不用
写、相对路径天然正确、SDUI 耦合问题全部消失,连接面几乎零成本。代价:必须走
WebView 形态(要么补 CORS 要么抄 A2A 式豁免)、离线只有 SW 那点能力、苹果 4.2
打回风险最高、原生推送仍要单独接。

**真壳**(`static/` 拷进 `webDir` 本地加载,配 `CapacitorHttp` 走原生请求)
——**用户拍板此项**。CORS 彻底消失、离线体验真实、过审故事好讲得多。代价:
base URL 层必须写、SDUI 与宿主 SPA 的耦合必须解开、版本协商从「早晚要做」
变成「上线前必须做」。

拍板理由(我给出的判断,用户采纳):瘦壳形态下 **app 依然只是那台 VPS 的
浏览器**,配置能改的仍旧只有一个页签内部——那不叫「app 本身有极大可变性」。

---

## 四、侦察落档(2026-07-28,四路并行 + 自核)

> 全部结论带 `file:line`。这一节是后续每个里程碑的事实底座,动工前重读。

### 第一档:接入面 —— 比预期松得多

**跨域不是墙。** 全仓**零 CORS**(`Access-Control` 在 `packages/` `deploy/`
`caddy/` 零命中,`OPTIONS` 无任何处理器),且 `checkOrigin()` 会 403 掉带非
白名单 Origin 的写请求([`security-helpers.ts:102`](../../packages/web/src/security-helpers.ts#L102))。
但两条化解:

- `checkOrigin` **无 Origin 头时直接放行**([`security-helpers.ts:106`](../../packages/web/src/security-helpers.ts#L106),
  注释写明是给 same-origin 表单 POST 留的),而原生请求不发 Origin;
- 仓库**早有「非浏览器 bearer 域绕开 CSRF 门」的范式**:A2A 入站被显式放在
  CSRF 门之前([`server.ts:840`](../../packages/web/src/server.ts#L840)),
  `/metrics` 同理([`server.ts:880`](../../packages/web/src/server.ts#L880))。

**Bearer 通道今天就通,而且不限角色。** `resolveV4Auth` 接受 `aipk_` / `adm_`
前缀([`identity-routes.ts:646-661`](../../packages/web/src/identity-routes.ts#L646)),
`/api/me/*` 的门只要求 user 与 role 非 null([`me-routes.ts:447-448`](../../packages/web/src/me-routes.ts#L447))。
一个 member 持 `aipk_` 现在就能打通全部三十多条成员 API。

**缺的是成员自助拿到钥匙的动线:**

| 事实 | 位置 |
|---|---|
| 唯一签发口在 **owner 门之后** | [`identity-routes.ts:857-863`](../../packages/web/src/identity-routes.ts#L857) + [`:933`](../../packages/web/src/identity-routes.ts#L933) |
| 登录**只回 Set-Cookie,响应体不含 token** | [`identity-routes.ts:1090-1094`](../../packages/web/src/identity-routes.ts#L1090) |
| `ses_` 前缀被 Bearer 路径明确拒收 | [`identity-routes.ts:648`](../../packages/web/src/identity-routes.ts#L648) |
| api key **永不过期、无 refresh、无设备维度** | [`store.ts:1116-1137`](../../packages/identity/src/store.ts#L1116) 不写 expiresAt |
| 成员 Bearer 路径**无限速**(admin 侧有 `adminLoginLimiter`) | 对比 [`server.ts:2151`](../../packages/web/src/server.ts#L2151) |
| 每次 Bearer 请求**写一行 session** | [`identity-routes.ts:654`](../../packages/web/src/identity-routes.ts#L654),注释自承 "Bearer auth amplifies session rows" |

**现成可抄的形状**:IM 绑定的 6 位配对码([`store.ts:3045`](../../packages/identity/src/store.ts#L3045))
——成员自助签发、10 分钟 TTL 钳制、单用户单码、同事务单次消费,方向全对;
今天兑换出的是一条 `im_bindings` 行而非 token,也没有 HTTP 兑换端点。

**SPA 无 base URL 层**:`app.js` 52 处 `fetch('/api...')`、`sdui-ui.js` 9 处、
[`app-core.js:4501`](../../packages/web/static/app-core.js#L4501) 的
`new EventSource('/api/stream')`、[`app.js:3994-4012`](../../packages/web/static/app.js#L3994)
十五个 admin bundle 绝对路径、[`sw.js:76`](../../packages/web/static/sw.js#L76)
主动锁同源。grep `hubUrl|baseUrl|apiBase` **零命中**。

**公网入口**:生产 web 跑 `127.0.0.1:3000` loopback,无域名无 TLS。
[`deploy/Caddyfile.baremetal`](../../deploy/Caddyfile.baremetal) 模板 #151
track 已备(自动 Let's Encrypt + SSE flush + HSTS)。**这是运维动作不是代码。**

### 第二档:「连接 VPS 的格式规范」—— 版本号在场,协商缺席

`PANEL_SCHEMA_VERSION = 1`([`panel-schema.ts:32`](../../packages/personal-butler/src/panel-schema.ts#L32)),
校验器**精确相等**才过([`:264`](../../packages/personal-butler/src/panel-schema.ts#L264)),
响应 DTO 也带版本号。但服务端**永远回填常量**
([`me-panel-surface.ts:154/180`](../../packages/host/src/me-panel-surface.ts#L154)),
客户端**从不读**——`sdui-ui.js` 全文没有一处读 `data.schemaVersion`,
[`renderPanel`](../../packages/web/static/sdui-ui.js#L758) 直接取
`data.config.sections`,版本字段被静默丢弃。

M0 计划的三条协商([`SDUI-PANEL.md:177-183`](SDUI-PANEL.md#L177))只做了一条:

- 未知组件 → 占位卡 ✅ [`sdui-ui.js:695`](../../packages/web/static/sdui-ui.js#L695)
- 客户端声明支持的组件集 ❌ `fetch('/api/me/panel')` 裸调,零 header 零 query
- 版本高于客户端 → 整面板降级 + 响亮提示 ❌ 完全未实现

今天两份 13 项清单靠一条**文本比对测试**保持同步
([`sdui-ui-contract.test.ts:46-51`](../../packages/web/tests/sdui-ui-contract.test.ts#L46))。
**这招只在渲染器与 schema 同仓同 commit 时成立**——壳一旦独立发版立刻失效:
旧壳收到新组件只会显示「需要升级客户端」,而服务端永远不知道该不该降级下发。

`/healthz` 只回纯文本 `ok`([`server.ts:762`](../../packages/web/src/server.ts#L762)),
**任何服务器都能伪造**,没有能力握手。

**但这一档有整套现成的宝可搬**:`/.well-known/agent-card.json` 免认证公开发现
([`server.ts:790`](../../packages/web/src/server.ts#L790))+ `resolveCardUrl()`
地址规范化([`peer-card.ts:54-58`](../../packages/cli/src/commands/peer-card.ts#L54))
+ `--expect-kid` **绑真实指纹而不认 header 里可伪造的 kid**
([`peer-card.ts:200-228`](../../packages/cli/src/commands/peer-card.ts#L200))+ 出码分级。
「输地址 → 验证这确实是我那台 hub → 拿它的能力声明」这条动线的服务端与验证
逻辑**都已写好并测过**,只是今天只有 CLI 在用。注意 hub 未接线 federation 时
该端点 404([`server.ts:795`](../../packages/web/src/server.ts#L795))。

同理 `peers` 表(`endpoint_url` + `vault_entry_id` 凭证分离 + 轮换原子事务)是
「记住一个远端地址加凭证」的成熟数据模型,只是今天主体是 hub 不是客户端。

### 第三档:形态可变性的真实天花板

`app.html` 的 tabbar **硬编码 17 个页签**([`app.html:242-260`](../../packages/web/static/app.html#L242)),
member 只看得见 `home` / `panel` / `settings` 三个,而 `#home-panel`
([`:269`](../../packages/web/static/app.html#L269))与 `#settings-panel`
([`:563`](../../packages/web/static/app.html#L563))的内容也是硬编码的。
**整个 app 里唯一由配置驱动的区域是 `#sdui-panel` 这个空壳**
([`:558`](../../packages/web/static/app.html#L558))。

**渲染器与宿主 SPA 五条硬耦合,零注入点**:

| 依赖 | 位置 | 归属 |
|---|---|---|
| `window.Gotong.t` 词典 | [`sdui-ui.js:39`](../../packages/web/static/sdui-ui.js#L39) | `app-core.js:1949-1951`(zh)/`:4093-4095`(en) |
| `gotoTab` / `location.hash` | [`sdui-ui.js:53-54`](../../packages/web/static/sdui-ui.js#L53) | app-core 的 tab 路由 |
| `onLangChange` | [`sdui-ui.js:962-964`](../../packages/web/static/sdui-ui.js#L962) | app-core |
| `document.body.dataset.activeTab` + MutationObserver | [`sdui-ui.js:951/956-959`](../../packages/web/static/sdui-ui.js#L951) | SPA tab 协议 |
| `#sdui-panel` 宿主元素 | [`sdui-ui.js:926`](../../packages/web/static/sdui-ui.js#L926) | app.html |
| `localStorage['gotong-sdui-change-ack']` | [`sdui-ui.js:727-732`](../../packages/web/static/sdui-ui.js#L727) | 全局 key |
| CSS(`sdui-*` 与共用的 `me-meta`) | `styles.css:3701` 起 | 不随文件走 |

文件本身是**规矩的**:裸 IIFE(`sdui-ui.js:32` 开 / `:970` 收),零 import
零 export,DOM 操作限定在自己宿主内。但「客户端只是渲染器」目前更接近
「app-core 的一个插件」。

**闭集里有一项空转**:`image-card` 校验器放行
([`panel-schema.ts:203`](../../packages/personal-butler/src/panel-schema.ts#L203)
有完整 contract)但不在渲染注册表里
([`sdui-ui.js:676-689`](../../packages/web/static/sdui-ui.js#L676)),永远渲染
成「即将上线」。合法配置 ≠ 能看见东西,而且管家拿到的组件小抄
([`personal-butler-panel.ts:145-152`](../../packages/host/src/personal-butler-panel.ts#L145))
也认为它可用——被注入或只是幻觉的管家会理直气壮摆一个空卡。

**成员侧没有实时通道**:`/api/stream` 对 member 直接 401
([`server.ts:921`](../../packages/web/src/server.ts#L921) 的
`requireAdminOrWorker` 要求 owner/admin)。app 里只能轮询加推送。

### 第四档:壳与原生能力

**零 Capacitor 代码。** 全仓 grep `capacitor|cordova` 只命中文档,外加一个
`'quantum flux capacitor misaligned'` 的测试 fixture 误命中。

**一条需要诚实修正的既有说法**:[`WEB-PUSH.md:188`](WEB-PUSH.md#L188) 写着
原生 FCM/APNs「这条腿将来原样复用,只换传输」。核实后这是过度乐观——
**WKWebView 明确不支持 Push API,Android WebView 也不支持**(app 关闭时唤不
醒),必须走 `@capacitor/push-notifications` 接原生通道。所以:

- **能复用**:订阅存储的 per-member 文件形状、`foldWebPushIntoPush` 的补位
  决策语义(仅 `unknown_member` 才回落)、`push(userId)` 不收 text 的低信息
  纪律、404/410 剪订阅的自愈模式
- **用不上**:`sw.js` 三事件、`PushSubscription`、RFC 8291 加密、VAPID
  ——原生通道拿的是 FCM/APNs device token,加密与 VAPID 全不适用

也就是说 PUSH-M1 那份 RFC 8291/8292 纯核**在壳里是死代码**。这不减损 PUSH
track 本身的价值(纯网页成员那条腿是真实收益),但 M6 的工作量不该按「换个
传输」估算。

**静态资产**:`STATIC_ASSETS_BASE64`([`static-assets.ts:9`](../../packages/web/src/static-assets.ts#L9),
30 文件 / 1,363,141 字节)是给 `bun build --compile` 单文件二进制用的内嵌副本,
唯一消费者是 [`static-routes.ts:34`](../../packages/web/src/static-routes.ts#L34)。
`static/` 目录本身在树在包,做 `webDir` 直接拷即可,**不必解 base64**;但目前
没有导出脚本。

**图标只有一个 SVG**([`manifest.webmanifest:12-19`](../../packages/web/static/manifest.webmanifest#L12)),
**iOS 完全不吃 SVG app icon**,商店打包要补 PNG 尺寸集。

**服务端模板注入**:`serveAppHtml()` 对 app.html 做两处替换——角色与 bootstrap
hint([`static-routes.ts:244-246`](../../packages/web/src/static-routes.ts#L244))。
本地加载拿不到注入,但注释([`:167-170`](../../packages/web/src/static-routes.ts#L167))
明确这只是 render hint 不是安全边界,壳自己填或改成 fetch 都不破坏鉴权。

### 横切的小账(app 化之后才会痛)

- 成员 session cookie **7 天**([`identity-routes.ts:504`](../../packages/web/src/identity-routes.ts#L504)),
  app 用户每周被踢一次
- api key 永不过期、无设备维度——丢手机没法只吊销一台
- 成员 Bearer 无限速;每次 Bearer 请求写一行 session,移动端轮询会放大写入

---

## 五、五条不可破边界

**① 壳是第 N 个渲染器,不是新的权威点。** 所有治理闸(governed park、审批、
角色门、`/me` 的 server-pin userId)在壳里**字节不变**。壳不得引入任何
「只有 app 能做」的动作,也不得成为绕过闸的旁路。装了 app ≠ 多了权限。

**② 同源假设的解除必须结构化。** base URL 收敛成**一处咽喉**,不是 52 处各自
判断;「连哪台 hub」在整个客户端里**只有一个地方**决定。散落的 base URL 拼接
是 SSRF 与错连的温床——这条与 PUSH-M2 把 endpoint 校验收进唯一咽喉同源。

**③ 契约先于第二渲染器。** 壳独立发版意味着「渲染器与 schema 同仓同 commit」
的假设失效,文本比对测试当场变成空头支票。**不做完 M3 协商就不发壳**——否则
第一次组件升级就是线上事故。

**④ opt-in 未装字节不变。** 现有 web SPA 在 base URL 为空时走相对路径,与今天
**逐字节一致**;设备配对不签发就没有第二条认证路径。壳与 web 共用一套代码,
但 web 用户感知不到 SHELL track 发生过。

**⑤ 内核零改动、零新旋钮。** 全部工作在 web 静态资产层 + 一条 identity 签发
路由 + 一个独立的壳工程目录。`GOTONG_*` 旋钮维持 **116**——「连哪台 hub」是
设备上的客户端状态,不是 hub 的环境变量;公网部署复用既有 `GOTONG_ALLOWED_HOSTS`。

---

## 六、里程碑

> 纪律照旧:一个里程碑一个 commit,每个独立可验收,先立门后写码。

| 里程碑 | 内容 | 验收 |
|---|---|---|
| **M0 计划** | 本文档(纯 docs) | 侦察 file:line 齐、边界钉死、岔口摆出 |
| **M1 设备配对签发** ✅ `4991bab` | 抄 IM 6 位码形状,成员自助兑换出 `aipk_`;补 expiresAt + 设备维度 + Bearer 限速;**二维码编码「地址 + 一次性码」**(岔口 C2) | 成员自助全程走通;码单次消费;过期拒;限速生效;二维码扫出的地址与码能直接建连 |
| **M2 base URL 层** ✅ `1178901` | 一处咽喉收编全部 hub 请求 + EventSource + 设备凭证 | 默认空 ⇒ 与今天**逐字节一致**(防腐门);设了 ⇒ 全部 `/api` 请求指向远端并带 Bearer |
| **M3 契约做实** | 客户端声明 schemaVersion + 组件集;服务端按声明下发;版本超出 ⇒ 整面板降级 + 响亮提示;顺手修 `image-card` 空转 | 旧客户端收到新组件配置 ⇒ 降级不炸;协商缺席时按最低集下发 |
| **M4 渲染器解耦** | 五条硬耦合改注入点(i18n / tab 协议 / 宿主元素 / CSS / storage key) | `sdui-ui.js` 能在裸 HTML 里挂起来跑 |
| **M4.5 骨架配置化** | **全部 17 个页签**纳入配置(岔口 B2):tabbar 配置驱动生成 + 15 个 admin bundle 改按需加载 | 两个成员打开 app 看到**不同的导航结构**,不只是不同的面板内容;**防腐门:配置驱动的 tabbar 不得成为提权路径**(member 配置里写 admin 页签仍拿不到 admin 面,服务端照样 403) |
| **M5 壳工程** | `capacitor.config.ts`(`webDir` + `CapacitorHttp.enabled`)+ static 导出脚本 + PNG 图标集 | 真机装上、打得开、能连本机 hub |
| **M6 原生推送** | `@capacitor/push-notifications` 接 FCM/APNs;复用订阅存储形状与 fold 决策。**大陆版按 A1 不接推送**(只轮询) | 真机锁屏收到低信息 tap;绑 IM 成员仍零双发 |
| **M7 真机 round-trip** | 装壳 → 输地址 → agent-card 验身份 → 配对拿 token → 面板渲染 → 推送送达 | 全链路一次跑通,console 零错误 |
| *分发* | 商店上架 / 演示形态过审 / APK 签名 / 大陆直发 | **用户门,不进 track** |

**前置条件(用户运维动作,阻塞 M7)**:VPS 需要域名 + TLS + 公网入口。
`deploy/Caddyfile.baremetal` 模板已备,要做的是买域名、配 DNS、`cp` 模板、
把 `GOTONG_ALLOWED_HOSTS` 对齐、`systemctl reload caddy`。约半天,不写代码。

### M2 落地时对计划的两处修正(2026-07-29)

1. **数字**:M0 侦察记的「52+9 处」是按 `fetch('/` 的粗口径数的。M2 开工前
   全量重数 = **227 处** `/api` 字面量 / **25 个手写文件**,外加**唯一一个**
   非 fetch 出口 `new EventSource('/api/stream')`。这个数字正是「不去逐处改、
   改补一层」这个设计判断的依据。

2. **「15 个 bundle 路径」不归 M2**:那 15 条是 `<script src>` 注入,不是
   fetch;而且在真壳里 admin bundle 是**设备本地资源**,重写它们只会把本来
   就在本地的东西打到网上去。M2 的咽喉因此**刻意只重写 `/api/`**。bundle 的
   按需加载是 **M4.5** 的活(岔口 B2 的主要增量),不是 URL 层的活。

**「SW 同源锁」也从 M2 出列**:service worker 是独立 global,补丁到不了;而
SW 只存在于服务它的那个源,它的 `/api/…` 按定义就是本 hub。真壳根本没有 SW
(推送在 M6 走原生)。已在 `sw.js` 就地注明,不是遗漏。

---

## 七、岔口拍板记录(2026-07-28)

### A. 大陆分发那条腿 → **A1 先不做推送,只轮询**

FCM 在大陆结构性不可用,不是配置问题。三选项:A1 只轮询(打开 app 才看到新
消息)/ A2 接厂商推送(小米 / 华为 HMS / OPPO / vivo,**每家一套 SDK 与审核**,
工作量大且持续——厂商 SDK 会腐)/ A3 UnifiedPush 自托管(与 PUSH-M2 刻意不做
厂商域白名单的设计天然兼容,但要求用户额外装一个分发器 app)。

**拍板 A1**:先证明壳本身成立,推送是第二战场,主用户在马来西亚(FCM 可用)。
大陆推送作为独立后续 track,不进 SHELL。

### B. 骨架配置化画到哪 → **B2 全部 17 个页签**

选项:B1 只 member 可见的三页签(`home` / `panel` / `settings`,admin 的 14 个
保持硬编码)/ B2 全部 17 个。

**我推荐的是 B1,用户拍板 B2**,理由是我在摆岔口时低估了一件事——

> **B2 的真正好处是「一套机制而不是两套」。** 若 tabbar 完全由配置生成,admin
> 页签只是「配置里默认发给 owner/admin 角色的条目」,不必维护「这三个可配置、
> 那十四个硬编码」的分界线;那条分界线本身会成为长期的腐坏点(每加一个页签都
> 要问它落在哪边)。而且与原话「**app 本身**要有极大可变性」一致:operator 自己
> 的 app 形态没道理是固定的。

**代价如实记录**(M4.5 设计时必须正面处理):

1. **`app.html` 骨架要从「静态 17 个 `data-tab` 按钮」变成配置驱动生成**
   ([`app.html:242-260`](../../packages/web/static/app.html#L242));
2. **15 个 admin bundle 的串行加载链**([`app.js:3994-4012`](../../packages/web/static/app.js#L3994))
   要从「owner/admin 就全加载」变成「按配置里出现过的页签按需加载」——这是
   B2 相对 B1 的**主要增量**,也是它唯一真正的风险点;
3. **角色门不得随配置松动**:页签可见性今天靠 `data-roles`,配置化后必须保持
   「配置只能减不能加」——一个 member 的配置里写上 `identity` 页签,**不得**
   因此拿到 admin 面;服务端该 403 的照样 403(边界①的直接推论)。

第 3 条是 B2 引入的**新的错误可能性**,B1 没有。M4.5 必须为它立一道防腐门:
**配置驱动的 tabbar 不得成为提权路径。**

### C. 设备配对的交互形状 → **C2 二维码 + C1 兜底**

选项:C1 6 位码(抄 IM 绑定,web 生成 app 手输)/ C2 二维码(web 显示 app 扫,
码里编码 **hub 地址 + 一次性码**)/ C3 手输 URL + 粘 token。

**拍板 C2 + C1 兜底**:二维码一步解决「输地址」与「拿凭证」两件事,顺带把
第一档「app 内输入服务器地址」的动线一起解决;扫不了时退回手输 6 位码
(此时地址仍需手输,是刻意接受的降级)。

---

## 八、显式不做

- **多 hub 客户端** — 一个 app 同时连多台 hub。`hubId` 是**服务端**多租户预留
  ([`identity/types.ts:1828`](../../packages/identity/src/types.ts#L1828)),
  不是客户端多连;真要做是独立设计,不塞进 SHELL。
- **成员侧实时 SSE** — `/api/stream` 对 member 开放需要按 userId 过滤 firehose,
  那是新的安全面(NA-M6 已显式不推荐过)。壳里走轮询 + 推送。
- **改用 React Native / Flutter** — 社区说这能永久解决 4.2,但那等于重写整套
  界面,与「一套 web UI 分批点亮」的既定交付路径冲突。若 M7 之后真被 4.2 反复
  打回,再单独开岔口。
- **离线写** — 壳里缓存读没问题,离线编排面板 / 离线审批涉及冲突合并,不做。
- **壳内 HealthKit / Google Fit** — SDUI-M0 就已划为独立后续 track(HEALTH)。

---

## 九、相关文档

- [`SDUI-PANEL.md`](SDUI-PANEL.md) — 组件系统与配置 schema 的出处(M1–M4 + C1)
- [`WEB-PUSH.md`](WEB-PUSH.md) — 浏览器那条推送腿;§八 落地记
- [`DEPLOY.md`](DEPLOY.md) §C.5 — 裸机 Caddy 反代逐行讲解
- [`THREAT-MODEL.md`](THREAT-MODEL.md) — 部署者视角的信任边界(壳是新的分发面)
- [`SURFACE-PATTERN.md`](SURFACE-PATTERN.md) — host↔web 鸭子注入惯例
