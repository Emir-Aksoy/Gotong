/**
 * Audit P2 — a butler's per-user memory must be BOUNDED.
 *
 * Before the fix `buildButlerMaintenanceReviewer` only ran `enforceBudget` when a
 * `budgetBytes` was explicitly configured, and the host never configured one — so
 * `semantic` grew without limit as atomic-fact extraction accreted self-contained
 * facts every 6h. This gate wires the reviewer exactly as production does (no
 * budget passed) over a REAL per-user file handle and asserts:
 *
 *   1. the namespace is capped at {@link DEFAULT_BUTLER_MEMORY_BUDGET_BYTES};
 *   2. eviction is keep-value ordered — low-importance ad-hoc facts are dropped
 *      while the small curated profile survives (importance-aware, not recency);
 *   3. an explicit `budgetBytes` override still wins over the default.
 *
 * The maintenance model is never called (no episodic to distil, no clusters to
 * promote) so the gate is deterministic with NO API key — it isolates the byte
 * backstop, which is pure/LLM-free by design (北极星: 框架不跑 LLM).
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Logger } from '@gotong/core'
import type { MemoryEntry } from '@gotong/services-sdk'

import {
  buildButlerMaintenanceReviewer,
  DEFAULT_BUTLER_MEMORY_BUDGET_BYTES,
} from '../src/personal-butler-maintenance.js'
import { openButlerMemory } from '../src/personal-butler-memory.js'
import type { ButlerStatusFile } from '../src/personal-butler-status.js'

const silentLogger: Logger = {
  trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
  child() { return silentLogger },
}

/** A status file that swallows the projected summary — this gate is about bytes. */
const noopStatus: ButlerStatusFile = { async write() {}, async read() { return null } }

/** Same footprint `enforceBudget` measures: UTF-8 bytes of text + meta JSON. */
function measured(entries: readonly MemoryEntry[]): number {
  let sum = 0
  for (const e of entries) {
    sum +=
      Buffer.byteLength(e.text ?? '', 'utf8') +
      Buffer.byteLength(e.meta ? JSON.stringify(e.meta) : '', 'utf8')
  }
  return sum
}

const TWO_MIB = 'x'.repeat(2 * 1024 * 1024)

describe('butler memory growth is bounded (audit P2)', () => {
  let tmp: string
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'butler-budget-')) })
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

  it('caps the namespace at the default ceiling with NO budget configured, evicting ad-hoc facts before the curated profile', async () => {
    const mem = openButlerMemory({ rootDir: tmp, userId: 'alice', logger: silentLogger })
    // One small, high-importance curated profile that MUST survive eviction.
    await mem.remember({
      kind: 'semantic',
      text: '主人的画像: 在做奶茶店项目',
      meta: { profile: true, importance: 5 },
    })
    // Six 2-MiB low-importance ad-hoc facts → ~12 MiB, well over the 8-MiB default.
    for (let i = 0; i < 6; i++) {
      await mem.remember({ kind: 'semantic', text: `${TWO_MIB}#${i}`, meta: { importance: 1 } })
    }
    expect(measured(await mem.list({ kind: 'semantic', limit: 10_000 }))).toBeGreaterThan(
      DEFAULT_BUTLER_MEMORY_BUDGET_BYTES,
    )

    // Production wiring: NO budgetBytes passed → the default backstop must apply.
    const reviewer = buildButlerMaintenanceReviewer({ summarize: async () => '', statusFile: noopStatus })
    await reviewer({ memory: mem, episodic: [], now: 1_000_000 })

    const after = await mem.list({ kind: 'semantic', limit: 10_000 })
    // 1 — bounded under the default ceiling.
    expect(measured(after)).toBeLessThanOrEqual(DEFAULT_BUTLER_MEMORY_BUDGET_BYTES)
    // 2 — some ad-hoc facts were evicted, and the curated profile survived.
    expect(after.length).toBeLessThan(7)
    expect(after.some((e) => e.text.includes('奶茶店项目'))).toBe(true)
  })

  it('an explicit budgetBytes override wins over the default (a tighter cap bites where the default would not)', async () => {
    const mem = openButlerMemory({ rootDir: tmp, userId: 'bob', logger: silentLogger })
    await mem.remember({ kind: 'semantic', text: '画像: 槟城人', meta: { profile: true, importance: 5 } })
    // ~4 MiB total — UNDER the 8-MiB default (would not evict), but a 2-MiB cap does.
    for (let i = 0; i < 2; i++) {
      await mem.remember({ kind: 'semantic', text: `${TWO_MIB}#${i}`, meta: { importance: 1 } })
    }
    const reviewer = buildButlerMaintenanceReviewer({
      summarize: async () => '',
      statusFile: noopStatus,
      budgetBytes: 2 * 1024 * 1024,
    })
    await reviewer({ memory: mem, episodic: [], now: 1_000_000 })

    const after = await mem.list({ kind: 'semantic', limit: 10_000 })
    expect(measured(after)).toBeLessThanOrEqual(2 * 1024 * 1024) // override enforced
    expect(after.some((e) => e.text.includes('槟城'))).toBe(true) // profile still kept
  })
})
