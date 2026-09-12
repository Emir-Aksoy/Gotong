/**
 * personal-butler-tiered-e2e — the acceptance gate for tiered + importance
 * memory (decisions ③ "多级长期" × ⑤ "重要性区分", built "两者结合").
 *
 * The unit suites prove each piece in isolation: `consolidate-tiered` routes /
 * folds / importance-gates, `clustered-frozen-block` groups + importance-orders,
 * `butler-memory-service` projects tier/level/importance. This drives them
 * COMPOSED through the production wiring. Legacy fixtures retain the original
 * model-curation coverage; a separate live-capture case pins protected evidence.
 *
 *   1. LEGACY TIERED CURATION THROUGH THE HEARTBEAT — legacy turns across
 *      topics → the `tieredReviewer` (the heartbeat job, Stream D) routes
 *      the episodic backlog into per-cluster DIGESTS with importance (③×⑤), and
 *      the member's `/me` privacy view (HostButlerMemoryService) shows WHICH
 *      cluster and HOW important — end to end, no unit shims.
 *   2. LEGACY IMPORTANCE-GRADED PROMOTION IN ONE TICK — the same heartbeat tick folds a
 *      high-importance cluster into a stable PROFILE while DROPPING a trivial
 *      cluster's digest (importance < gate, no prior profile) — visible in the
 *      `/me` view as a `level:'profile'` entry, with the trivia simply gone.
 *   3. A FRESH SESSION CONSUMES IT — a brand-new butler instance (same per-user
 *      memory) sends a CLUSTERED, IMPORTANCE-ORDERED frozen block to the model:
 *      `## 画像` / `## 项目` headings in catalog order, and a p5 fact ahead of a
 *      newer p2 one in the same cluster (salience beats recency, in the live block).
 *   4. NEW CAPTURES KEEP EVIDENCE — exact user statements and turn times survive
 *      deterministic routing and promotion, without model paraphrases or inferred ratings.
 *
 * The LLM is a deterministic provider (no API key): it acks turns (so capture
 * runs), routes the curator's batch by keyword into cluster JSON, writes cluster
 * profiles, and RECORDS the system prompt so claim 3 can assert the real block
 * the agent built. The butler's loop, capture, frozen-block injection, the
 * tiered reviewer, and the host `/me` projection are all the real code.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Hub, InMemoryStorage, type Logger } from '@gotong/core'
import {
  DEFAULT_TIERS,
  tieredReviewer,
  type MemoryReviewer,
} from '@gotong/personal-memory'
import { GovernedActionToolset, PersonalButlerAgent } from '@gotong/personal-butler'
import type {
  LlmRequest,
  LlmMessage,
  LlmProvider,
  LlmStreamChunk,
} from '@gotong/llm'
import type { MemoryHandle } from '@gotong/services-sdk'

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

const BUTLER_SYSTEM = '你是用户的私人管家。你有长期记忆,会主动帮忙。'

// ── deterministic provider ──────────────────────────────────────────────────
// Acks every turn (so `captureTurns` records it) AND records the last system
// prompt the agent built (claim 3 inspects the real frozen block). It is also
// the memory CURATOR: the `tieredReviewer` calls it as a `MemorySummarizer`, so
// the same fake both answers turns and routes/distills clusters — but those go
// through `summarize(...)`, NOT `stream(...)`, so they never cross here.
function lastUserText(req: LlmRequest): string {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const m = req.messages[i] as LlmMessage
    if (m.role === 'user' && typeof m.content === 'string') return m.content
  }
  return ''
}

class RecordingProvider implements LlmProvider {
  readonly name = 'butler-tiered-e2e'
  /** The system prompt of the most recent turn — the frozen block + agent prompt. */
  lastSystem = ''

  async *stream(req: LlmRequest): AsyncIterable<LlmStreamChunk> {
    this.lastSystem = req.system ?? ''
    void lastUserText(req)
    yield { type: 'text', text: '好的,我记下了。' }
    yield { type: 'end', stopReason: 'end_turn' }
  }
}

