# @gotong/im-slack

A Slack bot bridge implemented against
[`@gotong/im-adapter`](../im-adapter)'s `ImBridge` interface, over the
**official Socket Mode** transport.

Socket Mode is Slack's outbound-WebSocket transport: the app dials OUT,
so there is **no public request URL, no TLS, no reverse proxy, and no
HMAC signing secret** — it works behind NAT exactly like the Telegram /
Discord / Matrix / Lark bridges, and is the path OpenClaw / Hermes use
for Slack. No `@slack/bolt` / `@slack/socket-mode` dependency — the WS
state machine is hand-rolled (mirrors `im-discord`'s injectable gateway).

Two tokens (don't mix them up):

- **`appToken` (`xapp-…`, `connections:write` scope)** — opens the
  Socket Mode connection (`apps.connections.open` → WSS URL). Inbound.
- **`token` (`xoxb-…`, bot user OAuth token)** — `chat.postMessage`
  only. Outbound.

## What you get

```ts
import { SlackBridge } from '@gotong/im-slack'
import { parseImCommand } from '@gotong/im-adapter'

const bridge = new SlackBridge({
  token: process.env.SLACK_BOT_TOKEN!,        // xoxb-...
  appToken: process.env.SLACK_APP_TOKEN!,     // xapp-...
  // Node 20 lacks global WebSocket — pass one from `ws`:
  //   webSocketImpl: (await import('ws')).WebSocket,
  onError: (err) => console.error('[slack]', err),
})

bridge.onMessage(async (msg) => {
  const cmd = parseImCommand(msg.text)
  switch (cmd.kind) {
    case 'help':
      await bridge.sendMessage(msg.from, '发 /bind <code> 来连接', {
        chatId: msg.chatId, // Slack channel id
      })
      break
    case 'bind':
      // hand off to ImBindingResolver
      break
    case 'free':
      // dispatch to Hub
      break
    // …
  }
})

await bridge.start()
// later
await bridge.stop()
```

## Setup at the Slack app config

1. 打开 [api.slack.com/apps](https://api.slack.com/apps) → **Create New App**
   → **From scratch**。
2. **Socket Mode** → 打开 **Enable Socket Mode**。Slack 会引导你创建一个
   **App-Level Token** with the `connections:write` scope → 拿到
   `xapp-...`，填入 `SLACK_APP_TOKEN`。
3. **OAuth & Permissions** → **Bot Token Scopes** 加：
   - `chat:write` （发消息）
   - `app_mentions:read`, `channels:history`, `groups:history`,
     `im:history`, `mpim:history` （收消息）
   - `files:read` （想读用户上传的附件）
4. **Install to Workspace** → 拿到 **Bot User OAuth Token**
   (`xoxb-...`)，填入 `SLACK_BOT_TOKEN`。
5. **Event Subscriptions** → 开启 → **Subscribe to bot events** 勾
   `message.channels`, `message.groups`, `message.im`,
   `message.mpim`，**Save Changes**。
   With Socket Mode on, **no Request URL is needed** — Slack delivers
   the same events over the socket instead of an HTTPS webhook.
6. 重新邀请 bot 进 channel：`/invite @你的Bot`。

## 为什么 Socket Mode，不是 Events API webhook / RTM？

- **RTM** (Real Time Messaging) 早已废弃，新建 workspace 禁止启用。
- **Events API webhook** 需要一个公网可达的 HTTPS request URL +
  HMAC 验签 — 家用机要内网穿透 (ngrok / cloudflared)。
- **Socket Mode** 是 Slack 的官方 **免穿透** 答案：app 主动拨出一条
  WebSocket，事件从 socket 推下来。没有 request URL、没有 TLS、没有
  HMAC signing secret。

握手 (见 `socket-mode.ts`)：

1. `POST apps.connections.open`（带 `xapp-` app-level token）→
   `{ ok: true, url: "wss://…" }`。这个 URL 是 **单次使用**、~30s
   过期 — 每次 (重)连都拿一条新的。
2. 连上后服务器先发 `hello`。
3. 服务器推信封 `{ envelope_id, type, payload }`。Bridge 先按
   `envelope_id` **ack**（Slack 要求 3s 内、与处理是否成功无关），
   再按 `type` 路由：只有 `events_api`（payload 就是标准
   `event_callback` body）会 surface；`slash_commands` / `interactive`
   仅 ack。
4. 服务器可能发 `disconnect`（reason: refresh_requested / warning /
   too_many_connections）回收 socket — bridge 拆掉重连、拿新 URL。

不像 Discord 网关，Socket Mode **不需要 app 层心跳**：Slack 在
WebSocket 协议层 ping，`ws` 库自动 pong。所以状态机比 Discord 更简单
（无心跳定时器、无 sequence、无 RESUME）。

`apps.connections.open` 返回 `invalid_auth` / `not_allowed_token_type`
/ `account_inactive` / `token_revoked` / `token_expired` 视为 **fatal**
（app token 配错），`start()` loud fail 不重试；其余（限流 / 5xx /
网络）按指数退避重连。

## Surface

| Export                       | Purpose                                                       |
|------------------------------|---------------------------------------------------------------|
| `SlackBridge`                | `ImBridge` impl，over Socket Mode                             |
| `createSlackSocketMode`      | 手撸 Socket Mode WS 状态机（可注入 `webSocketImpl` / `fetchImpl`）|
| `defaultSlackSocketFactory`  | 生产工厂 — `createSlackSocketMode` 的薄包装                   |
| `createSlackClient`          | Fetch 封装，加 `Bearer xoxb-...` Authorization                |
| `SlackApiError`              | 非 2xx HTTP 或 `ok: false` 统一抛出 — 带 `code`, `retryAfterMs` (429) |
| `slackToImMessage`           | 纯映射: Slack `message` event → `ImMessage`                   |
| `slackExtractAttachments`    | 拉 image / audio / file 出来，根据 mimetype 分桶              |
| `stripSlackBotMentions`      | 剥 `<@BOT_USER_ID>` 提及（保留其他人的）                      |
| `slackFileUri` / `parseSlackFileUri` | `slack-file:<id>` URI 封装（auth-gated 下载）         |

## Slack 附件 vs Discord/Lark

| 平台      | URL 形式                    | Bridge 处理                          |
|-----------|----------------------------|--------------------------------------|
| Discord   | 公开 CDN URL                | pass-through 进 `ImAttachment.url`   |
| Slack     | `url_private` (Bearer 校验) | 包成 `slack-file:<id>` URI           |
| Lark/Feishu | `image_key` / `file_key`  | 包成 `lark-image:` / `lark-file:`    |
| Telegram  | `file_id` (调 getFile 拿 URL) | 包成 `telegram-file:`              |

下游 LLM agent 想喂 Vision API 时要先调 bridge / 共享 resolver
取 bytes，不能像 Discord 那样直接喂 URL。Slack 的 `url_private`
没有 Authorization 头会返回 200 HTML 登录页，是个常见踩坑点 —
所以 bridge 不直接暴露 URL，强制走 URI scheme。

## Slack channel id 形式

| 前缀 | 含义                          |
|------|-------------------------------|
| `C…` | public channel                |
| `D…` | direct message (1-1 DM)       |
| `G…` | private channel / group       |
| `W…` | enterprise / multi-workspace  |

`sendMessage` 的 `chatId` 接受任意一种；`platformUserId` (`U…`)
也行 — Slack 把它当 DM by user 处理。

## 群里 @机器人 的处理

频道 / 群组里 bot 被 @ 的时候 Slack 在 text 里插 `<@UBOT123>`。
`parseImCommand` 不接受这种前缀，所以 bridge 默认
`stripBotMentions: true` 帮你去掉自己的 mention（其他 user 的
`<@U…>` 保留）。

## botUserId 怎么来

- 显式传 `botUserId: 'UBOT...'` （知道的话最快）
- 否则 bridge 从第一个 `event_callback.authorizations` 数组里
  找 `is_bot: true` 的那条 `user_id` —— Socket Mode 的 `events_api`
  payload 跟 webhook 的 `event_callback` 同构，每次 delivery 都带这个数组
- 没有的话仍然能跑：`bot_id` 字段的 anti-loop layer 1 仍然
  生效，只是 `<@…>` mention strip 暂时不工作

## 不做的

- **Slash commands / interactivity** (`/<cmd>` + button click). Socket
  Mode 把这些当 `slash_commands` / `interactive` 信封推过来，bridge
  目前只 ack 不 surface — 后续补。
- **OAuth installation flow** (`oauth.v2.access`). 假设 host 已经
  从 Slack app 配置页拿到了 `xoxb-` + `xapp-` 两个 token。
- **出向 attachments / blocks / threads / reactions**. `sendMessage`
  带 attachments 会触发 `onError` 但 text 仍发出，跟其他桥一致。
- **Per-tier rate limit tracking**. 429 时拿 `Retry-After` header 自己
  honour。bridge 不做主动 throttling。

## 测试

`tests/message.test.ts` 纯映射函数 (mapper + mention strip + attachment
分类)；`tests/client.test.ts` Web API (Bearer + JSON shape / 429
retry-after / ok:false / unparseable body)；`tests/socket-mode.test.ts`
用 fake WebSocket 驱动状态机：ack-by-envelope_id、`hello`、
`apps.connections.open` fetch 路径、fatal token、干净 stop；
`tests/bridge.test.ts` 用 fake `socketFactory` 注入合成信封走端到端：
events_api dispatch、botUserId capture、dedup by event_id、anti-loop
(bot_id + botUserId)、file_share pass-through、system subtype skip、
start/stop 生命周期、sendMessage REST shape。

```bash
pnpm --filter @gotong/im-slack test
```

## host 接线

`startImBridges()`（`@gotong/host`）按 env 起桥：
`GOTONG_SLACK_APP_TOKEN` (`xapp-`) + `GOTONG_SLACK_BOT_TOKEN` (`xoxb-`)
齐则构造、push 进 `bridges` 数组（router `handleImMessage` 零改）。
See `docs/zh/IM-OFFICIAL-REARCH.md` for the official-transport rework.
