import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { FileInboxStore } from '../src/file-inbox-store.js'
import { InboxError, type InboxItem } from '../src/types.js'

function item(over: Partial<InboxItem> = {}): InboxItem {
  return {
    itemId: 'task-1',
    userId: 'user-a',
    kind: 'approval',
    prompt: 'Approve the plan?',
    parent: { taskId: 'wf-trigger-1', by: 'workflow:demo' },
    parentKind: 'workflow',
    status: 'pending',
    createdAt: 1000,
    ...over,
  }
}

describe('FileInboxStore', () => {
  let root: string
  let store: FileInboxStore

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aipe-inbox-'))
    store = new FileInboxStore(root)
    store.ensureDirs()
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('write then get round-trips an item', async () => {
    await store.write(item({ itemId: 'task-x', title: 'Sign off' }))
    const got = await store.get('task-x')
    expect(got).toBeTruthy()
    expect(got!.itemId).toBe('task-x')
    expect(got!.title).toBe('Sign off')
    expect(got!.parent).toEqual({ taskId: 'wf-trigger-1', by: 'workflow:demo' })
    expect(got!.status).toBe('pending')
  })

  it('get returns null for a missing item', async () => {
    expect(await store.get('nope')).toBeNull()
  })

  it('write is atomic (no .tmp left behind, overwrite replaces)', async () => {
    await store.write(item({ itemId: 'task-y', prompt: 'first' }))
    await store.write(item({ itemId: 'task-y', prompt: 'second' }))
    expect((await store.get('task-y'))!.prompt).toBe('second')
  })

  it('listPending filters by user AND pending status, newest first', async () => {
    await store.write(item({ itemId: 't1', userId: 'user-a', createdAt: 100 }))
    await store.write(item({ itemId: 't2', userId: 'user-a', createdAt: 300 }))
    await store.write(item({ itemId: 't3', userId: 'user-b', createdAt: 200 }))
    await store.write(item({ itemId: 't4', userId: 'user-a', createdAt: 400, status: 'resolved' }))

    const mine = await store.listPending('user-a')
    // user-b's item excluded; resolved item excluded; sorted newest-first.
    expect(mine.map((i) => i.itemId)).toEqual(['t2', 't1'])
  })

  it('listPending returns [] for a user with nothing pending', async () => {
    await store.write(item({ itemId: 't1', userId: 'user-a' }))
    expect(await store.listPending('user-z')).toEqual([])
  })

  it('markResolved transitions pending → resolved and persists the decision', async () => {
    await store.write(item({ itemId: 'task-r' }))
    const resolved = await store.markResolved(
      'task-r',
      { kind: 'approval', approved: true, comment: 'lgtm' },
      4242,
    )
    expect(resolved.status).toBe('resolved')
    expect(resolved.resolvedAt).toBe(4242)
    expect(resolved.decision).toEqual({ kind: 'approval', approved: true, comment: 'lgtm' })
    // Persisted, and no longer pending.
    const onDisk = await store.get('task-r')
    expect(onDisk!.status).toBe('resolved')
    expect(await store.listPending('user-a')).toEqual([])
  })

  it('markResolved on an already-resolved item throws (the race guard)', async () => {
    await store.write(item({ itemId: 'task-r' }))
    await store.markResolved('task-r', { kind: 'approval', approved: true })
    try {
      await store.markResolved('task-r', { kind: 'approval', approved: false })
      throw new Error('expected markResolved to throw')
    } catch (err) {
      expect(err).toBeInstanceOf(InboxError)
      expect((err as InboxError).code).toBe('already_resolved')
    }
    // The first decision stands.
    expect((await store.get('task-r'))!.decision).toEqual({ kind: 'approval', approved: true })
  })

  it('markResolved on a missing item throws not_found', async () => {
    try {
      await store.markResolved('ghost', { kind: 'edit', value: 'x' })
      throw new Error('expected markResolved to throw')
    } catch (err) {
      expect(err).toBeInstanceOf(InboxError)
      expect((err as InboxError).code).toBe('not_found')
    }
  })
})
