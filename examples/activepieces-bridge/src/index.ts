/**
 * Phase 19 P5-M3 — Activepieces (automation) -> Gotong webhook bridge demo.
 *
 * An automation platform fires an HTTP webhook when something happens (a new
 * CRM lead lands, a form is submitted, a cron tick); this bridge turns that
 * POST into a `Hub.dispatch` so an Gotong agent/workflow handles it.
 *
 * The demo is self-contained and self-asserting — it runs the bridge over
 * loopback and plays the part of Activepieces with `fetch`, so it doubles as a
 * smoke test (`pnpm --filter @gotong/example-activepieces-bridge start`
 * exits 0 on success, throws otherwise). No network, no Activepieces account.
 *
 * To wire a REAL Activepieces flow: add an "HTTP Request" action (method POST,
 * URL `https://<your-host>/hooks/new-lead`, header `X-Gotong-Webhook-Secret:
 * <secret>`, body = the lead JSON). See README.md.
 */

import { AgentParticipant, Hub, type Task } from '@gotong/core'
import type { Server } from 'node:http'
import { strict as assert } from 'node:assert'

import { createWebhookBridge } from './webhook-bridge.js'

/** Pretends to be the agent that processes a new CRM lead. */
class LeadIntakeAgent extends AgentParticipant {
  constructor() {
    super({ id: 'lead-intake', capabilities: ['crm:new-lead'] })
  }
  protected async handleTask(task: Task): Promise<unknown> {
    const p = (task.payload ?? {}) as { name?: string; company?: string }
    return {
      text: `Lead logged: ${p.name ?? '(unknown)'} @ ${p.company ?? '(no company)'}`,
      qualified: Boolean(p.company),
    }
  }
}

const SECRET = 'demo-shared-secret'

async function post(url: string, body: unknown, secret?: string): Promise<{ status: number; json: any }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(secret ? { 'x-gotong-webhook-secret': secret } : {}),
    },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: await res.json() }
}

async function main(): Promise<void> {
  console.log('\n=== Gotong demo: activepieces-bridge (Phase 19 P5-M3) ===\n')

  const hub = Hub.inMemory()
  await hub.start()
  hub.register(new LeadIntakeAgent())
  console.log('  hub        started, registered agent: lead-intake (cap crm:new-lead)')

  const bridge = createWebhookBridge({
    hub,
    secret: SECRET,
    routes: {
      'new-lead': {
        capabilities: ['crm:new-lead'],
        title: 'CRM lead from Activepieces',
        // Activepieces sends its own envelope; pull just the fields we want.
        toPayload: (body) => {
          const b = (body ?? {}) as Record<string, unknown>
          return { name: b.name, company: b.company, email: b.email }
        },
      },
    },
  })
  const server: Server = await bridge.listen(0)
  const port = (server.address() as { port: number }).port
  const base = `http://127.0.0.1:${port}`
  console.log(`  bridge     listening on ${base}/hooks/<name>\n`)

  // -- 1. happy path: Activepieces posts a new lead --------------------------
  console.log('  [1] Activepieces POST /hooks/new-lead (valid secret)')
  const ok = await post(`${base}/hooks/new-lead`, { name: 'Mei', company: 'Kopitiam Co', email: 'mei@example.com' }, SECRET)
  console.log('      ->', ok.status, JSON.stringify(ok.json))
  assert.equal(ok.status, 200)
  assert.equal(ok.json.ok, true)
  assert.equal(ok.json.output.qualified, true)
  assert.match(ok.json.output.text, /Mei @ Kopitiam Co/)

  // -- 2. wrong secret is rejected fail-closed -------------------------------
  console.log('  [2] POST with WRONG secret')
  const bad = await post(`${base}/hooks/new-lead`, { name: 'x' }, 'not-the-secret')
  console.log('      ->', bad.status, JSON.stringify(bad.json))
  assert.equal(bad.status, 401)

  // -- 3. unknown hook 404s (no enumeration of what exists) ------------------
  console.log('  [3] POST /hooks/does-not-exist (valid secret)')
  const missing = await post(`${base}/hooks/does-not-exist`, {}, SECRET)
  console.log('      ->', missing.status, JSON.stringify(missing.json))
  assert.equal(missing.status, 404)

  console.log('\n  transcript:', hub.transcript.size(), 'entries')
  console.log('  ✓ all assertions passed\n')

  await new Promise<void>((resolve) => server.close(() => resolve()))
  await hub.stop()
  process.exit(0)
}

main().catch((err) => {
  console.error('[activepieces-bridge] FAILED:', err)
  process.exit(1)
})
