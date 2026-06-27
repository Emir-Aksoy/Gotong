# IM 桥官方化 — 有官方的全接官方（对照 OpenClaw / Hermes）

> 这篇记录一次架构调整的**理由**：把每个有官方 API 的 IM 平台都切到官方直连，
> 对照主流项目 OpenClaw / Hermes 的做法。改的是三个桥（QQ / Lark / Slack）的
> **transport**，没有动 `ImBridge` 契约、没有动 host 路由 `handleImMessage`。
>
> 实操（建 bot、配反代、env、调试）看 [`IM-BRIDGES.md`](IM-BRIDGES.md)；上线拓扑
> 与公网风险看 [`GO-LIVE.md`](GO-LIVE.md)。
>
> Last updated: 2026-06-17

---

## 一、为什么做

AipeHub 有 6 个 IM 桥，但改之前**三个用的不是官方直连**：

| 桥 | 改之前 transport | 性质 |
|---|---|---|
| im-telegram | Bot API long-poll | ✅ 官方·出站，达标，不动 |
| im-discord | Gateway WSS | ✅ 官方·出站，达标，不动 |
| im-matrix | Client-Server `/sync` | ✅ 官方·出站，达标，不动 |
| **im-qq** | **OneBot v11 forward-WS** | ❌ **第三方逆向协议**（驱动个人号，有封号风险） |
| **im-lark** | **webhook（入站）** | ⚠️ 官方 API 但走入站 webhook（要公网） |
| **im-slack** | **Events API webhook（入站）** | ⚠️ 官方 API 但走入站 webhook（要公网） |

目标：**有官方直连的全切官方直连**，做法对齐 OpenClaw / Hermes。

唯一干净的接缝是 **`ImBridge` 契约**（`@aipehub/im-adapter` 的
`platform` / `start` / `stop` / `sendMessage` / `onMessage`）。host 路由
`handleImMessage` + `parseImCommand` **只依赖这个接口**，所以每个桥换 transport
host 路由 **零改**，爆炸半径锁在各自的包 + 其 hermetic 测试。

---

## 二、研究对照结论（带出处）

| 平台 | 官方直连模式 | 方向 | OpenClaw / Hermes 印证 |
|---|---|---|---|
| **Lark / 飞书** | 官方**长连接** `@larksuiteoapi/node-sdk` 的 `WSClient` + `EventDispatcher`（订 `im.message.receive_v1`） | **出站·免穿透** | OpenClaw Feishu = WebSocket 长连接；Hermes Feishu = 长连接免公网 |
| **Slack** | **Socket Mode**：`xapp-` app-level token → `apps.connections.open` → 动态出站 WSS（`connections:write`） | **出站·免穿透** | Socket Mode 是 Slack 官方免公网方案 |
| **QQ** | 官方 Bot API（`bot.q.qq.com`）：**WS 已判死**（2024 底停维护、群 bot 主动推送 2025-04 已停），官方推 **Webhook**（入站，公网域名 + SSL） | **入站·需公网** | OpenClaw 官方 bot 走 webhook 向；免穿透大群走 NapCat / OneBot（= im-qq 旧实现） |

出处：
- QQ 事件订阅 / 回调验证：<https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/event-emit.html>
- larksuite/node-sdk `WSClient`：<https://github.com/larksuite/node-sdk>
- Slack Socket Mode：<https://docs.slack.dev/apis/events-api/using-socket-mode/>
- `apps.connections.open`：<https://api.slack.com/methods/apps.connections.open>

---

## 三、关键发现 + 锁定决策

### 3.1 ★ QQ：「官方」和「免穿透」现在不能同时满足

官方 Bot API 把 WebSocket 判死、改推**入站 Webhook**（要公网域名 + SSL）。用户拍板
**官方 Bot + Webhook**——即为 QQ **放弃免穿透**，换真·官方。这把 QQ 从「出站
OneBot」翻成「入站官方 webhook」，**结构模板从 im-discord（WS 网关）换成
im-lark / im-slack 那一类 webhook bridge**（HTTP server + 验签 + handleEvent）。

Lark / Slack **没有这个冲突**——两者都能官方 + 免穿透，照官方长连接 / Socket Mode 做。

