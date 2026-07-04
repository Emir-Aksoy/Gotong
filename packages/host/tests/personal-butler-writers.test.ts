/**
 * Unit tests for `butlerMemoryWriters` (Z-M2) — the three injected meta writers
 * wired to the file backend's in-place `patchMeta`. These prove that closing a
 * validity interval (D), reinforcing a recalled fact (F), and growing a link set
 * (E) actually round-trip on a REAL file-backed handle — not a fake — and that
 * each preserves the rest of the entry (id/ts/text and the untouched meta keys).
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Logger } from '@gotong/core'
import {
  lastRecalledOf,
  linksOf,
  openedMeta,
  recallCountOf,
  validFromOf,
  validToOf,
} from '@gotong/personal-memory'
import type { MemoryHandle } from '@gotong/services-sdk'

import { openButlerMemory } from '../src/personal-butler-memory.js'
import { butlerMemoryWriters } from '../src/personal-butler-writers.js'

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

describe('butlerMemoryWriters', () => {
  let tmp: string
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'butler-writers-'))
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  function mem(): MemoryHandle {
    return openButlerMemory({ rootDir: tmp, userId: 'u1', logger: silentLogger })
  }

  it('closeEntry stamps validTo in place, preserving validFrom + other meta', async () => {
    const m = mem()
    // An open fact with a validFrom and an unrelated key.
    const e = await m.remember({
      kind: 'semantic',
      text: '住在吉隆坡',
      meta: openedMeta({ importance: 4 }, 100),
    })
    const { closeEntry } = butlerMemoryWriters(m)
    await closeEntry(e, 900)

    const [got] = await m.recall({ kinds: ['semantic'], k: 1 })
    expect(got?.id).toBe(e.id) // same entry — not a new id/ts
    expect(got?.ts).toBe(e.ts)
    expect(got?.text).toBe('住在吉隆坡')
    expect(validToOf(got!)).toBe(900) // interval closed
    expect(validFromOf(got!)).toBe(100) // open bound survived the merge
    expect(got?.meta?.importance).toBe(4) // unrelated key survived
  })

  it('reinforcer bumps recallCount (undefined→1→2) and updates lastRecalledTs', async () => {
    const m = mem()
    const e = await m.remember({ kind: 'semantic', text: '常喝三分糖', meta: { importance: 3 } })
    const { reinforcer } = butlerMemoryWriters(m)

    await reinforcer(e, 1_000)
    let [got] = await m.recall({ kinds: ['semantic'], k: 1 })
    expect(recallCountOf(got!)).toBe(1)
    expect(lastRecalledOf(got!)).toBe(1_000)
    expect(got?.meta?.importance).toBe(3) // preserved

    // Reinforce again off the freshly-read entry — count climbs to 2.
    await reinforcer(got!, 2_000)
    ;[got] = await m.recall({ kinds: ['semantic'], k: 1 })
    expect(recallCountOf(got!)).toBe(2)
    expect(lastRecalledOf(got!)).toBe(2_000)
  })

  it('linkWriter persists merged link lists across several updates', async () => {
    const m = mem()
    const a = await m.remember({ kind: 'semantic', text: 'A' })
    const b = await m.remember({ kind: 'semantic', text: 'B' })
    const c = await m.remember({ kind: 'semantic', text: 'C' })
    const { linkWriter } = butlerMemoryWriters(m)

    await linkWriter([
      { id: a.id, links: [b.id, c.id] },
      { id: b.id, links: [a.id] },
    ])

    const all = await m.list({ kind: 'semantic' })
    const byId = Object.fromEntries(all.map((e) => [e.id, e]))
    expect(linksOf(byId[a.id]!).sort()).toEqual([b.id, c.id].sort())
    expect(linksOf(byId[b.id]!)).toEqual([a.id])
    expect(linksOf(byId[c.id]!)).toEqual([]) // not in the update — untouched
  })

  it('throws when the backend cannot patch meta in place (wiring bug, fail visible)', () => {
    // A MemoryHandle without `patchMeta` (e.g. a future read-only backend).
    const noPatch = {
      async recall() {
        return []
      },
      async remember(e) {
        return { id: 'x', ts: 0, ...e }
      },
      async list() {
        return []
      },
      async forget() {},
      async clear() {},
    } as unknown as MemoryHandle
    expect(() => butlerMemoryWriters(noPatch)).toThrow(/patchMeta/)
  })
})
