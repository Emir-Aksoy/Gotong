/**
 * FeedbackLedger — M5 of the hub-mesh implementation.
 *
 * Two backends (memory + file) share the same ledger contract; tests
 * cover both. The ledger is event-sourced (append-only); status
 * transitions are layered on top by replaying the stream.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Hub } from '../src/hub.js'
import {
  FeedbackLedger,
  FileFeedbackStorage,
  MemoryFeedbackStorage,
  statusOf,
  type FeedbackEntryDraft,
} from '../src/feedback/index.js'

function draft(
  overrides: Partial<FeedbackEntryDraft> = {},
): FeedbackEntryDraft {
  return {
    toHub: 'hubB',
    toParticipant: 'b-writer',
    taskRunId: 'run-1',
    scope: 'whole-task',
    rating: 4,
    evaluatorHub: 'hubA',
    evaluatorParticipant: 'admin',
    ...overrides,
  }
}

describe('FeedbackLedger — memory backend', () => {
  let ledger: FeedbackLedger

  beforeEach(() => {
    ledger = new FeedbackLedger(new MemoryFeedbackStorage())
  })

  it('appendEntry returns a complete entry with generated id + createdAt', () => {
    const e = ledger.appendEntry(draft({ rating: 5, comment: 'great' }))
    expect(e.id).toBeTruthy()
    expect(e.id.length).toBeGreaterThan(8)
    expect(e.createdAt).toBeGreaterThan(0)
    expect(e.rating).toBe(5)
    expect(e.comment).toBe('great')
    expect(e.deliveredAt).toBeUndefined()
    expect(statusOf(e)).toBe('pending')
  })

  it('query returns entries (initially with status=pending)', () => {
    ledger.appendEntry(draft({ rating: 5 }))
    ledger.appendEntry(draft({ rating: 2, comment: 'too slow' }))

    const all = ledger.query()
    expect(all.length).toBe(2)
    expect(all.every((e) => statusOf(e) === 'pending')).toBe(true)
  })

  it('markDelivered lifts an entry to status=delivered', () => {
    const e = ledger.appendEntry(draft())
    ledger.markDelivered(e.id, 1234)

    const refetched = ledger.get(e.id)
    expect(refetched?.deliveredAt).toBe(1234)
    expect(statusOf(refetched!)).toBe('delivered')
  })

  it('markRead lifts an entry to status=read', () => {
    const e = ledger.appendEntry(draft())
    ledger.markDelivered(e.id, 1000)
    ledger.markRead(e.id, 2000)

    const refetched = ledger.get(e.id)
    expect(refetched?.readAt).toBe(2000)
    expect(statusOf(refetched!)).toBe('read')
  })

  it('markRejected wins over read/delivered and carries reason (Q4)', () => {
    const e = ledger.appendEntry(draft())
    ledger.markDelivered(e.id, 1000)
    ledger.markRejected(e.id, 'evaluator id unknown', 1500)

    const refetched = ledger.get(e.id)
    expect(refetched?.rejectedAt).toBe(1500)
    expect(refetched?.rejectionReason).toBe('evaluator id unknown')
    expect(statusOf(refetched!)).toBe('rejected')
  })

  it('status bumps are idempotent — second mark does not change first timestamp', () => {
    const e = ledger.appendEntry(draft())
    ledger.markDelivered(e.id, 1000)
    ledger.markDelivered(e.id, 9999) // ignored

    expect(ledger.get(e.id)?.deliveredAt).toBe(1000)
  })

  it('filter by toHub', () => {
    ledger.appendEntry(draft({ toHub: 'hubB' }))
    ledger.appendEntry(draft({ toHub: 'hubC' }))
    ledger.appendEntry(draft({ toHub: 'hubB' }))

    const onlyB = ledger.query({ toHub: 'hubB' })
    expect(onlyB.length).toBe(2)
    expect(onlyB.every((e) => e.toHub === 'hubB')).toBe(true)
  })

  it('filter by taskRunId', () => {
    ledger.appendEntry(draft({ taskRunId: 'run-1' }))
    ledger.appendEntry(draft({ taskRunId: 'run-2' }))

    expect(ledger.query({ taskRunId: 'run-1' }).length).toBe(1)
  })

  it('filter by status', () => {
    const e1 = ledger.appendEntry(draft())
    const e2 = ledger.appendEntry(draft())
    const e3 = ledger.appendEntry(draft())
    ledger.markDelivered(e2.id, 100)
    ledger.markRead(e3.id, 200)
    // e3 has no deliveredAt yet, but readAt is set — statusOf considers
    // it 'read' since readAt wins over the missing delivered.

    expect(ledger.query({ status: 'pending' }).length).toBe(1)
    expect(ledger.query({ status: 'delivered' }).length).toBe(1)
    expect(ledger.query({ status: 'read' }).length).toBe(1)
    expect(ledger.query()[0].id).toBeTruthy() // sanity
    expect(e1.id).not.toBe(e2.id)
  })

  it('filter by evaluatorHub', () => {
    ledger.appendEntry(draft({ evaluatorHub: 'hubA' }))
    ledger.appendEntry(draft({ evaluatorHub: 'hubX' }))
    expect(ledger.query({ evaluatorHub: 'hubA' }).length).toBe(1)
  })

  it('rawLines exposes the event stream verbatim (for M5b)', () => {
    const e = ledger.appendEntry(draft({ rating: 5 }))
    ledger.markDelivered(e.id, 100)
    ledger.markRejected(e.id, 'oops', 200)

    const lines = ledger.rawLines()
    expect(lines.length).toBe(3)
    expect(lines[0].kind).toBe('entry')
    expect(lines[1].kind).toBe('delivered')
    expect(lines[2].kind).toBe('rejected')
  })

  it('count() respects filter', () => {
    ledger.appendEntry(draft({ toHub: 'hubB' }))
    ledger.appendEntry(draft({ toHub: 'hubC' }))
    expect(ledger.count({ toHub: 'hubC' })).toBe(1)
    expect(ledger.count()).toBe(2)
  })
})

describe('FileFeedbackStorage — persists across instances', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aipehub-feedback-test-'))
  })
  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* swallow */
    }
  })

  it('append → re-open ledger → see entries', () => {
    const l1 = new FeedbackLedger(new FileFeedbackStorage({ dir }))
    const e = l1.appendEntry(draft({ rating: 5 }))
    l1.markDelivered(e.id, 1234)

    const l2 = new FeedbackLedger(new FileFeedbackStorage({ dir }))
    const refetched = l2.get(e.id)
    expect(refetched).toBeDefined()
    expect(refetched?.rating).toBe(5)
    expect(refetched?.deliveredAt).toBe(1234)
  })

  it('writes plain JSON-per-line (machine + human readable)', () => {
    const ledger = new FeedbackLedger(new FileFeedbackStorage({ dir }))
    ledger.appendEntry(draft({ comment: 'plain line' }))

    const raw = readFileSync(join(dir, 'outbound.jsonl'), 'utf8')
    // Two valid expectations: 1 trailing newline, no JSON parse errors.
    const lines = raw.split('\n').filter(Boolean)
    expect(lines.length).toBe(1)
    expect(() => JSON.parse(lines[0])).not.toThrow()
    const obj = JSON.parse(lines[0])
    expect(obj.kind).toBe('entry')
    expect(obj.entry.comment).toBe('plain line')
  })

  it('corrupt line in the middle is skipped, valid lines around it survive', () => {
    const storage = new FileFeedbackStorage({ dir })
    const ledger = new FeedbackLedger(storage)
    const e1 = ledger.appendEntry(draft({ comment: 'first' }))
    // Manually corrupt the file: insert junk between lines.
    const path = storage.path
    const before = readFileSync(path, 'utf8')
    require('node:fs').appendFileSync(path, 'GARBAGE-NOT-JSON\n')
    const e2 = ledger.appendEntry(draft({ comment: 'after garbage' }))

    const all = ledger.query()
    expect(all.length).toBe(2)
    expect(all.find((e) => e.id === e1.id)?.comment).toBe('first')
    expect(all.find((e) => e.id === e2.id)?.comment).toBe('after garbage')
    expect(before.length).toBeGreaterThan(0) // sanity
  })
})

describe('Hub.feedback integration', () => {
  it('Hub.inMemory() has a working in-memory feedback ledger', () => {
    const hub = Hub.inMemory()
    const e = hub.feedback.appendEntry(draft({ rating: 5 }))
    expect(hub.feedback.query().length).toBe(1)
    expect(hub.feedback.get(e.id)?.rating).toBe(5)
  })

  it('Hub backed by space writes feedback to <space>/feedback/outbound.jsonl', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aipehub-space-test-'))
    try {
      const { Space } = await import('../src/space.js')
      const opened = await Space.openOrInit(dir, { name: 'test-space' })
      const hub = new Hub({ space: opened.space })
      const e = hub.feedback.appendEntry(draft({ comment: 'persisted!' }))

      // Inspect the actual file
      const ledgerPath = join(dir, 'feedback', 'outbound.jsonl')
      const raw = readFileSync(ledgerPath, 'utf8')
      expect(raw).toContain('persisted!')
      expect(raw).toContain(e.id)

      // Re-open: a fresh Hub on the same space sees the same entry
      const hub2 = new Hub({ space: opened.space })
      expect(hub2.feedback.get(e.id)?.comment).toBe('persisted!')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
