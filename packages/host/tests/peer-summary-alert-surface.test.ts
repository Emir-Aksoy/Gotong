/**
 * v5 Stream F day-3 — the control-plane federation surface's DELIVERY half
 * (`evaluateAndDeliver` + channel CRUD + firing history + test delivery),
 * exercised against a REAL IdentityStore (it duck-types the rule / firing /
 * channel sinks all at once) and a FAKE fetch (no socket).
 *
 * The point of these tests is the edge-trigger orchestration: a breach opens a
 * firing + POSTs ONCE, a still-active breach is silent, a cleared breach
 * resolves + POSTs once more. Counts-only/no-leak is asserted on the captured
 * webhook body.
 */

import { openIdentityStore, type IdentityStore } from '@aipehub/identity'
import { beforeEach, describe, expect, it } from 'vitest'

import {
  createPeerSummaryFederation,
  PEER_SUMMARY_VERSION,
  type PeerSummary,
  type SummaryPeerRegistryView,
} from '../src/peer-summary.js'
import type { FetchLike } from '../src/peer-summary-alert-delivery.js'

function summaryWith(suspendedTasks: number): PeerSummary {
  return {
    hubId: 'local',
    protocolVersion: PEER_SUMMARY_VERSION,
    generatedAt: 1,
    assets: { agents: 1, workflows: 0, publishedWorkflows: 0, peers: 0 },
    runs: { total: 0, byStatus: {} },
    llm: { windowDays: 30, calls: 0, tokens: 0, costMicros: 0 },
    health: { suspendedTasks },
    alerts: { openFirings: 0 },
  }
}

/** Single-hub control plane: no peers, so `local` is the only alert source. */
const emptyRegistry: SummaryPeerRegistryView = {
  status: () => [],
  linkForHub: () => null,
}

type FetchInit = { method?: string; headers?: Record<string, string>; body?: string }

function fakeFetch(resp: { ok: boolean; status: number } = { ok: true, status: 200 }) {
  const calls: Array<{ url: string; init?: FetchInit }> = []
  const fn: FetchLike = async (url, init) => {
    calls.push({ url, init })
    return resp
  }
  return { fn, calls }
}

