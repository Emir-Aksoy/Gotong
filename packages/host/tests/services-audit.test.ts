/**
 * End-to-end coverage for the v1.1 admin-side observability additions:
 *
 *   1. HELLO.services flows into `Hub.pendingApplications()[].services`
 *      so the admin UI can render the requested ACL before approving.
 *
 *   2. Resolved SERVICE_CALL frames append a `service_call` transcript
 *      entry (succeeds or fails — either way it's auditable).
 *
 *   3. Failed calls (`forbidden_owner`, `forbidden_service`, etc.) carry
 *      the wire `ServiceErrorCode` through to the audit entry's `outcome`
 *      field — admins need that to spot ACL violations.
 *
 * Companion to `services-over-ws.test.ts`, which proves the happy path
 * over a real disk; this one focuses on the audit / admission surfaces.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Hub, Space, type Task } from '@aipehub/core'
import { AgentParticipant, connect, ServiceCallError, type Session, type ServiceClient } from '@aipehub/sdk-node'
import { serveWebSocket, type WebSocketTransportHandle } from '@aipehub/transport-ws'

import { bootstrapServices, type HubServices } from '../src/services/index.js'

class TouchingAgent extends AgentParticipant {
  services?: ServiceClient
  constructor() {
    super({ id: 'touch', capabilities: ['noop'] })
  }
  protected async handleTask(task: Task): Promise<unknown> {
    const action = (task.payload as { action: 'ok' | 'forbidden_owner' }).action
    if (action === 'ok') {
      const mem = this.services!.memoryFor('file', { kind: 'agent', id: 'touch' })
      await mem.remember({ kind: 'episodic', text: 'hello' })
      return { ok: true }
    }
    // Try a workflow-run owner the agent never declared — should land in
    // the audit log as `forbidden_owner`.
    const mem = this.services!.memoryFor('file', { kind: 'workflow-run', id: 'nope' })
    try {
      await mem.recall({ k: 1 })
      return { ok: false, expected: 'forbidden_owner' }
    } catch (err) {
      if (err instanceof ServiceCallError) return { ok: false, code: err.code }
      throw err
    }
  }
}

describe('audit: HELLO.services in PendingApplication + service_call transcript', () => {
  let tmpRoot: string
  let hub: Hub
  let services: HubServices
  let ws: WebSocketTransportHandle

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'aipehub-audit-'))
    const init = await Space.init(tmpRoot, { name: 'test' })
    hub = new Hub({ space: init.space })
    await hub.start()
    await writeFile(
      join(init.space.paths.services, 'plugins.json'),
      JSON.stringify({ plugins: ['@aipehub/service-memory-file'] }),
      'utf8',
    )
    const boot = await bootstrapServices({ space: init.space, hub })
    services = boot.services
    ws = await serveWebSocket(hub, { port: 0, services, gating: 'open' })
  })

  afterEach(async () => {
    await ws.close()
    await services.shutdownAll()
    await hub.stop()
    await rm(tmpRoot, { recursive: true, force: true })
  })

  it('appends service_call entries with outcome=ok for successful calls', async () => {
    const agent = new TouchingAgent()
    const session: Session = await connect({
      url: ws.url,
      agents: [agent],
      services: [{ type: 'memory', impl: 'file', owner: { kind: 'agent', id: 'self' } }],
      autoReconnect: false,
    })
    agent.services = session.services

    const r = await hub.dispatch({
      from: 'system',
      strategy: { kind: 'explicit', to: 'touch' },
      payload: { action: 'ok' },
      title: 'audit-ok',
    })
    expect(r.kind).toBe('ok')

    // Drain a beat so the audit append happens — the session writes it
    // after sending SERVICE_RESULT, which is after the handle method
    // resolved, which is what dispatch awaited. So by here it's already
    // in the transcript, but be paranoid against scheduling drift.
    await new Promise((res) => setTimeout(res, 25))

    const audit = hub.transcript.all().filter((e) => e.kind === 'service_call')
    expect(audit.length).toBeGreaterThanOrEqual(1)
    const entry = audit[0]! as Extract<(typeof audit)[number], { kind: 'service_call' }>
    expect(entry.data.from).toBe('touch')
    expect(entry.data.type).toBe('memory')
    expect(entry.data.impl).toBe('file')
    expect(entry.data.method).toBe('remember')
    expect(entry.data.outcome).toBe('ok')
    expect(entry.data.durationMs).toBeGreaterThanOrEqual(0)

    await session.close()
  })

  it('records error code in outcome when SERVICE_CALL fails ACL', async () => {
    const agent = new TouchingAgent()
    const session: Session = await connect({
      url: ws.url,
      agents: [agent],
      // Only declare `agent/self`. Asking for a workflow-run owner via
      // memoryFor must come back as forbidden_owner.
      services: [{ type: 'memory', impl: 'file', owner: { kind: 'agent', id: 'self' } }],
      autoReconnect: false,
    })
    agent.services = session.services

    const r = await hub.dispatch({
      from: 'system',
      strategy: { kind: 'explicit', to: 'touch' },
      payload: { action: 'forbidden_owner' },
      title: 'audit-forbidden',
    })
    expect(r.kind).toBe('ok')

    await new Promise((res) => setTimeout(res, 25))
    const audit = hub.transcript
      .all()
      .filter((e) => e.kind === 'service_call') as Array<
      Extract<ReturnType<typeof hub.transcript.all>[number], { kind: 'service_call' }>
    >
    const forbidden = audit.find((e) => e.data.outcome !== 'ok')
    expect(forbidden, 'expected at least one forbidden_owner audit entry').toBeTruthy()
    expect(forbidden!.data.outcome).toBe('forbidden_owner')
    expect(forbidden!.data.ownerKind).toBe('workflow-run')
    expect(forbidden!.data.ownerId).toBe('nope')

    await session.close()
  })

  it('PendingApplication.services mirrors HELLO.services under admin-approval gating', async () => {
    // Stand up a *separate* admin-gated transport on the same hub.
    const ws2 = await serveWebSocket(hub, {
      port: 0,
      services,
      gating: 'admin-approval',
    })
    try {
      const agent = new TouchingAgent()
      // Kick off connect in background — it will park in AWAIT_APPROVAL.
      const pending = connect({
        url: ws2.url,
        agents: [agent],
        services: [
          { type: 'memory', impl: 'file', owner: { kind: 'agent', id: 'self' } },
          { type: 'memory', impl: 'file', owner: { kind: 'workflow-run', id: '*' } },
        ],
        autoReconnect: false,
      })

      // Poll for the application to appear (admission is async).
      let app
      for (let i = 0; i < 30 && !app; i++) {
        await new Promise((r) => setTimeout(r, 20))
        app = hub.pendingApplications()[0]
      }
      expect(app, 'expected pending application').toBeTruthy()
      expect(app!.agents.map((a) => a.id)).toContain('touch')
      // services should be carried verbatim from HELLO.
      expect(app!.services?.length).toBe(2)
      const summary = app!.services!.map((s) => `${s.type}:${s.impl}/${s.owner.kind}=${s.owner.id}`)
      expect(summary).toEqual([
        'memory:file/agent=self',
        'memory:file/workflow-run=*',
      ])

      // Approve and let connect resolve.
      hub.approveApplication(app!.id, 'admin')
      const session = await pending
      await session.close()
    } finally {
      await ws2.close()
    }
  })
})