// The tiered curator: routes the episodic batch into cluster JSON (routing pass)
// and writes a cluster profile (promote pass). Branch on the system prompt the
// orchestrator builds — the routing system asks for a JSON `clusters` object;
// the promote system asks to "Collapse the cluster ... into ONE stable profile".
async function curate(args: { system: string; user: string }): Promise<string> {
  const { system, user } = args
  if (system.includes('JSON') && system.includes('cluster')) {
    // Catalog labels are instructions, not evidence that the user has a project.
    const batch = user.match(/\[\d+ recent conversation entries to route \(oldest first\)\]\n([\s\S]*)/)?.[1] ?? ''
    const clusters: Record<string, { digest: string; importance: number }> = {}
    if (/阿明|过敏|花生|名叫|我叫/.test(batch)) {
      clusters.persona = { digest: '主人名叫阿明;对花生严重过敏(关键安全信息)。', importance: 5 }
    }
    if (/奶茶店|项目|创业/.test(batch)) {
      clusters.projects = { digest: '在做一个奶茶店创业项目。', importance: 3 }
    }
    if (/天气|闲聊|随便|无聊/.test(batch)) {
      clusters.misc = { digest: '一些无关紧要的闲聊。', importance: 1 }
    }
    return JSON.stringify({ clusters })
  }
  // PROMOTE: distill the cluster's digests into a stable profile body.
  if (/过敏|阿明/.test(user)) return '画像:主人名叫阿明;对花生严重过敏,务必规避。'
  if (/奶茶店/.test(user)) return '项目:奶茶店创业,正在筹备阶段。'
  return '(已整理。)'
}

// A no-op governed toolset — the butler requires one, but the recording provider
// never emits a tool_use, so it is never invoked. Tiered memory is about what
// the butler REMEMBERS, not what it DOES (governance is the §七 gate's job).
function noopGoverned(): GovernedActionToolset {
  return new GovernedActionToolset({
    tools: [
      {
        name: 'noop',
        description: '占位,本测试不触发',
        inputSchema: { type: 'object', properties: {} },
      },
    ],
    classify: async () => ({ decision: 'allow' }),
    execute: async () => ({ text: 'ok' }),
  })
}

