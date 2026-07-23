/**
 * Perf audit A⑤ — run-time periodic retention sweeper.
 *
 * Pins the load-bearing contract:
 *   1. Nothing configured ⇒ arm() is null (zero timers) and a sweep touches
 *      no dependency — byte-identical host.
 *   2. Transcript family: a sweep against a LIVE storage's path archives old
 *      sealed segments via a throwaway instance while the live instance keeps
 *      appending; the next boot loads the retained tail and the full audit +
 *      high-water seq survive.
 *   3. Cutoffs re-anchor per tick — `before` advances with the clock instead
 *      of freezing at boot parse time.
 *   4. Best-effort isolation: one family (or one identity table) failing
 *      never blocks the others.
 *   5. The armed timer ticks and stop() ends it.
 */

import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { FileStorage, type Logger, type TranscriptEntry } from '@gotong/core'
import type { ArchiveRunsOptions } from '@gotong/workflow'

import {
  armRetentionSweeper,
  retentionConfigured,
  retentionSweepOnce,
  type RetentionSweeperOptions,
} from '../src/retention-sweeper.js'
import type { RetentionStore } from '../src/retention.js'

const MS_PER_DAY = 86_400_000
const NOW = 1_750_000_000_000

const silentLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => silentLog,
} as unknown as Logger

/** ~95 bytes/entry; a 50-byte cap seals after every entry → 1 entry/segment. */
const PER_ENTRY = 50

function entry(seq: number, ts: number): TranscriptEntry {
  return {
    seq,
    ts,
    kind: 'participant_joined',
    data: { id: `p-${seq}`, participantKind: 'agent', capabilities: ['x'] },
  }
}

function fakeRuns(): { calls: ArchiveRunsOptions[]; archiveRuns(o: ArchiveRunsOptions): Promise<string[]> } {
  const calls: ArchiveRunsOptions[] = []
  return {
    calls,
    async archiveRuns(o: ArchiveRunsOptions) {
      calls.push(o)
      return ['r-old']
    },
  }
}

function noopIdentity(): RetentionStore {
  return {
    pruneLedger: () => 0,
    pruneAuditLog: () => 0,
    prunePeerSummarySnapshots: () => 0,
    prunePeerSummaryAlertFirings: () => 0,
  }
}

function baseOpts(over: Partial<RetentionSweeperOptions>): RetentionSweeperOptions {
  return {
    env: {},
    storage: () => {
      throw new Error('storage factory must not be called')
    },
    runs: {
      archiveRuns: async () => {
        throw new Error('runs store must not be called')
      },
    },
    identity: null,
    log: silentLog,
    now: () => NOW,
    ...over,
  }
}

describe('retention sweeper (perf audit A⑤)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gotong-retain-sweep-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('retentionConfigured: false for an empty env, true for each family alone', () => {
    expect(retentionConfigured({}, NOW)).toBe(false)
    expect(retentionConfigured({ GOTONG_TRANSCRIPT_KEEP_SEGMENTS: '2' }, NOW)).toBe(true)
    expect(retentionConfigured({ GOTONG_RUN_ARCHIVE_DAYS: '30' }, NOW)).toBe(true)
    expect(retentionConfigured({ GOTONG_LEDGER_KEEP_DAYS: '90' }, NOW)).toBe(true)
  })

  it('nothing configured ⇒ arm() is null and a sweep touches no dependency', async () => {
    const opts = baseOpts({}) // throwing stubs — a touch would fail the test
    expect(armRetentionSweeper(opts)).toBeNull()
    const out = await retentionSweepOnce(opts)
    expect(out).toEqual({ archivedSegments: 0, archivedRuns: 0, prunedRows: 0 })
  })

  it('archives old sealed segments at runtime while the live storage keeps appending', async () => {
    const path = join(dir, 'transcript.jsonl')
    // The LIVE instance (models the Hub's own storage): 8 old entries.
    const live = new FileStorage(path, undefined, PER_ENTRY)
    for (let i = 1; i <= 8; i++) await live.appendTranscriptEntry(entry(i, 1_000 + i))
    // 8 entries at a 1-entry cap ⇒ 7 sealed segments + active(e8).

    const out = await retentionSweepOnce(
      baseOpts({
        env: { GOTONG_TRANSCRIPT_KEEP_SEGMENTS: '2' },
        // Throwaway per sweep — exactly the boot-path discipline.
        storage: () => new FileStorage(path, undefined, PER_ENTRY),
      }),
    )
    expect(out.archivedSegments).toBe(5) // e1..e5 out; e6,e7 protected; e8 active

    // The live instance is unbothered: it appends straight through.
    await live.appendTranscriptEntry(entry(9, 1_009))
    await live.close()

    // Next boot: bounded load, full audit, monotonic seq.
    const booted = new FileStorage(path, undefined, PER_ENTRY)
    expect((await booted.loadTranscript()).map((e) => e.seq)).toEqual([6, 7, 8, 9])
    expect((await booted.loadAll()).map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(booted.highWaterSeq()).toBeGreaterThanOrEqual(8)
  })

  it('re-anchors the age cutoff to the tick clock, not the boot clock', async () => {
    const runs = fakeRuns()
    let clock = NOW
    const opts = baseOpts({
      env: { GOTONG_RUN_ARCHIVE_DAYS: '30' },
      runs,
      now: () => clock,
    })

    await retentionSweepOnce(opts)
    clock = NOW + 2 * MS_PER_DAY
    await retentionSweepOnce(opts)

    expect(runs.calls.map((c) => c.before)).toEqual([
      NOW - 30 * MS_PER_DAY,
      NOW + 2 * MS_PER_DAY - 30 * MS_PER_DAY,
    ])
  })

  it('a failing family never blocks the others; a failing table never blocks its siblings', async () => {
    const runs = fakeRuns()
    const pruned: string[] = []
    const identity: RetentionStore = {
      pruneLedger: () => {
        throw new Error('ledger table locked')
      },
      pruneAuditLog: () => {
        pruned.push('audit')
        return 3
      },
      prunePeerSummarySnapshots: () => 0,
      prunePeerSummaryAlertFirings: () => 0,
    }
    const out = await retentionSweepOnce(
      baseOpts({
        env: {
          GOTONG_TRANSCRIPT_KEEP_SEGMENTS: '1',
          GOTONG_RUN_KEEP: '10',
          GOTONG_LEDGER_KEEP_DAYS: '30',
          GOTONG_AUDIT_KEEP_DAYS: '30',
        },
        storage: () => {
          throw new Error('disk hiccup') // transcript family fails...
        },
        runs, // ...runs and identity still sweep
        identity,
      }),
    )
    expect(out.archivedSegments).toBe(0)
    expect(out.archivedRuns).toBe(1)
    expect(out.prunedRows).toBe(3)
    expect(pruned).toEqual(['audit'])
  })

  it('the armed timer ticks on its cadence and stop() ends it', async () => {
    const runs = fakeRuns()
    const handle = armRetentionSweeper(
      baseOpts({
        env: { GOTONG_RUN_KEEP: '5' },
        runs,
        identity: noopIdentity(),
        intervalMs: 20,
      }),
    )
    expect(handle).not.toBeNull()
    await new Promise((r) => setTimeout(r, 90))
    handle!.stop()
    const after = runs.calls.length
    expect(after).toBeGreaterThanOrEqual(2)
    await new Promise((r) => setTimeout(r, 60))
    expect(runs.calls.length).toBe(after) // frozen after stop
  })
})
