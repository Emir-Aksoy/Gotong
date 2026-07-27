# PUSH — Web Push 触达 track(M0 计划)

> 状态:**M0 计划**(2026-07-27)。岔口 A/B 待用户拍板,拍板前不动代码。
> 动线出处:SDUI track 收口时的既定顺序第三项(① C1 组件做实[已全收口] ② isButler
> 票[已收口] ③ **PUSH** ④ M5 Capacitor 壳[用户门])。
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
payload,**零 App、零商店、零第三方 SDK**,PWA 直接能被叫醒。这也是 SDUI-M5
Capacitor 壳(远期)通知故事的前置——壳层将来只是把同一条投递腿换成原生通道。

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

- **原生 FCM / APNs 通道** — 那是 SDUI-M5 Capacitor 壳(用户门)的事,Web Push 这条腿
  将来原样复用,只换传输。
- **富通知**(图片 / action 按钮 / 内联回复)— 低信息纪律 v1 钉死,富化等真实需求。
- **admin 广播 / 群发面** — 本 track 只做「管家 → 成员」既有消息流的新腿,不新增发声权。
- **UnifiedPush 专门适配** — 标准 Web Push 端点天然兼容其网关,不做专门代码。
- **per-notification 类别订阅偏好** — 与 B3 同理,等真实高频需求。
