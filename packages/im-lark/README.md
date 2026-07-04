# @gotong/im-lark

A Lark / Feishu Open Platform Bot bridge implemented against
[`@gotong/im-adapter`](../im-adapter)'s `ImBridge` interface.

Inbound runs over the **official long connection**
(`@larksuiteoapi/node-sdk` `WSClient` + `EventDispatcher`) — the bridge
dials OUT to Lark and receives `im.message.receive_v1` events over a
persistent socket. **No public callback URL, no TLS, no reverse proxy,
no verification token: it works behind NAT** like Telegram / Discord /
Matrix. This matches how OpenClaw / Hermes connect Feishu.

Outbound (`sendMessage`) still goes through the REST client
(`POST /open-apis/im/v1/messages`). Only the inbound transport is the
long connection.

国内（Feishu）和国际（Lark）切换只需要换 `baseUrl`。

## What you get

```ts
import { LarkBridge } from '@gotong/im-lark'
import { parseImCommand } from '@gotong/im-adapter'

const bridge = new LarkBridge({
  appId: process.env.LARK_APP_ID!,
  appSecret: process.env.LARK_APP_SECRET!,
  // baseUrl: 'https://open.larksuite.com',  // 国际版 (via clientOptions)
  // baseUrl is 'https://open.feishu.cn' by default (国内)
  onError: (err) => console.error('[lark]', err),
})

bridge.onMessage(async (msg) => {
  const cmd = parseImCommand(msg.text)
  switch (cmd.kind) {
    case 'help':
      await bridge.sendMessage(msg.from, '发 /bind <code> 来连接', {
        chatId: msg.chatId,
      })
      break
    case 'bind':
      // hand off to ImBindingResolver (host wiring)
      break
    case 'free':
      // dispatch to Hub
      break
    // …
  }
})

await bridge.start()   // dials the long connection
// later
await bridge.stop()
```

## Setup at the Open Platform admin panel

1. 创建应用（cli_xxx）— 拿到 **App ID** + **App Secret**。
2. 在「凭证与基础信息」页找到 **App Secret**。
3. 启用「机器人」能力，在「事件订阅」页：
   - **传输方式选「长连接」**（不是「将事件发送至开发者服务器」）。
     长连接由 bot 主动外拨，**无需**公网回调地址、无需 HTTPS、无需配
     Verification Token / Encrypt Key。
   - 添加事件 `im.message.receive_v1`。
4. 给机器人加权限：`im:message`（接收）+ `im:message:send_as_bot`（回消息）。
5. 「版本管理与发布」发布到企业内部测试 / 全量。

