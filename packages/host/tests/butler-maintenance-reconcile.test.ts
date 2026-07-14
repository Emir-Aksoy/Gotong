/**
 * butler-maintenance-reconcile.test.ts — M-RECON write side.
 *
 * The 6h maintenance sweep reconciles a member's ad-hoc semantic facts ONLY when
 * reconcile mode is on (opt-in `GOTONG_BUTLER_MEMORY_RECONCILE` ⇒ `reconcile: true`),
 * and is byte-identical (no fact is ever retired) when off. This runs
 * `runButlerMaintenanceOnce` over a REAL tmp namespace so the patchMeta-backed
 * `closeEntry` writer + the `reconcileReviewer` composition are exercised exactly as
 * production wires them — a stale fact is CLOSED (validTo stamped, kept as reversible
 * history), never hard-deleted.
 *
 * The summarizer dispatches by pass: it returns the reconcile ops JSON only for the
 * RECONCILIATION prompt (empty for tiered/atomic distillation, which have no episodic
 * to work on here), and it reads the stored-facts list in the prompt to retire the
 * stale 吉隆坡 fact — standing in for the model's contradiction judgment, the same
 * honest fake pattern the reconcile unit tests use.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Logger } from '@gotong/core'
import { isActive, validToOf, type MemorySummarizer } from '@gotong/personal-memory'

import { runButlerMaintenanceOnce } from '../src/personal-butler-maintenance.js'
import { openButlerMemory } from '../src/personal-butler-memory.js'

const silentLogger: Logger = {
  trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
  child() { return silentLogger },
}

/**
 * A summarizer that only speaks for the RECONCILIATION pass (distillation/extraction
 * get '' → clean no-ops). It reads the stored-facts list and retires the stale 吉隆坡
 * fact by its real (file-assigned) id — the model's judgment, made deterministic.
 */
const reconcileSummarize: MemorySummarizer = async ({ system, user }) => {
  if (!system.includes('RECONCILIATION')) return ''
  const line = user.split('\n').find((l) => l.startsWith('- ') && l.includes('吉隆坡'))
  if (!line) return JSON.stringify({ ops: [] })
  const id = line.slice(2, line.indexOf(':')).trim()
  return JSON.stringify({ ops: [{ op: 'delete', id }] })
}

/**
 * Seed the entity-drift corpus: a contradictory residence pair (both blind-remembered,
 * both active) + enough distractors to clear the reconcile trigger (≥8 ad-hoc facts).
 */
async function seedMoved(rootDir: string, userId: string) {
  const mem = openButlerMemory({ rootDir, userId, logger: silentLogger })
  await mem.remember({ kind: 'semantic', text: '我住在吉隆坡' }) // stale
  await mem.remember({ kind: 'semantic', text: '我住在槟城' }) // current
  // Seven distractors so that even AFTER 吉隆坡 is closed, ≥8 ad-hoc facts stay
  // ACTIVE — enough to clear the reconcile trigger on a SECOND tick (the convergence
  // test relies on a second tick being ABLE to fire, yet finding nothing to do).
  for (const t of ['喜欢喝奶茶', '养了一只猫', '每天早上跑步', '生日是三月', '工作在软件公司', '会说三种语言', '喜欢看科幻电影']) {
    await mem.remember({ kind: 'semantic', text: t })
  }
  return mem
}

const bySubstr = (mem: Awaited<ReturnType<typeof seedMoved>>, needle: string) =>
  mem.recall({ kinds: ['semantic'], k: 50 }).then((all) => all.find((e) => e.text.includes(needle)))

describe('M-RECON — the 6h sweep retires stale facts only when reconcile mode is on', () => {
  let tmp: string
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'butler-reconcile-')) })
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

  it('reconcile: true — CLOSES the stale 吉隆坡 fact in place (reversible), leaves the current one active', async () => {
    const mem = await seedMoved(tmp, 'alice')

    const now = 2_000_000_000_000
    await runButlerMaintenanceOnce({
      rootDir: tmp, userId: 'alice', summarize: reconcileSummarize,
      logger: silentLogger, now: () => now, reconcile: true,
    })

    const stale = await bySubstr(mem, '吉隆坡')
    const current = await bySubstr(mem, '槟城')
    expect(stale).toBeDefined() // NOT forgotten — the closed fact survives on disk (reversible)
    expect(validToOf(stale!)).toBe(now) // its validity interval was closed this tick
    expect(isActive(stale!, now)).toBe(false) // …so activeOnly recall stops surfacing it
    expect(isActive(current!, now)).toBe(true) // the current truth is untouched
  })

  it('converges: a SECOND tick never re-litigates the already-closed fact (no drift, current stays active)', async () => {
    const mem = await seedMoved(tmp, 'carol')

    const tick1 = 2_000_000_000_000
    await runButlerMaintenanceOnce({
      rootDir: tmp, userId: 'carol', summarize: reconcileSummarize,
      logger: silentLogger, now: () => tick1, reconcile: true,
    })
    const closedAt = validToOf((await bySubstr(mem, '吉隆坡'))!)
    expect(closedAt).toBe(tick1) // closed on the first tick

    // Second tick, 6h later. 8 facts stay active (≥ trigger), so reconcile CAN fire —
    // but the closed 吉隆坡 is filtered out of the candidate set, so the model is never
    // shown it as a live sibling: no op, no re-close, no risk to the current fact.
    const tick2 = tick1 + 6 * 60 * 60 * 1000
    await runButlerMaintenanceOnce({
      rootDir: tmp, userId: 'carol', summarize: reconcileSummarize,
      logger: silentLogger, now: () => tick2, reconcile: true,
    })

    expect(validToOf((await bySubstr(mem, '吉隆坡'))!)).toBe(tick1) // validTo did NOT drift to tick2
    expect(isActive((await bySubstr(mem, '槟城'))!, tick2)).toBe(true) // the current fact is never mis-closed
  })

  it('default (reconcile off) — byte-identical: no fact is ever closed', async () => {
    const mem = await seedMoved(tmp, 'bob')

    await runButlerMaintenanceOnce({
      rootDir: tmp, userId: 'bob', summarize: reconcileSummarize, logger: silentLogger,
    })

    const all = await mem.recall({ kinds: ['semantic'], k: 50 })
    expect(all.every((e) => validToOf(e) === undefined)).toBe(true) // nothing retired
    expect(all.some((e) => e.text.includes('吉隆坡'))).toBe(true) // …both residence facts remain
    expect(all.some((e) => e.text.includes('槟城'))).toBe(true)
  })
})
