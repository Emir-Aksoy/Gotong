# 微信 iLink 桥（WX track）— 第 7 座 IM 桥计划文档

> 战略出处：[`STRATEGY-2026-07.md`](STRATEGY-2026-07.md) §五方向 A，用户 2026-07-09 拍板
> 「先 A 后 B」。华人个人用户的默认 IM 是微信；方向 B（家庭 hub）的目标家庭也都在微信上——
> A 是 B 的前置渠道。
>
> 状态：**M0 侦察 ✅ · M1 协议纯核 ✅（`26e15b7`）· M2 桥 + host 装配 + CLI ✅**
> （M2a `6820885` 桥纯核 · M2b `1b5aab0` host 装配 · M2c CLI `wechat-login`）
> · **M3 真机验证 待做**（需用户微信号；止损线见 §六）
>
> Last updated: 2026-07-09（侦察当日核实；M1/M2 同日落地）

---

## 一句话

给 Gotong 加 `packages/im-wechat`——走**腾讯官方 iLink 协议**（2026-03-22 发布的
「微信 ClawBot 插件」底层协议，域名 `ilinkai.weixin.qq.com`）的第 7 座 IM 桥，让成员在
微信里直接跟自己的管家「阿同」说话；十余年 hook / iPad 协议灰产的封号风险就此终结。

## 为什么是现在

- **十余年来首条合法个人微信通道**：有《微信 ClawBot 功能使用条款》法律文件背书，走
  `ilinkai.weixin.qq.com` 官方服务器，不是协议模拟。
- **协议形状与我们已有的桥高度同构**：纯 HTTP/JSON + Bearer token + **长轮询（35s hold +
  游标）**——就是 Telegram Bot API 的形状，`im-telegram` 的 fetch client 模式可整体镜像；
  无需公网回调（比 QQ webhook 桥更简单）。
- **生态已验证**：腾讯官方开源插件 `Tencent/openclaw-weixin`（TypeScript，npm
  `@tencent-weixin/openclaw-weixin`，v2.x 活跃维护）+ AstrBot / Hermes / 多语言社区 SDK
  （Python/Go/纯JS）都已接入——wire 面已被大量真实流量踩实。

---

## 二、侦察记录（2026-07-09，~45 次检索/抓取当日核实）

### 2.1 协议全貌（wire 面）

**基础域名** `https://ilinkai.weixin.qq.com`，纯 HTTP/JSON，无 WebSocket、无公网回调。

**端点清单**（官方插件源码 + 社区协议拆解交叉核对）：

| 端点 | 方法 | 用途 | 超时 |
|---|---|---|---|
| `/ilink/bot/get_bot_qrcode?bot_type=3` | GET | 获取登录二维码（`qrcode_img_content` + `qrcode` key） | - |
| `/ilink/bot/get_qrcode_status?qrcode={key}` | GET | 轮询扫码状态 → 成功返回 **`bot_token` + `baseurl`** | 35s |
| `/ilink/bot/getupdates` | POST | **长轮询收消息**（35s hold + `get_updates_buf` 游标） | 35s |
| `/ilink/bot/sendmessage` | POST | 发消息（**必须带 `context_token`**） | 15s |
| `/ilink/bot/getconfig` | POST | 取配置 + `typing_ticket` | 10s |
| `/ilink/bot/sendtyping` | POST | 「正在输入」指示 | 10s |
| `/ilink/bot/getuploadurl` | POST | 媒体 CDN 预签名地址 | 15s |
| `/ilink/bot/msg/notifystart` / `notifystop` | POST | 网关启停通知 | - |

**请求头**（每请求）：

```
Content-Type: application/json
AuthorizationType: ilink_bot_token
Authorization: Bearer {bot_token}
X-WECHAT-UIN: base64(String(随机uint32))   ← 每次随机，防重放
iLink-App-Id / iLink-App-ClientVersion     ← 官方插件从 package.json 读
```

**请求体必带** `base_info: { channel_version: "1.0.2" }`。

**消息结构**：

- 收：`msgs[].item_list[].type`（1=文本 2=图片 3=语音[silk+云端转文字] 4=文件 5=视频），
  文本在 `text_item.text`；`context_token` 关联对话窗口（回复必须原样带回）；
  `message_type: 2` = bot 发的（回显过滤依据）；`ref_msg` 引用消息只读。
- 发：`to_user_id` + `client_id`（唯一，UUID）+ `message_type: 2` + `message_state: 2`(FINISH)
  + `context_token`（必填）+ `item_list[{type:1, text_item:{text}}]`。
