/**
 * End-to-end acceptance for the family-learning-hub CHILD-side `/me` self-dispatch
 * (family-learning prod C-M3).
 *
 * `packages/web/tests/child-desk-template.test.ts` pins the STATIC structure of the
 * shipped child template (surface.me enabled, scope key `learner_id`, no human step,
 * zero LLM agents, …). This test closes the one seam that 防腐 test can't reach: the
 * RUNTIME `/me` self-dispatch contract against a REAL `WorkflowController`.
 *
 * The design (FAMILY-LEARNING-HUB-DESIGN.md §九) makes the 孩子's first-class entry the
 * `/me` PWA: the child self-serves a lesson, and `/me` FORCES `payload.learner_id` to the
 * member's own userId (孩子 only learns for themselves — no spoofing another learner). The
 * child-desk template ships both lesson workflows `surface.me` enabled; C-M3's acceptance
 * bar is "核实孩子 member 经 /me 自助 dispatch learn.request" — proven here against the
 * production wiring (`serveWeb({ workflows: controller })`), not a stub.
 *
 * It boots a real Hub + Space + IdentityStore + serveWeb, imports the SHIPPED child
 * template through the REAL admin `templates/import` route (exactly how a family operator
 * loads it: admin UI → 导入), and drives the endpoints as a non-admin 孩子 member:
 *   - 0 LLM agents land (the subscription lives on the 家长 hub — the child borrows it);
 *   - both child workflows surface to /me (guided-lesson `learn.request` + explore `explore.request`);
 *   - the member self-dispatches the lesson; `learner_id` is forced to the caller and a
 *     spoofed `learner_id` reaches no task — not the trigger, not the cross-org tutor borrow,
 *     not the local records-append, not the oversight fork;
 *   - internal enforcement details (capability / userScopeField) never leak to /me.
 *
 * It reads the shipped `examples/family-learning-hub/template/child-desk.template.yaml`
 * off disk, so the example can never silently drift out of sync with the runtime contract.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { AgentParticipant, Hub, Space, type Task } from '@gotong/core'
import { serveWeb, type WebServerHandle } from '@gotong/web'
import { openIdentityStore, type IdentityStore } from '@gotong/identity'

import { WorkflowController } from '../src/workflow-controller.js'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')
const CHILD_TEMPLATE = join(
  repoRoot,
  'examples',
  'family-learning-hub',
  'template',
  'child-desk.template.yaml',
)

/**
 * A deterministic stand-in for a child-hub LOCAL capability. The child workflows name
 * `tutor.teach` (normally crosses to the 家长 over a federation link — proven in C-M1),
 * `records.append` (the local learning-records master copy), `report.to-guardian` (the
 * oversight fork), `explore.local`. Here a local stub serves each so the lesson run
 * completes and the forced `learner_id` propagates through every step — C-M3 verifies
 * the `/me` SELF-DISPATCH contract, not the cross-hub gate (that's C-M1's concern).
 */
class CapStub extends AgentParticipant {
  readonly captured: Task[] = []
  protected async handleTask(task: Task): Promise<unknown> {
    this.captured.push(task)
    return { by: this.id, echo: task.payload }
  }
}

interface Rig {
  root: string
  hub: Hub
  identity: IdentityStore
  web: WebServerHandle
  memberId: string
  cookie: string
  stubs: { tutor: CapStub; records: CapStub; report: CapStub; explore: CapStub }
  importBody: { ok?: boolean; team?: { created?: unknown[] }; workflows?: unknown }
}

/** Poll until `pred()` is true (the lesson run fans out async after dispatch returns). */
async function waitFor(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

async function boot(): Promise<Rig> {
  const root = await mkdtemp(join(tmpdir(), 'gotong-family-child-me-'))
  const { space, adminToken } = await Space.init(root, {
    name: 'family-child',
    adminDisplayName: 'Owner',
  })
  if (!adminToken) throw new Error('expected admin token from Space.init')
  const hub = new Hub({ space })
  await hub.start()

  // The child hub's local capabilities are runtime deterministic participants (NOT in the
  // template — same posture as src/participants.ts). The template names them; the runtime
  // provides them.
  const stubs = {
    tutor: new CapStub({ id: 'tutor-stub', capabilities: ['tutor.teach'] }),
    records: new CapStub({ id: 'records-stub', capabilities: ['records.append'] }),
    report: new CapStub({ id: 'report-stub', capabilities: ['report.to-guardian'] }),
    explore: new CapStub({ id: 'explore-stub', capabilities: ['explore.local'] }),
  }
  for (const s of Object.values(stubs)) hub.register(s)

  // The REAL host workflow surface — the same `WorkflowSurface` production wires.
  const controller = new WorkflowController({
    hub,
    definitionsDir: join(root, 'workflows', 'definitions'),
    spaceRoot: root,
  })

  // Identity: bootstrap the owner from the v3 admin token, then add a plain 孩子 member.
  const identity = openIdentityStore({ dbPath: join(root, 'identity.sqlite') })
  identity.bootstrap({ adminToken, ownerEmail: 'owner@local', ownerDisplayName: 'Owner' })
  const member = identity.createUser({
    email: 'kid@e2e.test',
    displayName: 'Kid',
    password: 'kid-strong-password',
    role: 'member',
  })

  const web = await serveWeb(hub, {
    host: '127.0.0.1',
    port: 0,
    identity,
    workflows: controller, // <-- the production wiring under test
  })

  // Import the SHIPPED child template through the REAL admin route. Model-B import
  // publishes rev1, so the lessons immediately surface to /me (Phase 15 gate).
  const templateText = await readFile(CHILD_TEMPLATE, 'utf8')
  const imp = await fetch(`${web.url}/api/admin/templates/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ template: templateText }),
  })
  if (imp.status !== 200) throw new Error(`template import failed: ${imp.status}`)
  const importBody = (await imp.json()) as Rig['importBody']

  const login = await fetch(`${web.url}/api/admin/identity/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'kid@e2e.test', password: 'kid-strong-password' }),
  })
  if (login.status !== 200) throw new Error(`member login failed: ${login.status}`)
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!

  return { root, hub, identity, web, memberId: member.id, cookie, stubs, importBody }
}

