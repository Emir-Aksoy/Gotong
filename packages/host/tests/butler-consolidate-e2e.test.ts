/**
 * S2-M2 承重门 — the resident butler's on-demand "整理一下记忆" tool running the
 * SAME per-member maintenance pass BF-M8 runs on its 6h sweep, but fired NOW by a
 * member asking for it.
 *
 * The BF-M8 sweep gate (`butler-maintenance-sweep-e2e.test.ts`) proves the
 * BACKGROUND path (pool provider seam + `<root>/user/*` enumeration). This gate is
 * distinct: it proves the ON-DEMAND path — `buildButlerConsolidateToolset`, the
 * benign tool the butler calls when a member says "整理一下记忆" —
 *
 *   1. runs the exact shared `runButlerMaintenanceOnce` pass (蒸馏 episodic→cluster
 *      digest + STATUS.md), so on-demand and the sweep can never drift;
 *   2. resolves the distillation provider through the injected `buildProvider`
 *      (in prod = the butler's own model via `pool.buildButlerProvider()`) at CALL
 *      time, and a null model is a friendly, non-throwing refusal — NOT a crash;
 *   3. is benign (inline): it returns an `ok` tool result the butler relays, never
 *      parks — distilling one's OWN memory needs no /me approval.
 *
 * Tests the builder DIRECTLY (like the S1-M1 gate) with a deterministic mock
 * provider; the main.ts factory wiring is trusted to typecheck (it mirrors the
 * governed / workflows toolsets built alongside it in the same `benign` array).
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Logger } from '@aipehub/core'
import { MockLlmProvider, type LlmProvider } from '@aipehub/llm'
import { levelOf, type MemoryEntry } from '@aipehub/personal-memory'
import type { MemoryHandle } from '@aipehub/services-sdk'

import { buildButlerConsolidateToolset } from '../src/personal-butler-consolidate.js'
import { openButlerMemory } from '../src/personal-butler-memory.js'
import { openButlerStatusFile } from '../src/personal-butler-status.js'

const silentLogger: Logger = {
  trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
  child() { return silentLogger },
}

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
    await mem.remember({
      kind: 'episodic',
      text: `主人在聊第 ${i} 件事：奶茶店的事情`,
      meta: { importance: 2 },
    })
  }
}

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

/** Pull the first text block out of a tool result (the message the butler relays). */
function resultText(res: { content: ReadonlyArray<unknown> }): string {
  const first = res.content[0] as { text?: string } | undefined
  return first?.text ?? ''
}

describe('S2-M2 — butler on-demand "整理一下记忆" tool', () => {
  let root: string
  let memRoot: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'aipe-butler-consolidate-'))
    memRoot = join(root, 'butler', 'memory')
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  function toolset(userId: string, buildProvider: () => Promise<LlmProvider | null>) {
    return buildButlerConsolidateToolset({ userId, rootDir: memRoot, buildProvider, logger: silentLogger })
  }

  it('lists exactly the one consolidate tool', async () => {
    const ts = toolset('alice', async () => new MockLlmProvider({ reply: '主人常聊奶茶店。' }))
    const tools = await ts.listTools()
    expect(tools.map((t) => t.name)).toEqual(['consolidate_my_memory'])
  })

  it('distills the member episodic on demand, writes STATUS.md, returns a friendly ok', async () => {
    // 40 episodic clears the default 32-entry consolidation trigger.
    await seedEpisodic(memRoot, 'alice', 40)
    const provider = new MockLlmProvider({ reply: '主人常聊奶茶店的事。' })
    const ts = toolset('alice', async () => provider)

    // ── benign: returns an ok result (never parks) ────────────────────────────
    const res = await ts.callTool('consolidate_my_memory', {})
    expect(res.isError).toBeFalsy()
    expect(resultText(res)).toContain('记忆整理好了')

    // ── 蒸馏: episodic folded to keepRecent(8), a tiered digest wrote ──────────
    expect(await episodicCount(memRoot, 'alice')).toBe(8)
    expect((await digests(memRoot, 'alice')).length).toBeGreaterThanOrEqual(1)

    // ── STATUS.md: the same file /me's "上次维护" line surfaces was written ─────
    const status = await openButlerStatusFile({ rootDir: memRoot, userId: 'alice', logger: silentLogger }).read()
    expect(status).not.toBeNull()
    expect(status!.summary).toMatch(/tiered \d+ episodic/)
  })

  it('null provider → friendly non-throwing refusal, memory untouched', async () => {
    await seedEpisodic(memRoot, 'alice', 40)
    const ts = toolset('alice', async () => null)

    const res = await ts.callTool('consolidate_my_memory', {})
    expect(res.isError).toBe(true)
    expect(resultText(res)).toContain('没法整理记忆')

    // Nothing distilled, no STATUS.md — the tool honestly no-op'd.
    expect(await episodicCount(memRoot, 'alice')).toBe(40)
    expect(await digests(memRoot, 'alice')).toHaveLength(0)
    expect(
      await openButlerStatusFile({ rootDir: memRoot, userId: 'alice', logger: silentLogger }).read(),
    ).toBeNull()
  })

  it('a provider-build throw is caught → friendly refusal, not a crash', async () => {
    await seedEpisodic(memRoot, 'alice', 40)
    const ts = toolset('alice', async () => {
      throw new Error('boom: key resolution failed')
    })

    const res = await ts.callTool('consolidate_my_memory', {})
    expect(res.isError).toBe(true)
    expect(resultText(res)).toContain('没法整理记忆')
    expect(await episodicCount(memRoot, 'alice')).toBe(40)
  })

  it('no-leak: consolidating alice never touches bob namespace', async () => {
    await seedEpisodic(memRoot, 'alice', 40)
    await seedEpisodic(memRoot, 'bob', 40)
    const ts = toolset('alice', async () => new MockLlmProvider({ reply: '整理好了。' }))

    await ts.callTool('consolidate_my_memory', {})

    // alice distilled (→ 8), bob untouched (→ 40), bob has no STATUS.md.
    expect(await episodicCount(memRoot, 'alice')).toBe(8)
    expect(await episodicCount(memRoot, 'bob')).toBe(40)
    expect(
      await openButlerStatusFile({ rootDir: memRoot, userId: 'bob', logger: silentLogger }).read(),
    ).toBeNull()
  })

  it('unknown tool name → error result, no memory work', async () => {
    await seedEpisodic(memRoot, 'alice', 40)
    const ts = toolset('alice', async () => new MockLlmProvider({ reply: 'x' }))

    const res = await ts.callTool('not_a_tool', {})
    expect(res.isError).toBe(true)
    expect(await episodicCount(memRoot, 'alice')).toBe(40)
  })
})
