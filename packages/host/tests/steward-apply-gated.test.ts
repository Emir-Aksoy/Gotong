/**
 * SW-M5 — the steward's DANGEROUS / CROSS_HUB approval gate (the two hard
 * constraints: 「跨 hub 工作流 + 危险动作都再次确认」).
 *
 * Unlike the SAFE path (M4, executes inline), a `delete_agent` or a cross-hub
 * `edit_workflow` must NOT run on a single confirmation. `apply` dispatches it to
 * the `StewardApprovalBroker`, which parks it in the member's inbox and suspends.
 * Nothing runs until the member resolves it in `/me`; approval runs the SAME
 * `performStewardAction` chokepoint, rejection fails closed.
 *
 * This test wires the real service WITH an inbox (so the broker is registered) to
 * a real Hub with a production-shaped `suspendNotifier`, and proves:
 *
 *   1. apply(dangerous delete) → `pending_approval` + the action parked at
 *      `NEVER_RESUME_AT` (the sweep is blind to it) + an `approval` inbox item —
 *      and the executor's `remove` was NEVER called;
 *   2. apply(cross-hub edit) → `pending_approval` parked — editor NEVER called;
 *   3. resuming the parked task with an APPROVE decision runs the executor (the
 *      delete / edit finally happens) and returns `ok`;
 *   4. resuming with a REJECT decision fails closed (`steward_action_denied`) and
 *      the executor was NEVER called;
 *   5. with NO inbox wired the same tiers degrade to `needs_approval` (the M4
 *      fallback) — nothing parked.
 *
 * The full `/me` resolve round-trip (HostInboxService two-step) is the E2E gate
 * (M8); here we resume through `hub.resumeTask` exactly as `resumeChild` does, so
 * the broker is exercised via the real hub resume entry point.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Hub, Space, createLogger, type Task } from '@aipehub/core'
import { MockLlmProvider } from '@aipehub/llm'
import { FileInboxStore, NEVER_RESUME_AT } from '@aipehub/inbox'

import {
  createHubStewardService,
  type HubStewardSurface,
  type StewardAgentDirectory,
  type StewardWorkflowDirectory,
  type StewardWorkflowEditor,
} from '../src/hub-steward-service.js'
import { STEWARD_EXEC_CAPABILITY, STEWARD_EXEC_PARTICIPANT_ID } from '../src/steward-approval.js'

const USER = 'u1'

/** Records every write verb so the test can assert executed-vs-not. */
interface AgentCalls {
  created: Array<{ userId: string; id: string }>
  updated: Array<{ userId: string; agentId: string }>
  removed: Array<{ userId: string; agentId: string }>
}

function fakeAgentDir(calls: AgentCalls): StewardAgentDirectory {
  return {
    async listOwned() {
      return []
    },
    async availableProviders() {
      return ['anthropic', 'mock']
    },
    async create(userId, input) {
      calls.created.push({ userId, id: input.id })
      return { id: `me.${userId}.${input.id}`, label: input.label, capabilities: [], provider: input.provider }
    },
    async update(userId, agentId) {
      calls.updated.push({ userId, agentId })
      return { id: agentId, label: '(x)', capabilities: [], provider: 'anthropic' }
    },
    async remove(userId, agentId) {
      calls.removed.push({ userId, agentId })
      return true
    },
  }
}

/** One purely-local workflow + one cross-hub workflow (drives the tier split). */
function fakeWorkflowDir(): StewardWorkflowDirectory {
  return {
    async listForUser() {
      return [
        { id: 'local-wf', name: '本地工作流', crossHub: false },
        { id: 'xhub-wf', name: '跨 hub 工作流', crossHub: true },
      ]
    },
  }
}

function fakeWorkflowEditor(calls: { edited: Array<{ workflowId: string }> }): StewardWorkflowEditor {
  return {
    async edit(req) {
      calls.edited.push({ workflowId: req.workflowId })
      return {
        ok: true,
        state: 'published',
        applied: 'published',
        yaml: 'schema: aipehub.workflow/v1\nid: xhub-wf\n',
        explanation: '改好了。',
        boundary: { trigger: 'chat', egress: [] },
      }
    },
  }
}

