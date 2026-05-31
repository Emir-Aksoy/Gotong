import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Hub, InMemoryStorage } from '@aipehub/core'
import {
  WORKFLOW_SCHEMA_V1,
  WorkflowLifecycleError,
  WorkflowRevisionError,
  WorkflowRunner,
  hashDefinition,
  workflowParticipantId,
  type WorkflowDefinition,
} from '@aipehub/workflow'

import { WorkflowVersioning } from '../src/workflow-versioning.js'

const ID = 'flow'
const CAP = 'run-flow'
const PID = workflowParticipantId(ID)

/** A minimal valid definition; `name` is the content knob that moves the hash. */
function def(name?: string, over: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    schema: WORKFLOW_SCHEMA_V1,
    id: ID,
    ...(name !== undefined ? { name } : {}),
    trigger: { capability: CAP },
    steps: [
      {
        id: 's1',
        dispatch: { strategy: { kind: 'capability', capabilities: ['do'] }, payload: {} },
      },
    ],
    ...over,
  }
}

function runnerOn(hub: Hub): WorkflowRunner | undefined {
  const p = hub.registry.get(PID)
  return p instanceof WorkflowRunner ? p : undefined
}

describe('WorkflowVersioning', () => {
  let root: string
  let hub: Hub
  let svc: WorkflowVersioning
  let clock: number

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'aipe-wf-ver-'))
    hub = new Hub({ storage: new InMemoryStorage() })
    await hub.start()
    clock = 0
    svc = new WorkflowVersioning({ hub, spaceRoot: root, now: () => ++clock })
  })
  afterEach(async () => {
    await hub.stop()
    rmSync(root, { recursive: true, force: true })
  })

  // --- adopt (Model-B genesis) ---------------------------------------------

  it('adopt creates a published rev1 and registers a runner', async () => {
    const record = await svc.adopt(def('A'))
    expect(record.state).toBe('published')
    expect(record.currentRevision).toBe(1)
    expect(record.headRevision).toBe(1)
    expect(record.triggerCapability).toBe(CAP)
    expect(record.revisions).toHaveLength(1)
    expect(record.revisions[0]).toMatchObject({ revision: 1, origin: 'import' })
    // History is empty — genesis is audited by the revision's origin/createdAt.
    expect(record.history).toEqual([])
    // Runner is live on the Hub, on the trigger capability.
    expect(runnerOn(hub)?.capabilities).toEqual([CAP])
  })

  it('adopt is idempotent — re-adopting ignores a differing definition', async () => {
    await svc.adopt(def('A'))
    const again = await svc.adopt(def('B')) // different content
    expect(again.headRevision).toBe(1)
    expect(again.revisions).toHaveLength(1)
    expect(again.currentRevision).toBe(1)
    // Still the original content.
    expect(svc.getResolver(ID)!.current().definition.name).toBe('A')
  })

  // --- publish an edit -----------------------------------------------------

  it('publish of an edit appends rev2 and repoints the SAME runner', async () => {
    await svc.adopt(def('A'))
    const before = runnerOn(hub)
    expect(before?.definition.name).toBe('A')

    const record = await svc.publish(ID, { definition: def('B') })
    expect(record.headRevision).toBe(2)
    expect(record.currentRevision).toBe(2)
    expect(record.revisions).toHaveLength(2)
    expect(record.revisions[1]).toMatchObject({ revision: 2, origin: 'publish' })
    expect(record.state).toBe('published')

    // No re-registration: same participant object, but it now resolves rev2.
    const after = runnerOn(hub)
    expect(after).toBe(before)
    expect(after?.definition.name).toBe('B')
    // A history entry logs the publish transition.
    expect(record.history.at(-1)).toMatchObject({ action: 'publish', to: 'published' })
  })

  it('no-op publish of identical content does NOT append a revision', async () => {
    await svc.adopt(def('A'))
    const record = await svc.publish(ID, { definition: def('A') }) // same hash
    expect(record.headRevision).toBe(1)
    expect(record.revisions).toHaveLength(1)
    expect(record.currentRevision).toBe(1)
  })

  it('publish rejects a changed trigger capability (capability_immutable)', async () => {
    await svc.adopt(def('A'))
    const moved = def('A', { trigger: { capability: 'run-other' } })
    await expect(svc.publish(ID, { definition: moved })).rejects.toMatchObject({
      code: 'capability_immutable',
    })
    // Unchanged: still rev1 on the original capability.
    const view = await svc.getState(ID)
    expect(view.headRevision).toBe(1)
    expect(view.triggerCapability).toBe(CAP)
  })

  // --- deprecate / archive registration boundary ---------------------------

  it('deprecate keeps the runner registered; archive unregisters it', async () => {
    await svc.adopt(def('A'))
    expect(hub.registry.get(PID)).toBeDefined()

    const dep = await svc.deprecate(ID)
    expect(dep.state).toBe('deprecated')
    expect(hub.registry.get(PID)).toBeDefined() // deprecated is still live

    const arc = await svc.archive(ID)
    expect(arc.state).toBe('archived')
    expect(hub.registry.get(PID)).toBeUndefined() // archived → unregistered
  })

  it('rejects an illegal transition with illegal_transition', async () => {
    await svc.adopt(def('A')) // published
    // published → archive is not legal (must deprecate first).
    await expect(svc.archive(ID)).rejects.toMatchObject({ code: 'illegal_transition' })
    expect(svc.getResolver(ID)).not.toBeNull()
    expect((await svc.getState(ID)).state).toBe('published')
  })

  // --- rollback ------------------------------------------------------------

  it('rollback clones the target as head+1 with an equal content hash', async () => {
    await svc.adopt(def('A')) // rev1
    await svc.publish(ID, { definition: def('B') }) // rev2, current=2

    const record = await svc.rollback(ID, { targetRevision: 1 })
    expect(record.state).toBe('published')
    expect(record.headRevision).toBe(3)
    expect(record.currentRevision).toBe(3)
    expect(record.revisions).toHaveLength(3)
    expect(record.revisions[2]).toMatchObject({
      revision: 3,
      origin: 'rollback',
      rolledBackFrom: 1,
    })

    const resolver = svc.getResolver(ID)!
    // rev3 content equals rev1 content (it was cloned).
    expect(resolver.byRevision(3).name).toBe('A')
    expect(hashDefinition(resolver.byRevision(3))).toBe(hashDefinition(resolver.byRevision(1)))
    // The live runner now resolves the rolled-back content.
    expect(runnerOn(hub)?.definition.name).toBe('A')
  })

  it('rollback to a non-existent revision throws revision_missing', async () => {
    await svc.adopt(def('A'))
    await expect(svc.rollback(ID, { targetRevision: 9 })).rejects.toBeInstanceOf(
      WorkflowRevisionError,
    )
  })

  // --- saveDraft (opt-in, not live) ----------------------------------------

  it('saveDraft creates a draft that is NOT registered, then publish goes live', async () => {
    const record = await svc.saveDraft(def('A'))
    expect(record.state).toBe('draft')
    expect(record.currentRevision).toBeUndefined() // nothing published yet
    expect(record.headRevision).toBe(1)
    expect(hub.registry.get(PID)).toBeUndefined() // draft is not live

    const view = await svc.getState(ID)
    expect(view.currentRevision).toBeUndefined()
    expect(view.legalActions).toContain('publish')
    expect(view.legalActions).toContain('submitReview')

    // draft → review → published.
    await svc.submitReview(ID)
    expect(hub.registry.get(PID)).toBeUndefined() // review still not live
    const pub = await svc.publish(ID)
    expect(pub.state).toBe('published')
    expect(pub.currentRevision).toBe(1) // promoted the draft head
    expect(hub.registry.get(PID)).toBeDefined()
  })

  it('saveDraft over a published workflow is illegal (use publish to edit)', async () => {
    await svc.adopt(def('A'))
    await expect(svc.saveDraft(def('B'))).rejects.toMatchObject({
      code: 'illegal_transition',
    })
  })

  it('saveDraft twice on a draft appends a new head, dedupes identical content', async () => {
    await svc.saveDraft(def('A'))
    const same = await svc.saveDraft(def('A')) // identical → no new rev
    expect(same.headRevision).toBe(1)
    const edited = await svc.saveDraft(def('B')) // changed → rev2
    expect(edited.headRevision).toBe(2)
    expect(edited.state).toBe('draft')
  })

  // --- reads ---------------------------------------------------------------

  it('getState / listRevisions throw unknown_workflow for an absent id', async () => {
    await expect(svc.getState('ghost')).rejects.toMatchObject({ code: 'unknown_workflow' })
    await expect(svc.listRevisions('ghost')).rejects.toMatchObject({
      code: 'unknown_workflow',
    })
  })

  it('listRevisions returns metadata ascending', async () => {
    await svc.adopt(def('A'))
    await svc.publish(ID, { definition: def('B') })
    const metas = await svc.listRevisions(ID)
    expect(metas.map((m) => m.revision)).toEqual([1, 2])
    expect((metas[0] as Record<string, unknown>).definition).toBeUndefined()
  })

  // --- persistence / restart ----------------------------------------------

  it('hydrate on a fresh service+hub re-loads state and re-registers live runners', async () => {
    await svc.adopt(def('A'))
    await svc.publish(ID, { definition: def('B') }) // rev2

    // Simulate a restart: brand-new hub + service over the same space root.
    const hub2 = new Hub({ storage: new InMemoryStorage() })
    await hub2.start()
    const svc2 = new WorkflowVersioning({ hub: hub2, spaceRoot: root })
    expect(hub2.registry.get(PID)).toBeUndefined() // nothing yet
    await svc2.hydrate()

    const view = await svc2.getState(ID)
    expect(view.state).toBe('published')
    expect(view.currentRevision).toBe(2)
    expect(view.headRevision).toBe(2)
    // The runner is live again and resolves the persisted current revision.
    const r2 = hub2.registry.get(PID)
    expect(r2).toBeInstanceOf(WorkflowRunner)
    expect((r2 as WorkflowRunner).definition.name).toBe('B')
    // Old revision is still resolvable (no drift on resume).
    expect(svc2.getResolver(ID)!.byRevision(1).name).toBe('A')

    await hub2.stop()
  })

  it('hydrate does NOT register a draft workflow', async () => {
    await svc.saveDraft(def('A'))
    const hub2 = new Hub({ storage: new InMemoryStorage() })
    await hub2.start()
    const svc2 = new WorkflowVersioning({ hub: hub2, spaceRoot: root })
    await svc2.hydrate()
    expect(hub2.registry.get(PID)).toBeUndefined()
    expect((await svc2.getState(ID)).state).toBe('draft')
    await hub2.stop()
  })

  // --- error types ---------------------------------------------------------

  it('throws typed WorkflowLifecycleError (not a bare Error)', async () => {
    await expect(svc.getState('ghost')).rejects.toBeInstanceOf(WorkflowLifecycleError)
  })
})
