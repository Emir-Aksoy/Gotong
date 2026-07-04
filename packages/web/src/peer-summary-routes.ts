/**
 * Admin routes for the cross-hub control plane (v5 Stream E5-M3).
 *
 * The "控制面": this hub's own privacy-safe footprint joined with each connected
 * peer's voluntarily-shared summary (the `peer.summary` rpc, opt-in + gated).
 * Counts only — assets / runs / windowed LLM usage / suspended tasks; never raw
 * rows. These routes let the admin browse the aggregate and force an on-demand
 * refresh. Backed by a host-injected surface (the peer registry + an in-process
 * summary cache); web has no host dep, mirroring `peer-routes.ts`.
 *
 * Routes:
 *   GET  /api/admin/peer-summaries          local footprint + cached peer summaries
 *   POST /api/admin/peer-summaries/refresh  refetch (body {peerId?}) → local + list
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AdminRecord } from '@gotong/core'
import { createLogger } from '@gotong/core'

import { readJsonBody, sendJson } from './http-helpers.js'

const log = createLogger('peer-summary-routes')

/**
 * A peer's privacy-safe footprint (duck-typed mirror of the host's
 * `PeerSummary` — web has no host dep). COUNTS ONLY; web echoes whatever the
 * surface returns without reading or validating individual fields.
 */
export interface PeerSummary {
  hubId: string
  protocolVersion: string
  generatedAt: number
  assets: { agents: number; workflows: number; publishedWorkflows: number; peers: number }
  runs: { total: number; byStatus: Record<string, number> }
  llm: { windowDays: number; calls: number; tokens: number; costMicros: number }
  health: { suspendedTasks: number }
  // Cross-hub alert aggregation (Stream F cross-hub-agg M3): this hub's own
  // currently-open alert-firing count. A pure scalar — web just echoes it.
  alerts: { openFirings: number }
}

/**
 * One peer's summary row (duck-typed mirror of the host's `PeerSummaryRow`).
 * `summary` is null when never fetched / unavailable; `lastError` says WHY
 * (offline, or "not shared by this peer" — the opt-in gate's rejection).
 */
export interface PeerSummaryRow {
  peer: string
  label: string | null
  online: boolean
  stale: boolean
  summary: PeerSummary | null
  lastFetchedAt: number | null
  lastError: string | null
}

/**
 * One point on a metric's trend (duck-typed mirror of the host's
 * `PeerSummaryTrendPoint`): when it was captured + the scalar value.
 */
export interface PeerSummaryTrendPoint {
  capturedAt: number
  value: number
}

/** Query for the history route — one source's trend of one scalar metric. */
export interface PeerSummaryHistoryQuery {
  source: string
  metric: string
  since?: number
  until?: number
  limit?: number
}

/**
 * A configured alert rule (duck-typed mirror of the host's
 * `PeerSummaryAlertRule`). `source` is `'local'` | a peer id | `'*'`; `metric`
 * is a `metricKeys()` dotted key; `comparator` ∈ gt/gte/lt/lte.
 */
export interface PeerSummaryAlertRule {
  id: string
  source: string
  metric: string
  comparator: string
  threshold: number
  label: string | null
  enabled: boolean
  createdAt: number
  updatedAt: number
}

/**
 * A fired alert (duck-typed mirror of the host's `PeerSummaryAlertBreach`): the
 * rule, the ACTUAL source that breached (never `'*'`), and the value that tripped.
 */
export interface PeerSummaryAlertBreach {
  ruleId: string
  source: string
  metric: string
  comparator: string
  threshold: number
  value: number
  label: string | null
}

export interface PeerSummaryAlertRuleAddInput {
  source: string
  metric: string
  comparator: string
  threshold: number
  label?: string | null
  enabled?: boolean
}

export interface PeerSummaryAlertRuleUpdateInput {
  source?: string
  metric?: string
  comparator?: string
  threshold?: number
  label?: string | null
  enabled?: boolean
}

/**
 * A recorded alert firing (duck-typed mirror of the host's
 * `PeerSummaryAlertFiring`): one open→resolve lifecycle of a (rule, source).
 * Counts-only — numbers, a comparator, ids, and the rule's own label.
 */
