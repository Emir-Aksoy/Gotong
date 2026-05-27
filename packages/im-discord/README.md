# @aipehub/im-discord

Phase 12 M5 — fourth concrete `ImBridge` for AipeHub.

A Discord Bot bridge implemented against
[`@aipehub/im-adapter`](../im-adapter)'s `ImBridge` interface.
WebSocket Gateway v10 + REST; no `discord.js` dependency (`fetch` +
injectable `WebSocket`); ~700 lines of implementation.

## What you get

```ts
import { DiscordBridge } from '@aipehub/im-discord'
import { parseImCommand } from '@aipehub/im-adapter'

const bridge = new DiscordBridge({
  token: process.env.DISCORD_BOT_TOKEN!,
  // intents 默认是 GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT
  // 私有内容 intent (MESSAGE_CONTENT) 必须在 dev portal 启用
  onError: (err) => console.error('[discord]', err),
})

bridge.onMessage(async (msg) => {
  const cmd = parseImCommand(msg.text)
  switch (cmd.kind) {
    case 'help':
      await bridge.sendMessage(msg.from, '发 /bind <code> 来连接', {
        chatId: msg.chatId, // Discord channel id
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

## Setup at the Discord developer portal

1. 访问 [discord.com/developers/applications](https://discord.com/developers/applications),
   创建应用 → 在 **Bot** 标签页拿 **Bot Token**。
2. 同一页打开 **MESSAGE CONTENT INTENT**（这是 privileged，默认关）。
   若不开 token 还是能连上, 但所有消息的 `content` 都是空字符串。
3. **OAuth2 → URL Generator**：勾 `bot` scope + permissions
   `Read Messages/View Channels`, `Send Messages`, `Read Message History`。
   用生成的 URL 邀请 bot 进 guild。
4. 启动 host 把 token 喂进 `DiscordBridge`。

## 为什么 WebSocket gateway，不是 webhook？

Discord 给 bot 的唯一实时入口就是 gateway WebSocket：

- 收消息只能走 gateway (Interactions Webhook 仅服务 slash commands，
  不是普通文本)
- gateway 也送 reactions, typing, voice, presence 等事件 (bridge 只听
  `MESSAGE_CREATE`)
- 持久连接节省每条消息一次握手，长跑 bot 友好

Bridge 自带最小 gateway client：

- HELLO (op 10) → 启动 heartbeat 定时器
- 立即发 IDENTIFY (op 2) → 服务器返 READY
- DISPATCH (op 0, t=MESSAGE_CREATE) → 调 `discordToImMessage` → 派发监听者
- HEARTBEAT (op 1) ↔ HEARTBEAT_ACK (op 11)：上次没 ack 就视为 zombie 重连
- RECONNECT (op 7) → 关连接 + RESUME
- INVALID_SESSION (op 9, d=true) → 等 1-5s 重新 RESUME；d=false 清 session + IDENTIFY
- 断线 → 指数退避（默认 1s → 30s 上限）+ 自动 RESUME

致命 close code（**不**重连）：
- 4004 Authentication failed (token 错)
- 4010 Invalid shard
- 4011 Sharding required
- 4012 Invalid API version
- 4013 / 4014 Invalid / Disallowed intents（最常见错误：没开 MESSAGE_CONTENT）

## Surface

| Export                         | Purpose                                                       |
|--------------------------------|---------------------------------------------------------------|
| `DiscordBridge`                | `ImBridge` impl + gateway 编排                                |
| `createDiscordClient`          | Fetch 封装，加 `Bot <TOKEN>` Authorization + User-Agent       |
| `createDiscordGateway`         | 直接拿 gateway 用（不想用 bridge facade 时）                  |
| `DiscordApiError`              | 非 2xx HTTP 抛出 — 携带 `code`, `retryAfterMs` (429)          |
| `discordToImMessage`           | 纯映射: `DiscordMessage` → `ImMessage`                        |
| `discordExtractAttachments`    | 拉 image / audio / file 出来，根据 content_type 分桶          |
| `stripDiscordBotMentions`      | 剥 `<@BOT_ID>` 和 `<@!BOT_ID>` 历史 nick mention              |
| `DiscordOp` / `DiscordIntent`  | Gateway op code + intent 位掩码常量                           |
| `DEFAULT_DISCORD_INTENTS`      | GUILDS \| GUILD_MESSAGES \| DIRECT_MESSAGES \| MESSAGE_CONTENT |

## Node 版本兼容

bridge 调用的是 `globalThis.WebSocket`：

- Node **22+**：内置，零依赖跑得起。
- Node **20.x**：没有内置 WebSocket — 装 `ws` 或 `undici` 然后传入：
  ```ts
  import { WebSocket } from 'ws'
  new DiscordBridge({ token, webSocketImpl: WebSocket as unknown as WebSocketCtor })
  ```

REST 部分用 `globalThis.fetch`（Node 18+ 都有）。

## 附件如何工作

入向 image / audio / file 在 `MESSAGE_CREATE` 里就带了公开 CDN URL，
bridge **直接** pass-through 进 `ImAttachment.url`，不像 Lark / Telegram
需要 token-gated download：

```ts
{
  kind: 'image',          // 按 content_type 分桶；缺失时退到 width/height / duration_secs
  url: 'https://cdn.discordapp.com/attachments/.../pic.png',
  mime: 'image/png',
  filename: 'pic.png',
}
```

下游 LLM agent 可以直接喂 URL 给 Vision API（Anthropic vision +
OpenAI image_url 都接受 https URL）— 无需先 download bytes。

## 频道 vs DM

Discord 没有 "DM by user id" 捷径：

- 群消息：MESSAGE_CREATE 带 `guild_id`，`channel_id` 是频道 id
- DM：MESSAGE_CREATE **无** `guild_id`，`channel_id` 是 DM channel id

两种都通过 `ImMessage.chatId` 透传。回复时 `sendMessage` 必须
传 `options.chatId` — bridge 不替你猜。一般直接转 `ImMessage.chatId` 就行。

## 群里 @机器人 的处理

群消息里机器人会被 `<@BOT_USER_ID>` 提及（或 legacy `<@!BOT_USER_ID>`）。
`parseImCommand` 不接受这种前缀，所以 bridge 默认 `stripBotMentions: true`
帮你去掉。如果要保留原文，关掉这个选项。

## M5 不做的

- **Slash commands / interactions** (`INTERACTION_CREATE` op). 注册 +
  defer reply + follow-up 大约要再写 600 行；目前 bridge 走 mention
  free-text 路线，slash commands 留后续。
- **DM channel 自动创建** (`POST /users/@me/channels`). `sendMessage`
  要求调用方传 channel id。
- **出向附件 / embed / component**. `sendMessage` 带 attachments 会触发
  `onError` 但 text 仍发出，跟 Telegram M2 / Matrix M3 / Lark M4 一致。
- **Voice / video gateway**.
- **Sharding**. 单 shard 撑 2500 个 guild — AipeHub 用例够了。
- **Compression / zstd**. 原始 JSON 帧；省了 ~50% 带宽换的不是我们要的。
- **Identify rate limit 跟踪**. 单 bot 远在 1000/天 上限内；
  靠 `session_start_limit` header + 5s identify 退避。

## 测试

`tests/message.test.ts` 纯函数 (mapper + mention strip + attachment 分类)；
`tests/client.test.ts` REST (token header / 429 retry-after / error
unification / 204 处理)；`tests/bridge.test.ts` 用 `FakeWebSocket` +
`FakeDiscordClient` 走端到端：HELLO → IDENTIFY → READY → MESSAGE_CREATE
派发、anti-loop、系统消息过滤、致命 close code 不重连、sendMessage REST shape。

```bash
pnpm --filter @aipehub/im-discord test
```

## Status

- Phase 12 M5 — released（transport only；host integration pending）。
- Next milestones: M6 (Slack), M7 (QQ / OneBot v11)。

See `docs/zh/V4-PHASE7-13-PLAN.md` section 七 for the full roadmap.
