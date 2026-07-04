import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  MASTER_KEY_LEN_BYTES,
  openIdentityStore,
  type IdentityStore,
} from '@gotong/identity'

import {
  RETENTION_TABLES,
  applyRetentionPolicies,
  parseRetentionPolicies,
  type RetentionStore,
} from '../src/retention.js'

/**
 * Boot-time retention for the identity store's append-only tables, unified
 * over usage_ledger / audit_log / peer_summary_snapshots /
 * peer_summary_alert_firings. Pins: every knob is OFF when unset (a default
 * boot prunes nothing), each day knob maps to a now-anchored cutoff, a
 * malformed value throws (loud misconfig), applying against a REAL
 * IdentityStore deletes only rows older than the window (half-open — the
 * cutoff row is kept), open alert firings survive any cutoff, and one failing
 * table never blocks the others.
 */

const MS_PER_DAY = 86_400_000
const NOW = 1_000_000_000_000

describe('parseRetentionPolicies', () => {
  it('returns [] when no retention env is set (OFF by default)', () => {
    expect(parseRetentionPolicies({}, NOW)).toEqual([])
    // Empty string is treated as unset, not as a zero policy.
    const allEmpty = Object.fromEntries(RETENTION_TABLES.map((t) => [t.env, '']))
    expect(parseRetentionPolicies(allEmpty, NOW)).toEqual([])
  })

  it('maps each keep-days knob to a `before` cutoff anchored at now', () => {
    const policies = parseRetentionPolicies(
      {
        GOTONG_LEDGER_KEEP_DAYS: '30',
        GOTONG_AUDIT_KEEP_DAYS: '365',
        GOTONG_PEER_SUMMARY_KEEP_DAYS: '7',
        GOTONG_ALERT_FIRINGS_KEEP_DAYS: '0.5', // fractional days are valid arithmetic
      },
      NOW,
    )
    expect(policies).toHaveLength(4)
    const byTable = Object.fromEntries(policies.map((p) => [p.spec.table, p.before]))
    expect(byTable).toEqual({
      usage_ledger: NOW - 30 * MS_PER_DAY,
      audit_log: NOW - 365 * MS_PER_DAY,
      peer_summary_snapshots: NOW - 7 * MS_PER_DAY,
      peer_summary_alert_firings: NOW - 0.5 * MS_PER_DAY,
    })
  })

  it('a single knob configures a single table', () => {
    const policies = parseRetentionPolicies({ GOTONG_AUDIT_KEEP_DAYS: '90' }, NOW)
    expect(policies).toHaveLength(1)
    expect(policies[0]!.spec.table).toBe('audit_log')
  })

  it('throws on a malformed value rather than silently doing nothing', () => {
    for (const { env } of RETENTION_TABLES) {
      expect(() => parseRetentionPolicies({ [env]: 'abc' }, NOW)).toThrow(new RegExp(env))
      expect(() => parseRetentionPolicies({ [env]: '0' }, NOW)).toThrow(new RegExp(env))
      expect(() => parseRetentionPolicies({ [env]: '-1' }, NOW)).toThrow(new RegExp(env))
    }
  })
})

