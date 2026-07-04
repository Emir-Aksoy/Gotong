/**
 * Phase 15 — the no-drift acceptance gate (end-to-end).
 *
 * This is THE test the whole phase exists to pass: a workflow goes
 * import → run → suspend → publish-a-new-revision → resume, and the
 * resumed run must execute the revision it STARTED under, never the
 * freshly-published one. Run instances bind to an immutable revision;
 * publishing only moves the `currentRevision` pointer.
 *
 * Everything here is real, not stubbed:
 *   - a real `Hub` (InMemoryStorage) with a production-shaped
 *     `suspendNotifier` (the same hook the host wires to persist
 *     parked tasks) so we can drive the real resume path,
 *   - the real `WorkflowController` → `WorkflowVersioning` →
 *     file-backed `RevisionStore` / `LifecycleStore` under a tmp space,
 *   - the real `WorkflowRunner` the versioning service registers, whose
 *     `HostDefinitionResolver` reads the live lifecycle pointer.
 *
 * The suspend is genuine: a `worker` agent throws `SuspendTaskError` on
 * its first task, the scheduler converts that to a `suspended` result,
 * and the workflow parks. We resume exactly as the host's resume sweep
 * does — `hub.resumeTask(agentId, task, state)` per parked task.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { Hub, InMemoryStorage, SuspendTaskError } from '@gotong/core'
import type { ParticipantId, Participant, Task } from '@gotong/core'
import { WorkflowRunner, workflowParticipantId } from '@gotong/workflow'
import type { RunState } from '@gotong/workflow'

import { WorkflowController } from '../src/workflow-controller.js'

// rev1 and rev2 differ ONLY in the `name` and the `tail` step's marker
// payload, with the trigger capability frozen (lc:start). The `tail`
// marker is the drift probe: a resumed rev1 run must dispatch
// `{ marker: rev1 }`, never rev2's `{ marker: rev2 }`.
const yamlFor = (name: string, marker: string): string => `
schema: gotong.workflow/v1
workflow:
  id: lc-e2e
  name: ${name}
  trigger: { capability: lc:start }
  steps:
    - id: park
      dispatch:
        strategy: { kind: capability, capabilities: [do-work] }
        payload: $trigger.payload
    - id: tail
      dispatch:
        strategy: { kind: capability, capabilities: [mark] }
        payload: { marker: ${marker} }
`

interface Parked {
  task: Task
  by: ParticipantId
  state: unknown
}

describe('Phase 15 — workflow lifecycle no-drift acceptance gate', () => {
  it('a run resumed across a publish executes its ORIGINAL revision', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'host-wf-lc-e2e-'))
    const definitionsDir = join(tmp, 'workflows', 'definitions')
    const pid = workflowParticipantId('lc-e2e')

    // Parked tasks captured exactly like the host's SQLite-backed
    // suspendNotifier captures them — keyed by who suspended.
    const parked: Parked[] = []
    const hub = new Hub({
      storage: new InMemoryStorage(),
      suspendNotifier: (task, by, s) => {
        parked.push({ task, by, state: s.state })
      },
    })
    await hub.start()

    // `worker` suspends on its FIRST task (parking the workflow), then
    // runs immediately for every later task. `marker` records every
    // payload it sees so we can prove which revision's `tail` ran.
    let workerSuspends = true
    const markerSaw: Array<Record<string, unknown>> = []
    const worker: Participant = {
      id: 'worker',
      kind: 'agent',
      capabilities: ['do-work'],
      async onTask(task) {
        if (workerSuspends) {
          workerSuspends = false
          throw new SuspendTaskError({ resumeAt: 9_999_999_999_000, state: { parked: task.id } })
        }
        return { kind: 'ok', taskId: task.id, output: 'worker-immediate', by: 'worker', ts: 1 }
      },
      async onResume(task) {
        return { kind: 'ok', taskId: task.id, output: 'worker-resumed', by: 'worker', ts: 1 }
      },
    }
    const marker: Participant = {
      id: 'marker',
      kind: 'agent',
      capabilities: ['mark'],
      async onTask(task) {
        markerSaw.push(task.payload as Record<string, unknown>)
        return { kind: 'ok', taskId: task.id, output: 'marked', by: 'marker', ts: 1 }
      },
    }
    hub.register(worker)
    hub.register(marker)

    const controller = new WorkflowController({ hub, definitionsDir, spaceRoot: tmp })

    try {
      // --- 1. import rev1 → published, immutable snapshot on disk, runner up
      const sum1 = await controller.importFromText(yamlFor('rev1', 'rev1'))
      expect(sum1.state).toBe('published')
      expect(sum1.currentRevision).toBe(1)
      expect(existsSync(join(tmp, 'workflows', 'revisions', 'lc-e2e', '1.json'))).toBe(true)
      expect(await controller.getState('lc-e2e')).toMatchObject({
        state: 'published',
        currentRevision: 1,
        headRevision: 1,
        registered: true,
      })
      const runner = hub.registry.get(pid)
      expect(runner instanceof WorkflowRunner).toBe(true)

      // --- 2/3. fire the trigger → run starts, binds rev1, then parks
      const fired = await hub.dispatch({
        from: 'admin',
        strategy: { kind: 'capability', capabilities: ['lc:start'] },
        payload: { topic: 'hello' },
      })
      expect(fired.kind).toBe('suspended')

      const wfParked = parked.find((p) => p.by === pid)
      expect(wfParked, 'the workflow itself parked').toBeDefined()
      const wfState = wfParked!.state as { kind: string; runState: RunState }
      expect(wfState.runState.definitionRevision).toBe(1)
      const runId = wfState.runState.runId

      // …and the on-disk run is bound to rev1 with a suspended step.
      const parkedRun = await controller.readRun(runId)
      expect(parkedRun?.definitionRevision).toBe(1)
      expect(parkedRun?.status).toBe('running')
      expect(parkedRun?.steps.some((s) => s.status === 'suspended')).toBe(true)

      const workerParked = parked.find((p) => p.by === 'worker')
      expect(workerParked, 'the worker child task parked').toBeDefined()

      // --- 4. publish rev2 while the run is parked. The runner stays the
      //        SAME registered participant — frozen cap, no Hub churn.
      const before = hub.registry.get(pid)
      const sum2 = await controller.publish('lc-e2e', { text: yamlFor('rev2', 'rev2'), by: 'admin' })
      expect(sum2.currentRevision).toBe(2)
      expect(sum2.name).toBe('rev2')
      expect(hub.registry.get(pid)).toBe(before)
      // current() now points at rev2 — but the parked run is stamped rev1.

      // --- 5. resume (exactly as the host sweep does: per parked task).
      //        First wake the child worker so its result is ready, then
      //        resume the workflow itself.
      await hub.resumeTask('worker', workerParked!.task, workerParked!.state)
      const resumed = await hub.resumeTask(pid, wfParked!.task, wfParked!.state)
      expect(resumed.kind).toBe('ok')

      // THE no-drift assertion: the resumed run ran rev1's tail, not rev2's.
      expect(markerSaw).toContainEqual({ marker: 'rev1' })
      expect(markerSaw).not.toContainEqual({ marker: 'rev2' })
      const doneRun = await controller.readRun(runId)
      expect(doneRun?.status).toBe('done')
      expect(doneRun?.definitionRevision).toBe(1)

      // --- 6. rollback current → rev1's content (append-only clone as rev3)
      const sum3 = await controller.rollback('lc-e2e', { targetRevision: 1, by: 'admin' })
      expect(sum3.currentRevision).toBe(3)
      expect(sum3.state).toBe('published')
      expect(sum3.name).toBe('rev1')
      const revs = await controller.listRevisions('lc-e2e')
      expect(revs.map((r) => r.revision)).toEqual([1, 2, 3])
      // rev3 is byte-identical to rev1 — "current published == rev1".
      expect(revs[2]!.contentHash).toBe(revs[0]!.contentHash)
      expect(revs[2]!.origin).toBe('rollback')
      expect(revs[2]!.rolledBackFrom).toBe(1)

      // --- 7. a NEW dispatch after rollback binds rev3 and runs rev1's content
      const markerCountBefore = markerSaw.length
      const fired2 = await hub.dispatch({
        from: 'admin',
        strategy: { kind: 'capability', capabilities: ['lc:start'] },
        payload: { topic: 'after-rollback' },
      })
      expect(fired2.kind).toBe('ok')
      const newest = (await controller.listRuns({ workflowId: 'lc-e2e' }))[0]!
      const newestState = await controller.readRun(newest.runId)
      expect(newestState?.definitionRevision).toBe(3)
      // rev3 == rev1, so the freshest tail dispatch carries rev1's marker.
      expect(markerSaw.length).toBeGreaterThan(markerCountBefore)
      expect(markerSaw.at(-1)).toEqual({ marker: 'rev1' })
    } finally {
      await hub.stop()
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
