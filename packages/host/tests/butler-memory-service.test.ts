/**
 * Unit tests for HostButlerMemoryService — the /me butler-memory privacy view
 * (被遗忘权). Exercises the real per-user memory backend (filesystem, tmp dir)
 * through the SAME `openButlerMemory` factory the butler agent uses, so "what
 * the butler remembers" and "what this service shows / erases" are one tree.
 * The no-leak namespace boundary is pinned here at the service level; the e2e
 * (claim 4) proves it end-to-end through a real butler turn.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Logger } from '@aipehub/core'

import { HostButlerMemoryService } from '../src/butler-memory-service.js'
import { openButlerMemory } from '../src/personal-butler-memory.js'

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

describe('HostButlerMemoryService', () => {
  let tmp: string
  let svc: HostButlerMemoryService

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'butler-mem-svc-'))
    svc = new HostButlerMemoryService({ rootDir: tmp, logger: silentLogger })
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  // Seed a member's butler memory through the SAME factory the service uses.
  async function seed(userId: string): Promise<void> {
    const m = openButlerMemory({ rootDir: tmp, userId, logger: silentLogger })
    await m.remember({ kind: 'semantic', text: '主人叫阿明,在做奶茶店项目' })
    await m.remember({ kind: 'episodic', text: '用户说他叫阿明' })
    await m.remember({ kind: 'episodic', text: '用户说在做奶茶店' })
  }

  it('read() returns the semantic profile + recent episodic captures (views only)', async () => {
    await seed('alice')
    const snap = await svc.read('alice')
    expect(snap.profile.map((e) => e.text)).toContain('主人叫阿明,在做奶茶店项目')
    expect(snap.recent.map((e) => e.text)).toEqual(
      expect.arrayContaining(['用户说他叫阿明', '用户说在做奶茶店']),
    )
    // A view carries content + when + the tiering projection only — never the
    // raw meta object. Every key must be from the allowed view shape.
    const allowed = new Set([
      'id', 'kind', 'text', 'ts', 'tier', 'level', 'importance',
      // long-term projection (Z-M3) — only attached when the entry carries them
      'links', 'recallCount', 'lastRecalled', 'form', 'steps', 'validFrom', 'validTo', 'active',
    ])
    for (const e of [...snap.profile, ...snap.recent]) {
      for (const key of Object.keys(e)) expect(allowed.has(key)).toBe(true)
      expect((e as Record<string, unknown>).meta).toBeUndefined()
      // importance always projected (defaults to the mid value).
      expect(typeof e.importance).toBe('number')
    }
  })

  it('projects tier / level / importance from a clustered entry (decision ③)', async () => {
    const m = openButlerMemory({ rootDir: tmp, userId: 'alice', logger: silentLogger })
    await m.remember({
      kind: 'semantic',
      text: '阿明对花生过敏',
      meta: { tier: 'persona', level: 'profile', importance: 5 },
    })
    const snap = await svc.read('alice')
    const card = snap.profile.find((e) => e.text.includes('花生'))!
    expect(card.tier).toBe('persona')
    expect(card.level).toBe('profile')
    expect(card.importance).toBe(5)

    // A flat (untagged) semantic fact carries no tier/level, importance defaults.
    await m.remember({ kind: 'semantic', text: '随手一记' })
    const flat = (await svc.read('alice')).profile.find((e) => e.text === '随手一记')!
    expect(flat.tier).toBeUndefined()
    expect(flat.level).toBeUndefined()
    expect(flat.importance).toBe(3)
  })

  it('projects long-term tags — links / recall / procedure / validity (Z-M3)', async () => {
    // Fixed clock so the bitemporal `active` flag is deterministic.
    const svc300 = new HostButlerMemoryService({ rootDir: tmp, logger: silentLogger, now: () => 300 })
    const m = openButlerMemory({ rootDir: tmp, userId: 'alice', logger: silentLogger })

    await m.remember({ kind: 'semantic', text: '关联事实', meta: { links: ['x', 'y'] } })
    await m.remember({ kind: 'semantic', text: '常用事实', meta: { recallCount: 3, lastRecalledTs: 1234 } })
    await m.remember({
      kind: 'semantic',
      text: '怎么对账',
      meta: { form: 'procedure', steps: ['打开报表', '逐笔核对'] },
    })
    await m.remember({ kind: 'semantic', text: '现住槟城', meta: { validFrom: 100, validTo: 500 } }) // active at 300
    await m.remember({ kind: 'semantic', text: '曾住吉隆坡', meta: { validFrom: 0, validTo: 200 } }) // closed by 300
    await m.remember({ kind: 'semantic', text: '下月起健身', meta: { validFrom: 400 } }) // not yet in effect at 300

    const by = Object.fromEntries((await svc300.export('alice')).map((e) => [e.text, e]))

    // E — links surfaced as an id list.
    expect(by['关联事实']!.links).toEqual(['x', 'y'])
    expect(by['常用事实']!.links).toBeUndefined() // no links → field omitted

    // F — recall salience.
    expect(by['常用事实']!.recallCount).toBe(3)
    expect(by['常用事实']!.lastRecalled).toBe(1234)
    expect(by['关联事实']!.recallCount).toBeUndefined() // 0 recalls → omitted

    // G — a remembered how-to with its steps.
    expect(by['怎么对账']!.form).toBe('procedure')
    expect(by['怎么对账']!.steps).toEqual(['打开报表', '逐笔核对'])
    expect(by['关联事实']!.form).toBeUndefined()

    // D — validity interval + active flag relative to now=300.
    expect(by['现住槟城']!.validFrom).toBe(100)
    expect(by['现住槟城']!.validTo).toBe(500)
    expect(by['现住槟城']!.active).toBe(true)
    expect(by['曾住吉隆坡']!.active).toBe(false) // closed (validTo 200 <= 300)
    expect(by['下月起健身']!.active).toBe(false) // not yet in effect (validFrom 400 > 300)
    expect(by['下月起健身']!.validTo).toBeUndefined()
    // A plain fact carries no validity at all → no `active` badge.
    expect(by['关联事实']!.active).toBeUndefined()
  })

  it('export() returns every entry across kinds (data portability)', async () => {
    await seed('alice')
    const all = await svc.export('alice')
    expect(all).toHaveLength(3)
    expect(all.map((e) => e.kind).sort()).toEqual(['episodic', 'episodic', 'semantic'])
  })

  it('forget(id) removes one entry and reports whether it existed (no throw on miss)', async () => {
    await seed('alice')
    const target = (await svc.export('alice')).find((e) => e.kind === 'semantic')!
    expect(await svc.forget('alice', target.id)).toBe(true)
    expect((await svc.export('alice')).some((e) => e.id === target.id)).toBe(false)
    // A miss is a benign false — never an enumeration oracle, never a throw.
    expect(await svc.forget('alice', 'no-such-id')).toBe(false)
  })

  it('concurrent forgets for one user both land — ops share one write chain (Fix C)', async () => {
    // THREE entries in the SAME kind file, so two concurrent forgets contend on
    // one read-modify-write. A `MemoryFileHandle` serializes writes through a
    // per-instance chain, so this only stays correct if the service reuses ONE
    // handle per user: with a fresh handle per op the two rewrites would interleave
    // (both read {1,2,3}; A writes {2,3}; B writes {1,3}) and the last writer would
    // resurrect the other's deleted entry. The service caches by userId → both land.
    const m = openButlerMemory({ rootDir: tmp, userId: 'dave', logger: silentLogger })
    const e1 = await m.remember({ kind: 'semantic', text: '事实一' })
    const e2 = await m.remember({ kind: 'semantic', text: '事实二' })
    await m.remember({ kind: 'semantic', text: '事实三' })

    const [okA, okB] = await Promise.all([svc.forget('dave', e1.id), svc.forget('dave', e2.id)])
    expect(okA).toBe(true)
    expect(okB).toBe(true)

    const remaining = await svc.export('dave')
    expect(remaining.some((e) => e.id === e1.id)).toBe(false) // not resurrected
    expect(remaining.some((e) => e.id === e2.id)).toBe(false)
    expect(remaining.map((e) => e.text)).toEqual(['事实三']) // exactly the untouched one
  })

  it('forgetAll() clears everything (right to be forgotten)', async () => {
    await seed('alice')
    await svc.forgetAll('alice')
    const snap = await svc.read('alice')
    expect(snap.profile).toHaveLength(0)
    expect(snap.recent).toHaveLength(0)
    expect(await svc.export('alice')).toHaveLength(0)
  })

  it('is scoped per user — one member cannot see or erase another (no-leak)', async () => {
    await seed('alice')
    await seed('bob')

    // Bob clears HIS butler — Alice's tree is untouched.
    await svc.forgetAll('bob')
    expect(await svc.export('bob')).toHaveLength(0)
    expect((await svc.read('alice')).profile.length).toBeGreaterThan(0)

    // Alice cannot forget one of Bob's entries through her own scope: the id is
    // not in her namespace → reports false, and Bob keeps it.
    const bobMem = openButlerMemory({ rootDir: tmp, userId: 'bob', logger: silentLogger })
    const bobEntry = await bobMem.remember({ kind: 'semantic', text: 'bob 的秘密' })
    expect(await svc.forget('alice', bobEntry.id)).toBe(false)
    expect((await svc.export('bob')).some((e) => e.id === bobEntry.id)).toBe(true)
  })

  it('empty tree → empty snapshot, never throws', async () => {
    const snap = await svc.read('never-seen')
    expect(snap.profile).toEqual([])
    expect(snap.recent).toEqual([])
    expect(await svc.export('never-seen')).toEqual([])
  })
})