/** A parked-task row, mirroring what `IdentityStore.persistSuspendedTask` keeps. */
interface ParkedRow {
  agentId: string
  resumeAt: number
  state: unknown
  taskJson: string
}

interface Bench {
  root: string
  hub: Hub
  surface: HubStewardSurface
  agentCalls: AgentCalls
  editCalls: { edited: Array<{ workflowId: string }> }
  inboxStore: FileInboxStore
  parked: Map<string, ParkedRow>
}

/**
 * @param withInbox wire the inbox store (so the broker registers) — false proves
 *                  the no-broker `needs_approval` degradation.
 */
async function boot(withInbox = true): Promise<Bench> {
  const root = await mkdtemp(join(tmpdir(), 'aipe-steward-gated-'))

  // Production-shaped suspend persistence: the scheduler calls this when the
  // broker throws SuspendTaskError. Mirror the host's notifier (taskId-keyed row
  // with the serialized task) so we can reconstruct + resume exactly as
  // HostInboxService.resumeChild does.
  const parked = new Map<string, ParkedRow>()
  const { space } = await Space.init(root, { name: 'steward-gated-test' })
  const hub = new Hub({
    space,
    suspendNotifier: (task, by, s) => {
      parked.set(task.id, { agentId: by, resumeAt: s.resumeAt, state: s.state, taskJson: JSON.stringify(task) })
    },
  })
  await hub.start()

  const agentCalls: AgentCalls = { created: [], updated: [], removed: [] }
  const editCalls = { edited: [] as Array<{ workflowId: string }> }

  const inboxStore = new FileInboxStore(root)
  inboxStore.ensureDirs()

  const surface = createHubStewardService({
    hub,
    config: { provider: 'mock' },
    agents: fakeAgentDir(agentCalls),
    workflows: fakeWorkflowDir(),
    workflowEditor: fakeWorkflowEditor(editCalls),
    ...(withInbox ? { inbox: inboxStore } : {}),
    logger: createLogger('test-steward-gated'),
    provider: new MockLlmProvider({ reply: '{}' }),
  })
  if (!surface) throw new Error('createHubStewardService returned null (expected a surface)')

  return { root, hub, surface, agentCalls, editCalls, inboxStore, parked }
}

/** Resume a parked task as `HostInboxService.resumeChild` does — merge the
 * persisted state under `{ answer }` and route through the real hub. */
async function resolveParked(b: Bench, inboxItemId: string, approved: boolean) {
  const row = b.parked.get(inboxItemId)
  if (!row) throw new Error(`no parked row for ${inboxItemId}`)
  const task = JSON.parse(row.taskJson) as Task
  const state = { ...(row.state as object), answer: { kind: 'approval', approved } }
  return b.hub.resumeTask(row.agentId, task, state)
}

