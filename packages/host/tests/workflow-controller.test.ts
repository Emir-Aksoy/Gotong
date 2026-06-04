import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Hub, HumanParticipant, InMemoryStorage } from '@aipehub/core'
import { NEVER_RESUME_AT } from '@aipehub/inbox'
import { RunStore } from '@aipehub/workflow'

import { WorkflowController, createWorkflowController } from '../src/workflow-controller.js'
import { loadWorkflows } from '../src/workflow-loader.js'

const SAMPLE = `
schema: aipehub.workflow/v1
workflow:
  id: editorial
  name: 中文编辑
  description: writer → reviewer
  trigger: { capability: run-editorial }
  steps:
    - id: draft
      dispatch:
        strategy: { kind: capability, capabilities: [draft] }
        payload: $trigger.payload
    - id: review
      dispatch:
        strategy: { kind: capability, capabilities: [review] }
        payload: { draft: $draft.output }
`

describe('WorkflowController', () => {
  let tmp: string
  let definitionsDir: string
  let hub: Hub

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'host-wf-ctrl-'))
    definitionsDir = join(tmp, 'workflows', 'definitions')
    hub = new Hub({ storage: new InMemoryStorage() })
    await hub.start()
  })
  afterEach(async () => {
    await hub.stop()
    rmSync(tmp, { recursive: true, force: true })
  })

  it('list() is empty when no workflows are loaded', async () => {
    const c = new WorkflowController({ hub, definitionsDir, spaceRoot: tmp })
    expect(await c.list()).toEqual([])
  })

  it('createWorkflowController adopts a boot report as published rev1', async () => {
    // Drive the loader through a fake boot.
    mkdirSync(definitionsDir, { recursive: true })
    writeFileSync(join(definitionsDir, 'editorial.yaml'), SAMPLE)
    const report = await loadWorkflows({ dir: definitionsDir })
    expect(report.loaded).toHaveLength(1)
    const c = await createWorkflowController(
      { hub, definitionsDir, spaceRoot: tmp },
      report,
    )
    const list = await c.list()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({
      id: 'editorial',
      participantId: 'workflow:editorial',
      triggerCapability: 'run-editorial',
      stepCount: 2,
      name: '中文编辑',
      description: 'writer → reviewer',
      state: 'published',
      currentRevision: 1,
    })
    expect(list[0]!.file).toMatch(/editorial\.yaml$/)
    // The versioning service registered a runner for it.
    expect(hub.registry.get('workflow:editorial')).toBeDefined()
  })

  it('listAll() includes drafts + archived (live → authoring → archived); list() stays live-only', async () => {
    const c = new WorkflowController({ hub, definitionsDir, spaceRoot: tmp })
    // A live published workflow.
    await c.importFromText(SAMPLE)
    // A saved draft whose id sorts BEFORE 'editorial' — proves the state rank,
    // not the id, drives the ordering (running workflows stay on top).
    await c.saveDraft(
      SAMPLE.replace('id: editorial', 'id: aaa-draft').replace('run-editorial', 'run-aaa'),
    )
    // An archived tombstone (published → deprecated → archived is the legal path).
    await c.importFromText(
      SAMPLE.replace('id: editorial', 'id: mmm-arch').replace('run-editorial', 'run-mmm'),
    )
    await c.deprecate('mmm-arch')
    await c.archive('mmm-arch')

    // list() — live only: the draft + the archived tombstone are absent.
    expect((await c.list()).map((w) => w.id)).toEqual(['editorial'])

    // listAll() — every state, running-first then authoring then archived.
    const all = await c.listAll()
    expect(all.map((w) => w.id)).toEqual(['editorial', 'aaa-draft', 'mmm-arch'])
    expect(all.map((w) => w.state)).toEqual(['published', 'draft', 'archived'])
    // A draft surfaces its head content but has no published-revision pointer.
    const draft = all.find((w) => w.id === 'aaa-draft')!
    expect(draft.currentRevision).toBeUndefined()
    expect(draft.stepCount).toBe(2)
  })

  it('importFromText() writes to disk and registers a runner', async () => {
    const c = new WorkflowController({ hub, definitionsDir, spaceRoot: tmp })
    const summary = await c.importFromText(SAMPLE)
    expect(summary.id).toBe('editorial')
    expect(summary.participantId).toBe('workflow:editorial')

    // file landed
    const filePath = join(definitionsDir, 'editorial.yaml')
    expect(existsSync(filePath)).toBe(true)
    expect(readFileSync(filePath, 'utf8')).toBe(SAMPLE)

    // runner registered
    const p = hub.registry.get('workflow:editorial')
    expect(p).toBeDefined()
    expect(p?.capabilities).toEqual(['run-editorial'])

    // tmp file cleaned up
    expect(existsSync(`${filePath}.tmp`)).toBe(false)
  })

  it('exportDefinitionText() returns the authored YAML verbatim; null for unknown id (v5 B-M2)', async () => {
    const c = new WorkflowController({ hub, definitionsDir, spaceRoot: tmp })
    // Unknown before import — no silent empty string.
    expect(await c.exportDefinitionText('editorial')).toBeNull()
    await c.importFromText(SAMPLE)
    // After import, the on-disk text comes back byte-for-byte (no re-emit drift),
    // so a template embedding it is guaranteed to re-parse.
    expect(await c.exportDefinitionText('editorial')).toBe(SAMPLE)
    expect(await c.exportDefinitionText('ghost')).toBeNull()
  })

  it('importFromText() rejects duplicate ids', async () => {
    const c = new WorkflowController({ hub, definitionsDir, spaceRoot: tmp })
    await c.importFromText(SAMPLE)
    await expect(c.importFromText(SAMPLE)).rejects.toThrow(/already loaded/)
  })

  it('importFromText() surfaces schema errors verbatim (no file written)', async () => {
    const c = new WorkflowController({ hub, definitionsDir, spaceRoot: tmp })
    await expect(c.importFromText('not a workflow')).rejects.toThrow()
    // definitions dir might not even exist yet
    if (existsSync(definitionsDir)) {
      const { readdirSync } = await import('node:fs')
      expect(readdirSync(definitionsDir)).toEqual([])
    }
  })

  it('importFromText() rejects workflows that dispatch to their own trigger capability', async () => {
    const c = new WorkflowController({ hub, definitionsDir, spaceRoot: tmp })
    const yaml = `
schema: aipehub.workflow/v1
workflow:
  id: loop
  trigger: { capability: loop:start }
  steps:
    - id: again
      dispatch:
        strategy: { kind: capability, capabilities: [loop:start] }
        payload: {}
`
    await expect(c.importFromText(yaml)).rejects.toThrow(/self-trigger cycle/i)
    expect(hub.registry.get('workflow:loop')).toBeUndefined()
    expect(existsSync(definitionsDir)).toBe(false)
  })

  it('sanitises file name for ids containing colons', async () => {
    const c = new WorkflowController({ hub, definitionsDir, spaceRoot: tmp })
    const yaml = SAMPLE.replace('id: editorial', 'id: team:editorial')
    const summary = await c.importFromText(yaml)
    expect(summary.id).toBe('team:editorial')
    expect(summary.file).toMatch(/team__editorial\.yaml$/)
    expect(existsSync(summary.file!)).toBe(true)
  })

  it('toSummary passes through the workflow surface.me block (Phase 14)', async () => {
    const c = new WorkflowController({ hub, definitionsDir, spaceRoot: tmp })
    const withSurface = SAMPLE.replace(
      'trigger: { capability: run-editorial }',
      `trigger: { capability: run-editorial }
  surface:
    me:
      enabled: true
      label: 编辑工作台
      allowed_roles: [owner, admin, member]
      user_scope_field: owner_user_id`,
    )
    const summary = await c.importFromText(withSurface)
    expect(summary.surfaceMe).toEqual({
      enabled: true,
      label: '编辑工作台',
      allowedRoles: ['owner', 'admin', 'member'],
      userScopeField: 'owner_user_id',
    })
    expect((await c.list())[0]!.surfaceMe).toBeDefined()
  })

  it('toSummary omits surfaceMe when the workflow declares no surface', async () => {
    const c = new WorkflowController({ hub, definitionsDir, spaceRoot: tmp })
    const summary = await c.importFromText(SAMPLE)
    expect(summary.surfaceMe).toBeUndefined()
  })

  it('toSummary passes through the workflow governance block (Phase 19 P5)', async () => {
    const c = new WorkflowController({ hub, definitionsDir, spaceRoot: tmp })
    const withGov = SAMPLE.replace(
      'trigger: { capability: run-editorial }',
      `trigger: { capability: run-editorial }
  governance:
    data_sensitivity: confidential
    required_credentials: [anthropic]
    expected_cost_usd: 0.05
    external_systems: [chroma-mcp]`,
    )
    const summary = await c.importFromText(withGov)
    expect(summary.governance).toEqual({
      dataSensitivity: 'confidential',
      requiredCredentials: ['anthropic'],
      expectedCostUsd: 0.05,
      externalSystems: ['chroma-mcp'],
    })
    expect((await c.list())[0]!.governance).toBeDefined()
  })

  it('toSummary omits governance when the workflow declares none', async () => {
    const c = new WorkflowController({ hub, definitionsDir, spaceRoot: tmp })
    const summary = await c.importFromText(SAMPLE)
    expect(summary.governance).toBeUndefined()
  })

  describe('lifecycle (Phase 15)', () => {
    it('importFromText adopts as published rev1', async () => {
      const c = new WorkflowController({ hub, definitionsDir, spaceRoot: tmp })
      const summary = await c.importFromText(SAMPLE)
      expect(summary.state).toBe('published')
      expect(summary.currentRevision).toBe(1)
      const view = await c.getState('editorial')
      expect(view).toMatchObject({ state: 'published', currentRevision: 1, headRevision: 1 })
      expect(view.registered).toBe(true)
    })

    it('saveDraft creates a draft that is NOT registered and NOT in list()', async () => {
      const c = new WorkflowController({ hub, definitionsDir, spaceRoot: tmp })
      const summary = await c.saveDraft(SAMPLE)
      expect(summary.state).toBe('draft')
      expect(summary.currentRevision).toBeUndefined()
      // Not live → no runner, absent from the workflow list.
      expect(hub.registry.get('workflow:editorial')).toBeUndefined()
      expect(await c.list()).toEqual([])
      // But its YAML mirror is on disk and getState sees it.
      expect(existsSync(join(definitionsDir, 'editorial.yaml'))).toBe(true)
      expect((await c.getState('editorial')).state).toBe('draft')
    })

    it('publish promotes a draft → registered + in list()', async () => {
      const c = new WorkflowController({ hub, definitionsDir, spaceRoot: tmp })
      await c.saveDraft(SAMPLE)
      const summary = await c.publish('editorial')
      expect(summary.state).toBe('published')
      expect(summary.currentRevision).toBe(1)
      expect(hub.registry.get('workflow:editorial')).toBeDefined()
      const list = await c.list()
      expect(list.map((w) => w.id)).toEqual(['editorial'])
    })

    it('publish an edit appends rev2 and refreshes the YAML mirror', async () => {
      const c = new WorkflowController({ hub, definitionsDir, spaceRoot: tmp })
      await c.importFromText(SAMPLE)
      const edited = SAMPLE.replace('name: 中文编辑', 'name: 编辑 v2')
      const summary = await c.publish('editorial', { text: edited })
      expect(summary.currentRevision).toBe(2)
      expect(summary.name).toBe('编辑 v2')
      // The on-disk mirror now reflects the published edit.
      expect(readFileSync(join(definitionsDir, 'editorial.yaml'), 'utf8')).toBe(edited)
      const revs = await c.listRevisions('editorial')
      expect(revs.map((r) => r.revision)).toEqual([1, 2])
    })

    it('deprecate stays in list(); archive drops out of list()', async () => {
      const c = new WorkflowController({ hub, definitionsDir, spaceRoot: tmp })
      await c.importFromText(SAMPLE)
      await c.deprecate('editorial')
      expect((await c.list()).map((w) => w.id)).toEqual(['editorial']) // deprecated is live
      expect((await c.list())[0]!.state).toBe('deprecated')
      await c.archive('editorial')
      expect(await c.list()).toEqual([]) // archived → not live
      expect(hub.registry.get('workflow:editorial')).toBeUndefined()
    })

    it('rollback re-points current to an earlier revision', async () => {
      const c = new WorkflowController({ hub, definitionsDir, spaceRoot: tmp })
      await c.importFromText(SAMPLE) // rev1
      await c.publish('editorial', { text: SAMPLE.replace('中文编辑', 'v2') }) // rev2
      const summary = await c.rollback('editorial', { targetRevision: 1 })
      expect(summary.currentRevision).toBe(3) // append-only clone of rev1
      expect(summary.name).toBe('中文编辑') // back to rev1 content
      expect(summary.state).toBe('published')
    })
  })

  describe('remove()', () => {
    it('unregisters the runner and deletes the YAML file', async () => {
      const c = new WorkflowController({ hub, definitionsDir, spaceRoot: tmp })
      const summary = await c.importFromText(SAMPLE)
      expect(hub.registry.get('workflow:editorial')).toBeDefined()
      expect(existsSync(summary.file!)).toBe(true)

      await c.remove('editorial')

      expect(hub.registry.get('workflow:editorial')).toBeUndefined()
      expect(existsSync(summary.file!)).toBe(false)
      expect(await c.list()).toEqual([])
    })

    it('throws on unknown id', async () => {
      const c = new WorkflowController({ hub, definitionsDir, spaceRoot: tmp })
      await expect(c.remove('nope')).rejects.toThrow(/not loaded/)
    })

    it('allows re-importing after removal', async () => {
      const c = new WorkflowController({ hub, definitionsDir, spaceRoot: tmp })
      await c.importFromText(SAMPLE)
      await c.remove('editorial')
      // No longer in the way — reimport should succeed.
      const summary = await c.importFromText(SAMPLE)
      expect(summary.id).toBe('editorial')
      expect(hub.registry.get('workflow:editorial')).toBeDefined()
    })
  })

  describe('listRuns() / readRun() — run history pass-through', () => {
    // The controller is a thin wrapper around RunStore — these tests
    // just confirm the wiring is correct (data flows in/out, the
    // workflowId filter is honoured, missing ids return null).

    it('returns runs written through the same space root', async () => {
      const store = new RunStore(tmp)
      store.ensureDirs()
      await store.write({
        runId: 'r_1',
        workflowId: 'editorial',
        triggeredByTaskId: 't_1',
        triggerPayload: { topic: 'hi' },
        steps: [],
        startedAt: 100,
        endedAt: 200,
        status: 'done',
      })
      await store.write({
        runId: 'r_2',
        workflowId: 'other',
        triggeredByTaskId: 't_2',
        triggerPayload: {},
        steps: [],
        startedAt: 300,
        status: 'running',
      })

      const c = new WorkflowController({ hub, definitionsDir, spaceRoot: tmp })

      const all = await c.listRuns()
      expect(all.map((r) => r.runId)).toEqual(['r_2', 'r_1'])

      const onlyEditorial = await c.listRuns({ workflowId: 'editorial' })
      expect(onlyEditorial.map((r) => r.runId)).toEqual(['r_1'])
    })

    it('resumeRunningRuns() abandons runs whose workflow is no longer loaded', async () => {
      // Drop a "running" run on disk for a workflow id that we never
      // import — controller should close it out as failed.
      const store = new RunStore(tmp)
      store.ensureDirs()
      await store.write({
        runId: 'r_orphan',
        workflowId: 'long-gone',
        triggeredByTaskId: 't_orphan',
        triggerPayload: {},
        steps: [],
        startedAt: 1,
        status: 'running',
      })

      const c = new WorkflowController({ hub, definitionsDir, spaceRoot: tmp })
      const r = await c.resumeRunningRuns()
      expect(r).toEqual({ resumed: 0, abandoned: 1, parked: 0 })

      const recovered = await c.readRun('r_orphan')
      expect(recovered).not.toBeNull()
      expect(recovered!.status).toBe('failed')
      expect(recovered!.error).toMatch(/no longer loaded/)
      expect(recovered!.endedAt).toBeDefined()
    })

    it('resumeRunningRuns() skips runs that already reached a terminal status', async () => {
      const store = new RunStore(tmp)
      store.ensureDirs()
      // One done, one failed — neither should be touched.
      await store.write({
        runId: 'r_done',
        workflowId: 'editorial',
        triggeredByTaskId: 't_d',
        triggerPayload: {},
        steps: [],
        startedAt: 1,
        endedAt: 2,
        status: 'done',
        finalOutput: 'kept',
      })
      await store.write({
        runId: 'r_failed',
        workflowId: 'editorial',
        triggeredByTaskId: 't_f',
        triggerPayload: {},
        steps: [],
        startedAt: 1,
        endedAt: 2,
        status: 'failed',
        error: 'original error',
      })

      const c = new WorkflowController({ hub, definitionsDir, spaceRoot: tmp })
      const r = await c.resumeRunningRuns()
      expect(r).toEqual({ resumed: 0, abandoned: 0, parked: 0 })

      const done = await c.readRun('r_done')
      expect(done!.status).toBe('done')
      expect(done!.finalOutput).toBe('kept')

      const failed = await c.readRun('r_failed')
      expect(failed!.status).toBe('failed')
      expect(failed!.error).toBe('original error')
    })

    it('resumeRunningRuns() skips runs parked on a human-inbox step (NEVER_RESUME_AT)', async () => {
      // Audit M5 — a run waiting on a human-inbox decision stays `status:
      // 'running'` (RunStatus has no run-level 'suspended'); its step is
      // `status: 'suspended', resumeAt: NEVER_RESUME_AT`. Boot must NOT re-drive
      // it: the inbox-resolve path owns that run via the parked task's own
      // suspended_tasks row. Re-driving here would re-read the unresolved child
      // and race the resolve. This pins the skip — both runs target a LIVE
      // workflow, so WITHOUT the skip the parked run would be resumed too
      // (resumed: 2, no `parked` field).
      const c = new WorkflowController({ hub, definitionsDir, spaceRoot: tmp })
      await c.importFromText(SAMPLE) // registers a live workflow:editorial runner

      const store = new RunStore(tmp)
      store.ensureDirs()
      // Parked: a human-inbox step suspended forever.
      await store.write({
        runId: 'r_parked',
        workflowId: 'editorial',
        triggeredByTaskId: 't_parked',
        triggerPayload: {},
        steps: [
          {
            stepId: 'review',
            startedAt: 1,
            status: 'suspended',
            resumeAt: NEVER_RESUME_AT,
            attempts: 1,
          },
        ],
        startedAt: 1,
        status: 'running',
      })
      // A normal running run with no parked step — must still be resumed.
      await store.write({
        runId: 'r_live',
        workflowId: 'editorial',
        triggeredByTaskId: 't_live',
        triggerPayload: {},
        steps: [],
        startedAt: 1,
        status: 'running',
      })

      const r = await c.resumeRunningRuns()
      // The parked run is counted + skipped; the normal run is resumed.
      expect(r).toEqual({ resumed: 1, abandoned: 0, parked: 1 })

      // The parked run is untouched: still running, step still suspended forever.
      const parked = await c.readRun('r_parked')
      expect(parked!.status).toBe('running')
      expect(parked!.steps[0]!.status).toBe('suspended')
      expect(parked!.steps[0]!.resumeAt).toBe(NEVER_RESUME_AT)
    })

    it('readRun() returns the full state, or null when missing', async () => {
      const store = new RunStore(tmp)
      store.ensureDirs()
      await store.write({
        runId: 'r_x',
        workflowId: 'editorial',
        triggeredByTaskId: 't_x',
        triggerPayload: { hi: 1 },
        steps: [
          { stepId: 'draft', startedAt: 1, endedAt: 2, status: 'done', attempts: 1, subTaskIds: ['sub_a'], output: 'ok' },
        ],
        startedAt: 1,
        endedAt: 3,
        status: 'done',
        finalOutput: 'final',
      })

      const c = new WorkflowController({ hub, definitionsDir, spaceRoot: tmp })

      const got = await c.readRun('r_x')
      expect(got).not.toBeNull()
      expect(got!.runId).toBe('r_x')
      expect(got!.steps).toHaveLength(1)
      expect(got!.finalOutput).toBe('final')

      expect(await c.readRun('nope')).toBeNull()
    })
  })

  // P2-M1 — runtime-aware structural gate on import / draft / publish.
  describe('structural deep-check gate (P2-M1)', () => {
    // bad_ref: a step payload references a step that doesn't exist. Pure
    // structural → rejected on every path, even with no agents registered.
    const BAD_REF = `
schema: aipehub.workflow/v1
workflow:
  id: bad-ref-wf
  trigger: { capability: badref:start }
  steps:
    - id: only
      dispatch:
        strategy: { kind: capability, capabilities: [whatever] }
        payload: { x: $ghost.output }
`
    // forward_ref: 'first' references 'second.output', but 'second' runs later.
    const FORWARD_REF = `
schema: aipehub.workflow/v1
workflow:
  id: fwd-ref-wf
  trigger: { capability: fwd:start }
  steps:
    - id: first
      dispatch:
        strategy: { kind: capability, capabilities: [a] }
        payload: { x: $second.output }
    - id: second
      dispatch:
        strategy: { kind: capability, capabilities: [b] }
        payload: {}
`
    // unknown_agent: explicit dispatch at an id that isn't registered.
    const NEEDS_GHOST = `
schema: aipehub.workflow/v1
workflow:
  id: needs-ghost
  trigger: { capability: ghost:start }
  steps:
    - id: only
      dispatch:
        strategy: { kind: explicit, to: ghost-agent }
        payload: $trigger.payload
`

    it('rejects a bad_ref workflow at import, carrying code + violations', async () => {
      const c = new WorkflowController({ hub, definitionsDir, spaceRoot: tmp })
      let caught: unknown
      await c.importFromText(BAD_REF).catch((e) => {
        caught = e
      })
      expect(caught).toBeInstanceOf(Error)
      expect((caught as { code?: string }).code).toBe('structure_check_failed')
      // Structured violations ride along so the web layer can surface them.
      const violations = (caught as { violations?: Array<{ kind: string }> }).violations
      expect(Array.isArray(violations)).toBe(true)
      expect(violations!.some((v) => v.kind === 'bad_ref')).toBe(true)
      // Nothing registered / written on a rejected import.
      expect(hub.registry.get('workflow:bad-ref-wf')).toBeUndefined()
    })

    it('rejects a forward_ref workflow at import (hard)', async () => {
      const c = new WorkflowController({ hub, definitionsDir, spaceRoot: tmp })
      await expect(c.importFromText(FORWARD_REF)).rejects.toMatchObject({
        code: 'structure_check_failed',
      })
      expect(hub.registry.get('workflow:fwd-ref-wf')).toBeUndefined()
    })

    it('unknown_capability is advisory — import succeeds even when no agent satisfies the cap', async () => {
      // A registered participant makes the inventory non-empty (haveInventory),
      // so the checker DOES evaluate capability satisfaction — yet it must not
      // block: importing a workflow before its agents exist is legitimate.
      hub.register(new HumanParticipant({ id: 'helper', capabilities: ['help'] }))
      const c = new WorkflowController({ hub, definitionsDir, spaceRoot: tmp })
      // SAMPLE dispatches [draft]/[review] — neither satisfied by 'helper'.
      const summary = await c.importFromText(SAMPLE)
      expect(summary.id).toBe('editorial')
      expect(hub.registry.get('workflow:editorial')).toBeDefined()
    })

    it('unknown_agent: a draft may carry it, but publish (go-live) is blocked', async () => {
      // haveInventory true so the explicit-target check actually runs.
      hub.register(new HumanParticipant({ id: 'helper', capabilities: ['help'] }))
      const c = new WorkflowController({ hub, definitionsDir, spaceRoot: tmp })

      // Draft tolerates the unknown_agent warning → saved.
      const draft = await c.saveDraft(NEEDS_GHOST)
      expect(draft.state).toBe('draft')
      expect((await c.getState('needs-ghost')).state).toBe('draft')

      // Promoting it to live re-checks the head definition and blocks.
      let caught: unknown
      await c.publish('needs-ghost').catch((e) => {
        caught = e
      })
      expect((caught as { code?: string }).code).toBe('structure_check_failed')
      const violations = (caught as { violations?: Array<{ kind: string }> }).violations
      expect(violations!.some((v) => v.kind === 'unknown_agent')).toBe(true)
      // The failed publish left it a draft, unregistered.
      expect((await c.getState('needs-ghost')).state).toBe('draft')
      expect(hub.registry.get('workflow:needs-ghost')).toBeUndefined()
    })
  })

  // Stream G G2-M3 — cross-hub step flagging, through the REAL controller path
  // (importFromText → versioning → summaryFromView → computeCrossHubSteps). The
  // peer-capability view is an INJECTED stub: it's a duck-typed seam built for
  // injection, so this proves the projection without standing up a
  // transport-level 2-hub link (that's covered by cross-hub-workflow-e2e). The
  // pure detector itself is unit-tested in cross-hub-steps.test.ts.
  describe('cross-hub step flagging (Stream G G2)', () => {
    // One LOCAL step (draft-order) + one PEER-only step (supplier.confirm-order).
    const SUPPLY = `
schema: aipehub.workflow/v1
workflow:
  id: supply
  name: 补货
  trigger: { capability: run-supply }
  steps:
    - id: draft
      dispatch:
        strategy: { kind: capability, capabilities: [draft-order] }
        payload: {}
    - id: place
      dispatch:
        strategy: { kind: capability, capabilities: [supplier.confirm-order] }
        payload: {}
`
    const peerView = (caps: string[]) => ({
      peerCapabilities: () => [
        { peer: 'supplier-hub', label: '供货商', capabilities: caps },
      ],
    })

    it('flags the peer-served step, not the locally-served one', async () => {
      hub.register(new HumanParticipant({ id: 'buyer', capabilities: ['draft-order'] }))
      const c = new WorkflowController({
        hub,
        definitionsDir,
        spaceRoot: tmp,
        peerCapabilities: peerView(['supplier.confirm-order']),
      })
      const summary = await c.importFromText(SUPPLY)
      expect(summary.crossHubSteps).toEqual([
        { stepId: 'place', capability: 'supplier.confirm-order', peer: 'supplier-hub', peerLabel: '供货商' },
      ])
    })

    it('does not flag a cap a local participant also serves (routes locally)', async () => {
      hub.register(new HumanParticipant({ id: 'buyer', capabilities: ['draft-order'] }))
      hub.register(new HumanParticipant({ id: 'local-supplier', capabilities: ['supplier.confirm-order'] }))
      const c = new WorkflowController({
        hub,
        definitionsDir,
        spaceRoot: tmp,
        peerCapabilities: peerView(['supplier.confirm-order']),
      })
      const summary = await c.importFromText(SUPPLY)
      expect(summary.crossHubSteps).toBeUndefined()
    })

    it('omits the field entirely when no peer view is wired (single-hub)', async () => {
      hub.register(new HumanParticipant({ id: 'buyer', capabilities: ['draft-order'] }))
      const c = new WorkflowController({ hub, definitionsDir, spaceRoot: tmp })
      const summary = await c.importFromText(SUPPLY)
      expect(summary.crossHubSteps).toBeUndefined()
    })
  })
})
