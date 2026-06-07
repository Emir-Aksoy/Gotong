/**
 * v5 Stream F day-3 M7 — control-plane alert DELIVERY two-hub acceptance gate.
 *
 * Stream F-M7 proved trends + LIVE (point-in-time) alerts over two hubs. Day-3
 * makes the alert path PROACTIVE: a breach opens a firing and POSTs a webhook
 * ONCE, and the breach clearing resolves the firing and POSTs once more. This
 * gate is the reason day-3 exists — it drives the whole edge-trigger + delivery
 * path end-to-end against a REAL provider hub over a REAL in-proc link, with the
 * consumer's firing history + channel config backed by a REAL IdentityStore and
 * the webhook transport an injected capturing fake:
 *
 *   1. lifecycle — a real provider footprint change (a 3rd agent joins) pushes
 *      `assets.agents` over a rule's threshold → `evaluateAndDeliver` OPENS a
 *      firing + delivers an `opened` webhook. Re-evaluating while still breaching
 *      is idempotent (no second firing, no second POST — notify ONCE). The agent
 *      leaving clears the breach → the firing RESOLVES + a `resolved` webhook is
 *      delivered. Firing history persists through the consumer's IdentityStore.
 *   2. best-effort — a DISABLED channel is never POSTed; a FAILING channel's
 *      transport error resolves to `ok:false` WITHOUT blocking the other
 *      channel's delivery or the firing's persistence.
 *   3. test-delivery — `testAlertChannel` reaches even a DISABLED channel (you
 *      test reachability before you flip it on) and resolves its `headerEnv`
 *      env-var NAME into the `Authorization` header at delivery time — the bearer
 *      never lived in the channel row.
 *   4. no leak — every webhook body carries ONLY counts / ids / a comparator /
 *      the rule's own label: the provider's agent ids, capabilities, parked task
 *      id, and model name never appear (the delivery path inherits E5's
 *      counts-only shape — re-pinned here on the wire that leaves the host).
 *
 * Topology mirrors `stream-f-control-plane-e2e.test.ts` (the F-M7 gate): ONE real
 * provider Hub (+ real identity store seeded with a real footprint) shared over a
 * REAL in-proc HubLink to ONE consumer control plane driven through the REAL
 * federation surface. The new piece is the consumer's OWN IdentityStore wired as
 * the firing + channel sinks (duck-typed — exact method-name match, no host↔
 * identity dep) AND an injected `fetchImpl` so the entire delivery path runs
 * without a socket.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  AgentParticipant,
  Hub,
  createInprocHubLinkPair,
  installPeerLink,
  type HubLink,
} from '@aipehub/core'
import {
  MASTER_KEY_LEN_BYTES,
  openIdentityStore,
  type IdentityStore,
} from '@aipehub/identity'

import {
  PeerSummaryHost,
  createPeerSummaryFederation,
  type BuildSummaryDeps,
  type PeerSummary,
  type PeerSummaryFederation,
  type SummaryPeerRegistryView,
  type SummaryWorkflowSource,
} from '../src/peer-summary.js'
import type {
  AlertWebhookPayload,
  DeliverOptions,
  FetchLike,
} from '../src/peer-summary-alert-delivery.js'

/** A local participant with no behaviour — it exists only to be counted. */
class NoopAgent extends AgentParticipant {
  protected async handleTask(): Promise<unknown> {
    return { ok: true }
  }
}

/** Deterministic provider footprint for the workflow family (counts only). */
const workflowSource: SummaryWorkflowSource = {
  listAll: () => [{ state: 'published' }, { state: 'draft' }],
  countRuns: async () => ({ total: 3, byStatus: { running: 1, done: 2 } }),
}

/** A fixed, realistic provider clock (≈ 2033) — see the E5-M5 gate for why. */
const PROVIDER_NOW = 2_000_000_000_000

/** The provider's internal identifiers — the no-leak canaries. */
const CANARIES = [
  'agent-secret-alpha',
  'agent-secret-beta',
  'agent-secret-gamma',
  'confidential-svc',
  'parked-secret-1',
  'claude-secret-x',
]