国际版 Lark 的配置在 [open.larksuite.com](https://open.larksuite.com)，流程一致。

## 为什么长连接，不是 webhook？

webhook（事件订阅推到开发者服务器）要求一个公网 HTTPS 回调地址 —— 家
用机得做内网穿透 / 反代。官方长连接（`@larksuiteoapi/node-sdk` 的
`WSClient`）是**出站**的：bot 拨一条持久 WebSocket 给 Lark，事件经它推
回来。这跟 Telegram long-poll / Discord gateway / Matrix `/sync` 同一
类「官方 + 免穿透」模式，也是 OpenClaw / Hermes 接 Feishu 的路径。

SDK 负责 socket、重连、事件分帧；bridge 只剩三件事：**去重、映射、派发**。

连接通过一个**可注入工厂**（`connectionFactory`）创建，默认工厂惰性
`import('@larksuiteoapi/node-sdk')`。hermetic 测试注入 fake 工厂，喂合成
`im.message.receive_v1` 事件，不碰真 SDK、不开 socket。

## Surface

| Export                              | Purpose                                                       |
|-------------------------------------|---------------------------------------------------------------|
| `LarkBridge`                        | `ImBridge` impl over the official long connection             |
| `defaultLarkConnectionFactory`      | 默认连接工厂（惰性 import 官方 SDK 的 `WSClient`/`EventDispatcher`）|
| `LarkConnectionFactory` (type)      | 注入点：测试 / 自定义传输实现可替换                          |
| `createLarkClient`                  | Fetch 封装，自动管理 `tenant_access_token`（出站发消息用）     |
| `LarkApiError`                      | 非 0 code 抛出 — 携带 `code`, `msg`, `status`                 |
| `larkToImMessage`                   | 纯映射: `LarkMessageReceiveEvent` → `ImMessage`               |
| `larkExtractAttachments`            | 拉 image / audio / file 出来                                  |
| `larkUri` / `parseLarkUri`          | `lark-image:` / `lark-audio:` / `lark-file:` URI 工具         |
| `stripLarkMentions`                 | 剥掉群消息里的 `<at>` 标签                                    |
| `pickLarkReceiveIdType`             | 根据前缀（`oc_`/`ou_`/`on_`）推 `receive_id_type` 值           |

## Token 管理（出站发消息）

发消息走 REST，用短命的 `tenant_access_token`（约 2 小时 TTL）。
`createLarkClient`：

- 第一次业务调用前 `POST /open-apis/auth/v3/tenant_access_token/internal`
  拿 token，缓存
- 在 token 过期前 ~2 分钟（safety margin）主动 refresh
- 并发调用合并到同一个 refresh promise（不 thundering-herd）
- `invalidateToken()` 强制下次调用 refresh（在响应里看到 `99991663` 之类
  token 失效错误时调）

## 附件如何工作

入向 image / audio / file 包装成 `lark-<kind>:<key>` URI；字节**不**
预下载。下游需要时：

```ts
import { parseLarkUri } from '@gotong/im-lark'

const parsed = parseLarkUri(att.url)!
const endpoint = parsed.kind === 'image' ? 'images' : 'files'
const url = `https://open.feishu.cn/open-apis/im/v1/${endpoint}/${parsed.key}`
const res = await fetch(url, {
  headers: { authorization: `Bearer ${TENANT_TOKEN}` },
})
const bytes = await res.arrayBuffer()
```

## 群里 @机器人 的处理

群消息里机器人会被 `<at user_id="ou_bot">@Bot</at>` 提及。`parseImCommand`
不接受这种前缀，所以 bridge 默认 `stripBotMentions: true` 帮你去掉。如
果要保留原文，关掉这个选项。

## 国内 vs 国际

只换 `baseUrl`（出站 REST 用），事件 schema 完全一致；长连接由 SDK 按
`appId` 自动选对应域：

```ts
// 国内 Feishu — 默认
new LarkBridge({ ..., /* baseUrl: 'https://open.feishu.cn' (default) */ })

// 国际 Lark
new LarkBridge({ ...,
  clientOptions: { baseUrl: 'https://open.larksuite.com' }
})
```

## 不做的

- **交互卡片回调按钮** (`card.action.trigger`). 长连接**不投递**卡片按钮
  回调事件 —— 那只走 HTTPS 回调。纯文本聊天（bridge 的本职）完全覆盖；
  需要卡片按钮的 hub 得另起一条 webhook 旁路（超出本桥范围）。
- **出向附件 / 图片 / 卡片**. `sendMessage` 带 attachments 会触发
  `onError` 但 text 仍发出，跟 Telegram / Matrix 一致。
- **OAuth/SSO/Marketplace 应用流程**. 假定内部企业应用 + 长期 app
  secret。

## 测试

`tests/bridge.test.ts` 注入 fake `connectionFactory`，捕获 bridge 在
`start()` 里挂的 `onMessageReceive` 回调，再用 `emit()` 喂合成
`im.message.receive_v1` 事件 —— 不碰真 SDK、不开 socket、不占端口。
去重（按 `message_id`）、去 @ 标签、app-sender 反环、派发全在这条接缝上
验证。`FakeLarkClient` 不打网络，sendMessage 验证 `receive_id_type` 自动
嗅探。

## Status

- IM 桥官方化 — Lark/飞书改官方长连接（替代旧 webhook 模式）。
- 同批：QQ 改官方 Bot webhook、Slack 改 Socket Mode。

See `docs/zh/IM-OFFICIAL-REARCH.md` for the official-API re-architecture
rationale (OpenClaw / Hermes 对照 + 各桥 transport 决策).
