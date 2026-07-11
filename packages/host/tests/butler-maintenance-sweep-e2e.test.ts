/**
 * BF-M8 承重门 — the resident butler's 蒸馏 + 6h maintenance running in the
 * PRODUCTION host path: a real `LocalAgentPool` provider seam driving a real
 * `ButlerMaintenanceSweeper` over on-disk per-user namespaces.
 *
 * The MR4 §九 gate (`personal-butler-maintenance-e2e.test.ts`) fires the
 * maintenance reviewer DIRECTLY over a hand-built file handle. This gate is
 * distinct: it proves the two pieces BF-M8 actually adds to `gotong start` —
 *
 *   1. seam: the sweep's distillation model comes from the SAME managed `chat`
 *      row the butler talks through, resolved through the real
 *      `LocalAgentPool.buildButlerProvider()` (reusing `resolveApiKey` +
 *      `providerFactory`), NOT a hand-passed provider;
 *   2. sweep: `ButlerMaintenanceSweeper.runOnce()` enumerates `<root>/user/*`
 *      and maintains each member — episodic→cluster digest 蒸馏 lands, STATUS.md
 *      is written, and `/me` surfaces it — with NO api key (mock provider →
 *      fallback routing → deterministic digests).
 *
 * A butler omits `working` scratch and doesn't auto-author procedures, so the
 * lean BF-M8 pass is `tieredReviewer` (蒸馏) wrapped by `statusProjectingReviewer`
 * (STATUS.md). No inbox / identity needed — maintenance is a background sweep,
 * not a task.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  Hub,
  Space,
  AgentParticipant,
  type Logger,
  type Task,
} from '@gotong/core'
import type { LlmAgentOptions, LlmProvider, LlmRequest, LlmStreamChunk } from '@gotong/llm'
import { levelOf, tierOf, type MemoryEntry } from '@gotong/personal-memory'
import type { MemoryHandle } from '@gotong/services-sdk'

import type { GitRunner } from '../src/butler-memory-git.js'
import { HostButlerMemoryService } from '../src/butler-memory-service.js'
import { LocalAgentPool, type ButlerFactory } from '../src/local-agent-pool.js'
import {
  ButlerMaintenanceSweeper,
  type ButlerMaintenanceSweeperOptions,
} from '../src/personal-butler-maintenance.js'
import { openButlerMemory } from '../src/personal-butler-memory.js'
import { openButlerStatusFile } from '../src/personal-butler-status.js'

const silentLogger: Logger = {
  trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
  child() { return silentLogger },
}

/** Constant maintenance clock — far past the seeded episodic timestamps. */
const MT_NOW = 9_000_000

/** A butler factory is REQUIRED for `butlerEnabledFor` to see the row as a
 *  butler; the sweep never spawns, so this participant is never invoked. */
class FakeButler extends AgentParticipant {
  constructor(id: string, caps: readonly string[]) { super({ id, capabilities: caps }) }
  protected async handleTask(_task: Task): Promise<unknown> { return { butler: true } }
}
const trivialFactory: ButlerFactory = (base: LlmAgentOptions) =>
  new FakeButler(base.id, base.capabilities)

/** Seed `count` episodic entries into one member's butler namespace. */
async function seedEpisodic(rootDir: string, userId: string, count: number): Promise<void> {
  let clock = 1000
  const mem: MemoryHandle = openButlerMemory({
    rootDir,
    userId,
    logger: silentLogger,
    now: () => clock++,
  })
  for (let i = 0; i < count; i++) {
    await mem.remember({ kind: 'episodic', text: `主人在聊第 ${i} 件事：奶茶店的事情`, meta: { importance: 2 } })
  }
}

/** Count a member's live episodic entries (post-sweep). */
async function episodicCount(rootDir: string, userId: string): Promise<number> {
  const mem = openButlerMemory({ rootDir, userId, logger: silentLogger })
  return (await mem.recall({ kinds: ['episodic'], k: 500 })).length
}