/** Assert a captured webhook body leaks none of the provider's internals. */
function expectNoLeak(body: unknown): void {
  const wire = JSON.stringify(body)
  for (const canary of CANARIES) expect(wire).not.toContain(canary)
}

/** A capturing fake transport: records every POST, and can fail/throw per-url. */
function makeCapturingFetch(opts: { throwUrls?: Set<string>; failUrls?: Set<string> } = {}) {
  const calls: { url: string; headers: Record<string, string>; body: AlertWebhookPayload }[] = []
  const fetchImpl: FetchLike = async (url, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string>
    const body = JSON.parse(init?.body ?? '{}') as AlertWebhookPayload
    calls.push({ url, headers, body })
    if (opts.throwUrls?.has(url)) throw new Error('transport boom')
    if (opts.failUrls?.has(url)) return { ok: false, status: 503 }
    return { ok: true, status: 200 }
  }
  return { fetchImpl, calls }
}

/**
 * A capturing fake that keeps the RAW body string (im/email bodies are
 * platform-specific — `{chat_id,text}` / `{content}` / `{to,subject,text}` —
 * not an `AlertWebhookPayload`). `failFirstN` makes a url fail its first N
 * attempts then succeed, so a retry path is exercisable end-to-end.
 */
function makeRawCapturingFetch(opts: { failFirstN?: Map<string, number> } = {}) {
  const calls: { url: string; headers: Record<string, string>; raw: string; body: unknown }[] = []
  const remainingFails = new Map(opts.failFirstN ?? [])
  const fetchImpl: FetchLike = async (url, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string>
    const raw = init?.body ?? '{}'
    calls.push({ url, headers, raw, body: JSON.parse(raw) })
    const left = remainingFails.get(url) ?? 0
    if (left > 0) {
      remainingFails.set(url, left - 1)
      return { ok: false, status: 503 }
    }
    return { ok: true, status: 200 }
  }
  return { fetchImpl, calls }
}