describe('applyRetentionPolicies (real IdentityStore)', () => {
  let dir: string
  let store: IdentityStore

  // Per-table seeds straddle a cutoff so each prune exercises the half-open
  // boundary (the cutoff row itself is RETAINED).
  const D15 = Date.UTC(2026, 3, 15, 10, 0, 0)
  const D16 = Date.UTC(2026, 3, 16, 9, 0, 0)
  const D17 = Date.UTC(2026, 3, 17, 9, 0, 0)

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gotong-retention-'))
    store = openIdentityStore({
      dbPath: join(dir, 'identity.sqlite'),
      masterKey: randomBytes(MASTER_KEY_LEN_BYTES),
    })
  })
  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  function policiesFor(env: Record<string, string>, now: number) {
    return parseRetentionPolicies(env, now)
  }

  it('usage_ledger: prunes only rows older than the cutoff, keeping the window exportable', () => {
    for (const ts of [D15, D16, D17]) {
      store.appendLedger({ ts, agentId: 'a1', model: 'opus', inputTokens: 10, outputTokens: 1, costMicros: 100 })
    }
    // now anchored so the 1-day cutoff lands exactly on D16 ⇒ D15 pruned, D16 kept.
    const results = applyRetentionPolicies(
      store,
      policiesFor({ GOTONG_LEDGER_KEEP_DAYS: '1' }, D16 + MS_PER_DAY),
    )
    expect(results).toEqual([{ table: 'usage_ledger', before: D16, pruned: 1 }])
    expect(store.queryLedger({}).map((r) => r.ts).sort()).toEqual([D16, D17])
  })

  it('audit_log: prunes strictly-older rows, keeps the cutoff row (half-open)', () => {
    const a = store.writeAuditLog({ action: 'older', actorSource: 'system' })
    const b = store.writeAuditLog({ action: 'newer', actorSource: 'system' })
    // Cutoff exactly at b.ts: a (strictly older, if ts differs) is pruned; b kept.
    // writeAuditLog stamps Date.now(), so derive the cutoff from the rows.
    const before = Math.max(a.ts, b.ts)
    const pruned = store.pruneAuditLog({ before })
    const left = store.listAuditLog({})
    // Every surviving row sits at/after the cutoff; the cutoff row survived.
    expect(left.every((e) => e.ts >= before)).toBe(true)
    expect(left.length + pruned).toBe(2)
    expect(left.length).toBeGreaterThanOrEqual(1)
  })

  it('alert firings: resolved-only prune; an OPEN firing survives any cutoff', () => {
    const open = store.openPeerSummaryAlertFiring({
      ruleId: 'r1', source: 'peerA', metric: 'agents.total',
      comparator: 'gt', threshold: 1, value: 5, openedAt: D15,
    })
    const resolved = store.openPeerSummaryAlertFiring({
      ruleId: 'r2', source: 'peerB', metric: 'agents.total',
      comparator: 'gt', threshold: 1, value: 5, openedAt: D15,
    })
    store.resolvePeerSummaryAlertFiring(resolved.id, { resolvedAt: D16 })

    const results = applyRetentionPolicies(
      store,
      policiesFor({ GOTONG_ALERT_FIRINGS_KEEP_DAYS: '1' }, D17 + MS_PER_DAY),
    )
    expect(results[0]).toMatchObject({ table: 'peer_summary_alert_firings', pruned: 1 })
    const left = store.listPeerSummaryAlertFirings({})
    expect(left).toHaveLength(1)
    expect(left[0]!.id).toBe(open.id) // the live breach stayed visible
  })

  it('peer_summary_snapshots: prunes by captured_at', () => {
    for (const capturedAt of [D15, D16, D17]) {
      store.appendPeerSummarySnapshot({ source: 'local', capturedAt, summaryJson: '{}' })
    }
    const results = applyRetentionPolicies(
      store,
      policiesFor({ GOTONG_PEER_SUMMARY_KEEP_DAYS: '1' }, D16 + MS_PER_DAY),
    )
    expect(results[0]).toMatchObject({ table: 'peer_summary_snapshots', pruned: 1 })
  })

  it('a failing table never blocks the others (best-effort per table)', () => {
    store.appendLedger({ ts: D15, agentId: 'a1', model: 'opus', inputTokens: 1, outputTokens: 1, costMicros: 1 })
    const boom = new Error('audit prune exploded')
    const failing: RetentionStore = {
      pruneLedger: (o) => store.pruneLedger(o),
      pruneAuditLog: () => { throw boom },
      prunePeerSummarySnapshots: (o) => store.prunePeerSummarySnapshots(o),
      prunePeerSummaryAlertFirings: (o) => store.prunePeerSummaryAlertFirings(o),
    }
    const results = applyRetentionPolicies(
      failing,
      policiesFor({ GOTONG_AUDIT_KEEP_DAYS: '1', GOTONG_LEDGER_KEEP_DAYS: '1' }, D17),
    )
    const byTable = Object.fromEntries(results.map((r) => [r.table, r]))
    expect(byTable.audit_log!.error).toBe(boom)
    expect(byTable.audit_log!.pruned).toBeUndefined()
    // The ledger prune still ran and deleted the old row.
    expect(byTable.usage_ledger!.pruned).toBe(1)
  })
})