describe('personal-butler-tiered-e2e — tiered + importance memory (③×⑤)', () => {
  let tmp: string
  let memRoot: string
  let hub: Hub
  let provider: RecordingProvider
  let view: HostButlerMemoryService

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'host-butler-tiered-'))
    memRoot = join(tmp, 'mem')
    provider = new RecordingProvider()
    view = new HostButlerMemoryService({ rootDir: memRoot, logger: silentLogger })
    hub = new Hub({ storage: new InMemoryStorage() })
    await hub.start()
  })

  afterEach(async () => {
    await hub.stop().catch(() => {})
    rmSync(tmp, { recursive: true, force: true })
  })

  function memFor(userId: string): MemoryHandle {
    return openButlerMemory({ rootDir: memRoot, userId, logger: silentLogger })
  }

  // Per-user namespace key on every capture, mirroring main.ts — the curator
  // and view share the SAME handle, so scoping is by the handle, not a filter.
  function butlerFor(id: string, memory: MemoryHandle): PersonalButlerAgent {
    return new PersonalButlerAgent({
      id,
      provider,
      memory,
      system: BUTLER_SYSTEM,
      governed: noopGoverned(),
      maxToolRounds: 4,
    })
  }

  async function dispatchTo(butlerId: string, userId: string, prompt: string) {
    return hub.dispatch({
      from: `user:${userId}`,
      strategy: { kind: 'explicit', to: butlerId },
      payload: prompt,
      origin: { orgId: 'local', userId },
    })
  }

  /**
   * The heartbeat job main.ts wires: one tiered reviewer over the user's memory.
   * `keepRecent: 1` folds every topic turn but leaves the single most-recent
   * (a content-free filler each claim supplies last) — 0 isn't usable, the
   * tiered path clamps a non-positive keepRecent back to its default (8).
   */
  function reviewerFor(promoteAfterDigests: number, summarize: typeof curate = curate): MemoryReviewer {
    return tieredReviewer({
      summarize,
      config: DEFAULT_TIERS,
      force: true,
      keepRecent: 1,
      promoteAfterDigests,
      promoteMinImportance: 2,
    })
  }

  /** Old records had no user spans or turn clocks; do not downgrade new captures to simulate them. */
  async function seedLegacyTurns(userId: string, texts: string[]): Promise<void> {
    let clock = 1_000
    const memory = openButlerMemory({ rootDir: memRoot, userId, logger: silentLogger, now: () => clock++ })
    for (const text of texts) await memory.remember({ kind: 'episodic', text: `User: ${text}\nButler: 好的,我记下了。` })
  }

  it('claim 1 — heartbeat routes legacy fixtures into cluster digests with importance; /me shows cluster + salience', async () => {
    const mem = memFor('alice')
    await seedLegacyTurns('alice', [
      '记住,我叫阿明,我对花生过敏。', '我在做一个奶茶店创业项目。',
      '今天天气不错,随便聊聊。', '好的,谢谢你。',
    ])
    expect(await mem.recall({ kinds: ['episodic'], k: 50 })).toHaveLength(4)

    // One heartbeat tick. promoteAfter high so this tick ONLY consolidates
    // (each cluster has a single digest) — promotion is claim 2.
    const summarize = vi.fn(curate)
    const outcome = await reviewerFor(99, summarize)({ memory: mem, now: 3_000_000 })
    expect(outcome.summary ?? '').toContain('tiered')
    expect(summarize).toHaveBeenCalledOnce()

    // Topic turns folded into digests; only the filler kept-recent remains.
    const remaining = await mem.recall({ kinds: ['episodic'], k: 50 })
    expect(remaining).toHaveLength(1)
    expect(remaining[0]!.text).toContain('谢谢')

    // The /me privacy view shows the digests, each tagged with its cluster +
    // salience — the end-to-end ③×⑤ projection a member actually sees.
    const all = await view.export('alice')
    const persona = all.find((e) => e.tier === 'persona')!
    expect(persona.level).toBe('digest')
    expect(persona.importance).toBe(5) // safety-critical fact rated highest
    expect(persona.text).toContain('过敏')

    const projects = all.find((e) => e.tier === 'projects')!
    expect(projects.level).toBe('digest')
    expect(projects.importance).toBe(3)

    const misc = all.find((e) => e.tier === 'misc')!
    expect(misc.importance).toBe(1) // trivial chatter rated lowest (drops on promote)
  })

  it('claim 2 — legacy promotion keeps a high-importance profile and drops a trivial digest (/me view)', async () => {
    const mem = memFor('bob')

    // A safety-critical persona fact (p5), trivial chatter (p1), + a filler
    // (the kept-recent) so both topic turns fold this tick.
    await seedLegacyTurns('bob', [
      '我叫阿明,对花生过敏,这点很重要。', '今天天气不错,随便聊聊。', '好的,谢谢你。',
    ])

    // promoteAfter=1 → this single tick BOTH consolidates AND promotes every
    // cluster: persona (p5 ≥ gate) → stable profile; misc (p1 < gate, no prior
    // profile) → its digest is dropped, no empty profile synthesized.
    const summarize = vi.fn(curate)
    const outcome = await reviewerFor(1, summarize)({ memory: mem, now: 4_000_000 })
    expect(outcome.summary ?? '').toMatch(/promoted/)
    expect(outcome.summary ?? '').toMatch(/dropped/)
    expect(summarize).toHaveBeenCalledTimes(2) // Routing + nontrivial profile; trivia never reaches promotion.

    const all = await view.export('bob')
    const persona = all.find((e) => e.tier === 'persona')!
    expect(persona.level).toBe('profile') // promoted to the stable layer
    expect(persona.importance).toBe(5)
    expect(persona.text).toContain('过敏')

    // The trivial cluster left nothing durable — no misc entry at any level.
    expect(all.some((e) => e.tier === 'misc')).toBe(false)
    expect(all.some((e) => e.tier === 'projects')).toBe(false)
  })

  it('claim 4 — live captures retain exact user sources through conservative routing and promotion', async () => {
    const mem = memFor('dana')
    const b = butlerFor('butler:dana:s1', mem)
    hub.register(b)
    const users = ['记住,我叫阿明,我对花生过敏。', '我在做一个奶茶店创业项目。', '今天天气不错,随便聊聊。']
    for (const user of [...users, '好的,谢谢你。']) {
      expect((await dispatchTo('butler:dana:s1', 'dana', user)).kind).toBe('ok')
    }
    hub.unregister('butler:dana:s1')
    const captures = await mem.recall({ kinds: ['episodic'], k: 50 })
    expect(captures).toHaveLength(4)
    const sources = users.map(user => {
      const capture = captures.find(e => e.text.startsWith(`User: ${user}\n`))!
      expect(capture.meta?.userSpan).toEqual({ v: 1, start: 6, end: 6 + user.length })
      expect(capture.meta?.temporal).toMatchObject({ v: 1, basis: 'turn-start' })
      return { sourceId: capture.id, speaker: 'user', temporal: capture.meta!.temporal }
    })
    async function assertQuoteBindings(): Promise<void> {
      const entries = await mem.list({ kind: 'semantic', limit: 50 })
      const actual = entries.flatMap(entry => {
        const evidence = entry.meta?.evidence as { sources: { sourceId: string; start: number; end: number }[] }
        return evidence.sources.map(s => ({ sourceId: s.sourceId, text: entry.text.slice(s.start, s.end) }))
      }).sort((a, b) => a.sourceId.localeCompare(b.sourceId))
      expect(actual).toEqual(sources.map((s, i) => ({ sourceId: s.sourceId, text: users[i] }))
        .sort((a, b) => a.sourceId.localeCompare(b.sourceId)))
    }
    const summarize = vi.fn(curate)
    const digest = await reviewerFor(99, summarize)({ memory: mem, now: 5_000_000 })
    expect(digest.consolidated).toBe(3)
    expect(summarize).not.toHaveBeenCalled()
    await assertQuoteBindings()
    const remaining = await mem.recall({ kinds: ['episodic'], k: 50 })
    expect(remaining).toHaveLength(1)
    expect(remaining[0]!.text).toContain('谢谢')

    // The keyword router does not infer persona from an allergy statement or
    // assign the model's invented p5/p1 scores; sources keep their default p3.
    const all = await view.export('dana')
    const digests = all.filter(e => e.level === 'digest')
    expect(digests).toHaveLength(2)
    expect(digests.find(e => e.tier === 'misc')).toMatchObject({ text: `${users[0]}\n${users[2]}`, importance: 3 })
    expect(digests.find(e => e.tier === 'projects')).toMatchObject({ text: users[1], importance: 3 })
    expect(digests.some(e => e.tier === 'persona')).toBe(false)

    const promotion = await reviewerFor(1, summarize)({ memory: mem, now: 5_000_001 })
    expect(promotion.summary).toContain('promoted 2 cluster(s)')
    expect(promotion.summary).not.toContain('dropped')
    expect(summarize).not.toHaveBeenCalled()
    const profiles = await mem.list({ kind: 'semantic', limit: 50 })
    expect(profiles).toHaveLength(2)
    expect(profiles.every(e => e.meta?.level === 'profile')).toBe(true)
    await assertQuoteBindings()
    expect(profiles.find(e => e.meta?.tier === 'misc')?.meta).toMatchObject({
      evidence: { v: 1, sources: [sources[0], sources[2]] },
    })
    expect(profiles.find(e => e.meta?.tier === 'projects')?.meta).toMatchObject({
      evidence: { v: 1, sources: [sources[1]] },
    })
    expect(profiles.map(e => e.text).sort()).toEqual([`${users[0]}\n${users[2]}`, users[1]].sort())
    expect(profiles.every(e => !e.text.includes('好的,我记下了') && !e.text.includes('严重'))).toBe(true)
  })

  it('claim 3 — a fresh session sends a clustered, importance-ordered frozen block to the model', async () => {
    // Seed two clusters directly with a controlled clock so we can assert
    // salience beats recency: a p5 persona fact (older) and a p2 persona fact
    // (newer), plus a p3 projects fact for a second cluster heading.
    let clk = 1_000
    const mem = openButlerMemory({ rootDir: memRoot, userId: 'cara', logger: silentLogger, now: () => clk })
    clk = 1_000
    await mem.remember({ kind: 'semantic', text: '主人对花生严重过敏。', meta: { tier: 'persona', importance: 5 } })
    clk = 2_000 // newer, but lower importance — must still sort AFTER the p5 fact
    await mem.remember({ kind: 'semantic', text: '主人平时爱喝美式咖啡。', meta: { tier: 'persona', importance: 2 } })
    clk = 3_000
    await mem.remember({ kind: 'semantic', text: '在做一个奶茶店创业项目。', meta: { tier: 'projects', importance: 3 } })

    // A BRAND-NEW butler instance (default DEFAULT_TIERS → clustered block).
    const b = butlerFor('butler:cara:fresh', mem)
    hub.register(b)
    expect((await dispatchTo('butler:cara:fresh', 'cara', '你好。')).kind).toBe('ok')

    const sys = provider.lastSystem
    // Clustered: cluster headings present, in catalog order (画像 before 项目).
    expect(sys).toContain('## 画像')
    expect(sys).toContain('## 项目')
    expect(sys.indexOf('## 画像')).toBeLessThan(sys.indexOf('## 项目'))
    // Importance beats recency WITHIN a cluster: the p5 fact precedes the newer p2.
    expect(sys).toContain('过敏')
    expect(sys).toContain('美式')
    expect(sys.indexOf('过敏')).toBeLessThan(sys.indexOf('美式'))
    // The agent's own system prompt still follows the (front-loaded) block.
    expect(sys).toContain('私人管家')
  })
})
