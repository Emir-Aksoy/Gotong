/**
 * TN-M2 pure parts — the zero-LLM stall triage, the template nudge text, and
 * the READ-ONLY notebook snapshot the sweeper uses.
 *
 * Load-bearing boundaries under test:
 *  - triage is pure timestamp math (stall ≥ 3d, per-task cooldown, prune marks
 *    for gone/closed tasks) — no model anywhere;
 *  - the snapshot NEVER mutates the notebook file (no quarantine, no rename)
 *    — the butler turn stays the file's only toucher;
 *  - the nudge text asks, never acts, and never talks tool names at a member.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  openTaskNotebook,
  readTaskNotesSnapshot,
  triageStalledTaskNotes,
  formatTaskNudgeMessage,
  TASK_NUDGE_DEFAULTS,
  type TaskNote,
} from '../src/index.js'

const DAY = 24 * 60 * 60 * 1000
const NOW = 100 * DAY

const mk = (id: string, updatedAt: number, over: Partial<TaskNote> = {}): TaskNote => ({
  id,
  title: `任务${id}`,
  steps: [
    { text: '第一步', done: false },
    { text: '第二步', done: false },
  ],
  status: 'open',
  createdAt: updatedAt,
  updatedAt,
  ...over,
})

describe('triageStalledTaskNotes — zero-LLM stall triage', () => {
  it('flags only open tasks untouched for ≥ stallMs, most-stuck first', () => {
    const { stalled, pruneIds } = triageStalledTaskNotes({
      tasks: [
        mk('tn-1', NOW - 1 * DAY), // fresh — not stalled
        mk('tn-2', NOW - 4 * DAY), // stalled
        mk('tn-3', NOW - TASK_NUDGE_DEFAULTS.stallMs), // exactly at the boundary — stalled (≥)
        mk('tn-4', NOW - 9 * DAY, { status: 'done' }), // closed — never nudged
        mk('tn-5', NOW - 7 * DAY), // stalled, oldest
      ],
      marks: {},
      now: NOW,
    })
    expect(stalled.map((t) => t.id)).toEqual(['tn-5', 'tn-2', 'tn-3'])
    expect(pruneIds).toEqual([])
  })

  it('cooldown suppresses a recently nudged task, releases after it lapses', () => {
    const tasks = [mk('tn-1', NOW - 10 * DAY)]
    const recentlyNudged = triageStalledTaskNotes({ tasks, marks: { 'tn-1': NOW - 1 * DAY }, now: NOW })
    expect(recentlyNudged.stalled).toEqual([])
    const lapsed = triageStalledTaskNotes({ tasks, marks: { 'tn-1': NOW - 4 * DAY }, now: NOW })
    expect(lapsed.stalled.map((t) => t.id)).toEqual(['tn-1'])
  })

  it('prunes marks whose task is gone or closed, keeps marks for open tasks', () => {
    const { pruneIds } = triageStalledTaskNotes({
      tasks: [mk('tn-1', NOW - 1 * DAY), mk('tn-2', NOW - 1 * DAY, { status: 'dropped' })],
      marks: { 'tn-1': NOW - 5 * DAY, 'tn-2': NOW - 5 * DAY, 'tn-9': NOW - 5 * DAY },
      now: NOW,
    })
    expect(pruneIds.sort()).toEqual(['tn-2', 'tn-9'])
  })
})

describe('formatTaskNudgeMessage — asks, never acts', () => {
  it('renders next step per task and closes with a member-facing question', () => {
    const text = formatTaskNudgeMessage(
      [mk('tn-1', 0, { title: '筹备生日会', steps: [{ text: '订蛋糕', done: true }, { text: '发邀请', done: false }] })],
      1,
    )
    expect(text).toContain('筹备生日会')
    expect(text).toContain('下一步: 发邀请')
    expect(text).toContain('跟我说一声')
    // Members talk; the butler does the tool calls — no tool names at a member.
    expect(text).not.toContain('close_task_note')
    expect(text).not.toContain('update_task_note')
  })

  it('an all-steps-done stalled task nudges toward wrap-up, and overflow is stated', () => {
    const done = mk('tn-1', 0, { steps: [{ text: '唯一一步', done: true }] })
    const text = formatTaskNudgeMessage([done, mk('tn-2', 0), mk('tn-3', 0)], 5)
    expect(text).toContain('就差收个尾')
    expect(text).toContain('(还有 2 件也停着)')
  })
})

describe('readTaskNotesSnapshot — read-only, never mutates', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gotong-tn-nudge-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('missing file → [], corrupt file → [] with the bytes left EXACTLY in place', async () => {
    const file = join(dir, 'tasks.json')
    expect(await readTaskNotesSnapshot(file)).toEqual([])
    writeFileSync(file, '{ not json', 'utf8')
    expect(await readTaskNotesSnapshot(file)).toEqual([])
    // No quarantine, no rename, no rewrite — the file (and ONLY it) remains.
    expect(readFileSync(file, 'utf8')).toBe('{ not json')
    expect(readdirSync(dir)).toEqual(['tasks.json'])
  })

  it('round-trips what the notebook wrote', async () => {
    const file = join(dir, 'tasks.json')
    const nb = openTaskNotebook({ file, now: () => NOW })
    await nb.openNote({ title: '筹备生日会', steps: ['订蛋糕', '发邀请'] })
    const snap = await readTaskNotesSnapshot(file)
    expect(snap.map((t) => t.title)).toEqual(['筹备生日会'])
    expect(existsSync(file)).toBe(true)
  })
})