async function teardown(r: Rig): Promise<void> {
  await r.web.close()
  await r.hub.stop()
  r.identity.close()
  await rm(r.root, { recursive: true, force: true })
}

describe('family-learning-hub C-M3 — child /me self-dispatch, real WorkflowController', () => {
  let r: Rig
  beforeEach(async () => {
    r = await boot()
  })
  afterEach(async () => {
    await teardown(r)
  })

  it('imports the shipped child template through the real admin route — 0 LLM agents, both lessons surface to /me', async () => {
    // ★ The sharp child-side inversion: ZERO agents land. The subscription (LLM key)
    // lives on the 家长 hub; the child borrows it cross-org. So importing the child
    // template registers workflows + runners but no key-bearing managed agent.
    expect(r.importBody.ok).toBe(true)
    expect(r.importBody.team?.created).toEqual([])

    const res = await fetch(`${r.web.url}/api/me/workflows`, { headers: { cookie: r.cookie } })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      workflows: Array<
        { id: string; label: string; inputSchema: Array<{ id: string }> } & Record<string, unknown>
      >
    }
    const ids = body.workflows.map((w) => w.id).sort()
    expect(ids).toContain('child-guided-lesson')
    expect(ids).toContain('child-autonomous-explore')

    const lesson = body.workflows.find((w) => w.id === 'child-guided-lesson')!
    expect(lesson.label).toBe('跟 AI 导师学一课')
    // The member form shows the declared topic field WITHOUT the scope key (/me injects it).
    expect(lesson.inputSchema.map((f) => f.id)).toEqual(['topic'])
    // Internal enforcement details must not leak to the member surface.
    expect(lesson.capability).toBeUndefined()
    expect(lesson.userScopeField).toBeUndefined()
  })

  it('a 孩子 member self-dispatches the lesson — learner_id is forced to the caller (no spoofing) through every step', async () => {
    const res = await fetch(`${r.web.url}/api/me/dispatch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: r.cookie },
      body: JSON.stringify({
        workflowId: 'child-guided-lesson',
        payload: { topic: '太阳系', learner_id: 'someone-else' },
      }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; workflowId: string }
    expect(body.ok).toBe(true)
    expect(body.workflowId).toBe('child-guided-lesson')

    // Wait for the lesson run to fan out (tutor → record → report) so the propagation
    // assertion sees every sub-task, not just the trigger.
    await waitFor(() => r.stubs.report.captured.length > 0)

    // The cross-org tutor borrow carried the FORCED learner_id (the member's own id),
    // never the spoofed value — the child can't learn as someone else.
    const tutorPayload = r.stubs.tutor.captured.at(-1)!.payload as Record<string, unknown>
    expect(tutorPayload.learner_id).toBe(r.memberId)
    expect(tutorPayload.topic).toBe('太阳系')

    // The local learning-records master-copy write is scoped to the member too.
    const recordPayload = r.stubs.records.captured.at(-1)!.payload as Record<string, unknown>
    expect(recordPayload.learner_id).toBe(r.memberId)

    // The oversight fork to the 家长 is scoped to the member.
    const reportPayload = r.stubs.report.captured.at(-1)!.payload as Record<string, unknown>
    expect(reportPayload.learner_id).toBe(r.memberId)

    // ★ The spoof never lands ANYWHERE — not in a stub's payload, not in any recorded task.
    const allStubPayloads = Object.values(r.stubs).flatMap((s) =>
      s.captured.map((t) => t.payload as Record<string, unknown>),
    )
    expect(allStubPayloads.every((p) => p.learner_id !== 'someone-else')).toBe(true)
    const taskPayloads = r.hub.tasks().map((t) => t.task.payload as Record<string, unknown>)
    expect(taskPayloads.some((p) => p.learner_id === r.memberId)).toBe(true)
    expect(taskPayloads.every((p) => p.learner_id !== 'someone-else')).toBe(true)
  })

  it('refuses a workflow id that is not member-facing (403)', async () => {
    const res = await fetch(`${r.web.url}/api/me/dispatch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: r.cookie },
      body: JSON.stringify({ workflowId: 'no-such-workflow', payload: {} }),
    })
    expect(res.status).toBe(403)
  })
})
