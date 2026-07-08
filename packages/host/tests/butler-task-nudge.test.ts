/**
 * TN-M2 — ButlerTaskNudgeSweeper behavior on real files.
 *
 * The boundaries under test are the ones the plan doc pins:
 *  - triage is pure timestamps (3d stall / 3d per-task cooldown), zero LLM;
 *  - the sweeper writes ONLY its own fact file (`tasks-nudges.json`) and never
 *    touches `tasks.json` — even a corrupt notebook is skipped, not quarantined
 *    (quarantine belongs to the butler's own turn, the file's single writer);
 *  - marks land only on a DELIVERED nudge (a miss retries next tick);
 *  - one message lists at most `maxListed` tasks and only those get marked.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Logger } from '@gotong/core'
import { openTaskNotebook } from '@gotong/personal-butler'
import { ownerDir } from '@gotong/service-memory-file'

import { ButlerTaskNudgeSweeper } from '../src/personal-butler-task-nudge.js'

const silentLogger: Logger = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
  child() {
    return silentLogger
  },
}

const DAY = 24 * 60 * 60 * 1000
const T0 = 1_000 * DAY

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gotong-tn-sweep-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const userDir = (userId: string): string => ownerDir(root, { kind: 'user', id: userId })

/** Open a note for a member with the notebook's own writer, at time `at`. */
async function seedNote(userId: string, title: string, at: number, steps = ['第一步', '第二步']): Promise<string> {
  const nb = openTaskNotebook({ file: join(userDir(userId), 'tasks.json'), now: () => at })
  const t = await nb.openNote({ title, steps })
  return t.id
}

interface PushRecord {
  userId: string
  text: string
}

function makeSweeper(opts: { now: number; deliver?: boolean; pushes: PushRecord[] }): ButlerTaskNudgeSweeper {
  return new ButlerTaskNudgeSweeper({
    rootDir: root,
    push: async (userId, text) => {
      opts.pushes.push({ userId, text })
      return { delivered: opts.deliver !== false, ...(opts.deliver === false ? { reason: 'no_bridge' } : {}) }
    },
    logger: silentLogger,
    now: () => opts.now,
  })
}

const readMarks = (userId: string): Record<string, number> =>
  (JSON.parse(readFileSync(join(userDir(userId), 'tasks-nudges.json'), 'utf8')) as { nudgedAt: Record<string, number> })
    .nudgedAt

