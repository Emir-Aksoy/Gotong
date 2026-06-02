import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  MASTER_KEY_LEN_BYTES,
  openIdentityStore,
  type IdentityStore,
} from '@aipehub/identity'

import {
  LEDGER_KEEP_DAYS_ENV,
  applyLedgerRetention,
  parseLedgerRetention,
} from '../src/ledger-retention.js'

/**
 * Route B P0-M3 (M3-M4) — boot-time usage-ledger retention wiring. M3-M4a gave
 * the identity store the prune mechanism (`DELETE … WHERE ts < cutoff`); this is
 * the host policy that drives it at boot. These pin: an unset env is OFF (so a
 * default boot prunes nothing), the day knob maps to a now-anchored cutoff, a
 * malformed value throws (loud misconfig), and applying a parsed policy to a
 * real IdentityStore deletes only the rows older than the window while leaving
 * the retained window queryable (still exportable). Each guard is falsifiable.
 */

const MS_PER_DAY = 86_400_000
const NOW = 1_000_000_000_000

describe('parseLedgerRetention (Route B P0-M3 M3-M4)', () => {
  it('returns undefined when no retention env is set (OFF by default)', () => {
    expect(parseLedgerRetention({}, NOW)).toBeUndefined()
    // Empty string is treated as unset, not as a zero policy.
    expect(parseLedgerRetention({ [LEDGER_KEEP_DAYS_ENV]: '' }, NOW)).toBeUndefined()
  })

  it('maps keep-days to a `before` cutoff anchored at now', () => {
    expect(parseLedgerRetention({ [LEDGER_KEEP_DAYS_ENV]: '30' }, NOW)).toEqual({
      before: NOW - 30 * MS_PER_DAY,
    })
    // A fractional day is a valid positive number (the cutoff is arithmetic),
    // unlike run-keep's integer count.
    expect(parseLedgerRetention({ [LEDGER_KEEP_DAYS_ENV]: '0.5' }, NOW)).toEqual({
      before: NOW - 0.5 * MS_PER_DAY,
    })
  })

  it('throws on a malformed value rather than silently doing nothing', () => {
    expect(() => parseLedgerRetention({ [LEDGER_KEEP_DAYS_ENV]: 'abc' }, NOW)).toThrow(/LEDGER_KEEP_DAYS/)
    expect(() => parseLedgerRetention({ [LEDGER_KEEP_DAYS_ENV]: '0' }, NOW)).toThrow(/LEDGER_KEEP_DAYS/)
    expect(() => parseLedgerRetention({ [LEDGER_KEEP_DAYS_ENV]: '-1' }, NOW)).toThrow(/LEDGER_KEEP_DAYS/)
  })
})

describe('applyLedgerRetention (Route B P0-M3 M3-M4)', () => {
  let dir: string
  let store: IdentityStore

  // Three ledger rows, one per day. A cutoff on the middle day exercises the
  // half-open boundary (the cutoff row itself is RETAINED).
  const D15 = Date.UTC(2026, 3, 15, 10, 0, 0)
  const D16 = Date.UTC(2026, 3, 16, 9, 0, 0)
  const D17 = Date.UTC(2026, 3, 17, 9, 0, 0)

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aipe-ledger-retain-'))
    store = openIdentityStore({
      dbPath: join(dir, 'identity.sqlite'),
      masterKey: randomBytes(MASTER_KEY_LEN_BYTES),
    })
    for (const ts of [D15, D16, D17]) {
      store.appendLedger({ ts, agentId: 'a1', model: 'opus', inputTokens: 10, outputTokens: 1, costMicros: 100 })
    }
  })
  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('prunes only rows older than the cutoff, keeping the retained window queryable', () => {
    // Cutoff at D16 ⇒ half-open prune drops D15 only; D16 (== cutoff) stays.
    const { pruned } = applyLedgerRetention(store, { before: D16 })
    expect(pruned).toBe(1)

    // The retained window [D16, D17] is still fully readable for export.
    const remaining = store.queryLedger({})
    expect(remaining).toHaveLength(2)
    expect(remaining.map((r) => r.ts).sort()).toEqual([D16, D17])
  })

  it('is a no-op when nothing is older than the cutoff', () => {
    const { pruned } = applyLedgerRetention(store, { before: D15 })
    expect(pruned).toBe(0)
    expect(store.queryLedger({})).toHaveLength(3)
  })
})
