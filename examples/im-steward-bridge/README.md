# `@gotong/example-im-steward-bridge`

v5 Stream SW **Phase D** demo — reach the hub steward (管家) from an IM
client (Telegram, Slack, …). The same steward you talk to in the admin
console and the `/me` SPA, now over chat: say what you want in plain
language, the steward proposes a tiered set of actions, you `/apply`
one, and dangerous / cross-hub actions park to your `/me` inbox for a
second confirmation — with the outcome pushed back to you over IM.

Runs offline. No real Telegram / Slack / QQ account required.

## Why this is its own bridge (and not the generic `im-bridge-host`)

`examples/im-bridge-host/` routes IM messages into `Hub.dispatch` — IM
as a transport for *talking to agents*. This bridge is different: it
routes into the steward's **`plan` / `apply` seam** (mirroring the
host's `MeHubStewardSurface`), so IM becomes a transport for
*managing your hub*. Two consequences:

1. **No `@gotong/core` Hub needed.** The steward is reached the same
   way from the admin console, the `/me` SPA, and here — one steward,
   three transports. This bridge depends only on `@gotong/identity`
   (the binding flow), `@gotong/im-adapter` (the bridge + router
   contract), and `@gotong/hub-steward` (the **real** classifier, so
   the tier badges are honest).

2. **It forks the router.** `parseImCommand` only knows `/help`
   `/bind` `/unbind` `/agents` `/workflow` — `/steward` and `/apply`
   are unknown verbs to it. `StewardImRouter` pre-parses those two
   first, then reuses `parseImCommand` for the shared binding verbs, so
   the bind UX is identical to every other bridge.

## What it shows

The demo (`src/index.ts`) binds a member and walks the full lifecycle a
member would experience over Telegram:

1. **`/help` before binding** — anyone can read the command list.
2. **Free text before binding** — nudged to `/bind <code>`.
3. **`/bind <code>`** — links the IM identity to an Gotong user (the
   code is minted with `IdentityStore.issueImBindingCode`, exactly like
   `im-bridge-host`).
4. **"帮我建一个客服助手"** — the steward proposes a **SAFE**
   `create_agent`; `/apply 1` runs it inline.
5. **"删掉 mailer 助手"** — a **DANGEROUS** `delete_agent`; `/apply 1`
   **parks** it to the `/me` inbox (NOT run). Resolving it **approved**
   executes the delete and pushes a notify-back over IM.
6. **"改一下跨 hub 的评审工作流"** — a **CROSS-HUB** `edit_workflow`;
   `/apply 1` parks; resolving **rejected** does NOT execute (fail-closed)
   and pushes a notify-back.
7. **"帮我配置 openai 凭证"** — an operator-only sensitive ask; the
   member steward **refuses** (explains + points to the settings panel,
   reminding that keys travel via environment variables, never chat).
8. **`/unbind`** — binding removed; free text goes back to the nudge.

The two hard constraints the whole Stream SW is built around show up
end-to-end here: **dangerous and cross-hub actions require a second
confirmation in the human's inbox**, and **no plaintext secret ever
touches the chat transcript** (the demo asserts both).

## What is real vs. faked

| Part | Real or faked? |
|------|----------------|
| Risk **tier** of each action | **Real** — `classifyStewardAction` from `@gotong/hub-steward`. A `delete_agent` honestly tiers `dangerous`; `edit_workflow` on a cross-hub workflow honestly tiers `cross_hub`; a sensitive ask tiers `forbidden` for a member. |
| `apply` **re-classifies** server-side | **Real discipline** — `apply` never trusts the tier `plan` returned. A forged tier can't make a dangerous action run inline. |
| Binding flow | **Real** — `@gotong/identity` `im_bindings`. |
| The "LLM" turning an instruction into actions | **Faked** — `proposeActions` is a deterministic keyword router (the only faked part, exactly like every other example that stands in a provider). The host's real steward is an `LlmAgent`. |
| Inbox + notify-back | **Stand-in** — `FakeStewardPort` keeps an in-memory inbox so the park → resolve → notify-back loop is demonstrable. Production points this at `HostInboxService` + the multi-channel inbox/alert delivery (F day-3 `im` channel, MC-M1..M7). |

## Run

```bash
pnpm -r install
pnpm demo:im-steward-bridge
```

Output is the full scripted lifecycle in pretty-print, ending with 11
green assertions.

## Reading order

| File | Purpose |
|------|---------|
| `src/index.ts` | Boots IdentityStore + FakeStewardPort + FakeBridge + router and runs the scripted, self-asserting lifecycle. |
| `src/steward-router.ts` | The fork of `im-bridge-host`'s router. **Copy this into your host code; it's the steward command vocabulary in source form.** Routes to a `StewardPort`, not `hub.dispatch`. |
| `src/steward-port.ts` | The `plan` / `apply` seam (mirrors `MeHubStewardSurface`) + the `FakeStewardPort` stand-in. The **real** classifier lives here; the faked "LLM" (`proposeActions`) is the only stand-in. |
| `src/identity-resolver.ts` | Adapter from `IdentityStore` (sync, throws) to `ImBindingResolver` (Promise, discriminated result). Copied verbatim from `im-bridge-host`. |
| `src/fake-bridge.ts` | In-memory `ImBridge` impl for the demo. Copied verbatim from `im-bridge-host`. |

## Going from demo → production

1. **Point the `StewardPort` at the host's real steward surface.**
   Instead of `FakeStewardPort`, implement `StewardPort.plan` / `.apply`
   by calling the host's `MeHubStewardSurface` (the same one the `/me`
   SPA's `POST /api/me/steward/{plan,apply}` routes call). For an
   **operator** steward over IM, point it at the admin surface
   (`POST /api/admin/steward/{plan,apply}`, A-M6) — but gate IM access
   to operators carefully, since that steward manages **site-wide**
   resources.

2. **Pick the real bridge.** Swap `FakeBridge` for
   `new TelegramBridge({ token })` (or any `@gotong/im-*`); the router
   doesn't care which `ImBridge` impl it talks to. See
   `docs/zh/IM-BRIDGES.md`.

3. **Wire the notify-back to the real inbox.** `StewardPort.onInboxResolve`
   models the async "your parked action was resolved" event. In
   production this is the multi-channel inbox/alert delivery (F day-3
   `im` channel) — register the IM identity as a delivery target so a
   `/me` resolve fans out a message back to chat. Persist the
   userId → IM-identity mapping (the example keeps it in memory).

4. **Issue bindings from the `/me` UI.** Same flow as `im-bridge-host`:
   a "Bind IM" button that calls `IdentityStore.issueImBindingCode` and
   shows the 6-digit code.

## North-star fit

The steward only ever **proposes**; the human **applies**. Dangerous
and cross-hub actions don't run on `/apply` — they park to the approval
inbox and the user confirms in `/me`. This bridge carries that honestly
to IM: `/apply` on a parked action replies "sent to your inbox, I'll
tell you once you confirm," and the notify-back closes the loop. Chat
input is untrusted **data**, never authority — the binding (not the
chat text) decides who you are, and `apply` re-classifies server-side
so a forged tier can't escalate.
