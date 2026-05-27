# `@aipehub/example-im-bridge-host`

Phase 12 M8 demo — wire an IM bridge end-to-end through a host-side
router into `Hub.dispatch`, with the binding-code flow against
`@aipehub/identity`.

Runs offline. No real Telegram / Slack / QQ account required.

## What it shows

1. A user types `/help` before binding — they get the canonical
   command list. `/help` works without auth.
2. They type plain text before binding — bridge nudges them to
   `/bind <code>`.
3. They DM `/bind 123456` with a code minted in the admin UI — the
   binding lands in `im_bindings`, future messages are auto-resolved
   to their AipeHub user.
4. They free-text "what can you do?" — router dispatches to the
   `chat` capability; an echo `AgentParticipant` replies; the reply
   is sent back to IM via `bridge.sendMessage`.
5. They `/agents` — see what they can talk to.
6. They `/workflow echo hello world` — runs a named workflow.
7. They `/unbind` — binding row is removed; subsequent free-text
   goes back to the "please bind first" nudge.

The whole flow runs against a `FakeBridge` (`src/fake-bridge.ts`),
which lets the script inject inbound messages and observe outbound
replies. Swapping in a real bridge (`new TelegramBridge({ token })`,
`new SlackBridge({...})`, …) is a one-line change — `router.ts`
doesn't care which `ImBridge` impl it talks to.

## Run

```bash
pnpm -r install
pnpm demo:im-bridge-host
```

Output is the full scripted lifecycle in pretty-print, ending with
the transcript size and outbound count.

## Reading order

| File | Purpose |
|------|---------|
| `src/index.ts` | Boots Hub + IdentityStore + FakeBridge + router and runs the scripted lifecycle. |
| `src/router.ts` | The reusable `ImCommand` → `Hub.dispatch` glue. **Copy this into your own host code; tweak the command vocabulary as needed.** |
| `src/identity-resolver.ts` | Adapter from `IdentityStore` (sync, throws) to `ImBindingResolver` (Promise, discriminated result). Same trick works for federated / remote resolvers. |
| `src/fake-bridge.ts` | In-memory `ImBridge` impl for the demo. Real-bridge unit tests should NOT import this — they have their own (richer) fake helpers tuned to each platform. |

## Going from demo → production

The router is intentionally a small standalone module. To take it to
production:

1. **Pick the real bridges you want.** Each `@aipehub/im-*` package
   has its own README with the platform-specific setup (bot tokens,
   webhook URLs, signing secrets, OneBot adapter, …). See also
   `docs/zh/IM-BRIDGES.md` for the cross-bridge cookbook.

2. **Copy `router.ts` + `identity-resolver.ts`** into your host
   package (e.g. `packages/host/src/im/`). Wire `resolveWorkflow` to
   your real workflow registry (`@aipehub/host`'s `workflow-loader`)
   and `listAgents` to whatever surface your host uses to enumerate
   reachable agents for a given user.

3. **Issue bindings from the admin UI.** Add a "Bind IM" button to
   `/settings` that calls `POST /api/me/im-binding-code` (you'll
   need to add this route — wraps `IdentityStore.issueImBindingCode`)
   and displays the 6-digit code.

4. **Wire each bridge.** Per bridge:

   ```ts
   const bridge = new XxxBridge({ /* platform config */ })
   bridge.onMessage((msg) => router.handle(bridge, msg))
   await bridge.start()
   ```

   `start()` ordering matters in a real host — start the bridge AFTER
   `await hub.start()` so the first inbound message doesn't race.

5. **Stop them in reverse on shutdown.** `await bridge.stop()` for
   each, then `await hub.stop()`. Bridges' `stop()` is idempotent
   per the `ImBridge` contract.

## Why this is an example and not a package

The router is ~250 lines of glue plus type imports. Carving it into
`@aipehub/im-router` would mostly re-export `@aipehub/im-adapter` and
add a workspace edge for no value — the canonical thing hosts want
to fork (the command vocabulary) is right there in source form.

If a second caller shows up (a community host, a federation hub), we
promote this into a published package. For now: copy-paste-friendly
example beats premature factor-out.