- 错误：应用层 `ret !== 0` + `errmsg`；**`ret=-14` = 会话过期 → 需暂停 60 分钟**；
  token 无 refresh 机制，401 = 重新扫码。
- 媒体：AES-128-ECB 自行加解密 + CDN（`novac2c.cdn.weixin.qq.com/c2c`）预签名 PUT。

### 2.2 关键行为限制（直接影响管家功能面）

1. **被动回复模型**：不能主动推送，必须用户先发消息触发（要有 `context_token` 才能回）；
   社区实测**超 24h 静默后可能无法送达**（官方插件 issue #185「两天后收不到推送」、
   #202「优化 iLink 会话时效与主动消息条数限制」）。→ 与 QQ 桥同款姿态，`im-qq` 的
   「passive-reply honesty」先例直接复用：推不出去=诚实抛错，outbox 入盘等成员下次说话再补投。
2. **一个微信号只能绑一个 bot**（官方 FAQ 逐字：「一个微信账号仅支持接入一个『龙虾』」）。
3. **群聊未开放**：官方插件能力元数据只声明私聊 DM；协议源码有 `group_id` 字段但未开放。
4. **速率限制官方未公开**，需实测；腾讯条款保留限速/拦截/终止权。
5. 仅移动端微信可扫码开通（iOS ≥ 8.0.70 / Android ≥ 8.0.69），**灰度推送制**（实名 +
   建议注册 >3 个月）。

### 2.3 海外账号可用性（M0 首要核点的答案）

- 2026-03 发布时：「仅向国内微信用户开放，WeChat（国际版）暂不支持体验」（官方 FAQ 逐字）。
- **2026-06/07 已开始变化**：linux.do 社区帖「国际版的 WeChat 可以接入 ClawBot 了」（iOS 已
  实装）；腾讯云国际站页面写 "currently only supported in select regions outside mainland
  China... **Hong Kong is supported**; for other regions, please check with WeChat's official
  support"。
- **马来西亚号没有确凿证据**（两边都没点名）。结论：**不构成停做岔口**——桥代码对国内号
  确定可用（生产机在腾讯云、目标家庭多用大陆微信），国际版正在灰度放开；马来西亚号可用性
  放 M3 用你的真机一测便知，不可用则等灰度（代码零浪费）。
- **M3 前置探针（2026-07-09，M2 收口当日实测）**：从马来西亚开发机用真 M1 client 调生产
  `get_bot_qrcode` —— **可达，241ms**，真二维码 key + 图片链接（`liteapp.weixin.qq.com`）
  正常返回。说明 ①网络路径马来西亚→`ilinkai.weixin.qq.com` 无阻（无 GFW/SSL 问题）
  ②我们的头/`base_info`/UIN 被**生产服务器**接受（wire 实现对真机成立）。M3 剩余未知只有
  一个：**用户的微信账号是否在灰度内**（扫码→确认能否走完）。

### 2.4 条款红线（《微信 ClawBot 功能使用条款》要点）

