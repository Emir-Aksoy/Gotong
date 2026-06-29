/**
 * Write-time reconciliation (decision A / 用户 Q1「调用-修正同步」) — the Mem0
 * ADD / UPDATE / DELETE / NOOP pattern at the turn boundary or heartbeat.
 *
 * Deterministic fakes only: the summarizer returns the ops JSON, so the
 * apply-and-crash-safety logic is provable without an LLM.
 */

import { describe, expect, it, vi } from 'vitest'

import {
  importanceOf,
  reconcile,
  reconcileReviewer,
  type ReconcileOp,
  type ReviewContext,
} from '../src/index.js'
import { entry, makeFakeMemory, type FakeMemory } from './fake-memory.js'

/** A summarizer that always returns the given ops as `{"ops":[...]}`. */
const opsSummarizer = (ops: ReconcileOp[]) => async () => JSON.stringify({ ops })
/** A summarizer returning a fixed raw string (for parse / fail-soft tests). */
const rawSummarizer = (raw: string) => async () => raw

const sem = (id: string, text: string, ts: number, importance?: number) =>
  entry(id, 'semantic', text, ts, importance !== undefined ? { importance } : undefined)

const semWith = (id: string, text: string, ts: number, meta: Record<string, unknown>) =>
  entry(id, 'semantic', text, ts, meta)

const textsOf = (mem: FakeMemory) =>
  mem.entries.filter((e) => e.kind === 'semantic').map((e) => e.text).sort()
const has = (mem: FakeMemory, id: string) => mem.entries.some((e) => e.id === id)

