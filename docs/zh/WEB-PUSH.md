# PUSH — Web Push 触达 track(全完)

> 状态:**M0→M4 全完**(2026-07-27)。岔口已拍板:**A1 自实现** + **B1 补位腿**;
> 落地记见 [§八](#八落地收口记m1m4)。§一~§七保留 M0 原文当设计出处。
> 动线出处:SDUI track 收口时的既定顺序第三项(① C1 组件做实[已全收口] ② isButler
> 票[已收口] ③ **PUSH**[本 track] ④ M5 Capacitor 壳[用户门])。
> 本文形制镜像 [`SDUI-PANEL.md`](SDUI-PANEL.md) M0:先侦察后设计,岔口显式摆给用户。

---

## 一、要解决的真缺口

**纯网页(PWA)成员今天收不到任何主动触达。**

- 管家的全部主动消息(转派结果 / 提醒 / 巡检播报 / 审批回推)走唯一出口
  `pushToMember`,底下是 outbox → reachable → **按 IM platform 查桥**投递
  (`butler-reachable.ts:197-215`)。没绑 IM 的成员解析成
  `{delivered:false, reason:'unknown_member'}`,消息进 outbox 压着,**TTL 24h 后丢弃**
  (`butler-outbox.ts`)。
- A1「N 件事等你批」探针只在成员**主动打开页面**时才看得见
  (`personal-butler-pending.ts:76-83` 是 prompt 注入,不是触达)。
- 也就是说:装了 PWA 的手机,今天是个「哑终端」——审批过期、提醒过点,全靠成员自己想起来打开。

Web Push(RFC 8030/8291/8292)补的就是这条腿:浏览器订阅 + VAPID 签名 + 端到端加密
payload,**零 App、零商店、零第三方 SDK**,PWA 直接能被叫醒。

> **与原生壳的关系(2026-07-28 核实后修正)**:初稿曾写「壳层将来只是把同一条投递腿
> 换成原生通道」——**这句过度乐观**。WKWebView 明确不支持 Push API,Android WebView
> 同样不支持(app 关闭时唤不醒),Capacitor 壳必须走 `@capacitor/push-notifications`
> 接 FCM/APNs。**能复用的**是订阅存储的 per-member 文件形状、`foldWebPushIntoPush`
> 的补位决策语义、`push(userId)` 不收 text 的低信息纪律、404/410 剪订阅的自愈模式;
> **用不上的**是 sw.js 三事件、`PushSubscription`、RFC 8291 加密与 VAPID——原生通道
> 拿的是 device token,加密与签名全不适用。详见 [`APP-SHELL.md`](APP-SHELL.md) §四第四档。

平台真相(诚实边界):Android Chrome / 桌面全支持;**iOS 需 16.4+ 且「添加到主屏幕」
后才有 Web Push**——恰好与 PWA 安装动线一致,文案如实引导即可,不冒充「所有手机都行」。

---

## 二、侦察记录(2026-07-27,全部 file:line 落档)

1. **投递咽喉唯一**:`deliverToMember` 定义 `im-bridge.ts:1206`,先
   `sessions.append(userId,'assistant',text)` **再**投递——消息文本无论送达与否都已进
   SESS 会话窗;全部消费者走一根引用 `main.ts:2304 butlerPushRef`
   (审批回推 :1609 / ReminderParticipant :1629 / sweeps :1642 / DUO escalate :1070)。
   outbox flush 两触发:onReachable(`im-bridge.ts:1278`)+ 2min cadence(:1372-1378,
   常量非旋钮)。**新投递腿只要 fold 进这一条链,全家自动受益,零新权威点。**
2. **PWA 现状**:`sw.js` 只有 install/activate/fetch 三事件,**无 push/notificationclick**;
   `manifest.webmanifest` 可安装最小集齐全,Web Push 不需要改它;SPA 唯一相关引用是
   `app.js:4061-4066` 注册 sw,零 Notification API 使用。
3. **密钥保管先例**:host 自持密钥文件走 `agent-card-signing.ts:80-105`
   `loadOrCreateSigningKey`——existsSync 则读、类型不对**抛错绝不静默重建**,首次
   `generateKeyPairSync('ec', prime256v1)` → PKCS#8 PEM 0600;路径住 **space 根**
   (`main.ts:1538`,与 `identity-master.key` 同层),`runtime/` 下无密钥先例。
   VAPID 恰好也是 **ES256 / P-256**——与 STD-M1 同一套 node:crypto 原语
   (`@gotong/a2a` 的 `es256Sign`/`ecThumbprint` 可直接复用)。
4. **per-member 存储先例**:「可达路线」族是扁平 `<space>/butler/reachable/<userId>.json`
   (`butler-reachable.ts:226`)、`butler/outbox/<userId>.json`,均 `assertSafeOwnerId`。
   Web Push 订阅语义上就是「成员的另一条可达路线」,落 **`<space>/butler/push/<userId>.json`**
   与 reachable/outbox 对齐(不是 UI 偏好,不进 `butler/ui/`)。
5. **web 路由先例**:panel-routes 判例——逻辑放新文件、me-routes 单点前缀转发控预算
   (`me-routes.ts:749-751`)。预算门现值:me-routes **2880/2885(余 5)**、server.ts
   **2394/2395(余 1)**——server.ts 穿新 surface 需 3 处 ≈ 4 行,**必须显式抬棘轮并注释理由**
   (该文件既定惯例)。
6. **依赖政策**:全仓 grep `web-push` 零命中;web 包运行时依赖只有 3 workspace + yaml,
   host 只 4 外部包。kernel-deps-gate 管方向不管新增第三方包——「不引依赖」靠计划文档
   自律 + STD-M1 先例背书。
7. **旋钮登记**:`gotong-env-registry.txt` 双向门;`GOTONG_BUTLER_*` 族惯例=功能前缀 +
   「未设=字节不变」姿态注释。本 track **新增恰好 1 个旋钮**(见 §4.2)。
8. **披露分级先例**:IMA 的 `imApprovable` 按 SHAPE 写入时判定 + 读侧 fail-closed 双验
   (`personal-butler-escalation.ts:88-97` / `im-approval-service.ts:134-139`);低信息话术
   现成(`im-bridge.ts:1594/1626`「我已经放进你的『我的 → 收件箱』了」)。

---

## 三、五条不可破边界

1. **热路径零 LLM** — 推送是纯投递层:订阅登记 / VAPID 签名 / aes128gcm 加密 / fetch
   投递全是确定性代码,一次模型调用都没有。
2. **opt-in,未设=字节不变** — 旋钮未设 ⇒ 不生成密钥文件、订阅路由答 `{available:false}`、
   SPA 不出「开启通知」卡、sw.js push handler 因永无订阅而天然死路。设了才多一条腿。
3. **披露分级 + 数据边界诚实** — payload 走 RFC 8291 端到端加密(浏览器厂商推送服务
   **读不到内容**);但送达时序 / 频次 / 订阅端点经 Google(FCM)/ Mozilla / Apple 的推送
   基建=**data-leaves-box 方向,必须在文档与面板如实披露**。通知本体只送低信息 tap
   (「阿同有新消息」/「有 N 件事等你确认」),**不带条目内容**——锁屏是另一个肩窥面,
   与 IMA web-only 纪律同源。完整内容留在 /me 会话窗(侦察 §二1:文本本来就先进窗)。
4. **推送≠授权** — 点通知只是打开 /me;审批照走既有闸,Web Push 不新增任何动作面。
5. **内核零改动** — 全在 host / web 层;core / workflow / protocol / identity 零触碰。

---

## 四、设计草案

### 4.1 VAPID 密钥(host 自持,零新依赖方向)

- `loadOrCreateWebPushKey(join(space.root, 'webpush-vapid.key'))`,逐字镜像
  agent-card-signing:PKCS#8 PEM / 0600 / 坏钥抛错绝不静默重建。
- `applicationServerKey`(给浏览器的公钥)= P-256 未压缩点 65 字节 base64url,从
  keyObject 导 JWK x/y 拼 `0x04||x||y`。
- VAPID `Authorization: vapid t=<ES256 JWT>, k=<pubkey>`:JWT claims
  `{aud: 推送服务 origin, exp: ≤24h, sub: 旋钮值}`,签名走与 STD-M1 同套 ES256。

### 4.2 旋钮(恰好一个,一钮双职)

`GOTONG_WEBPUSH=mailto:you@example.com`(或 `https://` 联系页)——**值本身就是 RFC 8292
要求的 `sub` claim**(Apple 强制要求,FCM 建议),开关与必填项合一,不另设第二钮。
形状校验:非 `mailto:`/`https:` 开头 ⇒ warn 一次 + 视同未设(fail-closed)。
登记 env-registry(+1),注释按族惯例写「PUSH opt-in:未设=字节不变」。

### 4.3 订阅存储(file-first,per-member)

- `<space>/butler/push/<userId>.json`:`{ subs: [{ endpoint, keys:{p256dh,auth},
  ua?, createdAt, lastOkAt? }] }`,写路径 `assertSafeOwnerId` + tmp+rename +
  per-user 串行链(me-panel-surface 同套纪律)。
- **多设备**:上限 5 条,满了丢最旧并响亮 warn(no silent caps);同 endpoint 重订=原地更新。
- **自愈**:推送服务答 404/410(订阅已失效)⇒ 剪掉该条(浏览器端换订阅是常态,
  `pushsubscriptionchange` 里重新 POST 兜底)。
- 成员只能写自己的文件(session 钉 userId,与 panel-routes 同姿态)。

### 4.4 web 面(新文件 `push-routes.ts`,panel-routes 判例)

- `GET /api/me/push` → `{available, publicKey?, subscribed}`(未开旋钮=available:false,
  SPA 藏卡);
- `POST /api/me/push/subscribe` 收浏览器 `PushSubscription.toJSON()`;
- `POST /api/me/push/unsubscribe`(或 DELETE)。
- **SSRF 结构性防线**(PANEL_FIXED_SOURCES 同源思路):endpoint 必须 `https:`、
  拒回环 / 私网 / link-local 字面量;**不做厂商域白名单**(UnifiedPush 自托管网关是
  合法生态,白名单会误杀)。投递请求体是密文 + VAPID 头,攻击者可得信息面有限,
  但「hub 向成员指定的任意 URL 发请求」这条面必须收窄。
- me-routes 加 1 个前缀转发 if(≈3 行,余 5 够);server.ts 穿 surface 3 处 ≈ 4 行,
  **显式抬棘轮 2395→约 2400 并注释理由**。

### 4.5 投递腿(host)+ SW + SPA

- 纯核 `web-push-protocol.ts`(host):RFC 8291 aes128gcm 加密(ECDH P-256 + HKDF +
  AES-128-GCM + 0x02 padding 定界 + salt||rs||idlen||keyid 头)+ RFC 8292 VAPID JWT。
  **RFC 8291 附录 A 有完整官方测试向量,单测逐字节钉死**——这是自实现方案的可测性底气。
- fold 点:reachable 解析链的回落位(具体语义=岔口 B),失败三态与 IM 桥同型
  (`delivered:false` 进 outbox 重试,不静默丢)。
- `sw.js` 加 `push`(showNotification 低信息文案)+ `notificationclick`(聚焦已开
  tab 或开 `/`)+ `pushsubscriptionchange`(重订阅回 POST);CACHE bump。
- SPA:/me 通知卡(Notification.requestPermission 必须用户手势触发,卡上一个
  「开启通知」按钮)+ i18n 双语;iOS 未装主屏时如实提示「先添加到主屏幕」。

### 4.6 通知内容(v1 钉死低信息)

- 管家对话类:「阿同有新消息」(不带正文);
- 审批提醒类:「有 N 件事等你确认」(计数,不带条目——`buildPendingCard` 首行同款,
  去掉明细行);
- 点开一律进 /me,内容在会话窗 / 收件箱里。
- v1 **不做** per-notification 富内容开关;要看内容=打开页面,与 IMA「web-only 项只
  指路不给答案」同一纪律。

---

## 五、岔口(待用户拍板)

**岔口 A — 依赖姿态**
- **A1 自实现(推荐)**:RFC 8291/8292 全部原语 node:crypto 都有(ECDH / hkdfSync /
  aes-128-gcm / ES256),官方测试向量钉死正确性,~200 行纯核;与 STD-M1「零外部依赖
  走 node:crypto」同一先例,host 外部依赖保持 4 个。
- A2 引 `web-push` npm 包:省实现工夫,但带一串传递依赖进 host,且该库为兼容老 Node
  背了历史包袱;与本仓依赖纪律相逆。

**岔口 B — 触达语义(Web Push 与 IM 的关系)**
- **B1 补位腿(推荐)**:reachable 解析不到 IM 路线时才走 Web Push。绑了 IM 的成员
  行为**字节不变**、零重复触达;纯网页成员从盲区变可达。语义最小,v1 最稳。
- B2 双发:IM 与 Web Push 都发。触达最强,但同一条消息两处响,需要去重 / 静默窗设计。
- B3 成员偏好:/me 里选「IM 优先 / 浏览器优先 / 都要」。最灵活,但新偏好面 + UI,
  v1 过重;可等真实需求出现再从 B1 升级。

(4.2 旋钮形状 / 4.3 落点 / 4.6 低信息文案视为设计内定,不占岔口;用户有异议随时改。)

---

## 六、里程碑

- **M1 纯核**:`web-push-protocol.ts`(aes128gcm + VAPID JWT,RFC 向量单测)+
  `loadOrCreateWebPushKey`;零装配触碰,独立可测。
- **M2 订阅面**:`butler/push/` 存储 + `push-routes.ts` 三路由 + me-routes 转发 +
  server.ts 显式抬棘轮;路由测试(session 钉 userId / 未开旋钮 available:false /
  SSRF 拒 / 5 设备顶)。
- **M3 投递腿 + SW + SPA**:fold 进 reachable 回落链(按岔口 B 拍板)+ sw.js 三事件 +
  /me 通知卡 + i18n;host e2e(无 IM 成员消息走 Web Push / 410 自愈剪订阅 /
  未开旋钮字节不变)。
- **M4 真机 round-trip + 收口**:本机 https(或 localhost 特权)真浏览器订阅→关页→
  服务端推→锁屏级通知→点开进 /me;四门 PASS;README/文档挂链;账本。

节奏照旧:一个 commit 一个里程碑。

---

## 七、显式不做(v1)

- **原生 FCM / APNs 通道** — 那是 SHELL track(壳)的事,见 [`APP-SHELL.md`](APP-SHELL.md) M6。
  **不是「原样复用只换传输」**(初稿说法已于 2026-07-28 修正,见 §一注):WebView 不支持
  Push API,原生通道要另接一套;可复用的只有订阅存储形状、补位决策与低信息纪律。
- **富通知**(图片 / action 按钮 / 内联回复)— 低信息纪律 v1 钉死,富化等真实需求。
- **admin 广播 / 群发面** — 本 track 只做「管家 → 成员」既有消息流的新腿,不新增发声权。
- **UnifiedPush 专门适配** — 标准 Web Push 端点天然兼容其网关,不做专门代码。
- **per-notification 类别订阅偏好** — 与 B3 同理,等真实高频需求。

---

## 八、落地收口记(M1→M4)

> 节奏兑现:一个 commit 一个里程碑。岔口拍板 **A1 自实现**(零外部依赖走 node:crypto,
> STD-M1 判例)+ **B1 补位腿**(仅 `unknown_member` 回落,绑 IM 成员字节不变、零双发)。
> 五边界(§三)逐条兑现证据见各刀;**旋钮 115→116(`GOTONG_WEBPUSH` 是本 track 唯一新增)**。

### M1 纯核(`aeecd8c`,host)

`web-push-protocol.ts`:`encryptWebPushPayload` = RFC 8291 完整链(ECDH P-256 →
HKDF(auth) ikm → RFC 8188 cek/nonce → aes-128-gcm 单记录,头 `salt‖rs=4096‖idlen‖as_public`,
`0x02` 定界);**承重测试=RFC 8291 §5 官方向量整体密文逐字节断言**(info 串 / HKDF 步 /
头字段 / 定界任何一字节错都命不中),生产路径(随机瞬时钥+盐)由测试内「浏览器侧解密
回放」证自洽。`buildVapidAuthorization` = ES256 JWT `{aud,exp,sub}` 寿命钳 24h,签名复用
`@gotong/a2a` `es256Sign`;测试独立 `createVerify`(ieee-p1363)验签。`loadOrCreateWebPushKey`
逐字镜像 agent-card-signing 姿态:space 根 PKCS#8 PEM 0600,**坏文件/非 EC 抛错绝不静默
重建**——浏览器订阅全绑此公钥,静默换钥=无声废掉全部订阅。纯核纪律:除密钥文件零 I/O
(防腐测试钉 no fetch / no node:http);坏订阅材料(p256dh 长度 / 非曲线点 / auth 长度 /
明文超 3993 字节)一律响亮拒。

### M2 订阅面(`de1c631`,host+web)

host `web-push-store.ts`:订阅=「成员的另一条可达路线」,与 reachable/outbox 同族——
扁平 `<space>/butler/push/<userId>.json`、`assertSafeOwnerId` 先于任何路径拼接、per-user
promise 链串行读改写;订阅比 reachable 珍贵(撕裂=全设备作废须逐浏览器重订)故写走
`writeJsonAtomic`。**唯一校验咽喉**(validatePanelConfig 判例):endpoint 强制 `https:` +
拒 localhost/*.localhost + **拒一切 IP 字面量(v4/v6)**——hub 会向存进来的 endpoint 发
POST,存什么就是 SSRF 边界;正规推送服务(FCM/Mozilla/Apple/WNS/自托管 UnifiedPush 网关)
全是命名主机,私网 CIDR 清单只会腐。key 形状钉死(p256dh=65 字节 0x04 点 / auth=16 字节),
ua 仅展示(去控制符+80 顶);5 设备顶丢最旧响亮 warn,同 endpoint 重订=原地更新;读者永不
隔离(坏文件 warn+[] 证据原地留,坏条目逐条跳)。web `push-routes.ts`(panel-routes 判例,
me-routes 单点转发控预算):`GET /api/me/push` 是 SPA 探测面(无 surface=200
`{available:false}`;有=publicKey+count,**key 材料只进不出**,GET 永不吐 endpoint/keys);
`POST subscribe/unsubscribe`(无 surface=503;session 钉 userId,query 带别人 id 无效=测试
钉死);server.ts 穿线显式抬棘轮并注释理由。浏览器 `PushSubscription.toJSON()` 的多余键
(expirationTime 等)被「只挑具名字段」自然忽略=前端可整体 POST。

### M3 投递腿+SW+SPA(`8162284`,host+web,13 文件)

- **发**:host `web-push-sender.ts` `WebPushSender.push(userId)` **签名不收 text**=正文
  结构性上不了通知(锁屏可见面=IMA 同一披露纪律);固定双语 tap
  `{title:'阿同 · Gotong', body:'有新消息,点开查看 · New message'}` 逐订阅 RFC 8291 加密;
  VAPID JWT 按推送服务 origin 调用内缓存;`TTL:86400` + `Topic:gotong-butler-tap`(推送
  服务侧折叠积压);2xx 记 lastOkAt,**404/410 剪订阅自愈**,其余 warn;≥1 成功=delivered,
  全败=send_failed,无订阅=unknown_member。`buildWebPushService` 唯一装配点(镜像
  butlerVoiceFromEnv):`GOTONG_WEBPUSH` 一钮双职(开关+RFC 8292 sub),形状不对 warn+OFF
  fail-closed;**坏钥文件响亮拒启**;披露报 subject+公钥永不报私钥。
- **fold(B1 严格补位)**:`foldWebPushIntoPush` 纯函数进 fold 家族(hearing/seeing 同区)
  ——仅 `!delivered && reason==='unknown_member'` 才 tap;tap 也败**保留原 unknown_member**
  使 outbox 排队整链重试;fold 在 outbox **之下**=直投与 flush 补投同链;tap 送达=
  delivered ⇒ outbox 不排队(正文早已进 SESS 会话窗,§二1);无 tap 时返回**同一引用**
  (测试 `toBe` 钉死绑 IM 成员字节不变)。
- **收**:sw.js 三事件(push 防御性解析、兜底文案与 hub tap 逐字同句[不弹通知会被浏览器
  吊销订阅]、tag 折叠;notificationclick=聚焦已开 tab 或 openWindow('/'),**推送≠授权只
  开门**;pushsubscriptionchange 重订+best-effort 回报),CACHE v10。
- **开关**:/me「浏览器通知」卡**双确认才显**(特性探针 serviceWorker+PushManager+
  Notification[天然盖 iOS 未装主屏] AND `GET /api/me/push` available);订阅失败即退浏览器
  订阅不留孤行;解绑先告 hub 再退本地(hub 失败留行给 404/410 自愈);i18n 双语 7 键。
- 测试:host 新 12 例(**真 UA 侧 ECDH 解密**断言 tap 明文 / JWT aud=endpoint origin /
  410 剪+存活照发 / fold 五例 / builder 三态含 PEM 零泄露)+ web pwa 测试 +1(三 handler+
  低信息文案);main.ts 棘轮 2740→2750 显式抬。

### M4 真机 round-trip + 收口(本 commit)

真 host(`GOTONG_SPACE=/tmp/gotong-push-verify-m3`,`GOTONG_WEBPUSH=mailto:push-verify@example.net`,
launch.json 新 `gotong-push-verify` 条目)全动线证:

1. **披露行**:journal 抓到 `web push enabled (RFC 8291/8292): sub=mailto:push-verify@example.net
   key=BBn2G_…GSzk`,`dataLeavesBox:true`,**无私钥**;
2. 首跑向导四步(设密+Key/Agent/IM 三跳过)→ 登录 → Home;
3. **双确认真机过**:特性探针三真 + `GET /api/me/push` 200 `{available:true, publicKey
   87 字符(与披露行同钥), count:0}` → 卡渲染且未隐藏;
4. **denied 诚实分支**:内嵌浏览器 Notification 权限被 embedder 钉死 `denied`(不弹窗)——
   点「Enable notifications」→ mePushDenied 文案如实出现,**hub count 仍 0**(失败订阅不留
   孤行);
5. **双语**:切中文即时重渲染「浏览器通知」/ 低信息 hint(「弹一条『有新消息』提醒(不含
   内容)」「绑了 IM 的成员走 IM,不会重复打扰」)/「开启通知」;
6. SW 注册 active(`gotong-shell-v10`,三 push handler 在);**console 零错误**。

诚实边界:内嵌浏览器面**授权→真锁屏通知**这半程结构性走不到(权限被宿主钉 denied,
无 prompt 可点)——该半程的正确性由 M1 官方向量+M3 真 UA 解密单测盖(密文到浏览器侧
能解出 tap 明文),真设备订阅动线留给用户在正常 Chrome/Android/iOS 主屏 PWA 上自然使用。
验收:host **2592**+5skip / web **1527**,四门 PASS(旋钮 116 全登记,main.ts 2750 内)。

### 显式推迟(落地过程新增,§七之外)

- **审批提醒类第二文案**(「有 N 件事等你确认」计数 tap)——v1 单一 tap 文案已够叫醒,
  分类文案等 B3 偏好面一起议;
- **`lastOkAt` 面板可见化**(成员看自己哪台设备还活着)——等真实多设备使用信号。
