/**
 * §九 承重门 — the 6h maintenance heartbeat over a REAL per-user file handle (MR4-M4).
 *
 * The leaf reviewers (umbrella / cleanOutputs / dreaming) and the host projections
 * (SKILL.md / STATUS.md) are each unit-tested in isolation. This is the load-bearing
 * gate that wires them the way production would and runs ONE maintenance tick over a
 * real `MemoryFileHandle`, then asserts the FOUR claims of MR4:
 *
 *   1. 复盘技能 → SKILL.md: the composed pass merges near-duplicate skills and the
 *      `skillFileReviewer` projects the single resulting umbrella into SKILL.md (the
 *      closed originals drop out for free);
 *   2. ④写状态 → STATUS.md: `statusProjectingReviewer` writes the MERGED one-line
 *      summary (复盘技能 + 清输出 + 合并记忆) to STATUS.md;
 *   3. /me readable: `HostButlerMemoryService.read` surfaces that status as
 *      `lastStatus` and the dreaming promote shows up in the profile — the member
 *      sees the butler self-maintains;
 *   4. no-leak: a DIFFERENT member's tree is untouched — empty read, no SKILL.md /
 *      STATUS.md — because every op is scoped by the per-user namespace.
 *
 * The maintenance reviewer is composed + wrapped here exactly as the host would wire
 * it (`statusProjectingReviewer({ inner: composeReviewers(...) })`), and fired once
 * directly (a heartbeat tick) so the gate is deterministic with NO API key — the aux
 * model behind authoring/merge/dreaming is a structured mock, the leaf stays LLM-free.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Logger } from '@gotong/core'
import {
  activeProcedures,
  cleanOutputsReviewer,
  composeReviewers,
  dreamingReviewer,
  isUmbrella,
  MemoryToolset,
  queryHitMeta,
  umbrellaReviewer,
  type MemoryQueryHitWriter,
  type MemoryReviewer,
} from '@gotong/personal-memory'
import type { MemoryHandle } from '@gotong/services-sdk'

import { HostButlerMemoryService } from '../src/butler-memory-service.js'
import { openButlerMemory } from '../src/personal-butler-memory.js'
import { openButlerSkillFile, skillFileReviewer } from '../src/personal-butler-skills.js'
import { openButlerStatusFile, statusProjectingReviewer } from '../src/personal-butler-status.js'

const silentLogger: Logger = {
  trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
  child() { return silentLogger },
}

/** Far enough past the seeded timestamps that staleMs:1000 makes them all stale. */
const MT_NOW = 5_000_000

/** Build the composed-and-wrapped maintenance reviewer exactly as the host would. */
function buildMaintenance(opts: {
  skillFile: ReturnType<typeof openButlerSkillFile>
  statusFile: ReturnType<typeof openButlerStatusFile>
}): MemoryReviewer {
  const inner = composeReviewers(
    // ① 复盘技能 — fold near-duplicate skills into one umbrella (close, not delete).
    umbrellaReviewer({
      merge: async () => ({ name: '手冲咖啡(合并)', steps: ['烧水', '磨豆', '注水'] }),
      minSimilarity: 0.3,
      minCluster: 2,
    }),
    // ② 清输出 — prune stale working scratch (staleMs:1000 vs the seeded ts).
    cleanOutputsReviewer({ staleMs: 1000 }),
    // ③ 合并记忆 — promote the asked-about fact, prune the never-asked chatter.
    dreamingReviewer({
      summarize: async () => '主人偏好: 喜茶的多肉葡萄(常被问起)',
      promoteGate: 8,
      pruneGate: 1,
      staleMs: 1000,
    }),
    // SKILL.md projection — runs after the merge, returns {} (claims no work).
    skillFileReviewer({ skillFile: opts.skillFile }),
  )
  // ④写状态 — wrap the whole pass so STATUS.md gets the MERGED summary.
  return statusProjectingReviewer({ statusFile: opts.statusFile, inner })
}

