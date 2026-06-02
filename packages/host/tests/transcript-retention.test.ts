import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { FileStorage } from '@aipehub/core'
import type { TranscriptEntry } from '@aipehub/core'

import {
  TRANSCRIPT_ARCHIVE_DAYS_ENV,
  TRANSCRIPT_KEEP_SEGMENTS_ENV,
  applyTranscriptRetention,
  parseTranscriptRetention,
} from '../src/transcript-retention.js'

/**
 * Route B P0-M2 (M3b) — boot-time transcript retention wiring. M2a/M2b gave
 * FileStorage the archive mechanism + a persisted high-water seq (M3a); this is
 * the host policy that drives it before the Hub loads. These pin: an unset env
 * is OFF (so a default boot is unchanged), each knob maps to the right
 * ArchiveOptions, a malformed value throws (loud misconfig), and applying a
 * parsed policy to a real FileStorage archives the old segments — bounding the
 * next boot's load while preserving the full audit and seq continuity. Each
 * guard is falsifiable.
 */

const MS_PER_DAY = 86_400_000
const NOW = 1_000_000_000_000

describe('parseTranscriptRetention (Route B P0-M2 M3b)', () => {
  it('returns undefined when no retention env is set (OFF by default)', () => {
    expect(parseTranscriptRetention({}, NOW)).toBeUndefined()
    // Empty strings are treated as unset, not as a zero policy.
    expect(
      parseTranscriptRetention(
        { [TRANSCRIPT_KEEP_SEGMENTS_ENV]: '', [TRANSCRIPT_ARCHIVE_DAYS_ENV]: '' },
        NOW,
      ),
    ).toBeUndefined()
  })

  it('maps keep-segments to keepLast', () => {
    expect(parseTranscriptRetention({ [TRANSCRIPT_KEEP_SEGMENTS_ENV]: '5' }, NOW)).toEqual({
      keepLast: 5,
    })
    // 0 is a valid policy (archive every sealed segment), distinct from unset.
    expect(parseTranscriptRetention({ [TRANSCRIPT_KEEP_SEGMENTS_ENV]: '0' }, NOW)).toEqual({
      keepLast: 0,
    })
  })

  it('maps archive-days to a `before` cutoff anchored at now', () => {
    expect(parseTranscriptRetention({ [TRANSCRIPT_ARCHIVE_DAYS_ENV]: '7' }, NOW)).toEqual({
      before: NOW - 7 * MS_PER_DAY,
    })
  })

  it('combines both knobs', () => {
    expect(
      parseTranscriptRetention(
        { [TRANSCRIPT_KEEP_SEGMENTS_ENV]: '3', [TRANSCRIPT_ARCHIVE_DAYS_ENV]: '2' },
        NOW,
      ),
    ).toEqual({ keepLast: 3, before: NOW - 2 * MS_PER_DAY })
  })

  it('throws on a malformed value rather than silently doing nothing', () => {
    expect(() =>
      parseTranscriptRetention({ [TRANSCRIPT_KEEP_SEGMENTS_ENV]: 'abc' }, NOW),
    ).toThrow(/KEEP_SEGMENTS/)
    expect(() =>
      parseTranscriptRetention({ [TRANSCRIPT_KEEP_SEGMENTS_ENV]: '-1' }, NOW),
    ).toThrow(/KEEP_SEGMENTS/)
    expect(() =>
      parseTranscriptRetention({ [TRANSCRIPT_KEEP_SEGMENTS_ENV]: '1.5' }, NOW),
    ).toThrow(/KEEP_SEGMENTS/)
    expect(() =>
      parseTranscriptRetention({ [TRANSCRIPT_ARCHIVE_DAYS_ENV]: '0' }, NOW),
    ).toThrow(/ARCHIVE_DAYS/)
    expect(() =>
      parseTranscriptRetention({ [TRANSCRIPT_ARCHIVE_DAYS_ENV]: 'soon' }, NOW),
    ).toThrow(/ARCHIVE_DAYS/)
  })
})

// ~95 bytes/entry; a 50-byte cap seals after every entry → 1 entry per segment.
const PER_ENTRY = 50

function entry(seq: number): TranscriptEntry {
  return {
    seq,
    ts: 1_000 + seq,
    kind: 'participant_joined',
    data: { id: `p-${seq}`, participantKind: 'agent', capabilities: ['x'] },
  }
}

describe('applyTranscriptRetention (Route B P0-M2 M3b)', () => {
  let dir: string
  let path: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aipe-retain-'))
    path = join(dir, 'transcript.jsonl')
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('archives old segments, bounding the next boot load while preserving audit + seq', async () => {
    const seed = new FileStorage(path, undefined, PER_ENTRY)
    for (let i = 1; i <= 8; i++) await seed.appendTranscriptEntry(entry(i))
    await seed.close()
    // 8 entries at a 1-entry cap ⇒ 7 sealed segments + active(e8).

    const policy = parseTranscriptRetention({ [TRANSCRIPT_KEEP_SEGMENTS_ENV]: '2' }, NOW)!
    const { moved } = await applyTranscriptRetention(new FileStorage(path, undefined, PER_ENTRY), policy)
    // keepLast:2 protects the 2 newest sealed (e6, e7) ⇒ 5 archived (e1..e5).
    expect(moved.length).toBe(5)

    // A fresh instance models the Hub's own FileStorage on the next boot.
    const booted = new FileStorage(path, undefined, PER_ENTRY)
    // Boot load is bounded to the retained tail (kept segments + active)...
    expect((await booted.loadTranscript()).map((e) => e.seq)).toEqual([6, 7, 8])
    // ...but the full audit is preserved across active + archive...
    expect((await booted.loadAll()).map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    // ...and the high-water seq survived (M3a checkpoint written by the archive),
    // so seq never regresses on the next boot.
    expect(booted.highWaterSeq()).toBe(8)
  })

  it('is a no-op for an empty (no-policy) workspace path', async () => {
    // Defensive: a caller that somehow passes {} archives nothing.
    const seed = new FileStorage(path, undefined, PER_ENTRY)
    for (let i = 1; i <= 4; i++) await seed.appendTranscriptEntry(entry(i))
    await seed.close()

    const { moved } = await applyTranscriptRetention(new FileStorage(path, undefined, PER_ENTRY), {})
    expect(moved).toEqual([])
  })
})
