/**
 * Usage / cost ledger admin routes (Phase 17 — Sprint 4).
 *
 * These power the owner-only cost dashboard + exports. They are dispatched
 * from `handleIdentityRoute` AFTER its owner gate, so they inherit the
 * same auth boundary as the audit log (billing data is owner-level).
 *
 *   GET /api/admin/identity/usage/ledger?...        JSON, newest-first, paged
 *   GET /api/admin/identity/usage/ledger/export?... CSV / JSONL attachment
 *   GET /api/admin/identity/usage/summary?groupBy=  JSON aggregate roll-up
 *
 * The store surface is duck-typed (`UsageLedgerSurface`) so web keeps zero
 * runtime dependency on `@gotong/identity`; the host's IdentityStore
 * satisfies it structurally. Methods are optional — a pre-migration host
 * (no ledger) makes the routes degrade to an empty result rather than 500.
 */

import type { ServerResponse } from 'node:http'

import {
  parseExportFormat,
  sendExport,
  toCsv,
  toJsonl,
  type CsvColumn,
} from './export-format.js'
import { sendJson } from './http-helpers.js'

/** Structural mirror of `@gotong/identity` LedgerEntry. */
export interface UsageLedgerEntryDTO {
  id: number
  ts: number
  orgId: string | null
  userId: string | null
  /** Phase 19 P4-M2 — local peer-registry row id for federated usage; null local. */
  peerId: string | null
  agentId: string
  workflowId: string | null
  taskId: string | null
  model: string
  provider: string | null
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  costMicros: number
  unpriced: boolean
  meta: Record<string, unknown> | null
}

/** Structural mirror of `@gotong/identity` LedgerAggregateRow. */
export interface UsageLedgerAggregateRowDTO {
  key: string
  calls: number
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  costMicros: number
}

export type UsageLedgerGroupBy = 'user' | 'agent' | 'workflow' | 'model' | 'day' | 'peer'

const GROUP_BY_VALUES: readonly UsageLedgerGroupBy[] = [
  'user',
  'agent',
  'workflow',
  'model',
  'day',
  'peer',
]

/**
 * Duck-typed projection of the IdentityStore ledger surface. Both methods
 * optional so a host without the Phase 17 migration still typechecks +
 * degrades gracefully at runtime.
 */
export interface UsageLedgerSurface {
  queryLedger?(query: {
    orgId?: string
    userId?: string
    peerId?: string
    agentId?: string
    workflowId?: string
    model?: string
    since?: number
    until?: number
    limit?: number
    offset?: number
  }): UsageLedgerEntryDTO[]
  aggregateLedger?(query: {
    groupBy: UsageLedgerGroupBy
    since?: number
    until?: number
    orgId?: string
    userId?: string
    peerId?: string
  }): UsageLedgerAggregateRowDTO[]
}

/** Max rows an export pulls in one shot (mirrors the store's hard cap). */
const EXPORT_LIMIT = 10_000

// ---------------------------------------------------------------------------
// query-string parsing
// ---------------------------------------------------------------------------

function readStr(url: URL, key: string): string | undefined {
  const v = url.searchParams.get(key)
  return v && v.length > 0 ? v : undefined
}

function readInt(url: URL, key: string): number | undefined {
  const raw = url.searchParams.get(key)
  if (raw === null) return undefined
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined
}

/** Build the row-level ledger filter from the query string. */
function parseLedgerQuery(url: URL): {
  orgId?: string
  userId?: string
  peerId?: string
  agentId?: string
  workflowId?: string
  model?: string
  since?: number
  until?: number
  limit?: number
  offset?: number
} {
  const q: ReturnType<typeof parseLedgerQuery> = {}
  const orgId = readStr(url, 'orgId')
  if (orgId !== undefined) q.orgId = orgId
  const userId = readStr(url, 'userId')
  if (userId !== undefined) q.userId = userId
  const peerId = readStr(url, 'peerId')
  if (peerId !== undefined) q.peerId = peerId
  const agentId = readStr(url, 'agentId')
  if (agentId !== undefined) q.agentId = agentId
  const workflowId = readStr(url, 'workflowId')
  if (workflowId !== undefined) q.workflowId = workflowId
  const model = readStr(url, 'model')
  if (model !== undefined) q.model = model
  const since = readInt(url, 'since')
  if (since !== undefined) q.since = since
  const until = readInt(url, 'until')
  if (until !== undefined) q.until = until
  const limit = readInt(url, 'limit')
  if (limit !== undefined) q.limit = limit
  const offset = readInt(url, 'offset')
  if (offset !== undefined) q.offset = offset
  return q
}

