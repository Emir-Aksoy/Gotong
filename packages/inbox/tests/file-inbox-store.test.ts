import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
    root = mkdtempSync(join(tmpdir(), 'gotong-inbox-'))
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
    // inbox-gov M1 — the action trail is seeded with the resolve event; the
    // approval comment rides along as the note, the assignee is the actor.
    expect(resolved.history).toEqual([
      { type: 'resolved', actor: 'user-a', note: 'lgtm', at: 4242 },
    ])
    // Persisted, and no longer pending.
    const onDisk = await store.get('task-r')
    expect(onDisk!.status).toBe('resolved')
    expect(onDisk!.history).toHaveLength(1)
    expect(await store.listPending('user-a')).toEqual([])
  })

  it('markResolved seeds history without a note when the decision carries none', async () => {
    await store.write(item({ itemId: 'task-c', kind: 'choice', userId: 'user-a' }))
    const resolved = await store.markResolved('task-c', { kind: 'choice', value: 'b' }, 7)
    // No approval comment → the event has no `note` key at all (not `note: undefined`).
    expect(resolved.history).toEqual([{ type: 'resolved', actor: 'user-a', at: 7 }])
  })

  it('delegate reassigns a pending item + appends a delegated event (inbox-gov M2)', async () => {
    await store.write(item({ itemId: 'task-d', userId: 'user-a' }))
    const handed = await store.delegate('task-d', 'user-b', {
      actor: 'user-a',
      note: 'over to you',
      now: 99,
    })
    expect(handed.status).toBe('pending') // a handoff, not a resolve
    expect(handed.userId).toBe('user-b')
    expect(handed.history).toEqual([
      { type: 'delegated', actor: 'user-a', to: 'user-b', note: 'over to you', at: 99 },
    ])
    // Now visible to the new assignee only.
    expect((await store.listPending('user-b')).map((i) => i.itemId)).toEqual(['task-d'])
    expect(await store.listPending('user-a')).toEqual([])
  })

  it('delegate on an already-resolved item throws already_resolved', async () => {
    await store.write(item({ itemId: 'task-d2', userId: 'user-a' }))
    await store.markResolved('task-d2', { kind: 'approval', approved: true })
    try {
      await store.delegate('task-d2', 'user-b', { actor: 'user-a' })
      throw new Error('expected delegate to throw')
    } catch (err) {
      expect(err).toBeInstanceOf(InboxError)
      expect((err as InboxError).code).toBe('already_resolved')
    }
  })

  it('delegate on a missing item throws not_found', async () => {
    try {
      await store.delegate('ghost', 'user-b', { actor: 'user-a' })
      throw new Error('expected delegate to throw')
    } catch (err) {
      expect((err as InboxError).code).toBe('not_found')
    }
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

  // Audit M5 — the race guard is read-check-write, so two resolves issued in
  // the SAME tick (a double-click, or a request racing the resume sweep) can
  // both `get()` the pending item before either `write()`s, both pass the
  // pending check, and both go on to drive `hub.resumeTask` — a double resume.
  // The per-item serialization makes the read-check-write atomic in-process, so
  // the second op sees the first's `resolved` write and is rejected. These tests
  // PIN that: without `serialize()` both settle fulfilled (no `already_resolved`).
  it('two concurrent markResolved of one item: exactly one wins, one rejects', async () => {
    await store.write(item({ itemId: 'task-race' }))
    const results = await Promise.allSettled([
      store.markResolved('task-race', { kind: 'approval', approved: true }, 1),
      store.markResolved('task-race', { kind: 'approval', approved: false }, 2),
    ])
    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    const reason = (rejected[0] as PromiseRejectedResult).reason
    expect(reason).toBeInstanceOf(InboxError)
    expect((reason as InboxError).code).toBe('already_resolved')
    // Whichever won, the item ends resolved exactly once (single decision on disk).
    expect((await store.get('task-race'))!.status).toBe('resolved')
  })

  it('concurrent markResolved + delegate of one pending item: exactly one wins', async () => {
    await store.write(item({ itemId: 'task-race2', userId: 'user-a' }))
    const results = await Promise.allSettled([
      store.markResolved('task-race2', { kind: 'approval', approved: true }, 1),
      store.delegate('task-race2', 'user-b', { actor: 'user-a', now: 2 }),
    ])
    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')
    // Both mutations guard on `status === 'pending'`; serialization lets the
    // second see the first's write, so exactly one settles fulfilled.
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(InboxError)
  })

  // Route B P0-M5 — crash consistency (fault injection). write() is atomic
  // (`<file>.tmp` → rename), so a crash mid-write leaves at most an orphan
  // `<itemId>.json.tmp` that was never committed. These pin that listPending
  // ignores it. Falsifiable: drop the `.tmp` suffix skip and a fully-staged
  // orphan surfaces as a phantom inbox item; drop the per-file JSON catch and
  // one corrupt item file sinks the whole list.
  // Items live under `<spaceRoot>/inbox/` — inject crash artifacts there, not
  // at the space root (else listPending's readdir never sees them and the test
  // would pass vacuously even with the guard removed).
  const itemsDir = () => join(root, 'inbox')

  it('ignores an orphan .tmp (valid body) left by a crash before rename', async () => {
    await store.write(item({ itemId: 'task-ok', userId: 'user-a', createdAt: 100 }))

    // A crash after writeFile(tmp) but before rename leaves a complete,
    // parseable item under `.json.tmp`. The rename is the commit point and it
    // never happened, so this item must not appear to anyone.
    const orphan = item({ itemId: 'task-crash', userId: 'user-a', createdAt: 200 })
    writeFileSync(join(itemsDir(), 'task-crash.json.tmp'), JSON.stringify(orphan, null, 2), 'utf8')

    // Only the committed item is pending; the orphan is filtered by suffix.
    expect((await store.listPending('user-a')).map((i) => i.itemId)).toEqual(['task-ok'])
    // get() of the orphan id is null too — it was never committed at `.json`.
    expect(await store.get('task-crash')).toBeNull()
  })

  it('skips a corrupt item file instead of sinking the list', async () => {
    await store.write(item({ itemId: 'task-ok', userId: 'user-a' }))
    // A committed but unparseable `.json` (disk corruption / torn flush) must
    // not take down everyone else's pending items.
    writeFileSync(join(itemsDir(), 'task-bad.json'), '{ "itemId": "task-bad", trunc', 'utf8')

    expect((await store.listPending('user-a')).map((i) => i.itemId)).toEqual(['task-ok'])
  })
})
