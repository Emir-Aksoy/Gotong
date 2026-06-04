/**
 * v5 Stream F — control-plane alert rules (PeerSummaryAlertRuleStore via
 * IdentityStore).
 *
 * Coverage:
 *   - add: generates an `asr_` id, defaults enabled=true, round-trips fields
 *   - add: accepts an explicit id; a reused id → alert_rule_exists
 *   - add validation: bad comparator, non-finite threshold, empty source/metric
 *   - get/list: null for missing, created_at ASC ordering
 *   - update: targeted (undefined = keep), toggle enabled, change threshold;
 *     missing id → alert_rule_not_found
 *   - remove: true then false
 */

import { describe, expect, it, beforeEach } from 'vitest'

import { IdentityError, IdentityStore, openIdentityStore } from '../src/index.js'

describe('IdentityStore — peer summary alert rules (v5 Stream F)', () => {
  let store: IdentityStore

  beforeEach(() => {
    store = openIdentityStore({ dbPath: ':memory:' })
  })

  it('add generates an asr_ id, defaults enabled, round-trips fields', () => {
    const rule = store.addPeerSummaryAlertRule({
      source: 'local',
      metric: 'health.suspendedTasks',
      comparator: 'gt',
      threshold: 5,
    })
    expect(rule.id).toMatch(/^asr_[0-9a-f]+$/)
    expect(rule.source).toBe('local')
    expect(rule.metric).toBe('health.suspendedTasks')
    expect(rule.comparator).toBe('gt')
    expect(rule.threshold).toBe(5)
    expect(rule.label).toBeNull()
    expect(rule.enabled).toBe(true)

    const back = store.getPeerSummaryAlertRule(rule.id)
    expect(back).not.toBeNull()
    expect(back!.metric).toBe('health.suspendedTasks')
  })

  it('add accepts an explicit id; a label; enabled=false', () => {
    const rule = store.addPeerSummaryAlertRule({
      id: 'rule-1',
      source: '*',
      metric: 'llm.costMicros',
      comparator: 'gte',
      threshold: 1_000_000,
      label: 'cost ceiling',
      enabled: false,
    })
    expect(rule.id).toBe('rule-1')
    expect(rule.source).toBe('*')
    expect(rule.label).toBe('cost ceiling')
    expect(rule.enabled).toBe(false)
  })

  it('rejects a duplicate explicit id with alert_rule_exists', () => {
    store.addPeerSummaryAlertRule({ id: 'dup', source: 'local', metric: 'runs.total', comparator: 'gt', threshold: 1 })
    expect(() =>
      store.addPeerSummaryAlertRule({ id: 'dup', source: 'local', metric: 'runs.total', comparator: 'gt', threshold: 2 }),
    ).toThrow(IdentityError)
  })

  it('rejects a bad comparator / non-finite threshold / empty source or metric', () => {
    const base = { source: 'local', metric: 'runs.total', comparator: 'gt' as const, threshold: 1 }
    expect(() => store.addPeerSummaryAlertRule({ ...base, comparator: 'between' as never })).toThrow(IdentityError)
    expect(() => store.addPeerSummaryAlertRule({ ...base, threshold: Number.NaN })).toThrow(IdentityError)
    expect(() => store.addPeerSummaryAlertRule({ ...base, threshold: Infinity })).toThrow(IdentityError)
    expect(() => store.addPeerSummaryAlertRule({ ...base, source: '   ' })).toThrow(IdentityError)
    expect(() => store.addPeerSummaryAlertRule({ ...base, metric: '' })).toThrow(IdentityError)
  })

  it('get returns null for a missing id; list is created_at ASC', () => {
    expect(store.getPeerSummaryAlertRule('nope')).toBeNull()
    const a = store.addPeerSummaryAlertRule({ source: 'local', metric: 'runs.total', comparator: 'gt', threshold: 1 })
    const b = store.addPeerSummaryAlertRule({ source: 'p1', metric: 'assets.peers', comparator: 'lt', threshold: 2 })
    const ids = store.listPeerSummaryAlertRules().map((r) => r.id)
    expect(ids).toEqual([a.id, b.id])
  })

  it('update keeps untouched fields, toggles enabled, changes threshold', () => {
    const rule = store.addPeerSummaryAlertRule({
      source: 'local',
      metric: 'health.suspendedTasks',
      comparator: 'gt',
      threshold: 5,
      label: 'orig',
    })
    const updated = store.updatePeerSummaryAlertRule(rule.id, { threshold: 10, enabled: false })
    expect(updated.threshold).toBe(10)
    expect(updated.enabled).toBe(false)
    // untouched fields preserved
    expect(updated.metric).toBe('health.suspendedTasks')
    expect(updated.comparator).toBe('gt')
    expect(updated.label).toBe('orig')
    // clearing the label
    const cleared = store.updatePeerSummaryAlertRule(rule.id, { label: null })
    expect(cleared.label).toBeNull()
  })

  it('update on a missing id throws alert_rule_not_found', () => {
    expect(() => store.updatePeerSummaryAlertRule('nope', { threshold: 1 })).toThrow(IdentityError)
  })

  it('remove returns true then false', () => {
    const rule = store.addPeerSummaryAlertRule({ source: 'local', metric: 'runs.total', comparator: 'gt', threshold: 1 })
    expect(store.removePeerSummaryAlertRule(rule.id)).toBe(true)
    expect(store.removePeerSummaryAlertRule(rule.id)).toBe(false)
    expect(store.getPeerSummaryAlertRule(rule.id)).toBeNull()
  })
})