describe('reconcile', () => {
  it('ADD: a genuinely new candidate fact is remembered', async () => {
    const mem = makeFakeMemory([sem('s1', '喜欢珍珠奶茶', 100)])
    const r = await reconcile({
      memory: mem,
      summarize: opsSummarizer([{ op: 'add', text: '住在吉隆坡', importance: 4 }]),
      candidates: ['用户住在吉隆坡'],
    })
    expect(r).toMatchObject({ added: 1, updated: 0, deleted: 0 })
    const added = mem.entries.find((e) => e.text === '住在吉隆坡')!
    expect(added).toBeTruthy()
    expect(importanceOf(added)).toBe(4)
  })

  it('UPDATE: a candidate that refines an existing fact merges and keeps it bounded (old forgotten)', async () => {
    const mem = makeFakeMemory([sem('s1', '住在吉隆坡', 100, 3)])
    const r = await reconcile({
      memory: mem,
      summarize: opsSummarizer([{ op: 'update', id: 's1', text: '住在槟城（上周从吉隆坡搬来）' }]),
      candidates: ['上周搬到槟城'],
    })
    expect(r).toMatchObject({ updated: 1, added: 0, deleted: 0 })
    expect(has(mem, 's1')).toBe(false) // old forgotten
    const merged = mem.entries.find((e) => e.text.includes('槟城'))!
    expect(merged).toBeTruthy()
    expect(importanceOf(merged)).toBe(3) // importance carried from the superseded fact
  })

  it('UPDATE: explicit importance overrides the carried value', async () => {
    const mem = makeFakeMemory([sem('s1', 'fact', 100, 2)])
    await reconcile({
      memory: mem,
      summarize: opsSummarizer([{ op: 'update', id: 's1', text: 'fact v2', importance: 5 }]),
      candidates: ['x'],
    })
    expect(importanceOf(mem.entries.find((e) => e.text === 'fact v2')!)).toBe(5)
  })

  it('DELETE: a superseded fact is forgotten', async () => {
    const mem = makeFakeMemory([sem('s1', '在A公司工作', 100), sem('s2', '在B公司工作', 101)])
    const r = await reconcile({
      memory: mem,
      summarize: opsSummarizer([{ op: 'delete', id: 's1' }, { op: 'noop' }]),
      candidates: ['现在在 B 公司'],
    })
    expect(r).toMatchObject({ deleted: 1, nooped: 1 })
    expect(has(mem, 's1')).toBe(false)
    expect(has(mem, 's2')).toBe(true)
  })

  it('NOOP: an already-known candidate changes nothing', async () => {
    const mem = makeFakeMemory([sem('s1', '喜欢茶', 100)])
    const before = mem.entries.length
    const r = await reconcile({
      memory: mem,
      summarize: opsSummarizer([{ op: 'noop' }]),
      candidates: ['喜欢喝茶'],
    })
    expect(r).toMatchObject({ added: 0, updated: 0, deleted: 0, nooped: 1 })
    expect(mem.entries.length).toBe(before)
  })

  it('fail-soft: an unusable model response yields zero ops and changes nothing', async () => {
    const mem = makeFakeMemory([sem('s1', 'a', 100), sem('s2', 'b', 101)])
    const r = await reconcile({
      memory: mem,
      summarize: rawSummarizer('sorry, I cannot do that'),
      candidates: ['c'],
    })
    expect(r).toMatchObject({ noModel: true, added: 0, updated: 0, deleted: 0 })
    expect(mem.entries.length).toBe(2) // untouched
  })

  it('fail-soft: a throwing summarizer is caught (no ops, no corruption)', async () => {
    const mem = makeFakeMemory([sem('s1', 'a', 100), sem('s2', 'b', 101)])
    const r = await reconcile({
      memory: mem,
      summarize: async () => {
        throw new Error('network down')
      },
      candidates: ['c'],
    })
    expect(r!.noModel).toBe(true)
    expect(mem.entries.length).toBe(2)
  })

  it('fail-safe: ops referencing an unknown id are dropped, never acted on', async () => {
    const mem = makeFakeMemory([sem('s1', 'real', 100), sem('s2', 'real2', 101)])
    const r = await reconcile({
      memory: mem,
      summarize: opsSummarizer([
        { op: 'delete', id: 'PHANTOM' },
        { op: 'update', id: 'also-fake', text: 'x' },
      ]),
      candidates: ['c'],
    })
    expect(r).toMatchObject({ deleted: 0, updated: 0 })
    expect(mem.entries.length).toBe(2) // nothing deleted on a phantom id
  })

  it('an id is acted on at most once (first op wins)', async () => {
    const mem = makeFakeMemory([sem('s1', 'a', 100), sem('s2', 'b', 101)])
    const r = await reconcile({
      memory: mem,
      summarize: opsSummarizer([
        { op: 'update', id: 's1', text: 'a2' },
        { op: 'delete', id: 's1' }, // same id — ignored (already touched)
      ]),
      candidates: ['c'],
    })
    expect(r).toMatchObject({ updated: 1, deleted: 0 })
    expect(mem.entries.find((e) => e.text === 'a2')).toBeTruthy()
  })

  it('scopes to one namespace via filter; new entries carry the scope meta (no-leak)', async () => {
    const mem = makeFakeMemory([
      semWith('a1', 'alice fact', 100, { user: 'alice' }),
      semWith('a2', 'alice old', 101, { user: 'alice' }),
      semWith('b1', 'bob fact', 102, { user: 'bob' }),
    ])
    const r = await reconcile({
      memory: mem,
      summarize: opsSummarizer([
        { op: 'delete', id: 'a2' },
        { op: 'add', text: 'alice new', importance: 3 },
      ]),
      candidates: ['x'],
      filter: (e) => (e.meta as { user?: string } | undefined)?.user === 'alice',
      entryMeta: { user: 'alice' },
    })
    expect(r).toMatchObject({ deleted: 1, added: 1 })
    expect(has(mem, 'b1')).toBe(true) // bob untouched
    const added = mem.entries.find((e) => e.text === 'alice new')!
    expect((added.meta as { user?: string }).user).toBe('alice') // scope carried
  })

  it('reconciles ad-hoc semantic only — tiered digests/profiles are off-limits', async () => {
    const mem = makeFakeMemory([
      sem('ad1', 'ad-hoc one', 100),
      sem('ad2', 'ad-hoc two', 101),
      semWith('dig1', 'a digest', 102, { tier: 'misc', level: 'digest', importance: 3 }),
      semWith('prof1', 'a profile', 103, { tier: 'misc', level: 'profile', profile: true, importance: 5 }),
    ])
    // The model tries to touch the digest/profile ids too — they aren't in scope,
    // so those ops are dropped; only the ad-hoc merge happens.
    const r = await reconcile({
      memory: mem,
      summarize: opsSummarizer([
        { op: 'update', id: 'ad1', text: 'merged ad-hoc' },
        { op: 'delete', id: 'dig1' },
        { op: 'delete', id: 'prof1' },
      ]),
      candidates: ['x'],
    })
    expect(r).toMatchObject({ updated: 1, deleted: 0 })
    expect(has(mem, 'dig1')).toBe(true) // tiered layers untouched
    expect(has(mem, 'prof1')).toBe(true)
  })

  it('returns null when there is nothing to do', async () => {
    expect(await reconcile({ memory: makeFakeMemory([]), summarize: opsSummarizer([]) })).toBeNull()
    // pure dedup of a single fact has nothing to merge
    expect(
      await reconcile({ memory: makeFakeMemory([sem('s1', 'lonely', 100)]), summarize: opsSummarizer([]) }),
    ).toBeNull()
  })

  it('parses both {"ops":[...]} and a bare [...] array', async () => {
    const mem = makeFakeMemory([sem('s1', 'a', 100)])
    const r = await reconcile({
      memory: mem,
      summarize: rawSummarizer('[{"op":"add","text":"bare-array fact"}]'),
      candidates: ['x'],
    })
    expect(r).toMatchObject({ added: 1, noModel: false })
    expect(mem.entries.find((e) => e.text === 'bare-array fact')).toBeTruthy()
  })

  it('ADD works against an empty store (turn-boundary first fact)', async () => {
    const mem = makeFakeMemory([])
    const r = await reconcile({
      memory: mem,
      summarize: opsSummarizer([{ op: 'add', text: 'first fact' }]),
      candidates: ['first fact'],
    })
    expect(r).toMatchObject({ added: 1 })
    expect(mem.entries.length).toBe(1)
  })
})

