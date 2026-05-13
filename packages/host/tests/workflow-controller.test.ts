import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Hub, InMemoryStorage } from '@aipehub/core'

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

  it('createWorkflowController pre-populates from a boot report', async () => {
    // Drive the loader through a fake boot.
    const { mkdirSync, writeFileSync } = await import('node:fs')
    mkdirSync(definitionsDir, { recursive: true })
    writeFileSync(join(definitionsDir, 'editorial.yaml'), SAMPLE)
    const report = await loadWorkflows({ hub, dir: definitionsDir, spaceRoot: tmp })
    expect(report.loaded).toHaveLength(1)
    const c = createWorkflowController(
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
    })
    expect(list[0]!.file).toMatch(/editorial\.yaml$/)
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

  it('sanitises file name for ids containing colons', async () => {
    const c = new WorkflowController({ hub, definitionsDir, spaceRoot: tmp })
    const yaml = SAMPLE.replace('id: editorial', 'id: team:editorial')
    const summary = await c.importFromText(yaml)
    expect(summary.id).toBe('team:editorial')
    expect(summary.file).toMatch(/team__editorial\.yaml$/)
    expect(existsSync(summary.file!)).toBe(true)
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
})