> **取舍记录（必须如实写进运维文档）**：QQ 官方桥**不是免穿透**，要跑在云主机上，
> 前面挂反代（nginx / Caddy）终止 TLS + 公网域名。家用 NAT 后的机器**不能**直接收
> QQ 官方 webhook。Telegram / Lark / Slack / Discord / Matrix 不受此限。

### 3.2 ★ QQ 官方群 / C2C 只能被动回复（诚实限制，非实现缺陷）

官方群 / 单聊消息只能在用户消息的时间窗内、带 `msg_id` **被动回复**；**主动推送
2025-04 已停**。→ QQ 桥能回复指令 / 对话，但 **agent 主动推送（心跳 / 告警）到 QQ
群不可用**（官方限制）。`sendMessage` 到一个从没收到过消息的会话会**诚实失败**而不是
假装成功。Telegram / Lark / Slack / Discord 无此限。

### 3.3 删 OneBot 代码，不留 shim

用户「不需向前兼容、删旧代码优先」+ 明确「qq 改为接官网的那一套」→ im-qq 的 OneBot
v11 forward-WS 整条删掉，换官方 webhook 实现。不保留 `AIPE_QQ_BRIDGE_ACK_RISK` 风险
闸、不保留 NapCat / go-cqhttp adapter 接线。

### 3.4 QQ 用 Node 内置 `node:crypto`（零新依赖）

回调验证握手对 `event_ts + plain_token` 做 Ed25519 签名（密钥对从 bot secret 派生），
返回 `{ plain_token, signature }`；后续事件用同一把公钥验 `X-Signature-Ed25519`
（覆盖 `timestamp + rawBody`）。op:13（无签名的握手）在验签**之前**判别，因为它是还
没有签名的引导步。

### 3.5 Slack Socket Mode 手撸 `ws`，不引 `@slack/socket-mode`

仓库已有 `ws` 依赖（transport-ws）+ im-discord 手撸 gateway 先例。Socket Mode 比
webhook **更简单**（无 HMAC 验签，靠 `xapp-` token 鉴权）。状态机比 Discord 还简单：
没有 app 层心跳（Slack 在 WS 协议层 ping，`ws` 自动 pong）、没有 sequence / RESUME。

### 3.6 Lark 例外——用官方 SDK

长连接协议复杂，**用官方 `@larksuiteoapi/node-sdk`**（这是本轮唯一新增的运行时
依赖）。SDK 负责 socket、重连、事件分帧；桥只剩三件事：**去重、映射、派发**。连接走
一个**可注入工厂**（`connectionFactory`），hermetic 测试注入 fake、不碰真 SDK / 不开
socket。

---

## 四、各桥官方 transport 决策与 specifics

### 4.1 QQ — 官方 Bot webhook（入站，需公网）

- 凭证：QQ 开放平台注册 bot 拿 **AppID + AppSecret**。旧 *Token* 在 webhook + v2
  路径**不用**，桥不收它。
- 入站：桥自起 HTTP listener，运维侧反代终止 TLS。两个 `X-Signature-*` header 必须
  原样到达桥（op:0 事件签名覆盖 `timestamp + rawBody`）。
- 事件 → chatId 四命名空间（QQ id 是不透明 openid，加 tag 防串台）：
  `GROUP_AT_MESSAGE_CREATE→group:` / `C2C_MESSAGE_CREATE→c2c:` /
  `AT_MESSAGE_CREATE→channel:` / `DIRECT_MESSAGE_CREATE→dm:`。
- 出站：`sendMessage` 按 tag 路由到对应 REST 端点，作**被动回复**（查该会话最后一条
  入站消息的 `msg_id`，`msg_seq` 自增）。
- 详见 [`packages/im-qq/README.md`](../../packages/im-qq/README.md)。

### 4.2 Lark / 飞书 — 官方长连接（出站，免穿透）

- 入站：`WSClient` 拨一条持久 WS 给 Lark，`im.message.receive_v1` 经它推回。**无需**
  公网回调、HTTPS、Verification Token、Encrypt Key——在开放平台「事件订阅」页选
  **长连接**（不是「发送至开发者服务器」）。