describe('SW-M5 — hub steward approval gate (the two hard constraints)', () => {
  let b: Bench
  beforeEach(async () => {
    b = await boot()
  })
  afterEach(async () => {
    await b.hub.stop()
    await rm(b.root, { recursive: true, force: true })
  })

  it('★ a DANGEROUS delete parks for approval — not executed, parked at NEVER, blind to the sweep', async () => {
    const res = await b.surface.apply({
      userId: USER,
      action: { kind: 'delete_agent', agentId: `me.${USER}.mailer` },
    })
    expect(res.status).toBe('pending_approval')
    if (res.status !== 'pending_approval') throw new Error('unreachable')
    expect(res.tier).toBe('dangerous')
    expect(res.inboxItemId.length).toBeGreaterThan(0)

    // The hard constraint: the executor's remove was NEVER called — it only runs
    // after a human approves.
    expect(b.agentCalls.removed).toEqual([])

    // Parked at the never-resume sentinel under the broker id; the timer sweep
    // (resume_at <= now) is blind to it — only a resolve can wake it.
    const row = b.parked.get(res.inboxItemId)
    expect(row?.agentId).toBe(STEWARD_EXEC_PARTICIPANT_ID)
    expect(row?.resumeAt).toBe(NEVER_RESUME_AT)
    expect(row!.resumeAt > Date.now()).toBe(true)

    // An approval item lands in the MEMBER'S own inbox (they confirm their own ask).
    const pending = await b.inboxStore.listPending(USER)
    expect(pending).toHaveLength(1)
    expect(pending[0]!.kind).toBe('approval')
    expect(pending[0]!.parentKind).toBe('none')
    expect(pending[0]!.prompt).toContain(`me.${USER}.mailer`)
    expect(pending[0]!.itemId).toBe(res.inboxItemId)
  })

  it('★ a CROSS_HUB workflow edit parks for approval — editor not called', async () => {
    const res = await b.surface.apply({
      userId: USER,
      action: { kind: 'edit_workflow', workflowId: 'xhub-wf', instruction: '改触发条件' },
    })
    expect(res.status).toBe('pending_approval')
    if (res.status !== 'pending_approval') throw new Error('unreachable')
    expect(res.tier).toBe('cross_hub')
    expect(b.editCalls.edited).toEqual([])

    const pending = await b.inboxStore.listPending(USER)
    expect(pending).toHaveLength(1)
    expect(pending[0]!.prompt).toContain('xhub-wf')
  })

  it('approving a parked delete runs the executor (the delete finally happens)', async () => {
    const res = await b.surface.apply({
      userId: USER,
      action: { kind: 'delete_agent', agentId: `me.${USER}.mailer` },
    })
    if (res.status !== 'pending_approval') throw new Error('expected pending_approval')

    const resumed = await resolveParked(b, res.inboxItemId, true)
    expect(resumed.kind).toBe('ok')
    if (resumed.kind !== 'ok') throw new Error('unreachable')
    expect(resumed.output).toEqual({ kind: 'delete_agent', removed: true })
    // NOW the executor ran — on approval, via the SAME chokepoint a safe action uses.
    expect(b.agentCalls.removed).toEqual([{ userId: USER, agentId: `me.${USER}.mailer` }])
  })

  it('approving a parked cross-hub edit runs the editor', async () => {
    const res = await b.surface.apply({
      userId: USER,
      action: { kind: 'edit_workflow', workflowId: 'xhub-wf', instruction: '只改本地那步' },
    })
    if (res.status !== 'pending_approval') throw new Error('expected pending_approval')

    const resumed = await resolveParked(b, res.inboxItemId, true)
    expect(resumed.kind).toBe('ok')
    expect(b.editCalls.edited).toEqual([{ workflowId: 'xhub-wf' }])
  })

  it('★ rejecting a parked delete fails closed — the executor is never called', async () => {
    const res = await b.surface.apply({
      userId: USER,
      action: { kind: 'delete_agent', agentId: `me.${USER}.mailer` },
    })
    if (res.status !== 'pending_approval') throw new Error('expected pending_approval')

    const resumed = await resolveParked(b, res.inboxItemId, false)
    expect(resumed.kind).toBe('failed')
    if (resumed.kind !== 'failed') throw new Error('unreachable')
    expect(resumed.error).toBe('steward_action_denied')
    // Fail-closed: the delete NEVER happened.
    expect(b.agentCalls.removed).toEqual([])
  })

  it('degrades to needs_approval when no inbox is wired (the M4 fallback)', async () => {
    const noInbox = await boot(false)
    try {
      const res = await noInbox.surface.apply({
        userId: USER,
        action: { kind: 'delete_agent', agentId: `me.${USER}.mailer` },
      })
      expect(res).toEqual({ status: 'needs_approval', tier: 'dangerous' })
      // Nothing parked, nothing executed.
      expect(noInbox.parked.size).toBe(0)
      expect(noInbox.agentCalls.removed).toEqual([])
    } finally {
      await noInbox.hub.stop()
      await rm(noInbox.root, { recursive: true, force: true })
    }
  })
})
