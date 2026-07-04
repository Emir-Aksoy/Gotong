import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { FileLifecycleStore } from '../src/lifecycle-store.js'
import type { LifecycleRecord, LifecycleState } from '../src/lifecycle.js'

function record(workflowId: string, state: LifecycleState = 'published'): LifecycleRecord {
  return {
    workflowId,
    state,
    currentRevision: 1,
    headRevision: 1,
    triggerCapability: `run-${workflowId}`,
    revisions: [{ revision: 1, contentHash: 'h1', createdAt: 0, origin: 'import' }],
    history: [],
    updatedAt: 0,
  }
}

describe('FileLifecycleStore', () => {
  let root: string
  let store: FileLifecycleStore

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gotong-lc-'))
    store = new FileLifecycleStore(root)
    store.ensureDirs()
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('write then read round-trips a record', async () => {
    await store.write(record('wf'))
    const got = await store.read('wf')
    expect(got).toMatchObject({ workflowId: 'wf', state: 'published', currentRevision: 1 })
  })

  it('read returns null when absent', async () => {
    expect(await store.read('ghost')).toBeNull()
  })

  it('write overwrites (the record is mutable)', async () => {
    await store.write(record('wf', 'draft'))
    await store.write({ ...record('wf', 'published'), headRevision: 2, currentRevision: 2 })
    const got = await store.read('wf')
    expect(got!.state).toBe('published')
    expect(got!.currentRevision).toBe(2)
  })

  it('list returns every record', async () => {
    await store.write(record('a'))
    await store.write(record('b', 'draft'))
    const all = await store.list()
    expect(all.map((r) => r.workflowId).sort()).toEqual(['a', 'b'])
  })

  it('list is [] before anything is written', async () => {
    const empty = new FileLifecycleStore(mkdtempSync(join(tmpdir(), 'gotong-lc-empty-')))
    expect(await empty.list()).toEqual([])
  })

  it('remove deletes a record and is a no-op when absent', async () => {
    await store.write(record('wf'))
    expect(await store.read('wf')).toBeTruthy()
    await store.remove('wf')
    expect(await store.read('wf')).toBeNull()
    // No throw on a second remove.
    await expect(store.remove('wf')).resolves.toBeUndefined()
  })

  it('keys files by sanitised workflow id (colon → __)', async () => {
    await store.write(record('org:flow'))
    // Round-trips through the sanitised filename.
    expect((await store.read('org:flow'))!.workflowId).toBe('org:flow')
  })
})