describe('v5 Stream F day-3 M7 — control-plane alert delivery over two hubs', () => {
  let providerStore: IdentityStore
  let consumerStore: IdentityStore
  let tmp: string
  let provider: Hub
  let pair: ReturnType<typeof createInprocHubLinkPair>
  // The consumer clock advances per phase so a firing's openedAt < resolvedAt.
  let consumerClock: number

  /**
   * The consumer control plane's federation surface over one live link, with its
   * OWN IdentityStore backing snapshots + rules + firings + channels (the full
   * production shape) and an injected webhook transport.
   */
  function deliverFederation(deliver: DeliverOptions): PeerSummaryFederation {
    const registry: SummaryPeerRegistryView = {
      status: () => [{ peerId: 'provider', label: 'Provider Hub', connected: true }],
      linkForHub: (peerId) => (peerId === 'provider' ? pair.b : null),
    }
    const ownSummary: PeerSummary = {
      hubId: 'control-plane',
      protocolVersion: '1',
      generatedAt: 0,
      assets: { agents: 0, workflows: 0, publishedWorkflows: 0, peers: 1 },
      runs: { total: 0, byStatus: {} },
      llm: { windowDays: 30, calls: 0, tokens: 0, costMicros: 0 },
      health: { suspendedTasks: 0 },
      alerts: { openFirings: 0 },
    }
    return createPeerSummaryFederation(registry, {
      buildLocal: async () => ownSummary,
      // One IdentityStore backs all four sinks (duck-typed).
      snapshots: consumerStore,
      alertRules: consumerStore,
      firings: consumerStore,
      channels: consumerStore,
      deliver,
      now: () => consumerClock,
    })
  }

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'aipe-alert-delivery-e2e-'))
    providerStore = openIdentityStore({
      dbPath: join(tmp, 'provider.sqlite'),
      masterKey: randomBytes(MASTER_KEY_LEN_BYTES),
    })
    consumerStore = openIdentityStore({
      dbPath: join(tmp, 'consumer.sqlite'),
      masterKey: randomBytes(MASTER_KEY_LEN_BYTES),
    })
    consumerClock = 1_000_000

    // The provider shares its summary with this consumer (opt-in, fail-closed).
    providerStore.addPeer({
      peerId: 'control-plane',
      endpointUrl: 'wss://cp.example',
      peerToken: 'tok-cp-1234567890',
      kind: 'organization',
      shareSummary: true,
    })

    // Seed a REAL footprint so llm + health are non-zero. The agent id / model /
    // task id are the no-leak canaries the delivery path must never carry.
    providerStore.appendLedger({
      ts: PROVIDER_NOW,
      agentId: 'agent-secret-alpha',
      model: 'claude-secret-x',
      inputTokens: 100,
      outputTokens: 50,
      costMicros: 7000,
    })
    providerStore.persistSuspendedTask({
      taskId: 'parked-secret-1',
      agentId: 'agent-secret-alpha',
      resumeAt: 9_999_999_999_000,
      state: {},
      taskJson: '{}',
    })

    provider = Hub.inMemory()
    await provider.start()
    // Two agents to start: below an `assets.agents >= 3` threshold.
    provider.register(new NoopAgent({ id: 'agent-secret-alpha', capabilities: ['confidential-svc'] }))
    provider.register(new NoopAgent({ id: 'agent-secret-beta', capabilities: ['confidential-svc-2'] }))

    const summaryDeps: BuildSummaryDeps = {
      hubId: 'provider',
      hub: provider,
      peerWrapperIds: () => new Set(['control-plane']),
      workflows: workflowSource,
      identity: providerStore,
      now: () => PROVIDER_NOW,
    }
    const summaryHost = new PeerSummaryHost(summaryDeps)

    pair = createInprocHubLinkPair({ aPeerId: 'control-plane', bPeerId: 'provider' })
    installPeerLink({
      hub: provider,
      link: pair.a,
      remoteCapabilities: [],
      selfHubId: 'provider',
      originResolver: (from) => ({ userId: from, userRole: 'member' }),
      rpcResponder: summaryHost.respond,
    })
  })

  afterEach(async () => {
    providerStore.close()
    consumerStore.close()
    await provider.stop()
    await rm(tmp, { recursive: true, force: true })
  })

  it('lifecycle: breach opens a firing + delivers once (idempotent); clearing resolves + delivers once', async () => {
    const { fetchImpl, calls } = makeCapturingFetch()
    const fed = deliverFederation({ fetchImpl, env: {} })

    const url = 'https://hook.test/alerts'
    const channel = fed.addAlertChannel({ kind: 'webhook', url, label: '运维 webhook' })
    const rule = fed.addAlertRule({
      source: 'provider',
      metric: 'assets.agents',
      comparator: 'gte',
      threshold: 3,
      label: '太多 agent',
    })

    // --- Phase 1: below threshold (2 agents) — no breach, no firing, no POST. ---
    await fed.refresh()
    const quiet = await fed.evaluateAndDeliver()
    expect(quiet.opened).toHaveLength(0)
    expect(quiet.resolved).toHaveLength(0)
    expect(quiet.deliveries).toHaveLength(0)
    expect(calls).toHaveLength(0)
    expect(consumerStore.listPeerSummaryAlertFirings({})).toHaveLength(0)

    // --- Phase 2: a real 3rd agent joins → breach OPENS + delivers `opened`. ---
    provider.register(new NoopAgent({ id: 'agent-secret-gamma', capabilities: ['confidential-svc-3'] }))
    consumerClock = 1_000_000
    await fed.refresh() // cache now shows 3 provider agents
    const opened = await fed.evaluateAndDeliver()

    expect(opened.opened).toHaveLength(1)
    expect(opened.resolved).toHaveLength(0)
    const firing = opened.opened[0]
    expect(firing.ruleId).toBe(rule.id)
    expect(firing.source).toBe('provider') // the ACTUAL source, never '*'
    expect(firing.metric).toBe('assets.agents')
    expect(firing.comparator).toBe('gte')
    expect(firing.threshold).toBe(3)
    expect(firing.value).toBe(3)
    expect(firing.label).toBe('太多 agent')
    expect(firing.openedAt).toBe(1_000_000)
    expect(firing.resolvedAt).toBeNull()

    // Exactly one webhook delivered, ok, to the configured channel.
    expect(opened.deliveries).toHaveLength(1)
    expect(opened.deliveries[0]).toMatchObject({ channelId: channel.id, ok: true, status: 200 })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(url)
    const openedBody = calls[0].body
    expect(openedBody.type).toBe('aipehub.peer_summary_alert/v1')
    expect(openedBody.event).toBe('opened')
    expect(openedBody.firingId).toBe(firing.id)
    expect(openedBody.ruleId).toBe(rule.id)
    expect(openedBody.source).toBe('provider')
    expect(openedBody.metric).toBe('assets.agents')
    expect(openedBody.comparator).toBe('gte')
    expect(openedBody.threshold).toBe(3)
    expect(openedBody.value).toBe(3)
    expect(openedBody.resolvedAt).toBeNull()
    expectNoLeak(openedBody)

    // Persisted as an OPEN firing.
    expect(consumerStore.listOpenPeerSummaryAlertFirings()).toHaveLength(1)
    expect(consumerStore.listPeerSummaryAlertFirings({})).toHaveLength(1)

    // --- Phase 3: re-evaluate while STILL breaching — notify ONCE (no-op). ---
    consumerClock = 1_001_000
    const repeat = await fed.evaluateAndDeliver()
    expect(repeat.opened).toHaveLength(0)
    expect(repeat.resolved).toHaveLength(0)
    expect(repeat.deliveries).toHaveLength(0)
    expect(calls).toHaveLength(1) // no second POST — edge-triggered
    expect(consumerStore.listOpenPeerSummaryAlertFirings()).toHaveLength(1)

    // --- Phase 4: the agent leaves → breach CLEARS → firing RESOLVES + POSTs. ---
    provider.unregister('agent-secret-gamma')
    consumerClock = 1_002_000
    await fed.refresh() // cache now shows 2 provider agents
    const resolved = await fed.evaluateAndDeliver()

    expect(resolved.opened).toHaveLength(0)
    expect(resolved.resolved).toHaveLength(1)
    expect(resolved.resolved[0].id).toBe(firing.id)
    expect(resolved.resolved[0].resolvedAt).toBe(1_002_000)
    expect(resolved.deliveries).toHaveLength(1)
    expect(resolved.deliveries[0]).toMatchObject({ channelId: channel.id, ok: true })

    expect(calls).toHaveLength(2)
    const resolvedBody = calls[1].body
    expect(resolvedBody.event).toBe('resolved')
    expect(resolvedBody.firingId).toBe(firing.id)
    expect(resolvedBody.value).toBe(3) // the value AT OPEN — the firing is immutable
    expect(resolvedBody.resolvedAt).toBe(1_002_000)
    expectNoLeak(resolvedBody)

    // The firing is now resolved; nothing open.
    expect(consumerStore.listOpenPeerSummaryAlertFirings()).toHaveLength(0)
    expect(consumerStore.listPeerSummaryAlertFirings({ state: 'resolved' })).toHaveLength(1)

    // --- Phase 5: re-evaluate after resolve — stable, no re-open. ---
    const calm = await fed.evaluateAndDeliver()
    expect(calm.opened).toHaveLength(0)
    expect(calm.resolved).toHaveLength(0)
    expect(calls).toHaveLength(2)
  })

  it('best-effort: a disabled channel is skipped and a failing channel never blocks the others', async () => {
    const okUrl = 'https://hook.test/ok'
    const offUrl = 'https://hook.test/disabled'
    const failUrl = 'https://hook.test/fail'
    const { fetchImpl, calls } = makeCapturingFetch({ throwUrls: new Set([failUrl]) })
    const fed = deliverFederation({ fetchImpl, env: {} })

    const chanOk = fed.addAlertChannel({ kind: 'webhook', url: okUrl, label: '正常' })
    const chanOff = fed.addAlertChannel({ kind: 'webhook', url: offUrl, enabled: false, label: '停用' })
    const chanFail = fed.addAlertChannel({ kind: 'webhook', url: failUrl, label: '坏掉的' })
    fed.addAlertRule({ source: 'provider', metric: 'assets.agents', comparator: 'gte', threshold: 3 })

    // Drive a breach.
    provider.register(new NoopAgent({ id: 'agent-secret-gamma', capabilities: ['confidential-svc-3'] }))
    await fed.refresh()
    const report = await fed.evaluateAndDeliver()

    // The firing opened despite a failing channel — delivery is best-effort.
    expect(report.opened).toHaveLength(1)
    expect(consumerStore.listOpenPeerSummaryAlertFirings()).toHaveLength(1)

    // Two deliveries (the two ENABLED channels); the disabled one is absent.
    expect(report.deliveries).toHaveLength(2)
    expect(report.deliveries.find((d) => d.channelId === chanOff.id)).toBeUndefined()
    expect(report.deliveries.find((d) => d.channelId === chanOk.id)).toMatchObject({ ok: true })
    const failResult = report.deliveries.find((d) => d.channelId === chanFail.id)!
    expect(failResult.ok).toBe(false)
    expect(failResult.error).toBeTruthy()

    // The transport saw exactly the two enabled urls — never the disabled one.
    expect(calls).toHaveLength(2)
    expect(calls.some((c) => c.url === okUrl)).toBe(true)
    expect(calls.some((c) => c.url === failUrl)).toBe(true)
    expect(calls.every((c) => c.url !== offUrl)).toBe(true)
    for (const c of calls) expectNoLeak(c.body)
  })

  it('test-delivery: reaches even a disabled channel and resolves headerEnv into Authorization', async () => {
    const url = 'https://hook.test/preflight'
    const { fetchImpl, calls } = makeCapturingFetch()
    // The bearer lives ONLY in the injected env — never in the channel row.
    const fed = deliverFederation({ fetchImpl, env: { WEBHOOK_TOKEN_X: 'Bearer secret-xyz' } })

    const chan = fed.addAlertChannel({
      kind: 'webhook',
      url,
      headerEnv: 'WEBHOOK_TOKEN_X',
      enabled: false, // you test BEFORE you flip it on
      label: '待验证',
    })
    // The stored row carries the env-var NAME, not the secret.
    expect(chan.headerEnv).toBe('WEBHOOK_TOKEN_X')

    const result = await fed.testAlertChannel(chan.id)
    expect(result).toMatchObject({ channelId: chan.id, ok: true, status: 200 })

    // Delivered despite the channel being disabled.
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(url)
    // headerEnv resolved into Authorization at delivery time.
    expect(calls[0].headers.authorization).toBe('Bearer secret-xyz')

    // A synthetic, counts-only `opened` payload — no real firing was recorded.
    const body = calls[0].body
    expect(body.event).toBe('opened')
    expect(body.source).toBe('local')
    expect(body.ruleId).toBe('test')
    expect(body.metric).toBe('test.delivery')
    expect(body.firingId).toBe(0)
    expectNoLeak(body)
    expect(consumerStore.listPeerSummaryAlertFirings({})).toHaveLength(0)
  })

  it('multi-channel: a breach fans out to im (telegram + slack) and email with counts-only platform-specific wire', async () => {
    const { fetchImpl, calls } = makeRawCapturingFetch()
    // The telegram bot token lives ONLY in env — never in the channel row.
    const fed = deliverFederation({ fetchImpl, env: { TG_TOKEN: 'tg-bot-secret-987' } })

    const tgUrl = 'https://api.telegram.org'
    const slackUrl = 'https://hooks.slack.test/xyz'
    const emailUrl = 'https://email.test/send'

    const tg = fed.addAlertChannel({
      kind: 'im',
      platform: 'telegram',
      url: tgUrl,
      target: 'chat-555',
      headerEnv: 'TG_TOKEN',
      label: 'TG 告警',
    })
    fed.addAlertChannel({
      kind: 'im',
      platform: 'slack',
      url: slackUrl, // incoming-webhook: the token lives in the url, no target/secret
      label: 'Slack 告警',
    })
    fed.addAlertChannel({
      kind: 'email',
      url: emailUrl,
      target: 'ops@cp.example',
      label: 'Email 告警',
    })
    fed.addAlertRule({
      source: 'provider',
      metric: 'assets.agents',
      comparator: 'gte',
      threshold: 3,
      label: '太多 agent',
    })

    // The stored telegram row carries the env-var NAME, never the bot token.
    expect(tg.headerEnv).toBe('TG_TOKEN')
    expect(JSON.stringify(tg)).not.toContain('tg-bot-secret-987')

    // Drive a real breach: a 3rd provider agent joins.
    provider.register(new NoopAgent({ id: 'agent-secret-gamma', capabilities: ['confidential-svc-3'] }))
    consumerClock = 1_000_000
    await fed.refresh()
    const report = await fed.evaluateAndDeliver()

    // One firing, fanned out to all three enabled channels, all ok.
    expect(report.opened).toHaveLength(1)
    expect(report.deliveries).toHaveLength(3)
    for (const d of report.deliveries) expect(d.ok).toBe(true)
    expect(calls).toHaveLength(3)

    const byUrlPrefix = (p: string) => calls.find((c) => c.url.startsWith(p))!

    // --- Telegram: bot token from env goes in the PATH; chat id is `target`. ---
    const tgCall = byUrlPrefix('https://api.telegram.org')
    expect(tgCall.url).toBe('https://api.telegram.org/bottg-bot-secret-987/sendMessage')
    const tgBody = tgCall.body as { chat_id: string; text: string }
    expect(tgBody.chat_id).toBe('chat-555')
    expect(tgBody.text.startsWith('[aipehub] alert firing:')).toBe(true)
    expect(tgBody.text).toContain('太多 agent')
    expect(tgBody.text).toContain('assets.agents gte 3')
    expect(tgBody.text).toContain('(observed 3)')
    expect(tgBody.text).toContain('on source provider')

    // --- Slack: incoming-webhook, body is just `{text}`, url unchanged. ---
    const slackCall = byUrlPrefix(slackUrl)
    expect(slackCall.url).toBe(slackUrl)
    const slackBody = slackCall.body as { text: string }
    expect(slackBody.text).toBe(tgBody.text) // same counts-only line, re-encoded per platform

    // --- Email: `{to,subject,text}` to the email API, recipient is `target`. ---
    const emailCall = byUrlPrefix(emailUrl)
    expect(emailCall.url).toBe(emailUrl)
    const emailBody = emailCall.body as { to: string; subject: string; text: string }
    expect(emailBody.to).toBe('ops@cp.example')
    expect(emailBody.subject).toBe('[aipehub] alert opened: assets.agents')
    expect(emailBody.text).toBe(tgBody.text)

    // no leak: every platform body carries ONLY counts / ids / the rule label.
    for (const c of calls) expectNoLeak(c.body)

    // The bearer never crossed the wire as a stored value — it resolved into the
    // telegram path at delivery time; slack/email bodies never saw it.
    expect(slackCall.raw).not.toContain('tg-bot-secret-987')
    expect(emailCall.raw).not.toContain('tg-bot-secret-987')
  })

  it('retry: a transiently-failing channel succeeds on the second attempt through the surface', async () => {
    const url = 'https://hook.test/flaky'
    // Fail the FIRST POST to this url, then succeed.
    const { fetchImpl, calls } = makeRawCapturingFetch({ failFirstN: new Map([[url, 1]]) })
    const sleeps: number[] = []
    const fed = deliverFederation({
      fetchImpl,
      env: {},
      retry: {
        maxAttempts: 2,
        baseDelayMs: 1,
        sleepImpl: async (ms) => {
          sleeps.push(ms)
        },
      },
    })

    const chan = fed.addAlertChannel({ kind: 'webhook', url, label: '抖动 webhook' })
    fed.addAlertRule({ source: 'provider', metric: 'assets.agents', comparator: 'gte', threshold: 3 })

    provider.register(new NoopAgent({ id: 'agent-secret-gamma', capabilities: ['confidential-svc-3'] }))
    await fed.refresh()
    const report = await fed.evaluateAndDeliver()

    // The firing opened and — despite the first POST failing — delivery
    // eventually succeeded because the surface threaded retry/backoff through.
    expect(report.opened).toHaveLength(1)
    expect(report.deliveries).toHaveLength(1)
    expect(report.deliveries[0]).toMatchObject({ channelId: chan.id, ok: true, status: 200 })

    // Two POST attempts to the same url; one backoff slept (injected, no real wait).
    expect(calls.filter((c) => c.url === url)).toHaveLength(2)
    expect(sleeps).toEqual([1])
    for (const c of calls) expectNoLeak(c.body)
  })
})
