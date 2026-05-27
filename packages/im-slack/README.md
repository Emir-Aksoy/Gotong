# @aipehub/im-slack

Phase 12 M6 — fifth concrete `ImBridge` for AipeHub.

A Slack bot bridge implemented against
[`@aipehub/im-adapter`](../im-adapter)'s `ImBridge` interface. Events
API webhook + Web API (Bearer `xoxb-`); HMAC SHA256 signature
verification; no `@slack/bolt` / `@slack/web-api` dependency
(`fetch` + `node:crypto`); ~700 lines of implementation.

## What you get

```ts
import { SlackBridge } from '@aipehub/im-slack'
import { parseImCommand } from '@aipehub/im-adapter'

const bridge = new SlackBridge({
  token: process.env.SLACK_BOT_TOKEN!,        // xoxb-...
  signingSecret: process.env.SLACK_SIGNING_SECRET!,
  webhookPort: 9091,                          // 0 = host drives HTTP itself
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
2. **OAuth & Permissions** → **Bot Token Scopes** 加：
   - `chat:write` （发消息）
   - `app_mentions:read`, `channels:history`, `groups:history`,
     `im:history`, `mpim:history` （收消息）
   - `files:read` （想读用户上传的附件）
3. **Install to Workspace** → 拿到 **Bot User OAuth Token**
   (`xoxb-...`)，填入 `SLACK_BOT_TOKEN`。
4. **Basic Information** → **Signing Secret** → 填入
   `SLACK_SIGNING_SECRET`。
5. **Event Subscriptions** → 开启 → **Request URL** 填
   `https://your-host/slack/webhook`（公网可达 HTTPS；本地开发用
   ngrok / cloudflared 暴露 `webhookPort`）。Slack 会立刻发一次
   `url_verification` challenge — bridge 自动 echo。
6. **Subscribe to bot events** 勾 `message.channels`,
   `message.groups`, `message.im`, `message.mpim`，**Save Changes**。
7. 重新邀请 bot 进 channel：`/invite @你的Bot`。

## 为什么 webhook，不是 RTM WebSocket？

Slack 的 RTM (Real Time Messaging) API 早已废弃 — 新建的 workspace
甚至禁止启用。当前唯一的官方 bot 通路是 **Events API webhook**：

- Slack 推一个 HTTPS POST 给你的 request URL，dedup hint 自带
  (`event_id`)，超时会重试（~3 次 / 1 分钟）
- 每个请求带 `X-Slack-Signature` 和 `X-Slack-Request-Timestamp`，
  HMAC SHA256 with signing secret — 比 Lark 的明文 token 校验安全
  得多
- 也走 Events API 的还有 reactions、file_shared、app_mention 等。
  Bridge M6 只听 `message` event

Bridge 自带最小 webhook 路由：

- `POST /slack/webhook` →
  1. verify HMAC signature（5 min replay window）
  2. parse body
  3. `url_verification` → echo `challenge`
  4. `event_callback` → dedup by `event_id` → dispatch
- `GET /slack/webhook` → `200 slack-bridge ok` （load balancer 健康检查）
- 别的路径 → 404

签名失败：
- 缺 header → `401 missing-headers`
- 时间戳偏差超 5 分钟 → `401 bad-timestamp`
- HMAC 不匹配 → `401 mismatch`

不返 4xx 的情况：Slack 把 4xx 当 "请稍后重试"，401 已经够 Slack
不再 retry 这个特定请求。其他未识别的 event type 静默 200 ack +
跳过 — 避免 Slack 因为我们持续 4xx 而禁掉订阅。

## Surface