- 腾讯**仅提供信息收发**，不存储输入/输出（存储只在用户终端——与我们 file-first 同构）。
- 禁区：违法、危害微信产品安全、侵犯他人权益、**绕过/破解微信技术保护措施**（4.6）。
- 腾讯有权决定第三方 AI 服务的类型/范围/**收发规模与频率**，可识别+拦截+阻断（4.7）、
  单方修改条款（7.3）、随时变更/终止功能（7.2）。
- 适用中国大陆法律，深圳南山签订地；第三方 AI 后果用户自担（4.5）。
- → 我们正是条款定义的「第三方 AI 服务」标准用法；「不代操作账号、纯消息通道」红线与
  Gotong「接入≠授权行动」立场天然同构。**唯一要认的风险：腾讯单方管控权**（与所有官方
  平台桥同性质，Telegram/Slack 同样如此）。

### 2.5 生态实况与已知坑（官方插件 77 个 open issue 精读摘要）

参照实现：官方 `Tencent/openclaw-weixin`（`src/api/types.ts` 278 行 / `api.ts` 586 行 /
`session-guard.ts` 58 行——**M1 实现前用 `gh api` 逐字拉这三个文件核 wire 真相**，403 挡
WebFetch 但 gh 可用）；独立拆解 `x1ah/wechat-ilink-demo`（单文件 bot.mjs）；多语言 SDK
（PyPI `wechat-clawbot`、Go `openclaw-weixin-go`、纯 JS `RickyUKI/weixin-clawbot`）。

踩坑清单（写进 M1/M2 验收）：

| 官方 issue | 坑 | 我们的对策 |
|---|---|---|
| #197 | `sendmessage` 不检查 `ret` 导致 silent-fail（日志说 OK 用户没收到） | client 层强制检查 `ret!==0` 抛类型化错误 |
| #187 | 长轮询 `UND_ERR_HEADERS_TIMEOUT` 被当硬错误 | 视为软超时正常续轮（Telegram 桥同款） |
| #206 | `ilinkai.weixin.qq.com` 不同 IP 池表现不一致 | 长轮询失败退避重试，错误带次数上下文 |
| #164 | 游标无法回溯历史（无历史消息 API） | 游标内存态即可，重启从最新开始（诚实注释） |
| #185/#202 | 24h+ 静默后推送失效 | 被动回复姿态 + outbox 补投（见 2.2-1） |
| #193 | CDN 去重致重复文件 `aes_key` 不匹配 | 媒体推迟到后续里程碑，先文本 |
| #208 | 无流式，消息有序性问题 | 一次性整条发（管家本就整条回） |

---

## 三、边界（不可破，全程守）

1. **只走官方 iLink**，绝不做 hook / 逆向 / iPad 协议等灰色通路——条款内用法，这条也是
   传播叙事的一半（「合法接入」）。
2. **opt-in 字节不变**：未配 `GOTONG_WECHAT_*`（且 vault 无 wechat 行）= `startImBridges`
   根本不 push 该 factory，与今天逐字节一致（六桥同款门控）。
3. **接入≠授权行动**：微信只是又一条消息通道；替你对外发/花钱/改日程照过 personal-butler
   的 governed 审批闸（C-M1 三边界在生活域的延伸）。
4. **内核零改动**：新叶子包 `packages/im-wechat`（只依赖 `@gotong/im-adapter`）+ host
   `im-bridge.ts` 装配缝内加一个 factory 块；core/workflow/protocol/identity 零行。
5. **被动回复诚实模型**：镜像 `im-qq` 先例——没有 `context_token` 可用时 `sendMessage`
   诚实抛错（绝不静默丢），outbox 已有的「成员说话即 flush」补投机制自动兜住。

## 四、包形与里程碑

**包形**：`packages/im-wechat`，结构镜像 `im-telegram`（`client.ts` fetch-based +
`fetchImpl` 注入 / `message.ts` 纯解析 / `bridge.ts` implements ImBridge / `types.ts`
wire 类型），仅依赖 `@gotong/im-adapter`。

**凭证心智**（与 Telegram「BotFather 拿 token」对齐，M2 落地形态）：`gotong wechat-login`
扫码产出 `bot_token` + `baseurl`，stdout 打成 env 两行（`GOTONG_WECHAT_BOT_TOKEN` +
可选 `GOTONG_WECHAT_BASE_URL`）——**env 是当前文档正道**。host 侧 `resolveImCreds` 同时
支持 vault（`kind='im_bridge'`, `metadata.platform='wechat'`，secret=token、
`metadata.baseUrl` 非密随行，env 赢、绝不混源）；但 vault 行今天没有写入方——CLI 刻意
无状态（不复制 host 的 master-key 解析），web 向导白名单仍 telegram|lark（无扫码表单），
vault 读取路径是给将来面板扫码卡的前向兼容。

| 里程碑 | 内容 | 交付门 |
|---|---|---|
| **WX-M0 侦察 + 计划** ✅ | 本文档（协议面/海外可用性/条款/生态坑全核） | 计划落盘 + 无停做岔口 |
| **WX-M1 协议纯核** ✅（`26e15b7`+`2ed938d`） | `client.ts`（登录二维码/轮询状态/getupdates 长轮询/sendmessage/getconfig/notifystart·stop，强制查 `ret`[官方 #197 静默失败的反面]，`X-WECHAT-UIN` 随机头，`base_info` 注入，外部 abort 折叠成空页）+ `message.ts`（iLink msg → `ImMessage`，`message_type:2` 回显过滤承重，GENERATING 帧丢弃，语音走服务端转写，媒体=诚实无字节 stub）+ `types.ts` 官方逐字字段名；实现前 `gh api` 逐字核官方 5 文件，纠社区讹传 3 处（qrcode 是 POST / `-14` 在 `errcode` 不在 `ret` / `iLink-App-Id: "bot"` 是公开常量） | ✅ 21 单测全绿零真实凭证；fixture 对齐官方源码字段 |
| **WX-M2 桥 + host 装配 + CLI** ✅（M2a `6820885` / M2b `1b5aab0` / M2c） | **M2a** `bridge.ts`：长轮询循环镜像 TelegramBridge + 四个 iLink 差异（字符串游标 `get_updates_buf`；per-peer `context_token` 台账——**改为容量逐出无本地 TTL**，token 新旧由服务器裁决、发失败走 outbox 补投，比计划的「内存+TTL」更诚实；被动回复无台账=诚实抛错；`errcode=-14` 60min 冷却仅报一次自愈恢复；stop() abort 在飞长轮询不等 35s）10 单测。**M2b** host：`ImVaultPlatform` 扩 `wechat`（env 先行 `GOTONG_WECHAT_BOT_TOKEN`+可选 `_BASE_URL`，vault 行 secret=token/metadata.baseUrl 非密随行，绝不混源）+ factory 块 + `PLATFORM_NAMES` 加微信（A4 渠道感知自动覆盖）+ 旋钮 107→109 登记；web 向导白名单仍 telegram\|lark 不外泄。**M2c** CLI `gotong wechat-login`：官方状态机全镜像（IDC redirect 换轮询主机/配对数字 stdin 输错重问/过期与输错封锁刷码上限 3/binded_redirect 指路解绑），stdout 只打 env 两行可 `>> host.env`，二维码+引导走 stderr，qrcode-terminal 渲染 + 链接兜底；**刻意无状态**：CLI 不写 vault（无 master-key 解析面，复制会漂移），env 是文档正道，M2b 的 vault 读取为将来面板扫码卡前向兼容；15 单测 | ✅ im-wechat 31 / host 2022 / cli 269 全绿；未配=字节不变；四门 PASS（旋钮 109） |
| **WX-M3 真机验证 + runbook**（~1 天，**需要你的微信号**） | 真机 round-trip（扫码→绑定→管家对话→审批 park 回推）；**马来西亚国际版号可用性最终答案**；GO-LIVE 加节 + FEDERATION/IM 文档指针；CLAUDE.md 账本收口 | 真机收发成功（或诚实记录灰度未放开+国内号验证） |

## 五、显式推迟（不做的说清楚）

- **媒体收发**（图片/语音/文件/视频：AES-128-ECB + CDN + silk 转码）——M1/M2 文本 only，
  镜像 QQ 桥 MVP 姿态；官方插件在媒体路径上的 open issue 最多（#193/#213/#215/#172），
  等文本链路稳了按需加。
- **群聊**——官方能力元数据都未声明支持，不预造。
- **面板扫码卡**——CLI `wechat-login` 先行（镜像 DEPLOY 向导「粘 token」心智）；面板内
  嵌二维码需要 web 新出站面，等真需求。**wechat vault 行的写入方也归它**：M2b 的
  vault 读取已就位，面板卡落地时「扫码→写 vault→hot-start」一条龙即可接上（hot-start
  缝对 wechat 已免费覆盖）。
- **typing 指示器**（`sendtyping`）与**主动消息条数配额探测**——加分项，后置。
- **多账号**（官方插件支持多号在线）——Gotong 一桥一平台惯例，一个 hub 一个微信号，
  多号=多 hub（主权模型本来的答案）。

## 六、岔口登记

- **止损线（用户 2026-07-09 拍板）**：微信桥若开发失败（M3 真机验证不通 / 灰度始终不
  放开 / 腾讯协议面变卦致不可用），**放弃该路径，退回飞书**——Lark 桥已在生产跑着
  （生产机 IM 就是飞书），家庭 hub 垂直（方向 B）用飞书照样成立。WX track 三个里程碑
  每个都是小 commit，失败时沉没成本 ≤ 3 天且 `packages/im-wechat` 作为休眠包留着等
  灰度放开，不拖累任何其他代码（opt-in 字节不变保证）。
- **无停做级岔口**。海外可用性已从「未知风险」降级为「灰度中、真机可验」（见 2.3），
  不阻塞开工；若 M3 实测马来西亚号未获灰度，桥对国内号照常可用，等放开即可。
- 小决策（Auto Mode 默认，不值得打断）：凭证获取走 CLI 扫码先行（面板后置）；游标不
  持久化（无历史 API，重启从最新开始）；`baseurl` 以登录返回值为准（env 仅覆盖）。
