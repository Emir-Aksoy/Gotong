/**
 * butler-maintenance-links.test.ts — M-GRAPH write side.
 *
 * The 6h maintenance sweep grows associative `meta.links` ONLY when graph mode is
 * on (opt-in `GOTONG_BUTLER_MEMORY_LINKS` ⇒ `links: true`), and is byte-identical
 * (no entry ever gains links) when off. This runs `runButlerMaintenanceOnce` over a
 * real tmp namespace so the patchMeta-backed link writer + the `linkReviewer`
 * composition are exercised exactly as production wires them — not a stubbed pass.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Logger } from '@gotong/core'
import { linksOf } from '@gotong/personal-memory'

import { runButlerMaintenanceOnce } from '../src/personal-butler-maintenance.js'
import { openButlerMemory } from '../src/personal-butler-memory.js'

const silentLogger: Logger = {
  trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
  child() { return silentLogger },
}

// Episodic is empty in these fixtures, so distillation/extraction never call this —
// the tick's only real work is the link pass we're testing.
const noopSummarize = async () => ''

/** Seed the entity-bridge corpus: A→B share 玛丽; two distractors share nothing. */
async function seedBridge(rootDir: string, userId: string) {
  const mem = openButlerMemory({ rootDir, userId, logger: silentLogger })
  const a = await mem.remember({ kind: 'semantic', text: '我妈妈是玛丽' })
  const b = await mem.remember({ kind: 'semantic', text: '玛丽在槟城买了房子' })
  await mem.remember({ kind: 'semantic', text: '今天下午三点要开会' })
  await mem.remember({ kind: 'semantic', text: '记得周末去超市买牛奶' })
  return { mem, aId: a.id, bId: b.id }
}

describe('M-GRAPH — the 6h sweep grows links only when graph mode is on', () => {
  let tmp: string
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'butler-links-')) })
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

  it('links: true — discovers A↔B (shared 玛丽) and patches meta.links in place on disk', async () => {
    const { mem, aId, bId } = await seedBridge(tmp, 'alice')

    await runButlerMaintenanceOnce({
      rootDir: tmp, userId: 'alice', summarize: noopSummarize, logger: silentLogger, links: true,
    })

    const all = await mem.recall({ kinds: ['semantic'], k: 50 })
    const a = all.find((e) => e.id === aId)!
    const b = all.find((e) => e.id === bId)!
    expect(linksOf(a)).toContain(bId) // bidirectional bridge, persisted through patchMeta
    expect(linksOf(b)).toContain(aId)
    // A distractor shares no term with anything → it stays unlinked.
    expect(linksOf(all.find((e) => e.text.includes('开会'))!)).toEqual([])
  })

  it('default (links off) — byte-identical: no entry ever gains meta.links', async () => {
    const { mem, aId } = await seedBridge(tmp, 'bob')

    await runButlerMaintenanceOnce({
      rootDir: tmp, userId: 'bob', summarize: noopSummarize, logger: silentLogger,
    })

    const all = await mem.recall({ kinds: ['semantic'], k: 50 })
    expect(all.every((e) => linksOf(e).length === 0)).toBe(true) // nothing linked
    expect(all.some((e) => e.id === aId)).toBe(true) // …the facts are still all there
  })
})
