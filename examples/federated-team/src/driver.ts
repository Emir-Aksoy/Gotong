/**
 * Driver — a tiny CLI that drives the upstream Hub for the demo:
 *
 *   1. Wait for the team-bridge agent to show up as a pending application
 *   2. Approve the application (admin API)
 *   3. Dispatch a few tasks at capability ["draft"]; the bridge is the
 *      only agent claiming it, so the upstream scheduler routes there
 *   4. Poll `/api/state` until each task has a `result`; print it
 *
 * This automates the steps a human admin would otherwise click through
 * in the upstream admin UI, so you can verify the round-trip without
 * opening a browser.
 *
 * Usage:
 *   AIPE_ADMIN_TOKEN=<token from upstream> tsx src/driver.ts
 */

import { setTimeout as sleep } from 'node:timers/promises'

const UPSTREAM_HTTP = process.env.AIPE_UPSTREAM_HTTP ?? 'http://127.0.0.1:3200'
const TOKEN = process.env.AIPE_ADMIN_TOKEN
const BRIDGE_ID = process.env.AIPE_BRIDGE_ID ?? 'alice-team'

if (!TOKEN) {
  console.error('Set AIPE_ADMIN_TOKEN to the upstream admin token first.')
  process.exit(1)
}

interface PendingApp {
  id: string
  agents: { id: string; capabilities: string[] }[]
}
interface StateSnap {
  participants: { id: string; kind: string; capabilities: string[] }[]
  pendingApplications: PendingApp[]
  tasks: {
    id: string
    status: 'pending' | 'done' | 'failed' | 'cancelled'
    task: { title?: string }
    result?: { kind: string; output?: unknown; error?: string; reason?: string; by?: string }
  }[]
}

async function api<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(`${UPSTREAM_HTTP}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
  const text = await r.text()
  if (!r.ok) throw new Error(`${r.status} ${path}: ${text}`)
  return (text ? JSON.parse(text) : null) as T
}

async function snap(): Promise<StateSnap> {
  return api<StateSnap>('/api/state')
}

async function approveBridge(): Promise<void> {
  for (let i = 0; i < 60; i++) {
    const s = await snap()
    if (s.participants.some((p) => p.id === BRIDGE_ID)) {
      console.log(`Bridge '${BRIDGE_ID}' already online.`)
      return
    }
    const appForBridge = s.pendingApplications.find((a) =>
      a.agents.some((g) => g.id === BRIDGE_ID),
    )
    if (appForBridge) {
      console.log(`Approving application ${appForBridge.id} (carries agent '${BRIDGE_ID}')…`)
      await api(`/api/admin/applications/${appForBridge.id}/approve`, { method: 'POST' })
      // wait until participant is registered
      for (let j = 0; j < 30; j++) {
        const s2 = await snap()
        if (s2.participants.some((p) => p.id === BRIDGE_ID)) return
        await sleep(300)
      }
      throw new Error('approval did not register the participant')
    }
    await sleep(500)
  }
  throw new Error(`bridge '${BRIDGE_ID}' never appeared; is team-host running?`)
}

async function dispatchAndWait(title: string, payload: unknown): Promise<void> {
  const before = (await snap()).tasks.length
  await api('/api/admin/dispatch', {
    method: 'POST',
    body: JSON.stringify({
      strategy: { kind: 'capability', capabilities: ['draft'] },
      payload,
      title,
    }),
  })
  // wait for one new task to materialise + complete
  for (let i = 0; i < 60; i++) {
    const s = await snap()
    if (s.tasks.length > before) {
      const t = s.tasks.find((x) => x.task.title === title)
      if (t && t.status !== 'pending') {
        const r = t.result
        console.log(`  ${t.status.toUpperCase()} — ${
          r?.kind === 'ok' ? JSON.stringify(r.output) :
          r?.kind === 'failed' ? `error: ${r.error}` :
          JSON.stringify(r ?? {})
        }`)
        return
      }
    }
    await sleep(400)
  }
  console.log(`  TIMEOUT (still pending after 24s)`)
}

async function main(): Promise<void> {
  console.log(`Driver — upstream ${UPSTREAM_HTTP}, bridge '${BRIDGE_ID}'`)
  await approveBridge()
  console.log(`\nDispatching tasks at capability=['draft']…\n`)
  for (const topic of ['typescript', 'a federated agent', 'minimal hubs']) {
    console.log(`→ "${topic}"`)
    await dispatchAndWait(`draft about ${topic}`, { topic })
  }
  console.log(`\nDone. Both Hubs' transcripts now show the full round-trip.`)
}

main().catch((err) => {
  console.error('[driver] fatal:', err instanceof Error ? err.message : err)
  process.exit(1)
})