describe('ButlerTaskNudgeSweeper (TN-M2)', () => {
  it('nudges a stalled note, marks it, and the cooldown silences the next tick', async () => {
    const id = await seedNote('u1', '筹备生日会', T0)
    const pushes: PushRecord[] = []
    const sweeper = makeSweeper({ now: T0 + 4 * DAY, pushes })

    const first = await sweeper.runOnceForMember('u1')
    expect(first).toEqual({ nudged: true, count: 1 })
    expect(pushes).toHaveLength(1)
    expect(pushes[0]!.text).toContain('筹备生日会')
    expect(pushes[0]!.text).toContain('下一步: 第一步')
    expect(pushes[0]!.text).toContain('跟我说一声') // asks — never executes
    expect(readMarks('u1')[id]).toBe(T0 + 4 * DAY)

    // Same instant again — the per-task cooldown holds, no second ping.
    const second = await sweeper.runOnceForMember('u1')
    expect(second).toEqual({ nudged: false, reason: 'nothing-stalled' })
    expect(pushes).toHaveLength(1)

    // After the cooldown lapses (task still untouched) it may ask once more.
    const later = makeSweeper({ now: T0 + 8 * DAY, pushes })
    expect(await later.runOnceForMember('u1')).toEqual({ nudged: true, count: 1 })
  })

  it('a delivery miss writes NO mark and retries next tick', async () => {
    await seedNote('u1', '筹备生日会', T0)
    const pushes: PushRecord[] = []
    const down = makeSweeper({ now: T0 + 4 * DAY, deliver: false, pushes })
    expect(await down.runOnceForMember('u1')).toEqual({ nudged: false, reason: 'delivery-failed' })
    expect(existsSync(join(userDir('u1'), 'tasks-nudges.json'))).toBe(false)

    const up = makeSweeper({ now: T0 + 4 * DAY, pushes })
    expect(await up.runOnceForMember('u1')).toEqual({ nudged: true, count: 1 })
    expect(pushes).toHaveLength(2)
  })

  it('fresh notes / no notebook stay silent', async () => {
    await seedNote('u1', '刚开的事', T0)
    const pushes: PushRecord[] = []
    const sweeper = makeSweeper({ now: T0 + 1 * DAY, pushes })
    expect(await sweeper.runOnceForMember('u1')).toEqual({ nudged: false, reason: 'nothing-stalled' })
    expect(await sweeper.runOnceForMember('u2')).toEqual({ nudged: false, reason: 'no-notes' })
    expect(pushes).toHaveLength(0)
  })

  it('a corrupt notebook is SKIPPED — never renamed or rewritten by the sweeper', async () => {
    mkdirSync(userDir('u1'), { recursive: true })
    writeFileSync(join(userDir('u1'), 'tasks.json'), '{ not json', 'utf8')
    const pushes: PushRecord[] = []
    const sweeper = makeSweeper({ now: T0 + 4 * DAY, pushes })
    expect(await sweeper.runOnceForMember('u1')).toEqual({ nudged: false, reason: 'no-notes' })
    expect(readFileSync(join(userDir('u1'), 'tasks.json'), 'utf8')).toBe('{ not json')
    expect(readdirSync(userDir('u1'))).toEqual(['tasks.json']) // no quarantine sibling, no marks
  })

  it('prunes the mark of a task the member closed', async () => {
    const at = T0
    const file = join(userDir('u1'), 'tasks.json')
    const nb = openTaskNotebook({ file, now: () => at })
    const t = await nb.openNote({ title: '会收掉的事', steps: ['一步'] })

    const pushes: PushRecord[] = []
    const sweeper = makeSweeper({ now: T0 + 4 * DAY, pushes })
    await sweeper.runOnceForMember('u1')
    expect(readMarks('u1')[t.id]).toBeDefined()

    await nb.closeNote(t.id, 'done')
    // Next tick: nothing stalled anymore, and the stale mark is tidied away.
    expect(await sweeper.runOnceForMember('u1')).toEqual({ nudged: false, reason: 'nothing-stalled' })
    expect(readMarks('u1')[t.id]).toBeUndefined()
  })

  it('lists at most maxListed tasks per message and marks ONLY those', async () => {
    const nb = openTaskNotebook({ file: join(userDir('u1'), 'tasks.json'), now: () => T0 })
    const ids: string[] = []
    for (let i = 1; i <= 5; i++) {
      ids.push((await nb.openNote({ title: `第${i}件事`, steps: ['一步'] })).id)
    }
    const pushes: PushRecord[] = []
    const sweeper = makeSweeper({ now: T0 + 4 * DAY, pushes })
    expect(await sweeper.runOnceForMember('u1')).toEqual({ nudged: true, count: 3 })
    expect(pushes[0]!.text).toContain('(还有 2 件也停着)')
    const marks = readMarks('u1')
    expect(Object.keys(marks).sort()).toEqual(ids.slice(0, 3).sort()) // the 2 overflow tasks wait their turn
  })

  it('runOnce sweeps every member namespace independently', async () => {
    await seedNote('u1', '停住的事', T0)
    await seedNote('u2', '新鲜的事', T0 + 4 * DAY - 1)
    const pushes: PushRecord[] = []
    const sweeper = makeSweeper({ now: T0 + 4 * DAY, pushes })
    await sweeper.runOnce()
    expect(pushes.map((p) => p.userId)).toEqual(['u1'])
  })
})
