import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { RunStore, type RunState } from '@gotong/workflow'

import {
  RUN_ARCHIVE_DAYS_ENV,
  RUN_KEEP_ENV,
  applyRunRetention,
  parseRunRetention,
} from '../src/run-retention.js'

/**
 * Route B P0-M3 (M3-M2) — boot-time workflow-run retention wiring. M3-M1 gave
 * RunStore the archive mechanism; this is the host policy that drives it before
 * the boot resume scan. These pin: an unset env is OFF (so a default boot is
 * unchanged), each knob maps to the right ArchiveRunsOptions, a malformed value
 * throws (loud misconfig), and applying a parsed policy to a real RunStore
 * archives the old terminal runs — bounding the next scan while preserving the
 * running run for resume and keeping archived runs reachable. Each guard is
 * falsifiable.
 */

const MS_PER_DAY = 86_400_000
const NOW = 1_000_000_000_000

describe('parseRunRetention (Route B P0-M3 M3-M2)', () => {
  it('returns undefined when no retention env is set (OFF by default)', () => {
    expect(parseRunRetention({}, NOW)).toBeUndefined()
    // Empty strings are treated as unset, not as a zero policy.
    expect(
      parseRunRetention({ [RUN_KEEP_ENV]: '', [RUN_ARCHIVE_DAYS_ENV]: '' }, NOW),
    ).toBeUndefined()
  })

  it('maps run-keep to keepLast', () => {
    expect(parseRunRetention({ [RUN_KEEP_ENV]: '50' }, NOW)).toEqual({ keepLast: 50 })
    // 0 is a valid policy (archive every terminal run), distinct from unset.
    expect(parseRunRetention({ [RUN_KEEP_ENV]: '0' }, NOW)).toEqual({ keepLast: 0 })
  })

  it('maps archive-days to a `before` cutoff anchored at now', () => {
    expect(parseRunRetention({ [RUN_ARCHIVE_DAYS_ENV]: '30' }, NOW)).toEqual({
      before: NOW - 30 * MS_PER_DAY,
    })
  })

  it('combines both knobs', () => {
    expect(
      parseRunRetention({ [RUN_KEEP_ENV]: '10', [RUN_ARCHIVE_DAYS_ENV]: '7' }, NOW),
    ).toEqual({ keepLast: 10, before: NOW - 7 * MS_PER_DAY })
  })

  it('throws on a malformed value rather than silently doing nothing', () => {
    expect(() => parseRunRetention({ [RUN_KEEP_ENV]: 'abc' }, NOW)).toThrow(/RUN_KEEP/)
    expect(() => parseRunRetention({ [RUN_KEEP_ENV]: '-1' }, NOW)).toThrow(/RUN_KEEP/)
    expect(() => parseRunRetention({ [RUN_KEEP_ENV]: '1.5' }, NOW)).toThrow(/RUN_KEEP/)
    expect(() => parseRunRetention({ [RUN_ARCHIVE_DAYS_ENV]: '0' }, NOW)).toThrow(/ARCHIVE_DAYS/)
    expect(() => parseRunRetention({ [RUN_ARCHIVE_DAYS_ENV]: 'soon' }, NOW)).toThrow(/ARCHIVE_DAYS/)
  })
})

function makeRun(
  over: Partial<RunState> & Pick<RunState, 'runId' | 'workflowId' | 'startedAt' | 'status'>,
): RunState {
  return { triggeredByTaskId: 't_x', triggerPayload: {}, steps: [], ...over }
}

function terminal(runId: string, end: number): RunState {
  return makeRun({ runId, workflowId: 'wf', startedAt: end, endedAt: end, status: 'done', finalOutput: `out-${runId}` })
}

describe('applyRunRetention (Route B P0-M3 M3-M2)', () => {
  let dir: string
  let store: RunStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gotong-run-retain-'))
    store = new RunStore(dir)
    store.ensureDirs()
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('archives old terminal runs, bounding the next scan while preserving running + audit', async () => {
    for (const end of [100, 200, 300, 400, 500]) await store.write(terminal(`r_${end}`, end))
    // A still-running run — the resume scan must keep finding it on the active path.
    await store.write(makeRun({ runId: 'r_run', workflowId: 'wf', startedAt: 50, status: 'running' }))

    const policy = parseRunRetention({ [RUN_KEEP_ENV]: '2' }, NOW)!
    const { archived } = await applyRunRetention(store, policy)
    // keepLast:2 protects the 2 newest terminal (r_500, r_400) ⇒ 3 archived.
    expect(new Set(archived)).toEqual(new Set(['r_300', 'r_200', 'r_100']))

    // The active scan now sees only the retained tail + the running run…
    expect((await store.listRunIds()).sort()).toEqual(['r_400', 'r_500', 'r_run'])
    // …the running run was never archived (resume safety)…
    expect(await store.listArchivedRunIds()).not.toContain('r_run')
    // …and the archived terminal runs stay reachable in full for audit.
    expect((await store.listArchivedRunIds()).sort()).toEqual(['r_100', 'r_200', 'r_300'])
    expect((await store.readArchived('r_100'))?.finalOutput).toBe('out-r_100')
  })

  it('is a no-op for an empty (no-policy) store', async () => {
    // Defensive: a caller that somehow passes {} archives nothing.
    for (const end of [100, 200, 300]) await store.write(terminal(`r_${end}`, end))
    const { archived } = await applyRunRetention(store, {})
    expect(archived).toEqual([])
    expect((await store.listRunIds()).length).toBe(3)
  })
})
