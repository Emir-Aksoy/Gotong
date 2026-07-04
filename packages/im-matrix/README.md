# @gotong/im-matrix

Phase 12 M3 — second concrete `ImBridge` for Gotong.

A Matrix bot bridge implemented against
[`@gotong/im-adapter`](../im-adapter)'s `ImBridge` interface.
Sync long-poll mode; no `matrix-bot-sdk` dependency (just `fetch`);
~450 lines of implementation.

## Why Matrix matters specifically

Telegram, Slack, Discord, Lark are each a single corporate API.
**Matrix is the only protocol-level federated IM on the IM bridge
roadmap** — and that's the point.

Gotong already federates between hubs via peer tokens. Matrix
federates between homeservers natively. The two graphs compose:

```
   Gotong hub A ─── peer token ─── Gotong hub B
        │                                  │
   Matrix bot                          Matrix bot
        │                                  │
   matrix.org ── server-to-server ── kde.org
        │                                  │
   @alice:matrix.org                  @bob:kde.org
```

Neither side needs the other to centralise: an `@alice@matrix.org`
user can reach the bot on `kde.org` via Matrix federation, even
though her homeserver has no Gotong knowledge — and the bot can
forward her message to a peer Gotong hub via the Gotong
federation token, even though that hub has no Matrix knowledge.

Two distinct federation graphs, composed cleanly. That's the
philosophy match the rest of the Phase 12 bridges can't deliver.

## Why sync long-poll (not appservice / webhook)

- Works against any homeserver where the bot has a regular account
  (no admin / appservice config needed).
- No public endpoint required — TLS / inbound connectivity is the
  homeserver's problem, not the bridge's.
- Simpler shutdown: we own the loop and let the current `/sync`
  return.
- `next_batch` ACKs server-side and dedup is trivial (plus a bounded
  in-memory ring for paranoia).

Appservice mode is a future milestone for high-scale deployments;
the `ImBridge` interface is the same either way, so host wiring
won't change.

## Quick start

```ts
import { MatrixBridge } from '@gotong/im-matrix'
import { parseImCommand } from '@gotong/im-adapter'

const bridge = new MatrixBridge({
  homeserverUrl: process.env.MATRIX_HOMESERVER_URL!,  // e.g. 'https://matrix.org'
  accessToken: process.env.MATRIX_ACCESS_TOKEN!,
  onError: (err) => console.error('[matrix]', err),
  autoJoin: true, // accept invites automatically
})

bridge.onMessage(async (msg) => {
  const cmd = parseImCommand(msg.text)
  switch (cmd.kind) {
    case 'help':
      await bridge.sendMessage(msg.from, 'send /bind <code> to connect.', {
        chatId: msg.chatId, // REQUIRED on Matrix — no DM shortcut
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

## Getting an access token

The bridge expects a long-lived access token from a regular user
account (typically named `@gotong_bot:yourserver.org`). One-shot
acquisition:

```bash
curl -X POST -d '{"type":"m.login.password","user":"gotong_bot","password":"…"}' \
  https://your-homeserver.example/_matrix/client/v3/login
```

The `access_token` in the response is what you pass to
`MatrixBridge`. Some homeservers also expose admin tooling to mint
tokens without going through password login — check your homeserver
documentation.

## Surface

| Export                       | Purpose                                                       |
|------------------------------|---------------------------------------------------------------|
| `MatrixBridge`               | `ImBridge` impl driving the sync loop                         |
| `createMatrixClient`         | Thin fetch wrapper over `<homeserver>/_matrix/client/v3/...` |
| `MatrixApiError`             | Thrown on non-2xx — carries `status`, `errcode`, `retryAfterMs` |
| `matrixToImMessage`          | Pure mapper: `MatrixRoomEvent` → `ImMessage`                  |
| `matrixExtractAttachments`   | Pull `m.image / m.audio / m.video / m.file` → `ImAttachment[]` |
| `parseMxcUri` / `MXC_URI_PREFIX` | Helpers for resolving `mxc://server/id` URIs               |

## How attachments work

Inbound media surfaces as `ImAttachment` rows with `url: 'mxc://server/id'`
— the canonical Matrix content URI. Bytes are NOT eager-downloaded —
most messages don't need them and the cost compounds in larger rooms.

Downstream code that needs the bytes:

```ts
import { parseMxcUri } from '@gotong/im-matrix'

const { serverName, mediaId } = parseMxcUri(attachment.url)!
// Matrix v1.11+: authenticated media download
const url = `${homeserverUrl}/_matrix/client/v1/media/download/${serverName}/${mediaId}`
const res = await fetch(url, {
  headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
})
const bytes = await res.arrayBuffer()
```

Older homeservers may still need the unauthenticated v3 path
(`/_matrix/media/v3/download/...`) — check your homeserver version.

## DM semantics — there are no DMs

In Matrix, every conversation is a room. There's no "DM the user by
id" shortcut like Telegram's `chat_id = user_id` trick. Replies
**MUST** thread the `ImMessage.chatId` through:

```ts
bridge.onMessage(async (msg) => {
  // good
  await bridge.sendMessage(msg.from, 'reply', { chatId: msg.chatId })

  // bad — throws synchronously
  await bridge.sendMessage(msg.from, 'reply') // no chatId
})
```

A future milestone may add `POST /createRoom` to spin up a DM room
when a freshly-bound user has no prior conversation. For M3 the
bridge refuses rather than guess.

## What's NOT in M3

- **End-to-end encryption** (`m.room.encrypted` events). Requires
  libolm + persistent crypto state, would dwarf the bridge's
  footprint. Rooms the bot participates in must be unencrypted;
  encrypted events skip through the mapper silently.
- **Outbound attachments** (`sendMessage` with `options.attachments`).
  Logs to `onError` and sends text only — mirrors the Telegram M2
  decision.
- **DM auto-creation**. Sending requires an explicit `chatId` (room
  id). See the "DM semantics" section above.
- **Display name resolution**. `ImUser.displayName` is always `null`
  for Matrix; sender mxids are themselves human-readable. Consumers
  that want pretty names can fetch via `/profile/{userId}/displayname`
  on demand.
- **Token refresh / SSO**. The bridge expects a long-lived access
  token from config.
- **Appservice mode**. Sync long-poll only.
- **The Hub-side router**. Bridges are pure transports. The router
  that parses `ImCommand` and dispatches into Hub is host wiring
  (will land alongside the host integration milestone).

## Testing

Inject a `MatrixClient` (or a `fetchImpl`) to keep tests off any
real homeserver. See `tests/bridge.test.ts` for the pattern — the
`FakeMatrixClient` blocks empty `/sync` calls on an internal idle
queue, mimicking the homeserver's long-poll behaviour so tests
don't tight-spin.

## Status

- Phase 12 M3 — released (transport only; host integration pending).
- Next milestones: M4 (飞书 Lark), M5 (Discord), M6 (Slack).

See `docs/zh/ledger/V4-PHASE7-13-PLAN.md` section 七 for the full roadmap.
