# @gotong/im-qq

`ImBridge` for QQ over the **official** QQ Bot API
([bot.q.qq.com](https://bot.q.qq.com)) — HTTP webhook transport +
Ed25519 callback validation. No SDK dep (`fetch` + Node built-in
`node:crypto`).

> Replaces the former third-party **OneBot v11** implementation. That
> bridge drove a *personal* QQ account through reverse-engineered
> adapters (NapCat / go-cqhttp) and carried account-suspension risk.
> This one talks the sanctioned first-party bot API: an AppID /
> ClientSecret bot registered on the QQ open platform.

## Two things to know before you deploy

1. **It needs a public domain + TLS (it is NOT 免穿透).** The official
   platform discontinued its WebSocket gateway (end-2024) and now pushes
   events to an HTTP **webhook**. So unlike Telegram / Lark / Slack —
   which connect *outbound* and work behind NAT — QQ ingress requires a
   publicly reachable HTTPS URL. Run it on a cloud host behind a reverse
   proxy (nginx / Caddy) that terminates TLS and forwards to the bridge's
   plain-HTTP listener.

2. **Group / C2C are passive-reply only.** You can only reply to a user's
   message within the reply window, carrying that message's `msg_id`.
   **Proactive push to a group / user was discontinued (2025-04).** The
   bridge answers commands and conversation fine, but
   `sendMessage` to a chat it has never received a message from throws an
   honest error — an alert / heartbeat agent therefore cannot push
   unsolicited messages to QQ.

## What you get

```ts
import { QqBridge } from '@gotong/im-qq'
import { parseImCommand } from '@gotong/im-adapter'

const bridge = new QqBridge({
  appId: process.env.GOTONG_QQ_BOT_APPID!,    // 机器人 AppID
  secret: process.env.GOTONG_QQ_BOT_SECRET!,  // ClientSecret/AppSecret
  webhookPort: 9092,                        // 反代转发到这个端口
  webhookPath: '/qq/webhook',
  onError: (err) => console.error('[qq]', err),
})

bridge.onMessage(async (msg) => {
  const cmd = parseImCommand(msg.text)
  switch (cmd.kind) {
    case 'help':
      // chatId is one of: group:<id> / c2c:<id> / channel:<id> / dm:<id>
      await bridge.sendMessage(msg.from, '发 /bind <code> 来连接', {
        chatId: msg.chatId,
      })
      break
    // bind / unbind / free → hand off to ImBindingResolver / Hub
  }
})

await bridge.start() // binds the webhook HTTP listener
// later
await bridge.stop()
```

## Set up the bot on the QQ open platform

1. Register a bot at <https://q.qq.com> → get its **AppID** and
   **AppSecret** (ClientSecret). The legacy *Token* value is **not** used
   on the webhook + v2 path, so the bridge doesn't take it.
2. Configure the bot's **回调地址 (callback URL)** to your public HTTPS
   endpoint, e.g. `https://bot.example.com/qq/webhook`.
3. On save, QQ sends a one-off **callback validation** (op:13). The
   bridge signs `event_ts + plain_token` with the Ed25519 key derived
   from your AppSecret and echoes `{ plain_token, signature }` — the URL
   verifies automatically. No manual step.

### Reverse proxy (TLS termination)

```nginx
# nginx — terminate TLS, forward to the bridge's plain-HTTP listener
location /qq/webhook {
    proxy_pass http://127.0.0.1:9092/qq/webhook;
    proxy_set_header X-Signature-Ed25519   $http_x_signature_ed25519;
    proxy_set_header X-Signature-Timestamp $http_x_signature_timestamp;
}
```

The two `X-Signature-*` headers MUST reach the bridge unmodified — the
op:0 event signature is verified over `timestamp + rawBody`.

## How verification works

QQ derives one Ed25519 keypair from your AppSecret; the bridge derives
the same pair (`qq-crypto.ts`, Node built-in crypto, zero new dep):

| Direction | Op | What the bridge does |
|---|---|---|
| Callback validation | `op:13` (unsigned) | **Sign** `event_ts + plain_token` with the private key → return `{ plain_token, signature }`. Proves the bot holds the secret. |
| Inbound event | `op:0` (signed) | **Verify** `X-Signature-Ed25519` over `timestamp + rawBody` with the public key → 401 on mismatch, then dispatch. |

op:13 is discriminated *before* verification because it's the bootstrap
that has no signature yet.

## Event types → chatId

The bridge maps four message events to four tagged chatId namespaces (QQ
ids are opaque openid strings, not numbers — the tag keeps surfaces from
colliding):

| Event `t` | Surface | `chatId` |
|---|---|---|
| `GROUP_AT_MESSAGE_CREATE` | group @bot | `group:<group_openid>` |
| `C2C_MESSAGE_CREATE` | friend chat | `c2c:<user_openid>` |
| `AT_MESSAGE_CREATE` | guild channel @bot | `channel:<channel_id>` |
| `DIRECT_MESSAGE_CREATE` | guild DM | `dm:<guild_id>` |

`platformUserId` prefers `union_openid` — stable across group + C2C — so
an IM binding made in a DM also resolves when the same person @s the bot
in a group.

`sendMessage(to, text, { chatId })` parses the tag back and routes to the
matching REST endpoint as a **passive reply** (it looks up the `msg_id`
of the last inbound message for that chat and increments `msg_seq`).

## Surface

| Export | Purpose |
|---|---|
| `QqBridge` | `ImBridge` impl — webhook HTTP server + handshake + passive-reply send |
| `QqHandleResult` | Return shape of `handleRawRequest` (status + body) |
| `createQqClient` / `QqClient` | App-access-token cache + four REST send endpoints |
| `QqApiError` | Non-2xx / non-zero `code` — carries `status`, `code`, `detail` |
| `qqToImMessage` | Pure mapper: op:0 dispatch payload → `ImMessage` |
| `parseQqChatId` / `pickQqUserId` | chatId tag decode / author identity pick |
| `stripQqGuildMention` | Strip `<@!id>` from guild text |
| `deriveQqKeyPair` / `signQqCallback` / `verifyQqEventSignature` | Ed25519 primitives |

## Deferred (this milestone)

- **Rich media** (image / audio / file). Text only; outbound media via
  the official rich-media API is a follow-up. `sendMessage` with
  attachments surfaces via `onError` and still sends the text.
- **Guild proactive sends.** Guild channels historically allowed some
  proactive sends, but MVP treats every surface as passive-reply for one
  honest model.

## Tests

`tests/qq-crypto.test.ts` — Ed25519 derive / sign / verify (known pair;
tamper → reject). `tests/message.test.ts` — mapper for the four event
types + chatId encode/decode + mention strip. `tests/client.test.ts` —
token cache (coalesced refresh, expiry) + REST send shapes (injected
fetch). `tests/bridge.test.ts` — op:13 handshake produces a valid
signature, op:0 tamper → 401, event dispatch + dedup, and the
proactive-push honest-fail.

```bash
pnpm --filter @gotong/im-qq test
```

All hermetic — no real AppID / secret, no network. Live integration is
an opt-in manual step (see `docs/zh/IM-OFFICIAL-REARCH.md`).
