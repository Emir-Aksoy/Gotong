# activepieces-bridge

**Inbound automation → AipeHub.** Any platform that can send an HTTP POST —
[Activepieces](https://www.activepieces.com/), n8n, Make, Zapier, or a plain
`curl` in a cron job — triggers an AipeHub workflow through this bridge. It is
the automation-side twin of the IM bridges: *HTTP in, capability dispatch out,
transcript on the side.*

## Run the demo

```bash
pnpm --filter @aipehub/example-activepieces-bridge start
```

It boots a Hub + a `lead-intake` agent + the webhook bridge on an ephemeral
loopback port, then plays Activepieces with `fetch`: a valid POST dispatches and
returns the agent output (200), a wrong secret is rejected (401), an unknown
hook 404s. The script asserts each outcome, so it doubles as a smoke test.

## The bridge in one paragraph

`createWebhookBridge({ hub, secret, routes })` returns a Node `http` handler.
`POST /hooks/<name>` looks `<name>` up in `routes`; the request JSON body
becomes the task **payload**; the bridge dispatches to the route's
**capability**. That's it.

```ts
const bridge = createWebhookBridge({
  hub,
  secret: process.env.WEBHOOK_SECRET!,
  routes: {
    'new-lead': {
      capabilities: ['crm:new-lead'],
      toPayload: (body) => ({ name: body.name, company: body.company }),
    },
  },
})
await bridge.listen(8088)          // or mount bridge.handle on your own server
```

## Two trust rules (why it's safe to expose)

1. **Shared secret, fail-closed.** Every request must carry the operator's
   secret in `X-Aipe-Webhook-Secret`, compared in constant time. A blank secret
   throws at construction — there is no anonymous mode.
2. **Capability-only, operator-allow-listed.** A request can only reach the
   capabilities you wired into `routes`; it can **never** name an explicit
   agent. The body is the payload, nothing more. An external automation picks
   *what to do*; you decide *who may do it*. (Same rule the A2A server enforces.)

A human-in-the-loop step (see the P5 industry templates) parks the task and the
bridge replies `202 Accepted` — the automation should not treat that as a final
result.

## Wiring a real Activepieces flow

1. In your flow, add an **HTTP Request** action.
2. Method `POST`, URL `https://<your-host>/hooks/new-lead`.
3. Header `X-Aipe-Webhook-Secret: <the secret you configured>`.
4. Body: the JSON you want as the task payload (e.g. the trigger's lead fields).

The same recipe works for n8n's *HTTP Request* node, Make's *HTTP* module, or
Zapier's *Webhooks by Zapier* — anything that can POST JSON with a header.

> Run the bridge behind TLS (a reverse proxy or the host's own HTTPS). The
> shared secret is only as private as the transport carrying it.
