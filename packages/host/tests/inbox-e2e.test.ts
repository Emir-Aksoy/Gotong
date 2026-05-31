/**
 * Phase 16 — the member task inbox acceptance gate (end-to-end).
 *
 * THE test the feature exists to pass: a workflow pauses on a `human:` step,
 * a member resolves it from the inbox, and the run continues with the human's
 * decision as that step's output — AND a revision published while the step is
 * parked never drifts the resumed run (Phase 15 binding holds for human-parked
 * runs exactly as for timer-parked ones), AND the resume sweep can never
 * auto-wake a human task.
 *
 * Everything is real:
 *   - a real Hub (InMemoryStorage) with a production-shaped suspendNotifier
 *     persisting parked tasks to a real IdentityStore (tmp sqlite),
 *   - the real WorkflowController → versioning → file revision/lifecycle stores,
 *   - the real broker (HumanInboxParticipant + FileInboxStore),
 *   - the real HostInboxService doing the two-step resume.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Hub, InMemoryStorage, type Participant } from '@aipehub/core'
import { openIdentityStore, type IdentityStore } from '@aipehub/identity'
import {
  FileInboxStore,
  HumanInboxParticipant,
  NEVER_RESUME_AT,
} from '@aipehub/inbox'
import { workflowParticipantId } from '@aipehub/workflow'

import { WorkflowController } from '../src/workflow-controller.js'
import { HostInboxService } from '../src/inbox-service.js'

// rev1 and rev2 differ only in the `tail` marker, with the trigger capability
// and the `human:` gate frozen. The marker is the drift probe: a resumed rev1
// run must dispatch `{ marker: rev1 }`, never rev2's `{ marker: rev2 }`. The
// `approved: $gate.output.approved` field proves the human decision flows
// downstream as the gate step's output.
const yamlFor = (name: string, marker: string): string => `
schema: aipehub.workflow/v1
workflow:
  id: inbox-e2e
  name: ${name}
  trigger: { capability: ie:start }
  steps:
    - id: gate
      human:
        assignee: $trigger.payload.case_id
        kind: approval
        prompt: Approve the plan?
    - id: tail
      dispatch:
        strategy: { kind: capability, capabilities: [mark] }
        payload: { marker: ${marker}, approved: $gate.output.approved }
`

describe('Phase 16 — member task inbox acceptance gate', () => {
  let tmp: string
  let identity: IdentityStore
  let hub: Hub
  let inboxStore: FileInboxStore
  let controller: WorkflowController
  let service: HostInboxService
  let markerSaw: Array<Record<string, unknown>>

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'host-inbox-e2e-'))
    identity = openIdentityStore({ dbPath: join(tmp, 'identity.sqlite') })
    hub = new Hub({
      storage: new InMemoryStorage(),
      suspendNotifier: (task, by, s) => {
        identity.persistSuspendedTask({
          taskId: task.id,
          agentId: by,
          hubId: 'local',
          originUserId: task.origin?.userId ?? null,
          resumeAt: s.resumeAt,
          state: s.state,
          taskJson: JSON.stringify(task),
        })
      },
    })
    await hub.start()

    inboxStore = new FileInboxStore(tmp)
    inboxStore.ensureDirs()
    hub.register(new HumanInboxParticipant({ store: inboxStore }))

    markerSaw = []
    const marker: Participant = {
      id: 'marker',
      kind: 'agent',
      capabilities: ['mark'],
      async onTask(task) {
        markerSaw.push(task.payload as Record<string, unknown>)
        return { kind: 'ok', taskId: task.id, output: 'marked', by: 'marker', ts: 1 }
      },
    }
    hub.register(marker)

    controller = new WorkflowController({
      hub,
      definitionsDir: join(tmp, 'workflows', 'definitions'),
      spaceRoot: tmp,
    })
    service = new HostInboxService({ hub, store: inboxStore, identity })
  })

  afterEach(async () => {
    await hub.stop()
    identity.close()
    rmSync(tmp, { recursive: true, force: true })
  })

  it('a human decision resumes the workflow and becomes the gate step output', async () => {
    const sum = await controller.importFromText(yamlFor('rev1', 'rev1'))
    expect(sum.state).toBe('published')

    // Fire the trigger → run starts, dispatches the human gate → parks.
    const fired = await hub.dispatch({
      from: 'admin',
      strategy: { kind: 'capability', capabilities: ['ie:start'] },
      payload: { case_id: 'user-a' },
    })
    expect(fired.kind).toBe('suspended')

    // An inbox item exists for the assignee, with a workflow parent.
    const pending = await inboxStore.listPending('user-a')
    expect(pending).toHaveLength(1)
    const item = pending[0]!
    expect(item.kind).toBe('approval')
    expect(item.parentKind).toBe('workflow')
    expect(item.prompt).toBe('Approve the plan?')

    // Both the child broker task and the parent workflow run are parked at the
    // never-resume sentinel — and the sweep is blind to them (only resolve can
    // wake a human task).
    const childRow = identity.getSuspendedTask(item.itemId)
    const parentRow = identity.getSuspendedTask(item.parent!.taskId)
    expect(childRow?.resumeAt).toBe(NEVER_RESUME_AT)
    expect(parentRow?.agentId).toBe(workflowParticipantId('inbox-e2e'))
    expect(parentRow?.resumeAt).toBe(NEVER_RESUME_AT)
    const due = identity.listDueSuspendedTasks({ now: Date.now() })
    expect(due.some((d) => d.taskId === item.itemId)).toBe(false)
    expect(due.some((d) => d.taskId === item.parent!.taskId)).toBe(false)

    // The on-disk run is running with a suspended gate step.
    const runsBefore = await controller.listRuns({ workflowId: 'inbox-e2e' })
    const parkedRun = await controller.readRun(runsBefore[0]!.runId)
    expect(parkedRun?.status).toBe('running')
    expect(parkedRun?.steps.some((s) => s.stepId === 'gate' && s.status === 'suspended')).toBe(true)

    // Resolve as the assignee → the run continues.
    await service.resolve({
      itemId: item.itemId,
      userId: 'user-a',
      decision: { kind: 'approval', approved: true },
    })

    // The human decision became the gate step's output AND flowed downstream:
    // the tail step saw `approved: true`.
    expect(markerSaw).toContainEqual({ marker: 'rev1', approved: true })
    const doneRun = await controller.readRun(runsBefore[0]!.runId)
    expect(doneRun?.status).toBe('done')
    const gate = doneRun?.steps.find((s) => s.stepId === 'gate')
    expect(gate?.output).toEqual({ kind: 'approval', approved: true })

    // Parked rows are cleaned up.
    expect(identity.getSuspendedTask(item.itemId)).toBeNull()
    expect(identity.getSuspendedTask(item.parent!.taskId)).toBeNull()
  })

  it('publishing a new revision while a human step is parked never drifts the resumed run', async () => {
    await controller.importFromText(yamlFor('rev1', 'rev1'))
    const fired = await hub.dispatch({
      from: 'admin',
      strategy: { kind: 'capability', capabilities: ['ie:start'] },
      payload: { case_id: 'user-a' },
    })
    expect(fired.kind).toBe('suspended')
    const item = (await inboxStore.listPending('user-a'))[0]!

    // Publish rev2 while the gate is parked. Same registered runner (frozen
    // cap, no Hub churn); the parked run is stamped rev1.
    const before = hub.registry.get(workflowParticipantId('inbox-e2e'))
    const sum2 = await controller.publish('inbox-e2e', { text: yamlFor('rev2', 'rev2'), by: 'admin' })
    expect(sum2.currentRevision).toBe(2)
    expect(hub.registry.get(workflowParticipantId('inbox-e2e'))).toBe(before)

    // Resolve → the resumed run executes rev1's tail, NEVER rev2's. This is the
    // no-drift assertion for human-parked runs.
    await service.resolve({
      itemId: item.itemId,
      userId: 'user-a',
      decision: { kind: 'approval', approved: true },
    })
    expect(markerSaw).toContainEqual({ marker: 'rev1', approved: true })
    expect(markerSaw).not.toContainEqual({ marker: 'rev2', approved: true })

    const runs = await controller.listRuns({ workflowId: 'inbox-e2e' })
    const run = await controller.readRun(runs[0]!.runId)
    expect(run?.status).toBe('done')
    expect(run?.definitionRevision).toBe(1)
  })
})
