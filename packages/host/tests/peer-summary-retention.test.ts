/**
 * v5 Stream F — boot-time control-plane snapshot retention policy.
 *
 * Mirrors `ledger-retention.test.ts`: OFF by default (unset → undefined),
 * a valid day count yields a half-open cutoff anchored at `now`, a malformed
 * value throws so a boot typo fails loudly, and `applyPeerSummaryRetention`
 * just forwards the cutoff to the store's prune.
 */

import { describe, expect, it } from 'vitest'

import {
  PEER_SUMMARY_KEEP_DAYS_ENV,
  applyPeerSummaryRetention,
  parsePeerSummaryRetention,
} from '../src/peer-summary-retention.js'

const NOW = Date.UTC(2026, 5, 3, 12, 0, 0)
const MS_PER_DAY = 86_400_000

describe('parsePeerSummaryRetention (v5 Stream F)', () => {
  it('returns undefined when the env is unset or empty', () => {
    expect(parsePeerSummaryRetention({}, NOW)).toBeUndefined()
    expect(parsePeerSummaryRetention({ [PEER_SUMMARY_KEEP_DAYS_ENV]: '' }, NOW)).toBeUndefined()
  })

  it('computes a half-open cutoff anchored at now', () => {
    const policy = parsePeerSummaryRetention({ [PEER_SUMMARY_KEEP_DAYS_ENV]: '7' }, NOW)
    expect(policy).toEqual({ before: NOW - 7 * MS_PER_DAY })
  })

  it('throws on a malformed or non-positive day count', () => {
    expect(() => parsePeerSummaryRetention({ [PEER_SUMMARY_KEEP_DAYS_ENV]: 'abc' }, NOW)).toThrow(
      PEER_SUMMARY_KEEP_DAYS_ENV,
    )
    expect(() => parsePeerSummaryRetention({ [PEER_SUMMARY_KEEP_DAYS_ENV]: '0' }, NOW)).toThrow()
    expect(() => parsePeerSummaryRetention({ [PEER_SUMMARY_KEEP_DAYS_ENV]: '-3' }, NOW)).toThrow()
  })
})

describe('applyPeerSummaryRetention (v5 Stream F)', () => {
  it('forwards the cutoff to the store and returns the pruned count', () => {
    const calls: Array<{ before: number }> = []
    const store = {
      prunePeerSummarySnapshots(opts: { before: number }) {
        calls.push(opts)
        return 4
      },
    }
    const result = applyPeerSummaryRetention(store, { before: 1234 })
    expect(result).toEqual({ pruned: 4 })
    expect(calls).toEqual([{ before: 1234 }])
  })
})