| Export                       | Purpose                                                       |
|------------------------------|---------------------------------------------------------------|
| `SlackBridge`                | `ImBridge` impl + 内置 webhook HTTP server                    |
| `createSlackClient`          | Fetch 封装，加 `Bearer xoxb-...` Authorization                |
| `SlackApiError`              | 非 2xx HTTP 或 `ok: false` 统一抛出 — 带 `code`, `retryAfterMs` (429) |
| `slackToImMessage`           | 纯映射: Slack `message` event → `ImMessage`                   |
| `slackExtractAttachments`    | 拉 image / audio / file 出来，根据 mimetype 分桶              |
| `stripSlackBotMentions`      | 剥 `<@BOT_USER_ID>` 提及（保留其他人的）                      |
| `verifySlackSignature`       | 纯函数 HMAC 校验（discriminated result，不抛异常）            |
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
也行 — Slack 把它当 DM by user 处理（如果 bot 之前没跟该 user
DM 过，Slack 会自动 open IM channel）。

## 群里 @机器人 的处理

频道 / 群组里 bot 被 @ 的时候 Slack 在 text 里插 `<@UBOT123>`。
`parseImCommand` 不接受这种前缀，所以 bridge 默认
`stripBotMentions: true` 帮你去掉自己的 mention（其他 user 的
`<@U…>` 保留）。

## botUserId 怎么来

- 显式传 `botUserId: 'UBOT...'` （知道的话最快）
- 否则 bridge 从第一个 `event_callback.authorizations` 数组里
  找 `is_bot: true` 的那条 `user_id` —— 现代 Events API 每次
  delivery 都带这个数组
- 没有的话仍然能跑：`bot_id` 字段的 anti-loop layer 1 仍然
  生效，只是 `<@…>` mention strip 暂时不工作

## host 自己驱动 HTTP

不想让 bridge 自己 listen 端口（例如已经有 `@aipehub/web` 跑在
443）：

```ts
const bridge = new SlackBridge({
  token, signingSecret,
  webhookPort: 0,           // 不开自己的 listener
})

app.post('/slack/webhook', async (req, res) => {
  const rawBody = await readRawBody(req)        // ← 必须 raw bytes!
  const r = await bridge.handleRawRequest(rawBody, {
    signature: req.header('x-slack-signature'),
    timestamp: req.header('x-slack-request-timestamp'),
  })
  res.status(r.status).json(r.body)
})
```

**raw body 关键**：Slack 签名是基于 byte-exact body 算的，任何
JSON re-stringify 都会破签名。Express 用 `bodyParser.raw({ type: '*/*' })`
而不是 `bodyParser.json()`。

## M6 不做的

- **Slash commands / interactivity** (`/<cmd>` + button click). 用
  独立的 request URL，HMAC scheme 一样；后续补 ~200 行可以加。
- **OAuth installation flow** (`oauth.v2.access`). 假设 host 已经
  从 Slack app 配置页拿到了 bot token。多 workspace 的 distribution
  flow 是后续工作。
- **出向 attachments / blocks / threads / reactions**. `sendMessage`
  带 attachments 会触发 `onError` 但 text 仍发出，跟 M2/M3/M4/M5 一致。
- **Token rotation**. Bot token 长期有效（不像 Lark 2h TTL）。
  user installer token 才会 rotate — 不在 transport 范围。
- **Per-tier rate limit tracking**. Slack 用 [tier-based
  ratelimits](https://api.slack.com/apis/rate-limits)；429 时拿
  `Retry-After` header 自己 honour。bridge 不做主动 throttling。

## 测试

`tests/message.test.ts` 纯函数 (mapper + signature verifier + mention
strip + attachment 分类，42 tests)；`tests/client.test.ts` Web API
(Bearer + JSON shape / 429 retry-after / ok:false / unparseable body，
13 tests)；`tests/bridge.test.ts` 用 `FakeSlackClient` 走端到端：
url_verification → echo, event_callback → dispatch, signature 验证
(accept / 401 missing / 401 stale / 401 mismatch), dedup by event_id,
anti-loop (bot_id + botUserId), file_share pass-through, system
subtype skip, sendMessage REST shape, 还有真实 HTTP 端口的 smoke
test（30 tests）。

```bash
pnpm --filter @aipehub/im-slack test
```

## Status

- Phase 12 M6 — released（transport only；host integration pending）。
- Next milestones: M7 (QQ / OneBot v11), M8 (docs + docker-compose for
  IM bridges)。

See `docs/zh/V4-PHASE7-13-PLAN.md` section 七 for the full roadmap.
