/**
 * Tests for the host side of the master SKILL.md (MR3-M3).
 *
 * Four things, over a real per-user tmp tree:
 *   1. `projectButlerSkills` — the pure active-procedure → skill-ref projection
 *      (closed/superseded procedures and non-procedures excluded, umbrella flagged);
 *   2. the SKILL.md file — write is an OVERWRITE snapshot (not an append diary),
 *      `read` parses the machine marker, `remove` wipes it;
 *   3. `skillFileReviewer` end to end over a real file-backed handle — projects the
 *      post-merge active set, returning `{}` (a projection claims no work);
 *   4. `HostButlerMemoryService.forgetAll` removes SKILL.md too (被遗忘权 / §八).
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Logger } from '@aipehub/core'
import type { MemoryEntry } from '@aipehub/services-sdk'

import { HostButlerMemoryService } from '../src/butler-memory-service.js'
import { openButlerMemory } from '../src/personal-butler-memory.js'
import {
  openButlerSkillFile,
  projectButlerSkills,
  skillFileReviewer,
} from '../src/personal-butler-skills.js'

const silentLogger: Logger = {
  trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
  child() { return silentLogger },
}

const NOW = 9_000_000

/** A `form:'procedure'` semantic entry, optionally closed / umbrella via meta. */
function proc(
  id: string,
  name: string,
  steps: string[],
  ts: number,
  meta: Record<string, unknown> = {},
): MemoryEntry {
  return { id, kind: 'semantic', text: name, ts, meta: { form: 'procedure', steps, ...meta } }
}

describe('projectButlerSkills', () => {
  it('returns active procedures only, flagging umbrellas, excluding closed + non-procedures', () => {
    const entries: MemoryEntry[] = [
      proc('p1', '申请加班费', ['起草', '提交'], 100),
      proc('u1', '加班费总流程', ['起草', '提交', '记录'], 200, { umbrella: true }),
      proc('closed', '旧流程', ['x'], 50, { validTo: NOW - 1 }), // closed before now
      { id: 'f1', kind: 'semantic', text: '一个普通事实', ts: 60 }, // not a procedure
    ]
    const refs = projectButlerSkills(entries, NOW)
    // Order follows activeProcedures (input order, closed/non-proc filtered out).
    expect(refs.map((r) => r.id)).toEqual(['p1', 'u1'])
    expect(refs.find((r) => r.id === 'p1')!.umbrella).toBe(false)
    const u = refs.find((r) => r.id === 'u1')!
    expect(u.umbrella).toBe(true)
    expect(u.stepCount).toBe(3)
    expect(u.name).toBe('加班费总流程')
  })
})

