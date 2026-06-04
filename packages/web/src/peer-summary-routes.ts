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
import type { AdminRecord } from '@aipehub/core'
import { createLogger } from '@aipehub/core'

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