- 出站：`sendMessage` 仍走 REST（`POST /open-apis/im/v1/messages`，短命
  `tenant_access_token` 自动续）。只有**入站** transport 是长连接。
- 国内 Feishu / 国际 Lark 只换 `baseUrl`，事件 schema 一致。
- 详见 [`packages/im-lark/README.md`](../../packages/im-lark/README.md)。

### 4.3 Slack — Socket Mode（出站，免穿透）

- 两个 token 别混：`appToken`（`xapp-`，`connections:write`）开 Socket Mode 连接；
  `token`（`xoxb-`，bot OAuth）只用于 `chat.postMessage`。
- 握手：`POST apps.connections.open`（带 `xapp-`）→ 单次使用、~30s 过期的 WSS URL →
  连上收 `hello` → 服务器推信封 `{envelope_id, type, payload}` → 桥先**按 envelope_id
  ack**（3s 内、与处理成败无关）再按 type 路由（只 `events_api` surface）。
- `apps.connections.open` 返 `invalid_auth` / `not_allowed_token_type` 等视为 fatal，
  `start()` loud fail 不重试；限流 / 5xx / 网络按指数退避重连。
- 详见 [`packages/im-slack/README.md`](../../packages/im-slack/README.md)。

---

## 五、transport 方向 / 免穿透 / 公网需求 对照表

| 桥 | 官方 transport | 方向 | 免穿透 | 需公网入口 | 主动推送 |
|---|---|---|---|---|---|
| im-telegram | Bot API long-poll | 出站 | ✅ | ❌ | ✅ |
| im-discord | Gateway WSS | 出站 | ✅ | ❌ | ✅ |
| im-matrix | C-S `/sync` | 出站 | ✅ | ❌ | ✅ |
| im-lark | 官方长连接（SDK `WSClient`） | 出站 | ✅ | ❌ | ✅ |
| im-slack | Socket Mode（`xapp-`） | 出站 | ✅ | ❌ | ✅ |
| **im-qq** | **官方 Bot webhook** | **入站** | **❌** | **✅（域名 + TLS + 反代）** | **❌（仅被动回复）** |

**读法**：除 QQ 外五桥都是出站、免穿透、可主动推送（心跳 / 告警能发）。QQ 是唯一异类
——官方判死了它的 WS，只能入站 webhook + 被动回复，因此必须上云、配反代，且 agent
不能主动 push 到 QQ。

---

## 六、host 接线（env 闸）

`startImBridges()`（`packages/host/src/im-bridge.ts`）按 env **逐平台独立**起桥：某平台
env 齐才构造它的桥，全 push 进同一个 transport-agnostic 的 `bridges` 数组（router 零
改）。一个平台凭证坏不影响其他平台、也不阻断 host 启动（best-effort，镜像 A2A / ACP
出站 manager）；全没设则返回 `undefined`，零行为变化。

| 平台 | env（桥需要它**全部**才激活） | 方向 |
|---|---|---|
| Telegram | `AIPE_TELEGRAM_BOT_TOKEN` | 出站·免穿透 |
| QQ | `AIPE_QQ_BOT_APPID` + `AIPE_QQ_BOT_SECRET`（可选 `AIPE_QQ_WEBHOOK_PORT` / `_HOST` / `_PATH` 调监听；端口 0 = 不自起监听，由 host 自己的 HTTP 层喂 webhook） | 入站·需公网 |
| Lark | `AIPE_LARK_APP_ID` + `AIPE_LARK_APP_SECRET` | 出站·免穿透 |
| Slack | `AIPE_SLACK_APP_TOKEN`（`xapp-`） + `AIPE_SLACK_BOT_TOKEN`（`xoxb-`） | 出站·免穿透 |

> **诚实边界**：`startImBridges` 当前 env-gate 这 **4 个**平台。Discord / Matrix 桥本就
> 是官方 + 出站、不在本轮改动范围，仍走 `examples/im-bridge-host/` 的示例 router；要把
> 它俩也折进 host 是一个独立的小步（沿同一 env 闸模式，第二个 caller 稳定后再做）。

Slack 的 Socket Mode 客户端需要一个 `WebSocket` 实现——Node 20 没有全局 WebSocket
（22 前是 flag-gated），所以 host 把 `ws` 的实现传给它；`ws` 因此从 host 的
devDependencies 提升到 dependencies（host 源码现在直接 import 它）。

