# SHELL 真壳 — 独立客户端连自有 VPS(⏸ 已搁置)

> ## ⏸ 方向搁置声明(2026-08-02,用户令)
>
> **本 track(自适应壳 app 方向)暂停推进。** 用户在 Redmi 真机上对照大陆
> 成熟消费级 app 后判定观感差距过大,拍板搁置。诊断记录(观感差距三层):
> ① **数据活水未开**——手机连的是测试 hub,生产晨报/中转卡休眠,空卡占了
> 观感差距的一半以上;② **视觉资产层缺失**——渲染器只有「文字+边框+色块」,
> 没有图标/插画/图像位(这层可追,质感住在渲染器,但需要持续投入);
> ③ **WebView 结构性天花板**——滚动物理/触感/原生转场是网页渲染器天生弱项,
> 能到「干净清晰」到不了「精品级」,破它要换 React Native/Flutter 重写(不值)。
> 范式本身(SDUI 配置驱动)不是瓶颈——大陆精品 app 内部正是这套做法;差的是
> 设计资产投入与数据运营,一人项目投入产出比不划算,故搁置。
>
> **搁置时快照**:M0→M6A 全完 + POLISH 质感四刀(老龄化 token/组件三态/
> 壳 chrome/主题热切+刷新按钮),iOS 模拟器与 Android 真机(Redmi)全动线
> 验证过;debug APK 可用。**仅余 M7**(生产公网化域名+TLS + Apple Developer
> 账号,用户运维门)——搁置后不催不推进。
>
> **不受影响(继续活着)**:网页端 SDUI 面板(生产在用,晨报写面板卡小刀
> `27af9cd` 已部署)、渲染器三件(`packages/web/static/sdui-*`,网页端共用)、
> 设备配对/base URL/契约协商等 hub 侧机制(M1–M4.5 的产出都是 hub/web 层
> 通用资产,不随壳搁置而腐)。
>
> **恢复路径**:代码全在仓库(壳工程 `shell/`,iOS+Android 双线);APK 零改动、
> 填上生产域名即连生产。从 M7(#200 公网化)捡起即可;视觉资产层(图标/插画/
> 图像位)是恢复后的第一优先投入。
>
> ---
>
> **一句话**:把 `packages/web/static/` 那套界面**装进设备本地**,通过一层
> base URL 与一次设备配对连上**你自己那台 VPS 上的 hub**;界面形态仍由
> file-first 配置决定,但客户端不再是「那台 VPS 的浏览器」,而是一个能独立
> 发版、有原生推送、装了就在的 app。
>
> Track 代号:**SHELL**。Status: **⏸ 搁置(2026-08-02)**。搁置前进度:
> **M1 设备配对 ✅ · M2 base URL 层 ✅ ·
> M3 契约做实 ✅ · M4 渲染器解耦 ✅(2026-07-29) · M4.5 骨架配置化 ✅
> (2026-07-30) · M5 壳工程 ✅(2026-07-30,iOS 模拟器全动线;真机=M7) ·
> M6 原生推送 ✅(2026-07-30,APNs 直连;真 APNs 送达=M7) · M6A 安卓线 ✅ ·
> POLISH 质感四刀 ✅ · Android 真机(Redmi)全动线 ✅**;仅余 M7 真机
> round-trip(用户运维前置:域名+TLS + Apple Developer 账号)。
> 本 track 是 [`SDUI-PANEL.md`](SDUI-PANEL.md) 里程碑表 M5 那一格的展开——
> 侦察后确认它装不进一格(见 §四)。
> 形态拍板:**真壳**(本地资源 + `CapacitorHttp` 走原生请求),而非瘦壳
> (壳里包一个远端 URL)。理由见 §三。
> 岔口拍板(2026-07-28):**A1** 大陆推送先不做只轮询 / **B2 骨架配置化画到全部
> 17 个页签**(未取推荐的 B1 三页签,理由见 §七)/ **C2+C1** 二维码编码
> 「地址 + 一次性码」、6 位码兜底。
> Last updated: 2026-08-02(搁置声明)

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
| 固定的是**连接 VPS 的格式规范** | `schemaVersion` 字段在场,但服务端硬编码回填、客户端从不读 | 有版本号,没有协商 → **M3 ✅ 已补**(`?client=N` + 服务端判定 + 整面板降级) |
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