export interface PeerSummaryAlertFiring {
  id: number
  ruleId: string
  source: string
  metric: string
  comparator: string
  threshold: number
  value: number
  label: string | null
  openedAt: number
  resolvedAt: number | null
}

/** History query for the firings route (mirror of the host's firing query). */
export interface PeerSummaryAlertFiringQuery {
  source?: string
  ruleId?: string
  state?: 'open' | 'resolved'
  since?: number
  until?: number
  limit?: number
}

/**
 * A notification channel (duck-typed mirror of the host's
 * `PeerSummaryAlertChannel`). NO secret in the row: `headerEnv` is an env-var
 * NAME the host resolves at delivery time, never a bearer value. `platform`
 * (im only) selects telegram/slack/discord/lark; `target` is the im chat/room
 * id or the email recipient. Both are DESTINATION bits, never secrets.
 */
export interface PeerSummaryAlertChannel {
  id: string
  kind: string
  url: string
  headerEnv: string | null
  platform: string | null
  target: string | null
  enabled: boolean
  label: string | null
  createdAt: number
  updatedAt: number
}

export interface PeerSummaryAlertChannelAddInput {
  kind: string
  url: string
  headerEnv?: string | null
  platform?: string | null
  target?: string | null
  enabled?: boolean
  label?: string | null
}

export interface PeerSummaryAlertChannelUpdateInput {
  kind?: string
  url?: string
  headerEnv?: string | null
  platform?: string | null
  target?: string | null
  enabled?: boolean
  label?: string | null
}

/** One channel's delivery outcome (duck-typed mirror of `AlertDeliveryResult`). */
export interface PeerSummaryAlertDeliveryResult {
  channelId: string
  ok: boolean
  status?: number
  error?: string
}

/**
 * Host-injected control-plane surface. Backed by the peer registry + the
 * `peer.summary` rpc + an in-process cache, plus (v5 Stream F) a persisted
 * snapshot store for trends. Absent (→ 503) when peers are disabled.
 */
export interface PeerSummaryFederationSurface {
  local(): Promise<PeerSummary>
  list(): Promise<PeerSummaryRow[]>
  refresh(peerId?: string): Promise<void>
  /** Trend one scalar metric for one source over a window (v5 Stream F). */
  history(query: PeerSummaryHistoryQuery): Promise<PeerSummaryTrendPoint[]>
  /** The canonical list of trendable metric keys (single source — host owns it). */
  metricKeys(): string[]
  /** List the configured alert rules (v5 Stream F-M5). */
  listAlertRules(): PeerSummaryAlertRule[]
  addAlertRule(input: PeerSummaryAlertRuleAddInput): PeerSummaryAlertRule
  updateAlertRule(id: string, patch: PeerSummaryAlertRuleUpdateInput): PeerSummaryAlertRule
  removeAlertRule(id: string): boolean
  /** Evaluate rules against the current summaries → live breaches. */
  evaluateAlerts(): Promise<PeerSummaryAlertBreach[]>
  /** Firing history, newest first (v5 Stream F day-3). `[]` when no firing sink. */
  listAlertFirings(query?: PeerSummaryAlertFiringQuery): PeerSummaryAlertFiring[]
  /** List notification channels (v5 Stream F day-3). */
  listAlertChannels(): PeerSummaryAlertChannel[]
  addAlertChannel(input: PeerSummaryAlertChannelAddInput): PeerSummaryAlertChannel
  updateAlertChannel(id: string, patch: PeerSummaryAlertChannelUpdateInput): PeerSummaryAlertChannel
  removeAlertChannel(id: string): boolean
  /** Send a synthetic test payload to one channel (even a disabled one). */
  testAlertChannel(id: string): Promise<PeerSummaryAlertDeliveryResult>
}

export interface PeerSummaryRoutesCtx {
  peerSummaries?: PeerSummaryFederationSurface
  requireAdmin: (req: IncomingMessage, res: ServerResponse) => Promise<AdminRecord | null>
}

const PREFIX = '/api/admin/peer-summaries'
const REFRESH = '/api/admin/peer-summaries/refresh'
const HISTORY = '/api/admin/peer-summaries/history'

