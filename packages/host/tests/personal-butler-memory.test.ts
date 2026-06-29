/**
 * Unit tests for `openButlerMemory` — the per-user memory namespace seam. The
 * §七 no-leak claim rides on this: two members resolve to two jsonl trees, so
 * one butler can never recall another's facts. Here we pin that isolation at the
 * factory level (real filesystem, tmp dir); the e2e proves it end-to-end.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Logger } from '@aipehub/core'

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

describe('openButlerMemory', () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'butler-mem-'))
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('isolates one user from another (no-leak namespace)', async () => {
    const alice = openButlerMemory({ rootDir: tmp, userId: 'alice', logger: silentLogger })
    const bob = openButlerMemory({ rootDir: tmp, userId: 'bob', logger: silentLogger })

    await alice.remember({ kind: 'semantic', text: '主人在做奶茶店项目' })

    // Alice recalls her own fact …
    const aliceHits = await alice.recall({ kinds: ['semantic'], k: 10 })
    expect(aliceHits.map((e) => e.text)).toContain('主人在做奶茶店项目')

    // … but Bob's butler sees an empty tree — the directories never overlap.
    const bobHits = await bob.recall({ kinds: ['semantic'], k: 10 })
    expect(bobHits).toHaveLength(0)
  })

  it('throws on an empty userId (a butler with no member to scope by is a bug)', () => {
    expect(() => openButlerMemory({ rootDir: tmp, userId: '', logger: silentLogger })).toThrow(
      /non-empty userId/,
    )
  })

  it('defaults to episodic + semantic kinds', async () => {
    const m = openButlerMemory({ rootDir: tmp, userId: 'carol', logger: silentLogger })
    await m.remember({ kind: 'episodic', text: 'a captured turn' })
    await m.remember({ kind: 'semantic', text: 'a distilled fact' })
    // `working` is not in the default config → a write is refused early.
    await expect(m.remember({ kind: 'working', text: 'scratch' })).rejects.toThrow()
    const all = await m.list({})
    expect(all.map((e) => e.text).sort()).toEqual(['a captured turn', 'a distilled fact'])
  })
})