// ---------------------------------------------------------------------------
// CSV column specs
// ---------------------------------------------------------------------------

export const LEDGER_COLUMNS: ReadonlyArray<CsvColumn<UsageLedgerEntryDTO>> = [
  { header: 'id', value: (r) => r.id },
  { header: 'ts', value: (r) => r.ts },
  { header: 'iso_ts', value: (r) => new Date(r.ts).toISOString() },
  { header: 'org_id', value: (r) => r.orgId },
  { header: 'user_id', value: (r) => r.userId },
  { header: 'peer_id', value: (r) => r.peerId },
  { header: 'agent_id', value: (r) => r.agentId },
  { header: 'workflow_id', value: (r) => r.workflowId },
  { header: 'task_id', value: (r) => r.taskId },
  { header: 'model', value: (r) => r.model },
  { header: 'provider', value: (r) => r.provider },
  { header: 'input_tokens', value: (r) => r.inputTokens },
  { header: 'output_tokens', value: (r) => r.outputTokens },
  { header: 'cache_creation_tokens', value: (r) => r.cacheCreationTokens },
  { header: 'cache_read_tokens', value: (r) => r.cacheReadTokens },
  { header: 'cost_micros', value: (r) => r.costMicros },
  { header: 'cost_usd', value: (r) => (r.costMicros / 1_000_000).toFixed(6) },
  { header: 'unpriced', value: (r) => (r.unpriced ? 1 : 0) },
]

// ---------------------------------------------------------------------------
// handlers
// ---------------------------------------------------------------------------

/** GET …/usage/ledger — JSON list, newest-first, paginated. */
export function handleUsageLedgerList(
  surface: UsageLedgerSurface,
  url: URL,
  res: ServerResponse,
): void {
  if (typeof surface.queryLedger !== 'function') {
    sendJson(res, { entries: [], note: 'usage ledger unavailable on this host' })
    return
  }
  try {
    const entries = surface.queryLedger(parseLedgerQuery(url))
    sendJson(res, { entries })
  } catch (err) {
    sendJson(res, { error: (err as Error).message ?? 'ledger query failed' }, 400)
  }
}

/** GET …/usage/ledger/export — CSV / JSONL attachment (capped). */
export function handleUsageLedgerExport(
  surface: UsageLedgerSurface,
  url: URL,
  res: ServerResponse,
): void {
  if (typeof surface.queryLedger !== 'function') {
    sendJson(res, { error: 'usage ledger unavailable on this host' }, 503)
    return
  }
  const format = parseExportFormat(url.searchParams.get('format'))
  try {
    const q = parseLedgerQuery(url)
    q.limit = EXPORT_LIMIT
    q.offset = 0
    const entries = surface.queryLedger(q)
    const body =
      format === 'jsonl' ? toJsonl(entries) : toCsv(LEDGER_COLUMNS, entries)
    sendExport(res, format, 'usage-ledger', body)
  } catch (err) {
    sendJson(res, { error: (err as Error).message ?? 'ledger export failed' }, 400)
  }
}

/** GET …/usage/summary?groupBy= — JSON aggregate roll-up. */
export function handleUsageSummary(
  surface: UsageLedgerSurface,
  url: URL,
  res: ServerResponse,
): void {
  if (typeof surface.aggregateLedger !== 'function') {
    sendJson(res, { rows: [], note: 'usage ledger unavailable on this host' })
    return
  }
  const groupByRaw = url.searchParams.get('groupBy') ?? 'user'
  if (!GROUP_BY_VALUES.includes(groupByRaw as UsageLedgerGroupBy)) {
    sendJson(
      res,
      { error: `groupBy must be one of ${GROUP_BY_VALUES.join(', ')}` },
      400,
    )
    return
  }
  const query: Parameters<NonNullable<UsageLedgerSurface['aggregateLedger']>>[0] = {
    groupBy: groupByRaw as UsageLedgerGroupBy,
  }
  const since = readInt(url, 'since')
  if (since !== undefined) query.since = since
  const until = readInt(url, 'until')
  if (until !== undefined) query.until = until
  const orgId = readStr(url, 'orgId')
  if (orgId !== undefined) query.orgId = orgId
  const userId = readStr(url, 'userId')
  if (userId !== undefined) query.userId = userId
  const peerId = readStr(url, 'peerId')
  if (peerId !== undefined) query.peerId = peerId
  try {
    const rows = surface.aggregateLedger(query)
    sendJson(res, { groupBy: query.groupBy, rows })
  } catch (err) {
    sendJson(res, { error: (err as Error).message ?? 'summary failed' }, 400)
  }
}
