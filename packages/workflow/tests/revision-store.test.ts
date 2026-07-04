import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { FileRevisionStore, hashDefinition } from '../src/revision-store.js'
import { WorkflowRevisionError, type WorkflowRevision } from '../src/lifecycle.js'
import { WORKFLOW_SCHEMA_V1, type WorkflowDefinition } from '../src/types.js'

function def(over: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    schema: WORKFLOW_SCHEMA_V1,
    id: 'demo-flow',
    trigger: { capability: 'run-demo' },
    steps: [
      {
        id: 's1',
        dispatch: { strategy: { kind: 'capability', capabilities: ['do'] }, payload: {} },
      },
    ],
    ...over,
  }
}

function revision(rev: number, d: WorkflowDefinition, over: Partial<WorkflowRevision> = {}): WorkflowRevision {
  return {
    revision: rev,
    contentHash: hashDefinition(d),
    createdAt: rev * 1000,
    origin: 'import',
    definition: d,
    ...over,
  }
}

describe('FileRevisionStore', () => {
  let root: string
  let store: FileRevisionStore

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gotong-rev-'))
    store = new FileRevisionStore(root)
    store.ensureDirs()
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('write then read round-trips a revision', async () => {
    const d = def()
    await store.write(revision(1, d))
    const got = await store.read('demo-flow', 1)
    expect(got).toBeTruthy()
    expect(got!.revision).toBe(1)
    expect(got!.definition.id).toBe('demo-flow')
    expect(got!.contentHash).toBe(hashDefinition(d))
  })

  it('read returns null for a missing revision', async () => {
    expect(await store.read('demo-flow', 7)).toBeNull()
    expect(await store.read('no-such', 1)).toBeNull()
  })

  it('is write-once — refuses to overwrite an existing revision', async () => {
    await store.write(revision(1, def()))
    try {
      await store.write(revision(1, def({ name: 'edited' })))
      throw new Error('expected write to throw')
    } catch (err) {
      expect(err).toBeInstanceOf(WorkflowRevisionError)
      expect((err as WorkflowRevisionError).code).toBe('revision_exists')
    }
    // The original is untouched.
    const got = await store.read('demo-flow', 1)
    expect(got!.definition.name).toBeUndefined()
  })

  it('nextRevisionNumber starts at 1 and increments past the max', async () => {
    expect(await store.nextRevisionNumber('demo-flow')).toBe(1)
    await store.write(revision(1, def()))
    expect(await store.nextRevisionNumber('demo-flow')).toBe(2)
    await store.write(revision(2, def({ name: 'v2' })))
    await store.write(revision(3, def({ name: 'v3' })))
    expect(await store.nextRevisionNumber('demo-flow')).toBe(4)
  })

  it('list returns metadata only, sorted ascending', async () => {
    await store.write(revision(2, def({ name: 'v2' })))
    await store.write(revision(1, def()))
    await store.write(revision(3, def({ name: 'v3' }), { origin: 'rollback', rolledBackFrom: 1 }))
    const metas = await store.list('demo-flow')
    expect(metas.map((m) => m.revision)).toEqual([1, 2, 3])
    // No heavy definition blob leaks into the metadata list.
    expect((metas[0] as Record<string, unknown>).definition).toBeUndefined()
    expect(metas[2]).toMatchObject({ origin: 'rollback', rolledBackFrom: 1 })
  })

  it('list returns [] for an unknown workflow', async () => {
    expect(await store.list('ghost')).toEqual([])
  })

  it('keeps revisions of different workflows in separate dirs', async () => {
    await store.write(revision(1, def({ id: 'a' })))
    await store.write(revision(1, def({ id: 'b' })))
    expect((await store.read('a', 1))!.definition.id).toBe('a')
    expect((await store.read('b', 1))!.definition.id).toBe('b')
  })
})

describe('hashDefinition', () => {
  it('is stable across key-ordering / re-serialization', () => {
    const a: WorkflowDefinition = {
      schema: WORKFLOW_SCHEMA_V1,
      id: 'x',
      name: 'X',
      trigger: { capability: 'c' },
      steps: [{ id: 's', dispatch: { strategy: { kind: 'capability', capabilities: ['d'] }, payload: { a: 1, b: 2 } } }],
    }
    // Same content, different key insertion order.
    const b: WorkflowDefinition = {
      id: 'x',
      steps: [{ dispatch: { payload: { b: 2, a: 1 }, strategy: { capabilities: ['d'], kind: 'capability' } }, id: 's' }],
      trigger: { capability: 'c' },
      name: 'X',
      schema: WORKFLOW_SCHEMA_V1,
    } as WorkflowDefinition
    expect(hashDefinition(a)).toBe(hashDefinition(b))
  })

  it('differs when content differs', () => {
    expect(hashDefinition(def())).not.toBe(hashDefinition(def({ name: 'changed' })))
  })
})
