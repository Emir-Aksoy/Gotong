/**
 * Tests for the host side of the maintenance STATUS.md (MR4-M2 ④写状态).
 *
 * Four things, over a real per-user tmp tree:
 *   1. the STATUS.md file — write is an OVERWRITE snapshot (current status, not a
 *      diary), `read` parses the machine marker, an empty summary renders the
 *      "无需改动" body, `remove` wipes it, an empty userId throws;
 *   2. `statusProjectingReviewer` — wraps a composed inner reviewer: it writes
 *      STATUS.md from the inner's MERGED summary AND returns the inner outcome
 *      UNCHANGED (an idle `{}` tick still writes a "no changes" status but stays
 *      HEARTBEAT_OK-suppressed — the projection never disturbs notification gating);
 *   3. `HostButlerMemoryService.read` surfaces `lastStatus` (the "上次维护" line);
 *   4. `HostButlerMemoryService.forgetAll` removes STATUS.md too (被遗忘权 / §八).
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Logger } from '@gotong/core'
import type { MemoryReviewer, ReviewOutcome } from '@gotong/personal-memory'

import { HostButlerMemoryService } from '../src/butler-memory-service.js'
import { openButlerMemory } from '../src/personal-butler-memory.js'
import {
  openButlerStatusFile,
  statusProjectingReviewer,
} from '../src/personal-butler-status.js'

const silentLogger: Logger = {
  trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
  child() { return silentLogger },
}

const NOW = 9_000_000

/** A fixed-outcome reviewer stand-in for the composed inner pass. */
function constReviewer(outcome: ReviewOutcome): MemoryReviewer {
  return async () => outcome
}

describe('butler status file (STATUS.md)', () => {
  let tmp: string
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'butler-status-')) })
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

  it('writes a human-readable snapshot; read parses the marker', async () => {
    const file = openButlerStatusFile({ rootDir: tmp, userId: 'alice', logger: silentLogger })
    expect(await file.read()).toBeNull() // no file yet

    await file.write('merged 2 procedures; cleaned 1 stale output', NOW)

    const sum = await file.read()
    expect(sum).not.toBeNull()
    expect(sum!.writtenAt).toBe(NOW)
    expect(sum!.summary).toBe('merged 2 procedures; cleaned 1 stale output')

    const md = await readFile(join(tmp, 'user', 'alice', 'STATUS.md'), 'utf8')
    expect(md).toContain('# 管家维护状态')
    expect(md).toContain('merged 2 procedures; cleaned 1 stale output')
  })

  it('renders the "无需改动" body for an empty (idle) summary, still readable', async () => {
    const file = openButlerStatusFile({ rootDir: tmp, userId: 'alice', logger: silentLogger })
    await file.write('', NOW)
    const sum = await file.read()
    expect(sum!.writtenAt).toBe(NOW)
    expect(sum!.summary).toBe('') // the marker still carries a (blank) status
    const md = await readFile(join(tmp, 'user', 'alice', 'STATUS.md'), 'utf8')
    expect(md).toContain('无需改动')
  })

  it('is an OVERWRITE snapshot — a second write replaces, not appends', async () => {
    const file = openButlerStatusFile({ rootDir: tmp, userId: 'alice', logger: silentLogger })
    await file.write('cleaned 3 stale outputs', NOW)
    await file.write('promoted 1 into the profile', NOW + 1)

    const sum = await file.read()
    expect(sum!.writtenAt).toBe(NOW + 1)
    expect(sum!.summary).toBe('promoted 1 into the profile')
    const md = await readFile(join(tmp, 'user', 'alice', 'STATUS.md'), 'utf8')
    expect(md).toContain('promoted 1 into the profile')
    expect(md).not.toContain('cleaned 3 stale outputs') // replaced, not accumulated
  })

  it('remove() deletes the file (forget-all path), idempotently', async () => {
    const file = openButlerStatusFile({ rootDir: tmp, userId: 'bob', logger: silentLogger })
    await file.write('did a thing', NOW)
    expect(await file.read()).not.toBeNull()
    await file.remove()
    expect(await file.read()).toBeNull()
    await file.remove() // removing an absent file is fine
  })

  it('throws on an empty userId', () => {
    expect(() => openButlerStatusFile({ rootDir: tmp, userId: '', logger: silentLogger })).toThrow(
      /non-empty userId/,
    )
  })
})

describe('statusProjectingReviewer — wraps the maintenance pass, projects its summary', () => {
  let tmp: string
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'butler-statusrev-')) })
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

  it('writes STATUS.md from the inner summary and returns the inner outcome unchanged', async () => {
    const mem = openButlerMemory({ rootDir: tmp, userId: 'carol', logger: silentLogger })
    const file = openButlerStatusFile({ rootDir: tmp, userId: 'carol', logger: silentLogger })

    const inner = constReviewer({ summary: 'merged 2 procedures into umbrella' })
    const out = await statusProjectingReviewer({ statusFile: file, inner })({
      memory: mem,
      episodic: [],
      now: NOW,
    })

    // Returned unchanged — the wrapper must not alter the heartbeat's outcome.
    expect(out).toEqual({ summary: 'merged 2 procedures into umbrella' })
    const sum = await file.read()
    expect(sum!.writtenAt).toBe(NOW)
    expect(sum!.summary).toBe('merged 2 procedures into umbrella')
  })

  it('an idle tick still records a "no changes" status but stays HEARTBEAT_OK ({})', async () => {
    const mem = openButlerMemory({ rootDir: tmp, userId: 'carol', logger: silentLogger })
    const file = openButlerStatusFile({ rootDir: tmp, userId: 'carol', logger: silentLogger })

    // inner returns {} (HEARTBEAT_OK) — nothing to do this tick.
    const out = await statusProjectingReviewer({ statusFile: file, inner: constReviewer({}) })({
      memory: mem,
      episodic: [],
      now: NOW,
    })

    // Outcome is still {} so the heartbeat suppresses the notification...
    expect(out).toEqual({})
    // ...but STATUS.md was written anyway (liveness side-channel), with a blank summary.
    const sum = await file.read()
    expect(sum).not.toBeNull()
    expect(sum!.summary).toBe('')
  })
})

describe('HostButlerMemoryService — surfaces + wipes STATUS.md', () => {
  let tmp: string
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'butler-status-svc-')) })
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

  it('read() surfaces the latest maintenance status as lastStatus', async () => {
    const file = openButlerStatusFile({ rootDir: tmp, userId: 'dave', logger: silentLogger })
    await file.write('cleaned 2 stale outputs', NOW)

    const svc = new HostButlerMemoryService({ rootDir: tmp, logger: silentLogger, now: () => NOW })
    const snap = await svc.read('dave')
    expect(snap.lastStatus).toEqual({ writtenAt: NOW, summary: 'cleaned 2 stale outputs' })
  })

  it('read() omits lastStatus before any maintenance pass has run', async () => {
    const svc = new HostButlerMemoryService({ rootDir: tmp, logger: silentLogger, now: () => NOW })
    const snap = await svc.read('erin')
    expect(snap.lastStatus).toBeUndefined()
  })

  it('forget-all removes the derived status file', async () => {
    const file = openButlerStatusFile({ rootDir: tmp, userId: 'dave', logger: silentLogger })
    await file.write('did a thing', NOW)
    expect(await file.read()).not.toBeNull()

    const svc = new HostButlerMemoryService({ rootDir: tmp, logger: silentLogger })
    await svc.forgetAll('dave')

    expect(await file.read()).toBeNull() // the same path the service cleaned
  })
})
