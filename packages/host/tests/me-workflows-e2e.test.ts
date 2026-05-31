/**
 * End-to-end acceptance for the Phase 14 member-facing workbench.
 *
 * Everything else in Sprint 1 is unit-tested with a STUBBED workflow
 * surface (packages/web/tests/me-routes.test.ts). This test closes the
 * one seam those stubs can't: a REAL `WorkflowController` (the host's
 * actual `WorkflowSurface`) feeding `/api/me/workflows`. It boots a real
 * Hub + Space + IdentityStore + serveWeb wired exactly like production
 * (`serveWeb({ workflows: controller })`), imports a shipped
 * member-facing template, and drives the endpoints as a non-admin member.
 *
 * It is the durable proof of the Sprint 1 acceptance bar:
 *   - a non-admin member can list + run a member-facing workflow from /me
 *   - the scope key is forced to the caller's userId (no spoofing)
 *   - internal enforcement details (capability / userScopeField) never leak
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Hub, HumanParticipant, Space } from '@aipehub/core'
import { serveWeb, type WebServerHandle } from '@aipehub/web'
import { openIdentityStore, type IdentityStore } from '@aipehub/identity'

import { WorkflowController } from '../src/workflow-controller.js'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')
const TEMPLATE = join(repoRoot, 'templates', 'workflows', 'daily-reflection-flow.yaml')

interface Rig {
  root: string
  hub: Hub
  identity: IdentityStore
  web: WebServerHandle
  memberId: string
  cookie: string
}

async function boot(): Promise<Rig> {
  const root = await mkdtemp(join(tmpdir(), 'aipe-me-e2e-'))
  const { space, adminToken } = await Space.init(root, {
    name: 'me-e2e',
    adminDisplayName: 'Owner',
  })
  if (!adminToken) throw new Error('expected admin token from Space.init')
  const hub = new Hub({ space })
  await hub.start()

  // A benign target for the workflow's downstream step so the runner has
  // somewhere to dispatch `reflect-on-day` (a human participant just parks
  // the sub-task as pending — no error noise during the test).
  hub.register(new HumanParticipant({ id: 'reflect-stub', capabilities: ['reflect-on-day'] }))

  // The REAL host workflow surface, with a shipped member-facing template
  // imported (registers a WorkflowRunner on `daily-reflection`).
  const controller = new WorkflowController({
    hub,
    definitionsDir: join(root, 'workflows', 'definitions'),
    spaceRoot: root,
  })
  await controller.importFromText(await readFile(TEMPLATE, 'utf8'))

  // Identity: bootstrap the owner from the v3 admin token, then add a
  // plain member — the non-admin the /me surface is for.
  const identity = openIdentityStore({ dbPath: join(root, 'identity.sqlite') })
  identity.bootstrap({ adminToken, ownerEmail: 'owner@local', ownerDisplayName: 'Owner' })
  const member = identity.createUser({
    email: 'member@e2e.test',
    displayName: 'Member',
    password: 'member-strong-password',
    role: 'member',
  })

  const web = await serveWeb(hub, {
    host: '127.0.0.1',
    port: 0,
    identity,
    workflows: controller, // <-- the production wiring under test
  })

  const login = await fetch(`${web.url}/api/admin/identity/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'member@e2e.test', password: 'member-strong-password' }),
  })
  if (login.status !== 200) throw new Error(`member login failed: ${login.status}`)
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!

  return { root, hub, identity, web, memberId: member.id, cookie }
}

async function teardown(r: Rig): Promise<void> {
  await r.web.close()
  await r.hub.stop()
  r.identity.close()
  await rm(r.root, { recursive: true, force: true })
}

describe('Phase 14 — member-facing workbench, real WorkflowController', () => {
  let r: Rig
  beforeEach(async () => { r = await boot() })
  afterEach(async () => { await teardown(r) })

  it('GET /api/me/workflows derives the catalog from the live controller', async () => {
    const res = await fetch(`${r.web.url}/api/me/workflows`, { headers: { cookie: r.cookie } })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      workflows: Array<{ id: string; label: string; inputSchema: Array<{ id: string }> } & Record<string, unknown>>
    }
    const wf = body.workflows.find((w) => w.id === 'daily-reflection-flow')
    expect(wf).toBeTruthy()
    expect(wf!.label).toBe('每日反思')
    // surface.me.input_schema — the 4-section member form WITHOUT the scope key.
    expect(wf!.inputSchema.map((f) => f.id)).toEqual([
      'highlights', 'lowlights', 'tomorrow_focus',
    ])
    // Internal enforcement details must not leak to the member.
    expect(wf!.capability).toBeUndefined()
    expect(wf!.userScopeField).toBeUndefined()
  })

  it('POST /api/me/dispatch forces the scope key to the caller, ignoring spoofing', async () => {
    const res = await fetch(`${r.web.url}/api/me/dispatch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: r.cookie },
      body: JSON.stringify({
        workflowId: 'daily-reflection-flow',
        payload: { highlights: 'shipped Phase 14', case_id: 'someone-else' },
      }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; workflowId: string }
    expect(body.ok).toBe(true)
    expect(body.workflowId).toBe('daily-reflection-flow')

    // Across every recorded task (trigger + any sub-task the runner spawned),
    // case_id is the member's userId and the spoofed value never appears.
    const payloads = r.hub.tasks().map((t) => t.task.payload as Record<string, unknown>)
    expect(payloads.some((p) => p.case_id === r.memberId)).toBe(true)
    expect(payloads.every((p) => p.case_id !== 'someone-else')).toBe(true)
    // The declared field survives; nothing the member smuggled under the
    // scope key does.
    expect(payloads.some((p) => p.highlights === 'shipped Phase 14')).toBe(true)
  })

  it('refuses a workflow that is not member-facing (403)', async () => {
    // The runner is also registered on its trigger capability, but only the
    // surface.me declaration opens it to /me. An arbitrary id is refused.
    const res = await fetch(`${r.web.url}/api/me/dispatch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: r.cookie },
      body: JSON.stringify({ workflowId: 'no-such-workflow', payload: {} }),
    })
    expect(res.status).toBe(403)
  })
})