/** The semantic entries that are consolidation digests (`meta.level === 'digest'`). */
async function digests(rootDir: string, userId: string): Promise<MemoryEntry[]> {
  const mem = openButlerMemory({ rootDir, userId, logger: silentLogger })
  const sem = await mem.list({ kind: 'semantic', limit: 500 })
  return sem.filter((e) => levelOf(e) === 'digest')
}

describe('BF-M8 — butler 蒸馏 + 6h maintenance in the production host sweep', () => {
  let root: string
  let space: Space
  let hub: Hub
  let memRoot: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'gotong-butler-maint-sweep-'))
    const opened = await Space.init(root, { name: 'test' })
    space = opened.space
    hub = new Hub({ space })
    await hub.start()
    // Mirror main.ts: <space>/butler/memory — the same tree the factory + /me use.
    memRoot = join(space.root, 'butler', 'memory')
  })
  afterEach(async () => {
    await hub.stop()
    await rm(root, { recursive: true, force: true })
  })

  /** A real pool over a mock `chat` butler row (default-on). */
  function butlerPool(): LocalAgentPool {
    return new LocalAgentPool({ hub, space, butlerFactory: trivialFactory, butlerDefaultOn: true })
  }

  function sweeper(pool: LocalAgentPool, extra: Partial<ButlerMaintenanceSweeperOptions> = {}) {
    return new ButlerMaintenanceSweeper({
      rootDir: memRoot,
      buildProvider: () => pool.buildButlerProvider(),
      logger: silentLogger,
      now: () => MT_NOW,
      ...extra,
    })
  }

  it('resolves the provider from the butler row, distills one member, surfaces to /me, leaks to none', async () => {
    await space.upsertAgent({
      id: 'assistant',
      allowedCapabilities: ['chat'],
      createdAt: new Date().toISOString(),
      managed: { kind: 'llm', provider: 'mock', system: 'you are the butler' },
    })
    const pool = butlerPool()

    // Seed 40 episodic for alice (clears the default 32-entry trigger); bob stays empty.
    await seedEpisodic(memRoot, 'alice', 40)

    // ── Claim 1 — seam: the sweep's provider comes from the real pool + row. ──
    const provider = await pool.buildButlerProvider()
    expect(provider).not.toBeNull()

    // ── one maintenance sweep ────────────────────────────────────────────────
    await sweeper(pool).runOnce()

    // ── Claim 2 — 蒸馏: episodic folded to keepRecent(8), a tiered digest wrote. ──
    expect(await episodicCount(memRoot, 'alice')).toBe(8)
    const d = await digests(memRoot, 'alice')
    expect(d.length).toBeGreaterThanOrEqual(1)
    // Digest carries its cluster tier (routed, even under mock fallback routing).
    expect(tierOf(d[0]!, '')).not.toBe('')

    // ── Claim 3 — STATUS.md + /me: the member sees the maintenance summary. ──
    const status = await openButlerStatusFile({ rootDir: memRoot, userId: 'alice', logger: silentLogger }).read()
    expect(status).not.toBeNull()
    expect(status!.summary).toMatch(/tiered \d+ episodic/)
    const svc = new HostButlerMemoryService({ rootDir: memRoot, logger: silentLogger, now: () => MT_NOW })
    const snap = await svc.read('alice')
    expect(snap.lastStatus?.summary).toBe(status!.summary)

    // ── Claim 4 — no-leak: a member who never had a namespace is untouched. ──
    const bob = await svc.read('bob')
    expect(bob.profile).toEqual([])
    expect(bob.recent).toEqual([])
    expect(bob.lastStatus).toBeUndefined()
    expect(await openButlerStatusFile({ rootDir: memRoot, userId: 'bob', logger: silentLogger }).read()).toBeNull()
  })

  it('no butler-enabled row → buildButlerProvider null → sweep is a clean no-op', async () => {
    // A back-office LLM row with NO `chat` capability — never a butler.
    await space.upsertAgent({
      id: 'backoffice',
      allowedCapabilities: ['draft'],
      createdAt: new Date().toISOString(),
      managed: { kind: 'llm', provider: 'mock', system: 'drafter' },
    })
    const pool = butlerPool()

    // alice still has a butler memory tree on disk (from a prior butler session),
    // so the sweep FINDS her namespace — but with no provider it must not distill.
    await seedEpisodic(memRoot, 'alice', 40)

    expect(await pool.buildButlerProvider()).toBeNull()
    await sweeper(pool).runOnce() // must not throw

    // Episodic untouched, no digest, no STATUS.md — the tick honestly no-op'd.
    expect(await episodicCount(memRoot, 'alice')).toBe(40)
    expect(await digests(memRoot, 'alice')).toHaveLength(0)
    expect(await openButlerStatusFile({ rootDir: memRoot, userId: 'alice', logger: silentLogger }).read()).toBeNull()
  })

  it('audit P1 — corrupt agents.json → buildButlerProvider null (no throw) → sweep no-op', async () => {
    await space.upsertAgent({
      id: 'assistant',
      allowedCapabilities: ['chat'],
      createdAt: new Date().toISOString(),
      managed: { kind: 'llm', provider: 'mock', system: 'butler' },
    })
    const pool = butlerPool()
    await seedEpisodic(memRoot, 'alice', 40)

    // Corrupt the agents file: space.agents() → readJson → JSON.parse now throws.
    // Before the fix, buildButlerProvider() let that propagate through the sweep's
    // fire-and-forget `void runOnce()` → unhandledRejection → host crash.
    await writeFile(space.paths.agents, 'not valid json {{{', 'utf8')

    expect(await pool.buildButlerProvider()).toBeNull() // skips the tick, does not throw
    await expect(sweeper(pool).runOnce()).resolves.toBeUndefined() // must not reject

    // The tick honestly no-op'd — nothing distilled, alice's episodic untouched.
    expect(await episodicCount(memRoot, 'alice')).toBe(40)
    expect(await digests(memRoot, 'alice')).toHaveLength(0)
  })

  it('no members on disk → sweep never even builds a provider', async () => {
    await space.upsertAgent({
      id: 'assistant',
      allowedCapabilities: ['chat'],
      createdAt: new Date().toISOString(),
      managed: { kind: 'llm', provider: 'mock', system: 'butler' },
    })
    const pool = butlerPool()
    let providerBuilds = 0
    const sw = sweeper(pool, {
      buildProvider: async () => {
        providerBuilds++
        return pool.buildButlerProvider()
      },
    })
    await sw.runOnce() // no <root>/user/* dirs yet
    expect(providerBuilds).toBe(0) // returns before building — nothing to distill
  })

  it('MU-M5 — gitSnapshot opt-in reaches the member dir; default off invokes no git', async () => {
    await space.upsertAgent({
      id: 'assistant',
      allowedCapabilities: ['chat'],
      createdAt: new Date().toISOString(),
      managed: { kind: 'llm', provider: 'mock', system: 'butler' },
    })
    const pool = butlerPool()
    await seedEpisodic(memRoot, 'alice', 40)

    // Default (gitSnapshot unset) → the git runner is never called, even when one
    // is passed. Opt-in means opt-in: the knob defaults false.
    const offCwds: string[] = []
    const offGit: GitRunner = async (_args, cwd) => { offCwds.push(cwd); return { code: 0, stdout: '', stderr: '' } }
    await sweeper(pool, { git: offGit }).runOnce()
    expect(offCwds).toEqual([])

    // gitSnapshot:true → alice's memory dir is snapshotted through the injected
    // runner (clean status → 'nothing', but the dir was still visited).
    const onCwds: string[] = []
    const onGit: GitRunner = async (_args, cwd) => { onCwds.push(cwd); return { code: 0, stdout: '', stderr: '' } }
    await sweeper(pool, { gitSnapshot: true, git: onGit }).runOnce()
    expect(onCwds).toContain(join(memRoot, 'user', 'alice'))
  })

  /**
   * NA-M5 — 维护低价模型 override:spec 的 `maintenanceModel` 经
   * `pool.butlerMaintenanceModel()`(main.ts 的 `resolveModel` 接线)在每个
   * tick 解析,落到每次蒸馏调用的 `req.model` 上。未设 = 无 override,与今天
   * 逐字节一致;resolver 抛错降级为无 override,绝不让 tick 失败。
   */
  describe('NA-M5 — maintenance model override', () => {
    function capturingProvider(): { provider: LlmProvider; seen: LlmRequest[] } {
      const seen: LlmRequest[] = []
      const provider: LlmProvider = {
        name: 'na-m5-capture',
        async *stream(req: LlmRequest): AsyncIterable<LlmStreamChunk> {
          seen.push(req)
          yield { type: 'text', text: 'digest' }
          yield { type: 'end', stopReason: 'end_turn' }
        },
      }
      return { provider, seen }
    }

    it('spec maintenanceModel → butlerMaintenanceModel() → every distillation req.model', async () => {
      await space.upsertAgent({
        id: 'assistant',
        allowedCapabilities: ['chat'],
        createdAt: new Date().toISOString(),
        managed: {
          kind: 'llm', provider: 'mock', system: 'you are the butler',
          maintenanceModel: '  cheap-distill-v1  ', // whitespace → accessor trims
        },
      })
      const pool = butlerPool()
      expect(await pool.butlerMaintenanceModel()).toBe('cheap-distill-v1')

      await seedEpisodic(memRoot, 'alice', 40)
      const { provider, seen } = capturingProvider()
      await sweeper(pool, {
        buildProvider: async () => provider,
        // Exactly main.ts's wiring shape — per-tick resolution off the live row.
        resolveModel: () => pool.butlerMaintenanceModel(),
      }).runOnce()

      expect(seen.length).toBeGreaterThan(0)
      for (const req of seen) expect(req.model).toBe('cheap-distill-v1')
    })

    it('unset maintenanceModel → no override (req.model stays undefined, byte-identical)', async () => {
      await space.upsertAgent({
        id: 'assistant',
        allowedCapabilities: ['chat'],
        createdAt: new Date().toISOString(),
        managed: { kind: 'llm', provider: 'mock', system: 'you are the butler' },
      })
      const pool = butlerPool()
      expect(await pool.butlerMaintenanceModel()).toBeUndefined()

      await seedEpisodic(memRoot, 'alice', 40)
      const { provider, seen } = capturingProvider()
      await sweeper(pool, {
        buildProvider: async () => provider,
        resolveModel: () => pool.butlerMaintenanceModel(),
      }).runOnce()

      expect(seen.length).toBeGreaterThan(0)
      for (const req of seen) expect(req.model).toBeUndefined()
    })

    it('a throwing resolver degrades to no-override — the tick still completes', async () => {
      await space.upsertAgent({
        id: 'assistant',
        allowedCapabilities: ['chat'],
        createdAt: new Date().toISOString(),
        managed: { kind: 'llm', provider: 'mock', system: 'you are the butler' },
      })
      const pool = butlerPool()
      await seedEpisodic(memRoot, 'alice', 40)
      const { provider, seen } = capturingProvider()

      await expect(
        sweeper(pool, {
          buildProvider: async () => provider,
          resolveModel: async () => { throw new Error('boom') },
        }).runOnce(),
      ).resolves.toBeUndefined()

      expect(seen.length).toBeGreaterThan(0) // maintenance still ran
      for (const req of seen) expect(req.model).toBeUndefined()
    })
  })
})