/**
 * Parse an optional non-negative integer query param. Returns undefined when
 * absent; throws (→ 400) when present but not a finite non-negative integer.
 */
function optInt(raw: string | null, name: string): number | undefined {
  if (raw === null || raw === '') return undefined
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${name} must be a non-negative integer`)
  }
  return n
}

/**
 * Handle the control-plane browse + refresh routes. Returns `true` if the
 * request was handled, `false` otherwise.
 */
export async function handlePeerSummaryRoute(
  ctx: PeerSummaryRoutesCtx,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
): Promise<boolean> {
  if (path !== PREFIX && path !== REFRESH && path !== HISTORY) return false

  const admin = await ctx.requireAdmin(req, res)
  if (!admin) return true
  if (!ctx.peerSummaries) {
    sendJson(res, { error: 'peer federation not enabled on this host' }, 503)
    return true
  }
  const surface = ctx.peerSummaries

  // GET /api/admin/peer-summaries — local footprint + cached peer summaries
  if (path === PREFIX && method === 'GET') {
    try {
      const [local, peers] = await Promise.all([surface.local(), surface.list()])
      sendJson(res, { local, peers })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error('peer-summaries list failed', { by: admin.id, err: msg })
      sendJson(res, { error: msg }, 500)
    }
    return true
  }

  // POST /api/admin/peer-summaries/refresh — refetch, then return local + list
  if (path === REFRESH && method === 'POST') {
    let body: { peerId?: unknown }
    try {
      body = (await readJsonBody(req)) as typeof body
    } catch {
      // An empty / absent body means "refresh all" — tolerate rather than 400.
      body = {}
    }
    if (body.peerId !== undefined && typeof body.peerId !== 'string') {
      sendJson(res, { error: 'peerId must be a string' }, 400)
      return true
    }
    try {
      await surface.refresh(body.peerId as string | undefined)
      const [local, peers] = await Promise.all([surface.local(), surface.list()])
      sendJson(res, { ok: true, local, peers })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error('peer-summaries refresh failed', { by: admin.id, err: msg })
      sendJson(res, { error: msg }, 500)
    }
    return true
  }

  // GET /api/admin/peer-summaries/history?source=&metric=&since=&until=&limit=
  // — trend one scalar metric for one source (v5 Stream F). Returns the points
  // plus the canonical metric-key list so the UI dropdown stays single-source.
  if (path === HISTORY && method === 'GET') {
    const url = new URL(req.url ?? path, 'http://localhost')
    const source = url.searchParams.get('source') ?? ''
    const metric = url.searchParams.get('metric') ?? ''
    if (!source || !metric) {
      sendJson(res, { error: 'source and metric query params are required' }, 400)
      return true
    }
    let since: number | undefined
    let until: number | undefined
    let limit: number | undefined
    try {
      since = optInt(url.searchParams.get('since'), 'since')
      until = optInt(url.searchParams.get('until'), 'until')
      limit = optInt(url.searchParams.get('limit'), 'limit')
    } catch (err) {
      sendJson(res, { error: err instanceof Error ? err.message : String(err) }, 400)
      return true
    }
    try {
      const points = await surface.history({ source, metric, since, until, limit })
      sendJson(res, { source, metric, points, metrics: surface.metricKeys() })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error('peer-summaries history failed', { by: admin.id, err: msg })
      sendJson(res, { error: msg }, 500)
    }
    return true
  }

  // Path matched a prefix but no method/shape did → 405.
  sendJson(res, { error: `method ${method} not allowed on ${path}` }, 405)
  return true
}

// ─── alert rules (v5 Stream F-M5) ────────────────────────────────────────────

const ALERTS = '/api/admin/peer-summary-alerts'
const RULES = '/api/admin/peer-summary-alerts/rules'
const FIRINGS = '/api/admin/peer-summary-alerts/firings'
const CHANNELS = '/api/admin/peer-summary-alerts/channels'

/** Valid comparators — mirror of the host's `PEER_SUMMARY_ALERT_COMPARATORS`. */
const COMPARATORS = new Set(['gt', 'gte', 'lt', 'lte'])

/** Valid channel kinds — mirror of the host's `PEER_SUMMARY_ALERT_CHANNEL_KINDS`. */
const CHANNEL_KINDS = new Set(['webhook', 'im', 'email'])

/** Valid im platforms — mirror of the host's `PEER_SUMMARY_ALERT_IM_PLATFORMS`. */
const IM_PLATFORMS = new Set(['telegram', 'slack', 'discord', 'lark'])

const ALERT_ERROR_STATUS: Record<string, number> = {
  alert_rule_exists: 409,
  alert_rule_not_found: 404,
  alert_channel_exists: 409,
  alert_channel_not_found: 404,
  invalid_input: 400,
}

/** Map a typed store error (`.code`) to an HTTP status; unknown → 500. */
function sendAlertStoreError(res: ServerResponse, err: unknown): void {
  if (
    err &&
    typeof err === 'object' &&
    'code' in err &&
    typeof (err as { code?: unknown }).code === 'string'
  ) {
    const code = (err as { code: string }).code
    sendJson(res, { error: code }, ALERT_ERROR_STATUS[code] ?? 400)
    return
  }
  const msg = err instanceof Error ? err.message : String(err)
  log.error('peer-summary-alert store error', { err: msg })
  sendJson(res, { error: msg }, 500)
}

function asObject(body: unknown): Record<string, unknown> | null {
  return body && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null
}

/** label must be string|null; enabled must be boolean (when present). */
function checkRuleOptionals(o: Record<string, unknown>): string | null {
  if (o.label !== undefined && o.label !== null && typeof o.label !== 'string') {
    return 'label must be a string or null'
  }
  if (o.enabled !== undefined && typeof o.enabled !== 'boolean') return 'enabled must be a boolean'
  return null
}

function pickRuleOptionals(o: Record<string, unknown>): {
  label?: string | null
  enabled?: boolean
} {
  return {
    ...(o.label !== undefined ? { label: o.label as string | null } : {}),
    ...(o.enabled !== undefined ? { enabled: o.enabled as boolean } : {}),
  }
}

function coerceAddRule(
  body: unknown,
): { value: PeerSummaryAlertRuleAddInput } | { error: string } {
  const o = asObject(body)
  if (!o) return { error: 'body must be an object' }
  for (const f of ['source', 'metric'] as const) {
    if (typeof o[f] !== 'string' || (o[f] as string).trim().length === 0) {
      return { error: `${f} must be a non-empty string` }
    }
  }
  if (typeof o.comparator !== 'string' || !COMPARATORS.has(o.comparator)) {
    return { error: 'comparator must be one of gt/gte/lt/lte' }
  }
  if (typeof o.threshold !== 'number' || !Number.isFinite(o.threshold)) {
    return { error: 'threshold must be a finite number' }
  }
  const bad = checkRuleOptionals(o)
  if (bad) return { error: bad }
  return {
    value: {
      source: o.source as string,
      metric: o.metric as string,
      comparator: o.comparator,
      threshold: o.threshold,
      ...pickRuleOptionals(o),
    },
  }
}

function coerceUpdateRule(
  body: unknown,
): { value: PeerSummaryAlertRuleUpdateInput } | { error: string } {
  const o = asObject(body)
  if (!o) return { error: 'body must be an object' }
  for (const f of ['source', 'metric'] as const) {
    if (o[f] !== undefined && (typeof o[f] !== 'string' || (o[f] as string).trim().length === 0)) {
      return { error: `${f} must be a non-empty string` }
    }
  }
  if (o.comparator !== undefined && (typeof o.comparator !== 'string' || !COMPARATORS.has(o.comparator))) {
    return { error: 'comparator must be one of gt/gte/lt/lte' }
  }
  if (o.threshold !== undefined && (typeof o.threshold !== 'number' || !Number.isFinite(o.threshold))) {
    return { error: 'threshold must be a finite number' }
  }
  const bad = checkRuleOptionals(o)
  if (bad) return { error: bad }
  return {
    value: {
      ...(o.source !== undefined ? { source: o.source as string } : {}),
      ...(o.metric !== undefined ? { metric: o.metric as string } : {}),
      ...(o.comparator !== undefined ? { comparator: o.comparator as string } : {}),
      ...(o.threshold !== undefined ? { threshold: o.threshold as number } : {}),
      ...pickRuleOptionals(o),
    },
  }
}

/**
 * Shape checks for a channel's optionals; the deep cross-field rules (im needs a
 * platform, email/telegram need a target, URL scheme) are the store's. `platform`
 * membership IS checked here (a pure enum mirror, like `kind`/`comparator`) so an
 * out-of-set platform fails fast with a clear message before hitting the store.
 */
function checkChannelOptionals(o: Record<string, unknown>): string | null {
  if (o.headerEnv !== undefined && o.headerEnv !== null && typeof o.headerEnv !== 'string') {
    return 'headerEnv must be a string or null'
  }
  if (o.platform !== undefined && o.platform !== null) {
    if (typeof o.platform !== 'string' || !IM_PLATFORMS.has(o.platform)) {
      return 'platform must be one of: telegram, slack, discord, lark'
    }
  }
  if (o.target !== undefined && o.target !== null && typeof o.target !== 'string') {
    return 'target must be a string or null'
  }
  if (o.enabled !== undefined && typeof o.enabled !== 'boolean') return 'enabled must be a boolean'
  if (o.label !== undefined && o.label !== null && typeof o.label !== 'string') {
    return 'label must be a string or null'
  }
  return null
}

function pickChannelOptionals(o: Record<string, unknown>): {
  headerEnv?: string | null
  platform?: string | null
  target?: string | null
  enabled?: boolean
  label?: string | null
} {
  return {
    ...(o.headerEnv !== undefined ? { headerEnv: o.headerEnv as string | null } : {}),
    ...(o.platform !== undefined ? { platform: o.platform as string | null } : {}),
    ...(o.target !== undefined ? { target: o.target as string | null } : {}),
    ...(o.enabled !== undefined ? { enabled: o.enabled as boolean } : {}),
    ...(o.label !== undefined ? { label: o.label as string | null } : {}),
  }
}

function coerceAddChannel(
  body: unknown,
): { value: PeerSummaryAlertChannelAddInput } | { error: string } {
  const o = asObject(body)
  if (!o) return { error: 'body must be an object' }
  if (typeof o.kind !== 'string' || !CHANNEL_KINDS.has(o.kind)) {
    return { error: 'kind must be one of: webhook, im, email' }
  }
  if (typeof o.url !== 'string' || o.url.trim().length === 0) {
    return { error: 'url must be a non-empty string' }
  }
  const bad = checkChannelOptionals(o)
  if (bad) return { error: bad }
  return {
    value: { kind: o.kind, url: o.url, ...pickChannelOptionals(o) },
  }
}

function coerceUpdateChannel(
  body: unknown,
): { value: PeerSummaryAlertChannelUpdateInput } | { error: string } {
  const o = asObject(body)
  if (!o) return { error: 'body must be an object' }
  if (o.kind !== undefined && (typeof o.kind !== 'string' || !CHANNEL_KINDS.has(o.kind))) {
    return { error: 'kind must be one of: webhook, im, email' }
  }
  if (o.url !== undefined && (typeof o.url !== 'string' || o.url.trim().length === 0)) {
    return { error: 'url must be a non-empty string' }
  }
  const bad = checkChannelOptionals(o)
  if (bad) return { error: bad }
  return {
    value: {
      ...(o.kind !== undefined ? { kind: o.kind as string } : {}),
      ...(o.url !== undefined ? { url: o.url as string } : {}),
      ...pickChannelOptionals(o),
    },
  }
}

/**
 * Handle the control-plane alert routes (v5 Stream F-M5 + day-3). Returns `true`
 * if the request matched a `/api/admin/peer-summary-alerts[...]` path (answered).
 *
 *   GET    /api/admin/peer-summary-alerts            live breaches + the rule list
 *   POST   /api/admin/peer-summary-alerts/rules      add a rule
 *   PATCH  /api/admin/peer-summary-alerts/rules/:id  targeted update
 *   DELETE /api/admin/peer-summary-alerts/rules/:id  remove
 *   GET    /api/admin/peer-summary-alerts/firings    firing history (day-3)
 *   GET    /api/admin/peer-summary-alerts/channels   list notification channels
 *   POST   /api/admin/peer-summary-alerts/channels   add a webhook channel
 *   PATCH  /api/admin/peer-summary-alerts/channels/:id      targeted update
 *   DELETE /api/admin/peer-summary-alerts/channels/:id      remove
 *   POST   /api/admin/peer-summary-alerts/channels/:id/test send a test payload
 */
export async function handlePeerSummaryAlertRoute(
  ctx: PeerSummaryRoutesCtx,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
): Promise<boolean> {
  if (
    path !== ALERTS &&
    path !== RULES &&
    !path.startsWith(`${RULES}/`) &&
    path !== FIRINGS &&
    path !== CHANNELS &&
    !path.startsWith(`${CHANNELS}/`)
  ) {
    return false
  }

  const admin = await ctx.requireAdmin(req, res)
  if (!admin) return true
  if (!ctx.peerSummaries) {
    sendJson(res, { error: 'peer federation not enabled on this host' }, 503)
    return true
  }
  const surface = ctx.peerSummaries

  // GET /api/admin/peer-summary-alerts — live breaches + the rule list. One read
  // gives the UI everything it needs to render the panel (active alerts + rules).
  if (path === ALERTS && method === 'GET') {
    try {
      const [alerts, rules] = await Promise.all([
        surface.evaluateAlerts(),
        Promise.resolve(surface.listAlertRules()),
      ])
      sendJson(res, { alerts, rules, metrics: surface.metricKeys() })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error('peer-summary-alerts evaluate failed', { by: admin.id, err: msg })
      sendJson(res, { error: msg }, 500)
    }
    return true
  }

  // Rules collection — add.
  if (path === RULES) {
    if (method === 'POST') {
      let body: unknown
      try {
        body = await readJsonBody(req)
      } catch {
        sendJson(res, { error: 'invalid json body' }, 400)
        return true
      }
      const parsed = coerceAddRule(body)
      if ('error' in parsed) {
        sendJson(res, { error: parsed.error }, 400)
        return true
      }
      try {
        sendJson(res, { rule: surface.addAlertRule(parsed.value) }, 201)
      } catch (err) {
        sendAlertStoreError(res, err)
      }
      return true
    }
    sendJson(res, { error: `method ${method} not allowed on ${path}` }, 405)
    return true
  }

  // Firings history (day-3) — newest first, counts-only firing lifecycle rows.
  // Filterable by source / ruleId / state (open|resolved) / since / until / limit.
  if (path === FIRINGS) {
    if (method === 'GET') {
      const url = new URL(req.url ?? path, 'http://localhost')
      const source = url.searchParams.get('source') || undefined
      const ruleId = url.searchParams.get('ruleId') || undefined
      const stateRaw = url.searchParams.get('state')
      if (stateRaw !== null && stateRaw !== '' && stateRaw !== 'open' && stateRaw !== 'resolved') {
        sendJson(res, { error: 'state must be open or resolved' }, 400)
        return true
      }
      const state = stateRaw === 'open' || stateRaw === 'resolved' ? stateRaw : undefined
      let since: number | undefined
      let until: number | undefined
      let limit: number | undefined
      try {
        since = optInt(url.searchParams.get('since'), 'since')
        until = optInt(url.searchParams.get('until'), 'until')
        limit = optInt(url.searchParams.get('limit'), 'limit')
      } catch (err) {
        sendJson(res, { error: err instanceof Error ? err.message : String(err) }, 400)
        return true
      }
      try {
        const firings = surface.listAlertFirings({
          ...(source ? { source } : {}),
          ...(ruleId ? { ruleId } : {}),
          ...(state ? { state } : {}),
          ...(since !== undefined ? { since } : {}),
          ...(until !== undefined ? { until } : {}),
          ...(limit !== undefined ? { limit } : {}),
        })
        sendJson(res, { firings })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        log.error('peer-summary-alert firings failed', { by: admin.id, err: msg })
        sendJson(res, { error: msg }, 500)
      }
      return true
    }
    sendJson(res, { error: `method ${method} not allowed on ${path}` }, 405)
    return true
  }

  // Channels collection — list / add. A channel stores an env-var NAME, never a
  // secret; the host resolves the bearer at delivery time.
  if (path === CHANNELS) {
    if (method === 'GET') {
      try {
        sendJson(res, { channels: surface.listAlertChannels() })
      } catch (err) {
        sendAlertStoreError(res, err)
      }
      return true
    }
    if (method === 'POST') {
      let body: unknown
      try {
        body = await readJsonBody(req)
      } catch {
        sendJson(res, { error: 'invalid json body' }, 400)
        return true
      }
      const parsed = coerceAddChannel(body)
      if ('error' in parsed) {
        sendJson(res, { error: parsed.error }, 400)
        return true
      }
      try {
        sendJson(res, { channel: surface.addAlertChannel(parsed.value) }, 201)
      } catch (err) {
        sendAlertStoreError(res, err)
      }
      return true
    }
    sendJson(res, { error: `method ${method} not allowed on ${path}` }, 405)
    return true
  }

  // Channels item — update / remove / test. The remainder after /channels/ is
  // either "<id>" (PATCH/DELETE) or "<id>/test" (POST → synthetic delivery).
  if (path.startsWith(`${CHANNELS}/`)) {
    const rest = path.slice(CHANNELS.length + 1)
    const isTest = rest.endsWith('/test')
    const channelId = decodeURIComponent(isTest ? rest.slice(0, -'/test'.length) : rest)
    if (!channelId || channelId.includes('/')) {
      sendJson(res, { error: 'bad channel id' }, 400)
      return true
    }

    if (isTest) {
      if (method !== 'POST') {
        sendJson(res, { error: `method ${method} not allowed on ${path}` }, 405)
        return true
      }
      try {
        const result = await surface.testAlertChannel(channelId)
        sendJson(res, { result })
      } catch (err) {
        sendAlertStoreError(res, err)
      }
      return true
    }

    if (method === 'PATCH') {
      let body: unknown
      try {
        body = await readJsonBody(req)
      } catch {
        sendJson(res, { error: 'invalid json body' }, 400)
        return true
      }
      const parsed = coerceUpdateChannel(body)
      if ('error' in parsed) {
        sendJson(res, { error: parsed.error }, 400)
        return true
      }
      try {
        sendJson(res, { channel: surface.updateAlertChannel(channelId, parsed.value) })
      } catch (err) {
        sendAlertStoreError(res, err)
      }
      return true
    }

    if (method === 'DELETE') {
      try {
        if (!surface.removeAlertChannel(channelId)) {
          sendJson(res, { error: 'alert_channel_not_found' }, 404)
          return true
        }
        sendJson(res, { ok: true })
      } catch (err) {
        sendAlertStoreError(res, err)
      }
      return true
    }

    sendJson(res, { error: `method ${method} not allowed on ${path}` }, 405)
    return true
  }

  // Rules item — update / remove. The id is the single segment after /rules.
  const id = decodeURIComponent(path.slice(RULES.length + 1))
  if (!id || id.includes('/')) {
    sendJson(res, { error: 'bad rule id' }, 400)
    return true
  }

  if (method === 'PATCH') {
    let body: unknown
    try {
      body = await readJsonBody(req)
    } catch {
      sendJson(res, { error: 'invalid json body' }, 400)
      return true
    }
    const parsed = coerceUpdateRule(body)
    if ('error' in parsed) {
      sendJson(res, { error: parsed.error }, 400)
      return true
    }
    try {
      sendJson(res, { rule: surface.updateAlertRule(id, parsed.value) })
    } catch (err) {
      sendAlertStoreError(res, err)
    }
    return true
  }

  if (method === 'DELETE') {
    try {
      if (!surface.removeAlertRule(id)) {
        sendJson(res, { error: 'alert_rule_not_found' }, 404)
        return true
      }
      sendJson(res, { ok: true })
    } catch (err) {
      sendAlertStoreError(res, err)
    }
    return true
  }

  sendJson(res, { error: `method ${method} not allowed on ${path}` }, 405)
  return true
}