describe('peer summary federation — alert delivery surface (v5 Stream F day-3)', () => {
  let identity: IdentityStore

  beforeEach(() => {
    identity = openIdentityStore({ dbPath: ':memory:' })
  })

  // A federation backed by the real store for all three sinks + a mutable clock
  // + a mutable local summary so a test can drive a breach open then closed.
  function makeFed(
    fetchImpl: FetchLike,
    initialSuspended: number,
  ): {
    fed: ReturnType<typeof createPeerSummaryFederation>
    setSuspended: (n: number) => void
    setClock: (t: number) => void
  } {
    let suspended = initialSuspended
    let clock = 1000
    const fed = createPeerSummaryFederation(emptyRegistry, {
      buildLocal: async () => summaryWith(suspended),
      alertRules: identity,
      firings: identity,
      channels: identity,
      deliver: { fetchImpl },
      now: () => clock,
    })
    return {
      fed,
      setSuspended: (n) => {
        suspended = n
      },
      setClock: (t) => {
        clock = t
      },
    }
  }

  it('a new breach opens a firing and POSTs an "opened" webhook ONCE', async () => {
    const { fn, calls } = fakeFetch()
    const { fed } = makeFed(fn, 9) // suspendedTasks 9 > threshold 5
    identity.addPeerSummaryAlertRule({
      id: 'r1',
      source: 'local',
      metric: 'health.suspendedTasks',
      comparator: 'gt',
      threshold: 5,
    })
    identity.addPeerSummaryAlertChannel({ kind: 'webhook', url: 'https://hooks.example/x' })

    const report = await fed.evaluateAndDeliver()
    expect(report.opened).toHaveLength(1)
    expect(report.resolved).toHaveLength(0)
    expect(report.deliveries).toEqual([expect.objectContaining({ ok: true, status: 200 })])

    // A firing row was persisted, currently open.
    const open = identity.listOpenPeerSummaryAlertFirings()
    expect(open).toHaveLength(1)
    expect(open[0]).toMatchObject({ ruleId: 'r1', source: 'local', value: 9, resolvedAt: null })

    // The webhook carried an "opened" event for that firing.
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://hooks.example/x')
    const body = JSON.parse(calls[0].init!.body!)
    expect(body).toMatchObject({
      type: 'aipehub.peer_summary_alert/v1',
      event: 'opened',
      ruleId: 'r1',
      source: 'local',
      value: 9,
    })
  })

  it('a still-active breach is silent — no second firing, no second webhook', async () => {
    const { fn, calls } = fakeFetch()
    const { fed } = makeFed(fn, 9)
    identity.addPeerSummaryAlertRule({
      id: 'r1',
      source: 'local',
      metric: 'health.suspendedTasks',
      comparator: 'gt',
      threshold: 5,
    })
    identity.addPeerSummaryAlertChannel({ kind: 'webhook', url: 'https://hooks.example/x' })

    await fed.evaluateAndDeliver() // opens
    const second = await fed.evaluateAndDeliver() // stable
    expect(second.opened).toHaveLength(0)
    expect(second.resolved).toHaveLength(0)
    expect(second.deliveries).toHaveLength(0)
    expect(identity.listOpenPeerSummaryAlertFirings()).toHaveLength(1)
    expect(calls).toHaveLength(1) // only the first pass POSTed
  })

  it('a cleared breach resolves the firing and POSTs a "resolved" webhook', async () => {
    const { fn, calls } = fakeFetch()
    const { fed, setSuspended, setClock } = makeFed(fn, 9)
    identity.addPeerSummaryAlertRule({
      id: 'r1',
      source: 'local',
      metric: 'health.suspendedTasks',
      comparator: 'gt',
      threshold: 5,
    })
    identity.addPeerSummaryAlertChannel({ kind: 'webhook', url: 'https://hooks.example/x' })

    await fed.evaluateAndDeliver() // opens at clock 1000
    setSuspended(0) // metric falls back under threshold
    setClock(2000)
    const report = await fed.evaluateAndDeliver()

    expect(report.opened).toHaveLength(0)
    expect(report.resolved).toHaveLength(1)
    expect(report.resolved[0]).toMatchObject({ ruleId: 'r1', resolvedAt: 2000 })
    expect(identity.listOpenPeerSummaryAlertFirings()).toHaveLength(0)

    // Two POSTs total: opened then resolved.
    expect(calls).toHaveLength(2)
    expect(JSON.parse(calls[1].init!.body!)).toMatchObject({ event: 'resolved', ruleId: 'r1' })
  })

  it('disabled channels are skipped during delivery', async () => {
    const { fn, calls } = fakeFetch()
    const { fed } = makeFed(fn, 9)
    identity.addPeerSummaryAlertRule({
      id: 'r1',
      source: 'local',
      metric: 'health.suspendedTasks',
      comparator: 'gt',
      threshold: 5,
    })
    identity.addPeerSummaryAlertChannel({ kind: 'webhook', url: 'https://on.example/x', enabled: true })
    identity.addPeerSummaryAlertChannel({ kind: 'webhook', url: 'https://off.example/x', enabled: false })

    const report = await fed.evaluateAndDeliver()
    expect(report.deliveries).toHaveLength(1) // only the enabled channel
    expect(calls.map((c) => c.url)).toEqual(['https://on.example/x'])
  })

  it('a breach with no channels still records the firing (nothing to deliver)', async () => {
    const { fn, calls } = fakeFetch()
    const { fed } = makeFed(fn, 9)
    identity.addPeerSummaryAlertRule({
      id: 'r1',
      source: 'local',
      metric: 'health.suspendedTasks',
      comparator: 'gt',
      threshold: 5,
    })
    const report = await fed.evaluateAndDeliver()
    expect(report.opened).toHaveLength(1)
    expect(report.deliveries).toHaveLength(0)
    expect(calls).toHaveLength(0)
    expect(identity.listOpenPeerSummaryAlertFirings()).toHaveLength(1)
  })

  it('a webhook delivery failure never blocks persistence (best-effort)', async () => {
    const fn: FetchLike = async () => {
      throw new Error('ECONNREFUSED')
    }
    const { fed } = makeFed(fn, 9)
    identity.addPeerSummaryAlertRule({
      id: 'r1',
      source: 'local',
      metric: 'health.suspendedTasks',
      comparator: 'gt',
      threshold: 5,
    })
    identity.addPeerSummaryAlertChannel({ kind: 'webhook', url: 'https://dead.example/x' })

    const report = await fed.evaluateAndDeliver()
    expect(report.opened).toHaveLength(1) // firing recorded despite the dead webhook
    expect(report.deliveries).toEqual([expect.objectContaining({ ok: false })])
    expect(identity.listOpenPeerSummaryAlertFirings()).toHaveLength(1)
  })

  it('without a firing sink, evaluateAndDeliver is a no-op even with a live breach', async () => {
    const { fn, calls } = fakeFetch()
    const fed = createPeerSummaryFederation(emptyRegistry, {
      buildLocal: async () => summaryWith(9),
      alertRules: identity,
      channels: identity,
      deliver: { fetchImpl: fn },
    })
    identity.addPeerSummaryAlertRule({
      id: 'r1',
      source: 'local',
      metric: 'health.suspendedTasks',
      comparator: 'gt',
      threshold: 5,
    })
    identity.addPeerSummaryAlertChannel({ kind: 'webhook', url: 'https://hooks.example/x' })
    const report = await fed.evaluateAndDeliver()
    expect(report).toEqual({ opened: [], resolved: [], deliveries: [] })
    expect(calls).toHaveLength(0)
  })

  it('channel CRUD + listAlertFirings delegate to the wired sinks', async () => {
    const { fn } = fakeFetch()
    const { fed } = makeFed(fn, 0)
    const c = fed.addAlertChannel({ kind: 'webhook', url: 'https://hooks.example/x', label: 'ops' })
    expect(fed.listAlertChannels()).toHaveLength(1)
    const u = fed.updateAlertChannel(c.id, { enabled: false })
    expect(u.enabled).toBe(false)
    expect(fed.removeAlertChannel(c.id)).toBe(true)
    expect(fed.listAlertChannels()).toEqual([])
    expect(fed.listAlertFirings()).toEqual([]) // no firings yet
  })

  it('without a channel sink: list empty, mutations throw, test throws', async () => {
    const fed = createPeerSummaryFederation(emptyRegistry, {
      buildLocal: async () => summaryWith(0),
    })
    expect(fed.listAlertChannels()).toEqual([])
    expect(fed.removeAlertChannel('x')).toBe(false)
    expect(() => fed.addAlertChannel({ kind: 'webhook', url: 'https://x.example/y' })).toThrow(
      /not enabled/,
    )
    await expect(fed.testAlertChannel('x')).rejects.toThrow(/not enabled/)
  })

  it('testAlertChannel POSTs a synthetic payload — even to a DISABLED channel', async () => {
    const { fn, calls } = fakeFetch()
    const { fed } = makeFed(fn, 0)
    const c = fed.addAlertChannel({ kind: 'webhook', url: 'https://hooks.example/x', enabled: false })
    const res = await fed.testAlertChannel(c.id)
    expect(res.ok).toBe(true)
    expect(calls).toHaveLength(1)
    const body = JSON.parse(calls[0].init!.body!)
    expect(body).toMatchObject({
      type: 'aipehub.peer_summary_alert/v1',
      event: 'opened',
      firingId: 0,
      source: 'local',
      metric: 'test.delivery',
    })
  })

  it('testAlertChannel rejects a missing channel', async () => {
    const { fn } = fakeFetch()
    const { fed } = makeFed(fn, 0)
    await expect(fed.testAlertChannel('nope')).rejects.toThrow(/not found/)
  })

  it('the delivered webhook body exposes no leak surface — only counts / ids / config', async () => {
    const { fn, calls } = fakeFetch()
    const { fed } = makeFed(fn, 9)
    identity.addPeerSummaryAlertRule({
      id: 'r1',
      source: 'local',
      metric: 'health.suspendedTasks',
      comparator: 'gt',
      threshold: 5,
      label: 'too many parked',
    })
    identity.addPeerSummaryAlertChannel({ kind: 'webhook', url: 'https://hooks.example/x' })
    await fed.evaluateAndDeliver()
    const body = JSON.parse(calls[0].init!.body!)
    expect(Object.keys(body).sort()).toEqual(
      [
        'comparator',
        'event',
        'firingId',
        'label',
        'metric',
        'openedAt',
        'resolvedAt',
        'ruleId',
        'source',
        'threshold',
        'type',
        'value',
      ].sort(),
    )
  })
})