M0 计划的三条协商([`SDUI-PANEL.md:177-183`](SDUI-PANEL.md#L177))只做了一条
(**M3 已补齐,成色见下方 ✅ 标注**):

- 未知组件 → 占位卡 ✅ [`sdui-ui.js:695`](../../packages/web/static/sdui-ui.js#L695)
- 客户端声明支持的组件集 ❌ `fetch('/api/me/panel')` 裸调,零 header 零 query
  → **M3 改为声明 schemaVersion**(`?client=N`);**组件集刻意不声明**,理由见
  下方 M3 落地记
- 版本高于客户端 → 整面板降级 + 响亮提示 ❌ 完全未实现 → **M3 ✅**

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
**M3 已收**(闭集 13→12):真做它要图片字节存储 + content-type + 尺寸校验,那是
一个里程碑不是一个脚注;全仓无人引用,诚实的修法是不再列它。这类 bug 随即转成
防腐门——**每个 KNOWN_TYPE 必须有真渲染器**,把「暂列一个还没渲染器的类型」
从「悄悄活过一次发版」变成一个必须故意做的动作。

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
**M3 ✅ 已解除**(`f6aa7be`):`?client=N` 声明 + 服务端算判定 + 版本更新 ⇒ 整面板
降级。那条文本比对测试**留着**,但改口成**仓内卫生**而非协议要求——协议自此
不再依赖「两份清单相等」,一个已发版的壳带着更老的清单是合法的。

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
| **M3 契约做实** ✅ `f6aa7be` | 客户端声明 schemaVersion(`?client=N`);服务端算判定;版本超出 ⇒ **整面板**降级 + 响亮提示;顺手退役 `image-card` 空转 | 旧客户端收到新 schema ⇒ 整面板降级不炸,徽章与形态选择器仍在;声明**永远改变不了配置字节**(四种声明同字节) |
| **M4 渲染器解耦** ✅ | 五条硬耦合改注入点(i18n / tab 协议 / 宿主元素 / CSS / storage key)全部收进 `GotongPanel.mount(opts)`;**SPA 成为这个 API 的第一个调用者**而非特权侧门 | `sdui-standalone.html` 只加载渲染器三件套就渲染出真面板(真浏览器已证:3 段 5 卡 · `window.Gotong` undefined · console 零错误) |
| **M4.5 骨架配置化** ✅ | **全部 17 个页签**纳入配置(岔口 B2;落地时实为 18——M0 数的 17 + SDUI-M2 的「面板」页签):tabbar 配置驱动生成 + 15 个 admin bundle 改按需加载 | 两个成员打开 app 看到**不同的导航结构**,不只是不同的面板内容;**防腐门:配置驱动的 tabbar 不得成为提权路径**(member 配置里写 admin 页签仍拿不到 admin 面,服务端照样 403)——真机三层全证 |
| **M5 壳工程** ✅ | `capacitor.config.ts`(`webDir` + `CapacitorHttp.enabled`)+ static 导出脚本(兼防腐门)+ PNG 图标集;顶层 `shell/` 刻意不进 pnpm workspace | 装上、打得开、能连本机 hub 三条在 iOS 模拟器全过:**机内**配对(HID 真点真打)→ claim 换 `aipk_` → 面板渲染真巡检数据;重启直落连接态;`gotong://` 深链预填不自提交。真机 + 生产 VPS = M7 |
| **M6 原生推送** ✅ | **APNs 直连**(host `apns-push.ts`:node:http2 + ES256 provider token,零新依赖零中央中转);凭证 file-first `<space>/apns.json` + p8 **非旋钮**;壳侧 `@capacitor/push-notifications` 按钮开启绝不启动自动弹权限;**FCM 随 Android 壳一起推迟**,大陆 A1 只轮询不变 | 模拟器全动线十段(开启→真 160-hex token 注册→前台/锁屏横幅→点开只回面板→断开先注销);绑 IM 成员字节不变(`composeTapFallback` 并两腿后仍只在 `unknown_member` 回落);**真 APNs 送达=M7**(需 Apple Developer p8;发送器由 20 单测含真 h2 wire 逐字节盖) |
| **M6A 安卓线** ✅ | Android 壳(`cap add android`,AGP 8.13/Gradle 8.14.3/SDK 36 官方基线)+ hub **FCM v1 发送腿**(`native-push.ts` 共核:APNs/FCM 两腿骑同一 per-user token store;凭证 file-first `<space>/fcm.json` **非旋钮**;404 `UNREGISTERED` 剪 token)+ **明文只回环**的 network security config(M2 咽喉在原生层的镜像) | Android 模拟器八段全绿:机内配对(`adb reverse`,咽喉拒非回环 `10.0.2.2` 实证)→面板真数据;设备行 `Gotong 壳 (android)`;通知行按 `platforms()` 门控隐藏;深链只预填不动既有连接;断开=本机忘记。**FCM 端到端=用户门**(Firebase 项目 + google-services.json;发送腿 24 单测盖) |
| **M7 真机 round-trip** | 装壳 → 输地址 → agent-card 验身份 → 配对拿 token → 面板渲染 → 推送送达 | 全链路一次跑通,console 零错误 |
| *分发* | 商店上架 / 演示形态过审 / APK 签名 / 大陆直发 | **用户门,不进 track** |

**前置条件(用户运维动作,阻塞 M7)**:①VPS 需要域名 + TLS + 公网入口。
`deploy/Caddyfile.baremetal` 模板已备,要做的是买域名、配 DNS、`cp` 模板、
把 `GOTONG_ALLOWED_HOSTS` 对齐、`systemctl reload caddy`。约半天,不写代码。
②M6 后新增:**Apple Developer 账号**(出真 p8 APNs key + 真机签名)——没有它
真 APNs 送达与真机安装都验不了。

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

### M3 落地记 + 对计划措辞的一处校准(2026-07-29)

**两条协议规则**(写进 `panel-schema.ts` 头注,它们是这个数字的全部含义):

1. 渲染器**必须**渲染 schemaVersion **≤** 自己的配置。版本号买的就是这个
   保证,所以 `client_ahead`(hub 比壳旧)是**正常且完全可用**的状态,不是错误。
2. 渲染器**绝不**猜更新的 schema。未知**组件**早已一张卡一张卡地降级;但未知
   **schema** 会改变它认得的字段的含义——半懂的面板比诚实拦下的面板更坏,
   所以答案是**整面板**降级。

**判定服务端算,一处权威。** `panelContract(clientDeclared)` 由 schema 包独占
(镜像 `derivePatrolCards` 的严重度、server-computed `isButler` 同一纪律),
管家视图、HTTP 面与将来任何渲染器都不可能各说各话。客户端谎报版本只改变
**它自己被告知什么**,永远改变不了**它被服务什么**。

**校准:「协商缺席时按最低集下发」= 按最低能力客户端判定,不是下发一份被裁剪
的配置。** M3 实现时按后一种读法试了一遍就否掉了:声明过滤配置会悄悄削窄
**成员自己配的**面板(与「占位卡是设计内一等公民,永不空白」正相反),并且把
一个**客户端自报的值**放进「服务什么数据」的路径上。这条性质现在钉了两道——
路由测试断言四种声明(无 / `?client=1` / `99` / 路径穿越串)下 config **字节
完全相同**,真机再证一次(`identicalConfigBytes: true`)。

**组件集刻意不声明。** 计划原写「声明 schemaVersion **+ 组件集**」,落地只留
前者:服务端**用不上**组件集(未知组件本地降级;管家的组件小抄是 spawn 时构建
的,per-request 声明够不到它;同一成员还可能同时开着两个不同版本的客户端)。
留着它只会让协商面变宽而不增加任何保证。协商面因此**只有一个整数宽**。

**`panelContractVerdict(server, client)` 从 `panelContract` 里拆出来**:服务端
那侧是常量,`PANEL_SCHEMA_VERSION` 还是 1 时 `client_outdated` 分支从公开入口
**结构性到不了**——而那正是本里程碑存在的理由。两个版本都收作参数后,
「v2 hub 对 v1 壳」的用例在 v2 hub 存在之前好几年就可测。这就是要点:机制必须
在分叉**还是假设**的时候就证死。

**降级分支保什么:徽章 + 形态选择器。** 版本不符绝不能变成藏起待批条的路子
(那是 SDUI 保留区纪律的直接推论),成员也必须始终留着一条退路——换一个形态。
真机实证:伪造 v2 响应打这台 v1 渲染器 ⇒ 0 段 0 卡、通知出现、徽章在、形态
选择器在;撤掉补丁后 3 段 5 卡照旧,console 零错误。

**这一刀之后,「不做完 M3 协商就不发壳」这条前置条件已解除。**

### M4 落地记(2026-07-29)

M0 侦察点名的**第四硬骨头**:渲染器与宿主 SPA 有**五条硬耦合、零注入点**——
i18n 词典在 `app-core.js`、tab 协议靠 `document.body.dataset.activeTab`、宿主
元素写死 `#sdui-panel`、CSS 混在 `styles.css` 里、storage key 是文件内常量。
壳里没有这个 SPA,所以五条里任何一条留着,渲染器就搬不走。

**收法是一个公开 API,不是五个补丁**:`GotongPanel.mount(opts)` 收下
`{host, lang, gotoHome, storageKey, render}`,渲染路径只读模块级 `CTX`,
`window.Gotong` / `document.body` / `getElementById` 一律不再出现在渲染路径里
(防腐门按 `boot()` 位置切开源码,逐个断言)。

**最关键的一处判断:SPA 成为这个 API 的第一个调用者,而不是特权侧门。**
自举块自己调 `mount()` 传三个选项,于是**每一次页面加载、每一条既有浏览器测试
都在走壳将来要走的那条路**;若让 SPA 继续直接摸内部函数,壳那条路就只有一个
demo 页面在覆盖——那正是「写完就腐」的形状。

**i18n 是一刀切走,不是复制一份。** 140 个 `sdui*` 词条在 `app-core.js` 里
**只有一个消费者**,所以搬进渲染器是**消灭**了一个漂移源而非新增一个。这类
漂移已经真实咬过一次:`sduiShapeInstallBtn` 曾经发版时没有对应词条,按钮直接
把 key 名渲染在界面上。现在两份词典同在一个文件,防腐门于是能做**双向**核对
(每个用到的 key 中英都在 + 每个声明的 key 都有人用),顺手清掉了一个从
SDUI-M2 起就没人用过的 `sduiMadeByAtong`。

**刻意不算耦合的一条:`fetch('/api/...')` 保持根相对。** M2 的 `hub-target.js`
是「连哪台 hub」的唯一咽喉,渲染器再答一次这个问题,正是 M2 明令禁止的第二处缝。

**一页一个面板,是设计不是限制。** `mount()` 重绑模块级 `CTX` 而不是造
per-instance 闭包:同页两个活面板不是壳或 SPA 需要的东西,而为它买单要把一个
context 穿过约 40 个渲染函数。

**验收面 `sdui-standalone.html`**——里程碑那句「能在裸 HTML 里挂起来跑」的
可执行形式:只加载 `/sdui-ui.css`、`/hub-target.js`、`/sdui-ui.js`,宿主元素
**故意不叫 `#sdui-panel`**(于是 SPA 自举在这页结构性是空转,屏幕上的面板只可能
来自那次 `mount()` 调用)。它同时是 M5 的种子:Capacitor 的 `webDir` 里就是一张
这个形状的页。防腐门把「不许把 SPA 拉回来」写成断言——`/styles.css`、
`/app-core.js`、`/app.js` 一个都不许出现。

**排错记一条(真踩到,已转成防腐门)**:那页第一版把 `mount()` 写在**内联
`<script>`** 里,浏览器里一片空白且控制台不报错——hub 的 CSP 是
`script-src 'self'`(没有 `'unsafe-inline'`),内联块根本不执行。这条策略是对的,
不该为一个诊断页放宽;正确修法是把引导代码抽成 `sdui-standalone.js`。门因此
多断言一条:**该页不得含内联 `<script>` 块**——真壳的 CSP 只会更严。
(同期还确认了一件运维事实:host **在启动时**读嵌入静态资源表,改 `static/*`
之后必须 `pnpm build` **并重启进程**,否则浏览器拿到的仍是旧字节。)

**真机 round-trip 双向**:①SPA 侧无回归——面板页签仍 3 段 5 卡、徽章在、
停在面板页切语言即时重渲染、`window.Gotong.t` 里 `sdui*` 词条**为 0**(证明
文案确实来自渲染器自己那份)、`.sdui-card` 的圆角来自新的 `/sdui-ui.css`;
②裸页侧——3 段 5 卡真数据、`window.Gotong` 为 `undefined`、页面自带的
中英按钮即时切换、`#sdui-panel` 元素不存在;两侧 console 均零错误。

### M4.5 落地记(2026-07-30)

M0 侦察点名的**形态天花板**(tabbar 硬编码、只有 `#sdui-panel` 一格配置驱动
=「一个页签内部可变」)收口:导航骨架本身进配置。落地按岔口 B2 画到**全部
页签**——实为 **18** 个而非 M0 数的 17(SDUI-M2 加的成员可见「面板」页签也在
册,它没有理由是特例;「一套机制」正是 B2 当初胜出的理由)。

**骨架只有一个真相源:`TAB_REGISTRY`。** app.js 里 18 条 `{ id, i18n, roles }`,
role 基线逐条照抄改造前 `data-roles` 的字面值(owner-only 的 users/quotas/
usage/reputation/federation/oidc/saml 一个不松);`app.html` 的
`<nav id="admin-tabbar">` **出厂为空**——一个写死在 markup 里的按钮会同时绕过
角色过滤与配置,把它从骨架里物理移除是比「记得过滤」强得多的形状(防腐门直接
断言 served bytes 里零按钮,注释也不许含按钮 class 字面量——M4「散文可以说、
代码不许写」同一姿态)。

**提权门是一次交集,不是一串检查。** `effectiveTabs()` = 配置序 ∩ 角色基线,
再把保留区地板补到尾部——这是配置与角色**唯一**相遇的地方,交集运算只能收窄
不能放宽,于是「member 配置里写 `users` 也拿不到 admin 面」不是被某个 if 挡住
的,是**结构性不可表达**的。三层门:①按钮不渲染 ②bundle 不加载 ③服务端照样
拒(实测是 **403** 不是 401——member 会话是真身份,`requireAdmin` 拒的是权限,
两层测试各钉各的)。

**保留区地板 `['home','panel','settings']` 镜像 schema 的
`PANEL_RESERVED_TABS`**,配置漏了也补回:home 装着待批收件箱(藏起它=藏起
审批,保留区纪律的直接推论)、panel 是成员的形态选择器与 undo 退路(M3 降级
分支保的同一件东西)、settings 是语言与登出。防腐门双向核对两份名单同序。

**首屏纳入配置**:`defaultTab()` = 配置里第一个可用页签(无配置=角色默认,
与改造前逐字节同行为);hash 深链仍然赢。「对不同的人不同形态」自此包含
**打开 app 落在哪一屏**。

**wire 是 additive 的一个可选键,schemaVersion 不跳。** `PanelConfig.tabs?`
进 M1 校验器(非空、≤18、known id、无重复),按 M3 规则①「additive + 可忽略」
留在 v1;**它只是渲染提示**——服务端不解释、不过滤,任何客户端拿到的 config
字节相同(M3「声明改变不了被服务什么」纪律原样适用)。管家小抄从
`PANEL_TAB_IDS` 运行时派生(零手抄=零漂移)。骨架读者自带
`SKELETON_SCHEMA_VERSION` 与面板渲染器锁步(防腐门钉死),hub schemaVersion
更新 ⇒ 忽略 tabs 回落角色默认——这个回落**天然无害**:角色默认只会在角色内
显示**更多**,永远不会越过角色显示不该显示的。

**14 个 admin bundle 改按需加载(B2 的主要增量)**:`CORE_ADMIN_BUNDLES`
(admin.js + wf-assist)在任一 admin 页签幸存时装,其余 12 个按
`TAB_BUNDLES` 映射(overview→steward/setting-ops,users→identity-ui,
federation→peer 三件+a2a,……)只装配置里出现过的。**按配置选,不按
simple-mode 选**——simple mode 是 localStorage 活开关,关掉的瞬间 bundle 必须
已经在场;而配置变更走整页重载,是安全的选择时机。**boot 顺序因此是刻意的**:
`await resolveTabConfig()`(4s AbortController 有界,失败 fail-soft 角色默认)
先于 wireTabs 与 loadAdminBundles——script 标签注入了就收不回来,配置必须先
落定。admin-src 里三处 `.tabbar-btn[data-tab=…]` 消费者(任务徽章/services/
reallife)各自带缺席守卫,页签被配置移除时优雅空转。

**防腐门 `skeleton-config-contract.test.ts`(19 例)双半**:文本半用响亮解析
(`must()`——解析不到就红,不会静默变绿)钉注册表↔`PANEL_TAB_IDS` 双向同序、
保留区镜像、版本锁步、role 基线逐条字面值、app.html 零按钮、每 id 有 section、
每 i18n 键双语在、15 bundle 无重复且 src 都真实存在;VM 半把**真 app.js** 跑
在 DOM stub 里逐条证行为——member 提权配置 ⇒ 恰好三页签 + `injectedSrcs` 为
空、owner 裁剪配置 ⇒ 只装核心对、重排+hash 深链、新 schema 忽略、fetch 失败
fail-soft。**六处锚点逐一变异测试**(M4 那次「锚点不存在门假绿」的教训:每个
变异先断言真的改动了文件):假注册表条目/静态按钮回填/users 基线放宽/交集
破坏/bundle 无视配置/版本跳号——六次全按预期变红,复原后 byte-identical。

**真机 round-trip 全动线**(fresh space,SW v15 + caches 先清):owner 默认
= 18 个生成按钮按注册表序、首屏 overview(改造前同款)→ 库区种入带 `tabs` 的
形态、走**真实 `PUT {libraryId}` 动线**换上 ⇒ 重载后 5 页签按配置序 + 首屏落
**workflows**;切中文生成按钮即时重渲染(工作流/智能体/我的/面板/设置)→
owner 经 admin 直装面(岔口 D 路由)给 member 装「提权尝试形态」
(`tabs:['users','federation','home']`)⇒ member 登录:hub 如实服务该配置,
渲染恰好 `['home','panel','settings']`、admin bundle 加载数 **0**(仅 5 个核心
脚本)、admin API 探针 **403**——**两个成员看到的导航结构真的不同,且不同不
出角色**;member 面板页签正常渲染(带 `tabs` 键的配置零降级)、member 自己
`{reset:true}` 一步回默认(D 岔口「随时换回」对骨架同样成立);两侧 console
零错误。

**sw.js CACHE v14→v15**:app.html 永不缓存(角色 meta),但预缓存的 app.js
若停在 v14,对上新的空 nav markup 会**一个 tabbar 都渲染不出来**——壳必须
整体刷新。

### M5 落地记(2026-07-30)

**工程落点:顶层 `shell/`,刻意不进 pnpm workspace。**它不是可发布包,
version-gate / publish-readiness-gate / line-budget-gate 只枚举 `packages/*`
(逐一核过),Capacitor 的原生工具链依赖也不该混进内核依赖图——壳在结构上站在
全部四门之外,靠 `pnpm --ignore-workspace install` 独立装依赖,`.npmrc`
`node-linker=hoisted`(原生工具按路径引 `node_modules`,要平铺)。

**`capacitor.config.ts` 三行就是里程碑本体**:`webDir: 'www'` +
`plugins.CapacitorHttp.enabled: true`。后者把 `window.fetch` 换到原生层执行
——原生请求**没有浏览器 Origin**,CORS 问题域整个消失,这就是 M0 拍板「真壳」
的技术根基。与 M2 的 hub-target 补丁**任意先后可共存**:补丁只改 URL 和头再把
活交给当时的 fetch(M2 已单测钉死绝对 URL 原样放行)。

**`scripts/export-webdir.mjs` 是导出脚本兼防腐门**。`www/` 永远现装:渲染器
三件(`hub-target.js` / `sdui-ui.js` / `sdui-ui.css`)从 `packages/web/static`
**逐字节拷贝**(copy 不 fork)+ 壳三件(`index.html` / `shell.js` /
`shell.css`);`www/` 进 `.gitignore`——提交它就是第二份渲染器源,会漂移。
门的断言:**SPA 七件禁入**(app.js / app-core.js / styles.css / sw.js /
admin.js / app.html / manifest,M4「壳里没有这个 SPA」的可执行形式);页面
**不得含内联 `<script>`**(hub 的 CSP `script-src 'self'` 会无声吞掉它——
M4 排错记①原坑);脚本顺序钉死 hub-target → sdui-ui → shell.js(咽喉先于
消费者);标记物在位(`GotongHub` / `GotongPanel` / `CLIENT_SCHEMA_VERSION`)。
**壳刻意没有 service worker**:本地资源无需缓存层,M3/M4 两次踩过的「SW 喂
陈旧字节」坑在壳里结构性不存在;推送走 M6 原生通道。

**壳三件的几处承重判断**:①配对屏 `POST /api/devices/claim` 用**绝对 URL +
`credentials:'omit'`** 直发——此刻 target 还不存在,码就是全部凭证,这一发
**刻意绕过** hub-target 补丁(它只重写根相对路径);拿到 `aipk_` 后交给
`GotongHub.setTarget()`,「连哪台 hub」仍只有 M2 那一处咽喉,壳自己绝不另存
一份。②面板挂载走 `GotongPanel.mount({host, lang, gotoHome, storageKey})`
——M4 那个公开 API 的**第二个真实调用者**(第一个是 SPA 自举),宿主元素刻意
不叫 `#sdui-panel`(sdui-standalone 同手法)。③**深链只预填,绝不自动提交**
:`gotong://pair?u=…&c=…` 打开后地址和码进输入框、按钮留给人按——连接是把
设备凭证交出去的动作,被构造的恶意链接不能把设备静默绑到攻击者的 hub;真机
实测深链也**不动既有连接**(预填后重启,连接原样)。④断开=本机忘记;真撤销
在网页端「我的 → 设备」——claim 响应本就不含 credentialId,设备侧拿不到
撤销句柄是设计不是缺口。⑤裸主机便利层(输 `127.0.0.1:3135` 自动试
https/http 前缀)每个候选都过 `normalizeHubBase` 单裁决,明文 http 只在回环
——便利层永不放宽咽喉。

**iOS 工程事实**(M7 会再用到,记档):Capacitor 8 走 **SPM 不是 CocoaPods**
(`CapApp-SPM/Package.swift` 引 GitHub `capacitor-swift-pm` 8.4.2 + 本地
`node_modules` 路径 ⇒ `pnpm install` 必须先于首次构建);CLI 要 **Node ≥22**
(nvm 装 22.23.2,仓库其余仍 v20)且与 **TypeScript 7 不兼容**(配置加载器抛
`Cannot read properties of undefined (reading 'CommonJS')`,壳内 devDep 钉
`typescript@^5`);图标零新依赖:`qlmanage -t -s 1024` 把 `icon.svg` 栅格成
PNG,alpha 通道走 JPEG q100 往返剥离(**BMP 往返剥不掉**,实测),启动屏
`sips --padColor 1a1a1a` 铺 2732;`Info.plist` 注册 `gotong://`
(CFBundleURLTypes)= M1 注释「custom scheme 由壳认领」的兑现。

**抓到并修一个真 bug(M2 同型第二次出现)**:`#screen-pair { display:flex }`
的 ID 选择器把 UA 的 `[hidden]{display:none}` 压掉——boot 判定已连接走
showPanel 后,配对屏照常渲染,两屏叠影。修 =
`#screen-pair[hidden], #screen-panel[hidden] { display:none }` 显式夺回。
教训升一级:**任何带 display 的选择器,配 hidden 属性用时都要显式夺回**;
且这类 bug 只有渲染面能抓(逻辑测试全绿,叠影在截图里)。

**验证(iPhone 17 Pro 模拟器 / iOS 26.5,验收行「真机」按模拟器如实降级,
真设备=M7)**:①装上(`simctl install`)②打得开(本地资源+CSP+三脚本,配对
屏像素级正常)③**能连本机 hub——机内全动线**:idb HID 真点真打(地址
`http://127.0.0.1:3135` + 80-bit 一次性码)→ 点「连接」→ claim 换 `aipk_`
→ `setTarget` → 面板挂载渲染**真数据**(「IM 通道全无」黄牌来自
`derivePatrolCards` 真巡检——fresh space 没挂 IM 桥,这张卡只可能来自 API;
聊天卡/审批空态/任务空态/定时流空态/形态选择器全在);hub 侧设备表新行
createdAt 与点按钮时刻吻合、`lastUsedAt` 随面板取数持续更新。④重启存活:
terminate + relaunch 直落连接态,面板数据重新拉取。⑤深链:`simctl openurl`
弹系统对话框「在 "Gotong" 中打开?」(= iOS 已把 scheme 解析到本 app)→ 打开
→ 预填 + 不提交 + 不动既有连接。⑥同码二次兑换在 M1 已证 400,此处不重复。

**验证环境排错记(给 M7 与后来者)**:MCP 模拟器面板工具在 macOS 26 上**误检**
xcode-select——报「Xcode is installed but not selected」并要求
`sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`,实际
`xcode-select -p` 已是该路径、xcodebuild 正常,根源疑似它检查的
`/var/db/xcode_select_link` 在 macOS 26 不存在;sudo 在本机被禁,故全程改用
通用工具(headless `xcodebuild` + `simctl` + Simulator.app 窗口给用户看)。
模拟器合成输入三条路全死:AppleScript keystrokes 被 TCC 拒(1002)/`simctl`
无 tap 子命令/往 legacy `WebsiteData/LocalStorage` 种 localStorage 被现代
WebKit 无视(注:那份种子在模拟器**重启后**反而被 WebKit 迁移进新存储——
「以为失败的种子」可能延迟生效,勿当无害丢弃)。解法 = Meta **idb**:
`fb-idb` 1.1.7 客户端 + GitHub release 预编译 `idb_companion` v1.1.8
(2022 年构建在 macOS 26 仍工作),直连 CoreSimulator 打 HID,**无需辅助功能
权限**;brew 装 `idb-companion` 会卡死在 auto-update 拉镜像,绕法 = release
tar 直下 + `HOMEBREW_NO_AUTO_UPDATE=1`。

**诚实边界**:模拟器证不了真机(推送、真网络、商店签名全在 M7 之后);机内
WebView console 未接 Web Inspector,以「渲染结果 + hub 侧行为」双向证;
Android 显式不做脚手架(写完不能验证=写完就腐,待构建环境再 `cap add`)。
边界五条全守:`packages/*` 本刀**零改动**、旋钮 **116 冻结零新增**、四门
PASS——壳是第 N 个渲染器,装 app 不多一分权限。

### M6 落地记(2026-07-30)

**一句话**:hub 长出一条 **APNs 直连**投递腿(operator 自己的 Apple 凭证,
零中央中转——宪章「零中央节点」在推送上的形状),壳长出一行「开启通知」;
绑 IM 成员逐字节不变,纯壳成员从「打开 app 才知道」变「锁屏被低信息 tap
叫醒」。**FCM/Android 刻意不做**(Android 壳本身不存在,写完不能验证=写完
就腐,M5 同一判断);大陆 A1 只轮询不变。§四第四档预判的「PUSH-M1 纯核在
壳里是死代码」如实兑现——RFC 8291 加密与 VAPID 一行都没用上,复用的恰是
当时点名的四样:per-member 文件形状、fold 补位语义、不收 text 低信息纪律、
404/410 剪订阅自愈(在 APNs 侧=410 `Unregistered` 剪 token)。

**凭证是 file-first 数据不是旋钮(116 冻结零新增)**:`<space>/apns.json`
`{keyId, teamId, bundleId, environment:'sandbox'|'production', keyFile?}` +
p8 私钥(默认 `apns-key.p8`,相对路径以 space 根解析),与 `agent-card.json`
同族——「这台 hub 用哪份 Apple 凭证」是空间里的运营数据,不是部署环境开关。
三态合同:**缺席=OFF 字节不变;形状不对=warn+OFF;形状对但 key 读不了或
不是 EC P-256=boot 抛错拒启**——写下合法配置的人明确想开推送,静默降级
等于把「没开」谎报成「开了」(web-push 坏钥响亮拒同一姿态)。启动披露一行
`apns push enabled: topic=… env=… keyId=… teamId=…` 且 `dataLeavesBox`
(推送时序元数据经 Apple),永不打印 key 字节。

**发送器 `host/src/apns-push.ts` 零新依赖**:node:http2 直连
`api.push.apple.com` / `api.sandbox.push.apple.com`,node:crypto ES256
provider token(45 分钟内缓存复用);`apns-push-type: alert` + `apns-topic`
+ TTL;**403 `ExpiredProviderToken` 丢缓存重铸一次**;**410 `Unregistered`
剪 token 自愈**。20 单测的承重形状=**起真 h2c HTTP/2 mock 服务器逐字节断言
wire**(`:path` 含 token/`apns-topic` 头/JWT 用独立 `createVerify` 验签/
payload 字节)+ 403 重铸重发 + 410 剪掉后存活 token 照发。

**文案一份两腿**:`TAP_PAYLOAD` 常量从 `web-push-sender.ts` 导出(标题
「阿同 · Gotong」/正文「有新消息,点开查看 · New message」),web 腿与 APNs
腿共用同一常量=两腿文案漂移结构性不可能;`push(userId)` 签名仍不收 text=
正文结构性上不了锁屏(PUSH-M3 纪律原样)。**fold 语义**:新
`composeTapFallback(a, b)` 把两条 tap 腿并成一条(并行发,≥1 送达=
delivered;单腿=原样透传恒等),外层仍是 `foldWebPushIntoPush` **仅
`unknown_member` 回落**——绑 IM 成员字节不变零双发,B1 严格补位语义原封。

**token 存储 per-user 不 per-credential(诚实边界)**:
`<space>/butler/push-native/<userId>.json` `{tokens:[{token, platform,
createdAt, lastOkAt?}]}`,5 设备顶丢最旧、同 token 重注册原地更新、
`assertSafeOwnerId` 先于拼接、per-user promise 链(镜像 web-push-store 全
形状);token 校验 **16–200 hex**——**模拟器实测发 160 hex**(比真机的 64
长,上限当时就留对了)。网页端撤销设备凭证**立即**断数据面,但推送 token 要
等壳注销或 Apple 410 才剪——所以壳的「断开」**先 best-effort POST
unregister 再 clearTarget**(顺序承重:凭证一忘就再也发不出注销),UI 红字
如实注明网页端撤销后通知可能仍短暂到达。web 面三路由骑 push-routes(鸭子
`MeNativePushSurface`,session 钉 userId):GET 探测三态诚实(无 surface=
`native.available:false`)/POST register 收 `{token, platform:'ios'}` 白
名单/POST unregister;坏 token 400。

**壳侧五条 UX 纪律(全部实机化验证)**:①**绝不启动自动弹权限**——通知行
只在「原生平台 + 已连接 + hub `native.available:true`(懒 GET 探测)」才
显示,系统权限框是成员按「开启通知」的动作;②权限已授过再开启**不弹框**
直接注册;③boot 时此前开过=**静默重注册**(token 轮换自愈,零打扰);
④推送点开=只回到面板(**推送≠授权**,PUSH-M3 同句);⑤
`presentationOptions:['banner','sound']`——前台也出横幅,否则「开了通知却
看不到」像 bug。

**验证(iPhone 17 Pro 模拟器,hub 带测试 apns.json[临时 EC 钥,非生产凭证],
十段全绿)**:①全新装 boot 落配对屏,无通知行无叠影;②idb 机内配对→面板真
数据;③通知行出现——它只可能来自懒探测打到 `native.available:true`(证壳→
hub-target 重写→Bearer→native surface 全链);④点「开启通知」→ iOS 系统
权限框(仅此刻出现);⑤允许→模拟器发**真 160-hex token**→hub `count:1` +
盘上 per-user 文件落地;⑥`simctl push` TAP 字节同款 payload→**前台横幅**
(presentationOptions 生效);⑦HOME 后台→锁屏面横幅;⑧点横幅(横幅约 5s
自灭,须 2s 内点到)→app 回面板,不多一分权限;⑨断开→确认框→hub 侧
`count:0`(**注销先于忘凭证**已证)+ 红字诚实注;⑩重配对→再开启**不弹框**
→ terminate + relaunch →**静默重注册**(entry createdAt 刷新,零提示)。
hub 侧另以 curl 独立证:GET 三态 / register / unregister round-trip / 坏
token 400。

**诚实边界**:真 APNs 送达(hub→Apple→设备)**结构性验证不了**——无 Apple
Developer 账号拿不到真 p8,模拟器也不连真 APNs;`simctl push` 只证**设备侧**
显示/点按半程,hub 侧发送器由 20 单测(真 h2 wire 逐字节 + 独立验签 +
403/410)盖。真机 + 真 p8 = M7 前置(用户门)。存储 token 上 `lastOkAt`
缺席也是诚实态——只有真送达才写。

**验证环境排错记(续 M5)**:MCP 模拟器工具在 macOS 26 误检 xcode-select
依旧,全程仍用通用工具(simctl + idb);/tmp 验证环境被系统清理→space、
hub、idb companion 全重建(companion 走 GitHub release tar 直下);**新坑**:
companion 启动命令接了 `| head` 管道,head 收满即杀长跑进程,窗口内的 idb
tap/text **静默失败**(`2>/dev/null` 又吞了报错)——教训:**长跑进程绝不接
会提前关闭的管道**,输出要么落文件要么后台任务。

验收:host **2618** + 5 skip(+20 apns)/ web **1612**(+3 native 路由),
四门 PASS(**旋钮 116 冻结零新增**;main.ts 2758/2760)。`packages/*` 改动
=host 发送腿 + web 三路由,渲染器/schema/治理闸零触碰——推送是投递腿不是
新权威点。下一步 **M7 真机 round-trip**(用户运维前置:VPS 域名+TLS+公网
入口,及 Apple Developer 账号出真 p8)。

### M6A 落地记:安卓线(2026-07-30)

**一句话**:用户拍板试验设备「混合都有」且 Apple Developer 注册未完成→
**先走安卓**——M6 那句「FCM/Android 刻意不做=壳不存在写完就腐」在壳存在
的当天即刻兑现补齐:hub 长出 FCM 发送腿,`cap add android` 长出真壳,
模拟器机内配对全动线八段全绿。分发姿态与「数人试验型产品」对齐:debug
APK 直装,不进商店。

**hub 侧:共核重构不是第二份实现**。`apns-push.ts`(309 行)把 per-user
token store 抽出进新 `native-push.ts`(640 行)共核——`assertSafeOwnerId`
先于拼接/5 设备顶/同 token 原地更新/per-user promise 链,APNs 腿原样骑上,
FCM 腿平级长出:file-first `<space>/fcm.json` 指向 service account JSON
(**非旋钮,116 冻结零新增**,与 `apns.json` 同族三态合同:缺席=OFF 字节
不变/形状不对=warn+OFF/形状对 key 坏=boot 拒启),OAuth2 RS256 JWT 换
access token(内缓存),`POST /v1/projects/{pid}/messages:send`,**404
`UNREGISTERED` 剪 token 自愈**(APNs 410 同型)。`TAP_PAYLOAD` 一份三腿
(web/APNs/FCM),`push(userId)` 仍不收 text。token 校验按平台分形:ios=
16–200 hex,android=FCM 不定长非 hex 形状故走长度+字符白名单。web 路由
`platforms()` 鸭子:GET 探测答**可用平台列表**(有 apns.json 报 ios、有
fcm.json 报 android),壳侧 `shellPlatform()` 读 Capacitor 平台名与列表求
交——iOS 壳连 FCM-only hub 时通知行诚实不显示,反之亦然。24 单测(mock
FCM 端点:OAuth 换发/wire 形状/404 剪/store 平台校验)。

**工具链三幕(给下一个在慢链路上装安卓工具链的人)**:幕一 pin-down
(AGP 8.7.3+SDK 35 全用本地缓存)被硬事实杀死——capacitor-android 8.4.2
的 androidx 依赖(core-ktx 1.17 等 6 项 AAR metadata)**强制 compileSdk
36,而 AGP ≤8.7 顶配 35**,降级路线结构性不存在;幕二 恢复官方基线
**AGP 8.13.0 + Gradle 8.14.3 + compileSdk/targetSdk 36**(minSdk 24,
JDK=Android Studio 内置 JBR 21),大件改从**腾讯镜像**
`mirrors.cloud.tencent.com/AndroidSDK/`(SDK 组件)与 `…/gradle/`(dist)
直连(`--noproxy "*"` 实测 >6MB/s;dl.google.com 经代理滴流停摆,jstack
两次坐实卡死在 SSL read——**滴流字节能骗过 per-read 超时**,杀不掉只能
换源);gradle wrapper 种缓存=官方 URL 不动,zip 放
`~/.gradle/wrapper/dists/<dist>/<hash>/`(hash 由官方 URL 派生)wrapper
本地验完直接解压零下载;幕三 maven 依赖仍滴流→**阿里云镜像 init 脚本**
(`-I` 本机专用,google()/mavenCentral()/plugins 三源换
`maven.aliyun.com`,**不进仓**——仓里 build.gradle 保持官方源,镜像是
本机链路补丁不是工程事实)→ **BUILD SUCCESSFUL in 67s**,APK 5.6MB。

**明文一坑(安卓独有,真 bug 真修)**:首次连接失败,logcat 坐实
`Cleartext HTTP traffic to 127.0.0.1 not permitted`——**Android 9+ 默认
全局禁明文**(iOS 的 ATS 默认豁免回环,故 M5 没撞);同一条 logcat 顺带
证明 CapacitorHttp 的 fetch patch 在安卓活着(claim 请求 16.7ms 走原生层
=M0「CORS 问题域消失」的安卓实证)。修=新
`app/src/main/res/xml/network_security_config.xml` **只对回环放行**
(127.0.0.1/localhost 含子域/::1),manifest 挂 `networkSecurityConfig`
——与 M2 咽喉同一条策略在原生层的镜像,**绝不开全局
`usesCleartextTraffic`**;非回环明文自此 JS 咽喉与系统策略两层都过不去。

**模拟器网络事实(与 iOS 相反)**:Android 模拟器 NAT 隔离,设备
`127.0.0.1`=设备自身,宿主回环别名是 `10.0.2.2`——但它**不是回环**,咽喉
如约红字拒绝(「地址没被接受:要 https://…」=M2 咽喉在安卓壳活着的第一个
实证);正道=**`adb reverse tcp:3135 tcp:3135`** 把设备回环映射到宿主,
`http://127.0.0.1:3135` 直用,**零策略放宽**。(iOS 模拟器共享宿主网络栈
故 M5 直连即通;这条差异记档免下次再撞。)

**模拟器验证八段全绿**(自建 AVD `Gotong_API35`,android-35 google_apis
arm64;fresh space 真 hub :3135,adb input 真点真打):①装上打得开,配对屏
像素级同 iOS,无叠影;②咽喉拒 `10.0.2.2`(见上);③reverse 后机内配对全
动线——claim→`aipk_`→面板渲染**真数据**(「IM 通道全无」黄牌=
derivePatrolCards 真巡检,只可能来自 API);④hub 侧设备行 label
**`Gotong 壳 (android)`**(平台检测正确),lastUsedAt 比 createdAt 晚
163ms=凭证到手即取数;⑤**通知行不显示**——hub 无 apns.json/fcm.json,
`platforms()` 答空,按钮按平台门控如约隐藏;⑥`am force-stop`+重启直落
连接态(localStorage 持久);⑦深链 `gotong://pair?u=攻击者地址&c=假码`
系统解析到本 app(manifest scheme 生效),**只预填绝不提交**,重启后仍连
原 hub=**不动既有连接**;⑧断开→确认框→回配对屏+红字诚实指路「真正
失效请到网页端移除」,hub 侧设备行仍在(断开=本机忘记,撤销权在网页,
设计原样)。

**诚实边界**:FCM 端到端(hub→Google→设备横幅)**结构性验证不了**——
需用户 Firebase 项目出 `google-services.json`(app/build.gradle 模板自带
条件挂载:文件就位才 apply google-services 插件,零 gradle 改动),且注册
要 Play services=`google_apis_playstore` 镜像(本 AVD 是 google_apis);
发送腿由 24 单测(mock 端点逐字节)盖,壳侧「开启通知」按钮在 hub 配
fcm.json 前根本不显示故按钮动线同属用户门。大陆 A1 不变:无 Google 服务
设备 register() 失败按钮回落,不崩。**真机安装+真 FCM=M7 安卓半**(用户
门:Firebase 项目;真机 USB 调试直装 debug APK 即可,无签名年费)。

验收:host **2633** + 5 skip(+24 native-push,含 apns 迁移)/ web
**1612**(+platforms 三态)四门 PASS(**旋钮 116 冻结零新增**);
`shell/android/` 54 文件进仓=工程本体(gradle+manifest+资源+
network_security_config),**产物/`assets/public` 拷贝/生成配置全被模板
gitignore 挡住**(iOS `App/App/public` 同款「第二份渲染器源不进仓」纪律,
Capacitor 安卓模板自带);`capacitor.settings.gradle` 引本地 node_modules
路径=iOS Package.swift 同款事实(pnpm install 必须先于首次构建)。

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