---

## 七、真 token 联调（opt-in 人工，不入 CI）

各桥的包内测试全 hermetic——注入 fake transport，**无真 token / 无真网络**：

- **QQ**：已知 keypair 验 op:13 握手签名正确 + 篡改 body → 401 + 事件映射四类型 +
  REST send 形状 + 主动推送的诚实失败路径。
- **Lark**：注入 fake `connectionFactory`，喂合成 `im.message.receive_v1` → 断言去重 /
  去 @ / 派发 + `sendMessage` REST 形状。
- **Slack**：注入 fake socket，喂 `events_api` / `hello` / `disconnect` 信封 → 断言
  ack-by-envelope_id + 派发 + send 形状。

真 token 联调是 **opt-in 人工步骤**，按 [`IM-BRIDGES.md`](IM-BRIDGES.md) /
[`GO-LIVE.md`](GO-LIVE.md) 的 runbook 照跑——**不入 CI**（生产凭证 / 真 token 永不读写
不 commit）。QQ 联调还需要公网域名 + 反代 + 真 AppID/Secret。

---

## 八、显式推迟

1. **QQ 频道（guild）消息完整支持**——MVP 聚焦群 / C2C（官方主推），频道映射留接口位。
2. **QQ 富媒体（图片 / 文件 / 语音）**——MVP 文本，媒体走官方富媒体 API 是后续；
   `sendMessage` 带 attachments 触发 `onError` 但 text 仍发。
3. **Lark 卡片按钮交互事件**——长连接**不投递**卡片按钮回调（那只走 HTTPS 回调）；纯文本
   聊天不受影响，需要卡片按钮的 hub 得另起一条 webhook 旁路。
4. **Slack slash commands / interactivity**——Socket Mode 把它们当 `slash_commands` /
   `interactive` 信封推来，桥目前只 ack 不 surface。
5. **Discord / Matrix 折进 host env 闸**——见 §六诚实边界，独立小步。
6. **QQ webhook 经云中继转出站（免穿透折中）**——本轮按用户拍板走纯官方 webhook，不做中继。

---

## 九、设计决策：IM 桥维持随包（不做插件化）

> 2026-06-27 用户拍板：「IM 桥维持现状，一点性能向易用性让步是值得的。」

**问题**：六个桥能不能像 `services-sdk` 那样做成可选插件，让框架进一步轻量化、要哪个桥
再装哪个？

**核实**：六个桥早已是各自独立的包，都实现同一 `ImBridge` 契约
（`platform`/`start`/`stop`/`sendMessage`/`onMessage`），host 路由只认契约——**契约层解耦
已完成**。但 `im-bridge.ts` 在模块顶层**静态 import** Telegram/QQ/Lark/Slack，
`host/package.json` 也无条件依赖它们；env 闸只决定要不要 `.start()`，不决定要不要
**装进来**。所以这四个桥（连同飞书 SDK、`ws` 这些传递依赖）对所有人无条件打进 host
安装包并在启动时加载——这正是「插件化能省什么」的核算基础。

**两个杠杆（评估过，都不做）**：

- **懒加载**（静态 import → env 闸后 `await import()`）：消掉「未启用桥仍被加载」的冷启动 +
  常驻内存代价，但**零体积收益、零易用性影响**。这点运行时代价小到不值得为它增加一层
  条件加载的复杂度。
- **真插件化**（可选 peer-dep，按需发现 / 加载）：能瘦便携包 / 安装体积，但代价是非技术
  用户得知道「去装一个组件」——跟北极星「5 分钟跑起来、不写代码」相悖。唯一干净的解法是
  admin UI「一键启用 X 桥」，那是一条独立工作流，不是顺手的活。

**决策**：**维持随包现状**。未启用的桥模块被加载进来这点微小运行时代价（传递依赖常驻
一点内存 + 冷启动那一下 import），换来的是**开箱即用、零插件安装摩擦**——对「下载双击
即跑」的非技术用户，这个权衡是值得的。**记在此处是为了不再被重新提议**；将来若便携包
体积成为真痛点，再按上面「真插件化 + admin 一键启用」那条路另起工作流。