describe('reconcileReviewer (heartbeat dedup)', () => {
  const ctx = (mem: FakeMemory): ReviewContext => ({ memory: mem, episodic: [], now: 5_000_000 })

  it('stays idle (and spends no model call) below the trigger', async () => {
    const mem = makeFakeMemory([sem('s1', 'a', 100), sem('s2', 'b', 101), sem('s3', 'c', 102)])
    const summarize = vi.fn(opsSummarizer([{ op: 'delete', id: 's1' }]))
    const out = await reconcileReviewer({ summarize, triggerEntries: 8 })(ctx(mem))
    expect(out).toEqual({})
    expect(summarize).not.toHaveBeenCalled() // gated before the LLM call
    expect(mem.entries.length).toBe(3)
  })

  it('runs above the trigger and summarizes what it changed', async () => {
    const seed = Array.from({ length: 8 }, (_, i) => sem(`s${i}`, `fact ${i}`, 100 + i))
    const mem = makeFakeMemory(seed)
    const out = await reconcileReviewer({
      summarize: opsSummarizer([
        { op: 'update', id: 's0', text: 'fact 0 (merged with 1)' },
        { op: 'delete', id: 's1' },
      ]),
      triggerEntries: 8,
    })(ctx(mem))
    expect(out.summary).toMatch(/reconciled:/)
    expect(out.summary).toMatch(/merged 1/)
    expect(out.summary).toMatch(/dropped 1/)
    expect(has(mem, 's1')).toBe(false)
  })

  it('returns {} when the pass changed nothing (all noop)', async () => {
    const seed = Array.from({ length: 8 }, (_, i) => sem(`s${i}`, `fact ${i}`, 100 + i))
    const mem = makeFakeMemory(seed)
    const out = await reconcileReviewer({
      summarize: opsSummarizer([{ op: 'noop' }, { op: 'noop' }]),
      triggerEntries: 8,
    })(ctx(mem))
    expect(out).toEqual({})
    expect(textsOf(mem).length).toBe(8) // unchanged
  })
})
