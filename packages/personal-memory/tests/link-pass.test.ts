/**
 * Linking pass (E-M2) — the heartbeat-driven I/O half over a live MemoryHandle.
 *
 * Load-bearing claims:
 *   1. OFF by default — nothing links until a pass/reviewer is run (the writer
 *      seam is the opt-in; existing behavior is byte-identical).
 *   2. A pass links the ad-hoc semantic set (digests/profiles excluded) and hands
 *      the GROWN link lists to the injected writer; idempotent across ticks.
 *   3. Best-effort — a throwing writer never aborts the pass.
 *   4. Scoping via `filter` keeps one user's links out of another's.
 */

import { describe, expect, it, vi } from 'vitest'

import {
  linkPass,
  linkReviewer,
  linksOf,
  type LinkUpdate,
  type MemoryLinkWriter,
} from '../src/index.js'
import { entry, makeFakeMemory, type FakeMemory } from './fake-memory.js'

/** A writer that applies updates in place (mirrors the host's file-backed patch:
 *  patch meta.links, preserve id/ts/text). Lets us test convergence. */
function applyingWriter(mem: FakeMemory): MemoryLinkWriter {
  return (updates: ReadonlyArray<LinkUpdate>) => {
    for (const u of updates) {
      const i = mem.entries.findIndex((e) => e.id === u.id)
      if (i >= 0) {
        mem.entries[i] = { ...mem.entries[i]!, meta: { ...mem.entries[i]!.meta, links: u.links } }
      }
    }
  }
}

describe('linkPass — nothing to do', () => {
  it('returns null with fewer than two eligible entries', async () => {
    const mem = makeFakeMemory([entry('a', 'semantic', '奶茶', 100)])
    const write = vi.fn<MemoryLinkWriter>()
    expect(await linkPass({ memory: mem, write })).toBeNull()
    expect(write).not.toHaveBeenCalled()
  })
})

describe('linkPass — links the ad-hoc semantic set', () => {
  it('writes grown links for overlapping facts, leaves the unrelated one alone', async () => {
    const mem = makeFakeMemory([
      entry('s1', 'semantic', '楼下新开了奶茶店', 100),
      entry('s2', 'semantic', '奶茶加珍珠最好喝', 90),
      entry('s3', 'semantic', '今天去爬山', 80),
    ])
    const captured: LinkUpdate[] = []
    const write: MemoryLinkWriter = (u) => {
      captured.push(...u)
    }
    const r = await linkPass({ memory: mem, write })
    expect(r).toEqual({ linked: 2 }) // s1, s2; s3 unrelated
    const ids = captured.map((u) => u.id).sort()
    expect(ids).toEqual(['s1', 's2'])
    expect(captured.find((u) => u.id === 's1')!.links).toEqual(['s2'])
    expect(captured.find((u) => u.id === 's2')!.links).toEqual(['s1'])
  })

  it('excludes tiered digests/profiles from linking (ad-hoc only)', async () => {
    const mem = makeFakeMemory([
      entry('s1', 'semantic', '楼下奶茶店', 100),
      entry('s2', 'semantic', '奶茶珍珠', 90),
      entry('dg', 'semantic', '奶茶相关摘要', 80, { level: 'digest' }), // tiered → skipped
    ])
    const captured: LinkUpdate[] = []
    const r = await linkPass({ memory: mem, write: (u) => captured.push(...u) })
    expect(r).toEqual({ linked: 2 })
    expect(captured.map((u) => u.id)).not.toContain('dg')
    // and no one links TO the digest either
    for (const u of captured) expect(u.links).not.toContain('dg')
  })

  it('scopes to one namespace via filter (per-user no-leak)', async () => {
    const mem = makeFakeMemory([
      entry('a1', 'semantic', '奶茶店', 100, { user: 'alice' }),
      entry('a2', 'semantic', '奶茶珍珠', 90, { user: 'alice' }),
      entry('b1', 'semantic', '奶茶拿铁', 80, { user: 'bob' }),
    ])
    const captured: LinkUpdate[] = []
    const r = await linkPass({
      memory: mem,
      write: (u) => captured.push(...u),
      filter: (e) => (e.meta as { user?: string }).user === 'alice',
    })
    expect(r).toEqual({ linked: 2 })
    const ids = captured.map((u) => u.id).sort()
    expect(ids).toEqual(['a1', 'a2']) // bob never linked
    for (const u of captured) expect(u.links).not.toContain('b1')
  })
})

describe('linkPass — robustness', () => {
  it('is best-effort: a throwing writer yields {linked:0}, never throws', async () => {
    const mem = makeFakeMemory([
      entry('s1', 'semantic', '奶茶店', 100),
      entry('s2', 'semantic', '奶茶珍珠', 90),
    ])
    const boom: MemoryLinkWriter = () => {
      throw new Error('disk full')
    }
    await expect(linkPass({ memory: mem, write: boom })).resolves.toEqual({ linked: 0 })
  })

  it('is idempotent: a second pass over the applied result writes nothing', async () => {
    const mem = makeFakeMemory([
      entry('s1', 'semantic', '楼下奶茶店', 100),
      entry('s2', 'semantic', '奶茶加珍珠', 90),
    ])
    const write = applyingWriter(mem)
    const first = await linkPass({ memory: mem, write })
    expect(first).toEqual({ linked: 2 })
    expect(linksOf(mem.entries.find((e) => e.id === 's1')!)).toEqual(['s2'])

    const second = await linkPass({ memory: mem, write })
    expect(second).toEqual({ linked: 0 }) // converged → no further writes
  })
})

describe('linkReviewer — heartbeat adapter', () => {
  it('is idle below the trigger, links and summarizes at/above it', async () => {
    const mem = makeFakeMemory([
      entry('s1', 'semantic', '楼下奶茶店', 100),
      entry('s2', 'semantic', '奶茶加珍珠', 90),
    ])
    const write = applyingWriter(mem)

    const high = linkReviewer({ write, triggerEntries: 5 })
    expect(await high({ memory: mem, episodic: [], now: 1000 })).toEqual({}) // 2 < 5 → idle

    const low = linkReviewer({ write, triggerEntries: 2 })
    const out = await low({ memory: mem, episodic: [], now: 1000 })
    expect(out.summary).toMatch(/^linked: 2 entries/)

    // converged → next tick idle even at/above trigger
    expect(await low({ memory: mem, episodic: [], now: 2000 })).toEqual({})
  })
})
