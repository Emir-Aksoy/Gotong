# @aipehub/im-telegram

Phase 12 M2 — first concrete `ImBridge` for AipeHub.

A Telegram bot bridge implemented against
[`@aipehub/im-adapter`](../im-adapter)'s `ImBridge` interface.
Long-polling mode; no SDK dependency (just `fetch`); ~400 lines of
implementation.

## Why long-polling (not webhooks) for M2

- Works from a laptop with no inbound connectivity.
- No TLS / public URL required.
- Simpler shutdown: we own the loop and let the current
  `getUpdates` return.
- Telegram delivers each `update_id` at-least-once and we ACK by
  passing `offset = lastSeen + 1` — dedup is trivial.

Webhook mode is a future milestone; the `ImBridge` interface is the
same either way, so host wiring won't change.

## Quick start

```ts
import { TelegramBridge } from '@aipehub/im-telegram'
import { parseImCommand } from '@aipehub/im-adapter'

const bridge = new TelegramBridge({
  token: process.env.TELEGRAM_BOT_TOKEN!,
  onError: (err) => console.error('[telegram]', err),
})

bridge.onMessage(async (msg) => {
  const cmd = parseImCommand(msg.text)
  switch (cmd.kind) {
    case 'help':
      await bridge.sendMessage(msg.from, 'send /bind <code> to connect.', {
        chatId: msg.chatId,
      })
      break
    case 'bind':
      // hand off to your ImBindingResolver (host wiring)
      break
    case 'free':
      // dispatch via Hub
      break
    // …
  }
})

await bridge.start()
// later
await bridge.stop()
```

## Surface

| Export                          | Purpose                                            |
|---------------------------------|----------------------------------------------------|
| `TelegramBridge`                | `ImBridge` impl driving the long-poll loop         |
| `createTelegramClient`          | Thin fetch wrapper over `api.telegram.org/bot…`    |
| `TelegramApiError`              | Thrown on `ok: false` — carries `errorCode`, `retryAfter` |
| `telegramToImMessage`           | Pure mapper: `TelegramMessage` → `ImMessage`       |
| `telegramExtractAttachments`    | Pull photos / voice / audio / document into `ImAttachment[]` |
| `telegramFileUri` / `parseTelegramFileUri` | Encode/decode `telegram-file:<file_id>` URIs |

## How attachments work

Inbound photos / audio / files surface as `ImAttachment` rows with
`url: 'telegram-file:<file_id>'`. Bytes are NOT eager-downloaded —
most messages don't need them and the cost is real on Telegram's CDN.

Downstream code that needs the bytes:

```ts
const fileId = parseTelegramFileUri(attachment.url)
const { file_path } = await client.call('getFile', { file_id: fileId })
const url = `https://api.telegram.org/file/bot${TOKEN}/${file_path}`
const bytes = await (await fetch(url)).arrayBuffer()
```

## What's NOT in M2

- **Outbound attachments** (`sendPhoto`, `sendDocument`). `sendMessage`
  with `options.attachments` logs to `onError` and sends text only.
- **Webhooks**. Long-polling only.
- **Inline keyboards / callbacks** (`callback_query` updates filtered
  out by `allowed_updates: ['message']`).
- **Edits** (`edited_message` updates also filtered out).
- **The Hub-side router**. Bridges are pure transports. The router
  that parses `ImCommand` and dispatches into Hub is host wiring
  (will land alongside the host integration milestone).

## Testing

Inject a `TelegramClient` (or a `fetchImpl`) to keep tests off the
real Bot API. See `tests/bridge.test.ts` for the pattern.

## Status

- Phase 12 M2 — released (transport only; host integration pending).
- Next milestones: M3 (Matrix) and the host-side `ImCommand` router.

See `docs/zh/ledger/V4-PHASE7-13-PLAN.md` section 七 for the full roadmap.