describe('personal-butler 6h maintenance — real file handle, one tick, four claims', () => {
  let tmp: string
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'butler-maint-e2e-')) })
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

  it('projects SKILL.md + STATUS.md, surfaces to /me, and leaks to no other member', async () => {
    const userId = 'alice'
    // A butler omits `working` by default (its in-flight state rides the suspend);
    // include it here so the ② 清输出 job has real scratch to prune end to end.
    let clock = 1000
    const mem: MemoryHandle = openButlerMemory({
      rootDir: tmp,
      userId,
      logger: silentLogger,
      config: { kinds: ['episodic', 'semantic', 'working'] },
      now: () => clock++,
    })

    // ── seed ──────────────────────────────────────────────────────────────
    // ① two near-duplicate skills to be merged.
    await mem.remember({ kind: 'semantic', text: '手冲咖啡', meta: { form: 'procedure', steps: ['烧水', '磨豆', '注水'] } })
    await mem.remember({ kind: 'semantic', text: '手冲咖啡法', meta: { form: 'procedure', steps: ['煮水', '研磨', '冲泡'] } })
    // ② a stale working scratch + a durable profile that must survive.
    await mem.remember({ kind: 'working', text: '工具输出: 临时草稿 abc' })
    await mem.remember({ kind: 'semantic', text: '主人的画像: 在做奶茶店项目' })
    // ③ an asked-about hot fact + stale never-asked chatter.
    const hot = await mem.remember({ kind: 'episodic', text: '主人最爱喜茶的多肉葡萄', meta: { importance: 5 } })
    await mem.remember({ kind: 'episodic', text: '随口说一句今天有点热', meta: { importance: 1 } })

    // Two DIFFERENT questions about the hot fact → query-diversity 2 (through the
    // real recall tool + file-backed patchMeta, exactly what the host wires).
    const queryHit: MemoryQueryHitWriter = (e, fp) => {
      const delta = queryHitMeta(e, fp)
      return delta ? Promise.resolve(mem.patchMeta!(e.id, delta)).then(() => {}) : Promise.resolve()
    }
    const tools = new MemoryToolset({ memory: mem, queryHit })
    await tools.callTool('recall', { query: '喜茶', kinds: ['episodic'] })
    await tools.callTool('recall', { query: '葡萄', kinds: ['episodic'] })

    // ── one maintenance tick ────────────────────────────────────────────────
    const skillFile = openButlerSkillFile({ rootDir: tmp, userId, logger: silentLogger })
    const statusFile = openButlerStatusFile({ rootDir: tmp, userId, logger: silentLogger })
    const maintenance = buildMaintenance({ skillFile, statusFile })
    const out = await maintenance({
      memory: mem,
      episodic: await mem.recall({ kinds: ['episodic'], k: 50 }),
      now: MT_NOW,
    })

    // Claim 1 — 复盘技能 → SKILL.md: one active umbrella, projected to the file.
    const active = activeProcedures(await mem.list({ kind: 'semantic', limit: 50 }), MT_NOW)
    expect(active.length).toBe(1)
    expect(isUmbrella(active[0]!)).toBe(true)
    const skill = await skillFile.read()
    expect(skill!.count).toBe(1)
    expect(skill!.skills[0]!.umbrella).toBe(true)

    // Claim 2 — ④写状态 → STATUS.md: the MERGED summary of all three jobs.
    expect(out.summary).toMatch(/merged \d+ skill cluster/) // ① 复盘技能
    expect(out.summary).toMatch(/cleaned \d+ stale output/) // ② 清输出
    expect(out.summary).toMatch(/dreamed: promoted [1-9]/) // ③ 合并记忆
    const status = await statusFile.read()
    expect(status!.summary).toBe(out.summary)

    // Claim 3 — /me readable: the member sees the status + the dreaming promote, and
    // the stale scratch / chatter are gone (read through a SEPARATE service handle on
    // the same on-disk tree, proving these are the same bytes).
    const svc = new HostButlerMemoryService({ rootDir: tmp, logger: silentLogger, now: () => MT_NOW })
    const snap = await svc.read(userId)
    expect(snap.lastStatus).toEqual({ writtenAt: MT_NOW, summary: out.summary })
    // The durable profile survived the cleanup AND the dreaming promote landed.
    expect(snap.profile.some((e) => e.text.includes('奶茶店'))).toBe(true)
    expect(snap.profile.some((e) => e.text.includes('多肉葡萄'))).toBe(true)
    // The asked-about episodic was folded away; the chatter was pruned.
    expect(snap.recent.some((e) => e.id === hot.id)).toBe(false)
    expect(snap.recent.some((e) => e.text.includes('有点热'))).toBe(false)

    // Claim 4 — no-leak: a DIFFERENT member's tree is empty, no derived files.
    const other = await svc.read('mallory')
    expect(other.profile).toEqual([])
    expect(other.recent).toEqual([])
    expect(other.lastStatus).toBeUndefined()
    expect(await openButlerSkillFile({ rootDir: tmp, userId: 'mallory', logger: silentLogger }).read()).toBeNull()
    expect(await openButlerStatusFile({ rootDir: tmp, userId: 'mallory', logger: silentLogger }).read()).toBeNull()
  })
})