describe('butler skill file (SKILL.md)', () => {
  let tmp: string
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'butler-skills-')) })
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

  it('writes a human-readable snapshot; read parses the marker; closed excluded', async () => {
    const file = openButlerSkillFile({ rootDir: tmp, userId: 'alice', logger: silentLogger })
    expect(await file.read()).toBeNull() // no file yet

    await file.write(
      [
        proc('p1', '申请加班费', ['起草', '提交'], 100),
        proc('u1', '加班费总流程', ['起草', '提交', '记录'], 200, { umbrella: true }),
        proc('closed', '旧流程', ['x'], 50, { validTo: NOW - 1 }),
      ],
      NOW,
    )

    const sum = await file.read()
    expect(sum).not.toBeNull()
    expect(sum!.writtenAt).toBe(NOW)
    expect(sum!.count).toBe(2) // the closed original is excluded
    const byId = Object.fromEntries(sum!.skills.map((s) => [s.id, s]))
    expect(byId.p1!.umbrella).toBe(false)
    expect(byId.u1!.umbrella).toBe(true)
    expect(byId.u1!.stepCount).toBe(3)
    expect(byId.closed).toBeUndefined()

    const md = await readFile(join(tmp, 'user', 'alice', 'SKILL.md'), 'utf8')
    expect(md).toContain('# 我会做的事')
    expect(md).toContain('## 加班费总流程 （合并）') // umbrella badge
    expect(md).toContain('## 申请加班费')
    expect(md).toContain('1. 起草')
    expect(md).not.toContain('旧流程') // closed never rendered
  })

  it('is an OVERWRITE snapshot — a second write replaces, not appends', async () => {
    const file = openButlerSkillFile({ rootDir: tmp, userId: 'alice', logger: silentLogger })
    await file.write([proc('p1', '申请加班费', ['起草'], 100)], NOW)
    await file.write([proc('p2', '冲茶', ['烧水', '泡'], 300)], NOW + 1)

    const sum = await file.read()
    expect(sum!.count).toBe(1)
    expect(sum!.skills[0]!.id).toBe('p2')
    const md = await readFile(join(tmp, 'user', 'alice', 'SKILL.md'), 'utf8')
    expect(md).toContain('冲茶')
    expect(md).not.toContain('申请加班费') // replaced, not accumulated
  })

  it('renders an empty snapshot when there are no active skills', async () => {
    const file = openButlerSkillFile({ rootDir: tmp, userId: 'alice', logger: silentLogger })
    await file.write([], NOW)
    const sum = await file.read()
    expect(sum!.count).toBe(0)
    expect(sum!.skills).toEqual([])
    const md = await readFile(join(tmp, 'user', 'alice', 'SKILL.md'), 'utf8')
    expect(md).toContain('还没有记录任何技能')
  })

  it('remove() deletes the file (forget-all path), idempotently', async () => {
    const file = openButlerSkillFile({ rootDir: tmp, userId: 'bob', logger: silentLogger })
    await file.write([proc('p1', '冲茶', ['烧水'], 1)], NOW)
    expect(await file.read()).not.toBeNull()
    await file.remove()
    expect(await file.read()).toBeNull()
    await file.remove() // removing an absent file is fine
  })

  it('throws on an empty userId', () => {
    expect(() => openButlerSkillFile({ rootDir: tmp, userId: '', logger: silentLogger })).toThrow(
      /non-empty userId/,
    )
  })
})

describe('skillFileReviewer — projects the active set end to end', () => {
  let tmp: string
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'butler-skillrev-')) })
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

  it('writes SKILL.md from the real handle, excluding a merged-away (closed) skill', async () => {
    const mem = openButlerMemory({ rootDir: tmp, userId: 'carol', logger: silentLogger })
    await mem.remember({ kind: 'semantic', text: '冲茶', meta: { form: 'procedure', steps: ['烧水', '泡'] } })
    // A closed (merged-away) procedure: present in jsonl, absent from the active set.
    await mem.remember({
      kind: 'semantic',
      text: '旧冲茶',
      meta: { form: 'procedure', steps: ['x'], validTo: NOW - 1 },
    })

    const file = openButlerSkillFile({ rootDir: tmp, userId: 'carol', logger: silentLogger })
    const out = await skillFileReviewer({ skillFile: file })({ memory: mem, episodic: [], now: NOW })

    expect(out).toEqual({}) // a projection is not a memory mutation — claims no work
    const sum = await file.read()
    expect(sum!.count).toBe(1) // only the active one
    expect(sum!.skills[0]!.name).toBe('冲茶')
  })
})

describe('HostButlerMemoryService — forgetAll wipes SKILL.md', () => {
  let tmp: string
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'butler-skill-svc-')) })
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

  it('forget-all removes the derived skill index', async () => {
    const file = openButlerSkillFile({ rootDir: tmp, userId: 'dave', logger: silentLogger })
    await file.write([proc('p1', '冲茶', ['烧水'], 1)], NOW)
    expect(await file.read()).not.toBeNull()

    const svc = new HostButlerMemoryService({ rootDir: tmp, logger: silentLogger })
    await svc.forgetAll('dave')

    expect(await file.read()).toBeNull() // the same path the service cleaned
  })
})
