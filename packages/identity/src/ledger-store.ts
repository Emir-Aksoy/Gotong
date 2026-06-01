/**
 * LedgerStore — Phase 17 (Sprint 4) usage / cost ledger.
 *
 * One row per LLM provider call. Sits UNDER the `usage_counters` /
 * `org_quotas` domain (QuotaStore): the counters answer the hot-path
 * quota question ("is this user over their daily cap"), the ledger
 * answers the forensic / billing question ("show me exactly what was
 * spent, by whom, on what"). They share the same billing story but
 * different access patterns — counters are read+write on every call,
 * the ledger is append-only on write and scan-heavy on read (dashboard
 * aggregates + CSV/JSONL export), so it gets its own table + indices.
 *
 * Cost is supplied PRE-COMPUTED by the caller (the host owns the model
 * price table); identity stays model-agnostic and just stores the
 * resolved `cost_micros`. See `packages/host/src/pricing.ts` (M2).
 *
 * Statements: the two fixed shapes (INSERT, get-by-id) are eagerly
 * prepared — append is on the post-LLM-call path. query / aggregate
 * build their WHERE + GROUP BY dynamically (filters vary), so they
 * prepare per-call; both are off the hot path (admin dashboards /
 * export). The groupBy axis NEVER reaches SQL as raw text — only via
 * the {@link GROUP_BY_SQL} whitelist map — so there's no injection
 * surface despite the dynamic SQL.
 */

import { type SqliteDb, type SqliteStmt } from './db.js'
import { IdentityError } from './errors.js'
import {
  LEDGER_GROUP_BY,
  LEDGER_QUERY_DEFAULT_LIMIT,
  LEDGER_QUERY_MAX_LIMIT,
  type LedgerAggregateQuery,
  type LedgerAggregateRow,
  type LedgerAppendInput,
  type LedgerEntry,
  type LedgerGroupBy,
  type LedgerQuery,
} from './types.js'

/** Sqlite row shape — snake_case columns mirror the schema verbatim. */
interface LedgerRow {
  id: number
  ts: number
  org_id: string | null
  user_id: string | null
  peer_id: string | null
  agent_id: string
  workflow_id: string | null
  task_id: string | null
  model: string
  provider: string | null
  input_tokens: number
  output_tokens: number
  cache_creation_tokens: number
  cache_read_tokens: number
  cost_micros: number
  unpriced: number
  meta_json: string | null
}

/** Aggregate row shape straight from sqlite (snake_case). */
interface AggRow {
  key: string
  calls: number
  input_tokens: number
  output_tokens: number
  cache_creation_tokens: number
  cache_read_tokens: number
  cost_micros: number
}

/**
 * Map a public {@link LedgerGroupBy} axis → the SQL column expression it
 * rolls up by. Whitelisted: groupBy is validated against this map's keys
 * and only the mapped expression is interpolated, never the caller's
 * string. `day` floors the ms `ts` to a UTC calendar day.
 */
const GROUP_BY_SQL: Record<LedgerGroupBy, string> = {
  user: 'user_id',
  agent: 'agent_id',
  workflow: 'workflow_id',
  model: 'model',
  peer: 'peer_id',
  // ts is ms; sqlite's 'unixepoch' modifier wants seconds.
  day: `strftime('%Y-%m-%d', ts / 1000, 'unixepoch')`,
}

/** Max serialised size of the optional `meta` blob (mirrors audit_log). */
const META_MAX_BYTES = 8 * 1024

export class LedgerStore {
  private readonly db: SqliteDb
  private readonly stmtInsert: SqliteStmt
  private readonly stmtGetById: SqliteStmt

  constructor(db: SqliteDb) {
    this.db = db
    this.stmtInsert = db.prepare(
      `INSERT INTO usage_ledger
         (ts, org_id, user_id, peer_id, agent_id, workflow_id, task_id, model,
          provider, input_tokens, output_tokens, cache_creation_tokens,
          cache_read_tokens, cost_micros, unpriced, meta_json)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    this.stmtGetById = db.prepare('SELECT * FROM usage_ledger WHERE id = ?')
  }

  /**
   * Append one ledger row. Returns the persisted entry with its assigned
   * `id` + resolved `ts`. Validates the required `agentId` / `model` and
   * the token / cost integers (all non-negative). No transaction needed:
   * better-sqlite3 is synchronous and we read back by the exact
   * `lastInsertRowid`, so no concurrent insert can return the wrong row.
   */
  append(input: LedgerAppendInput): LedgerEntry {
    if (!input || typeof input !== 'object') {
      throw new IdentityError({
        code: 'invalid_input',
        message: 'appendLedger: input object required',
      })
    }
    assertNonEmptyStr(input.agentId, 'agentId')
    assertNonEmptyStr(input.model, 'model')
    const ts = input.ts ?? Date.now()
    assertNonNegInt(ts, 'ts')
    const inputTokens = assertNonNegInt(input.inputTokens, 'inputTokens')
    const outputTokens = assertNonNegInt(input.outputTokens, 'outputTokens')
    const cacheCreation = assertNonNegInt(
      input.cacheCreationTokens ?? 0,
      'cacheCreationTokens',
    )
    const cacheRead = assertNonNegInt(
      input.cacheReadTokens ?? 0,
      'cacheReadTokens',
    )
    const costMicros = assertNonNegInt(input.costMicros, 'costMicros')
    const metaJson = serialiseMeta(input.meta)

    const res = this.stmtInsert.run(
      ts,
      input.orgId ?? null,
      input.userId ?? null,
      input.peerId ?? null,
      input.agentId,
      input.workflowId ?? null,
      input.taskId ?? null,
      input.model,
      input.provider ?? null,
      inputTokens,
      outputTokens,
      cacheCreation,
      cacheRead,
      costMicros,
      input.unpriced ? 1 : 0,
      metaJson,
    )
    const id = Number(res.lastInsertRowid)
    const row = this.stmtGetById.get(id) as LedgerRow | undefined
    if (!row) {
      throw new IdentityError({
        code: 'invalid_input',
        message: `appendLedger: insert succeeded but read-back returned nothing for id=${id}`,
      })
    }
    return rowToEntry(row)
  }

  /**
   * Row-level query, newest-first (`id DESC`). Every filter optional and
   * ANDed; `[since, until)` is a half-open time window. `limit` defaults
   * to {@link LEDGER_QUERY_DEFAULT_LIMIT}, clamped to
   * {@link LEDGER_QUERY_MAX_LIMIT}; `offset` paginates.
   */
  query(q: LedgerQuery = {}): LedgerEntry[] {
    const { where, params } = buildWhere(q)
    const limit = clampLimit(q.limit)
    const offset =
      typeof q.offset === 'number' && q.offset > 0 ? Math.floor(q.offset) : 0
    const sql = `SELECT * FROM usage_ledger ${where} ORDER BY id DESC LIMIT ? OFFSET ?`
    const rows = this.db
      .prepare(sql)
      .all(...params, limit, offset) as LedgerRow[]
    return rows.map(rowToEntry)
  }

  /**
   * Aggregate roll-up: GROUP BY the requested axis, SUM tokens + cost,
   * COUNT calls. Ordered cost DESC (biggest spenders first), key ASC as
   * a stable tiebreak. NULL group values (e.g. unattributed userId)
   * collapse to `'(none)'` so the bucket stays visible.
   */
  aggregate(q: LedgerAggregateQuery): LedgerAggregateRow[] {
    if (!q || typeof q !== 'object') {
      throw new IdentityError({
        code: 'invalid_input',
        message: 'aggregateLedger: query object with groupBy required',
      })
    }
    if (!LEDGER_GROUP_BY.includes(q.groupBy)) {
      throw new IdentityError({
        code: 'invalid_input',
        message: `aggregateLedger: groupBy must be one of ${LEDGER_GROUP_BY.join(', ')}; got ${JSON.stringify(q.groupBy)}`,
      })
    }
    const col = GROUP_BY_SQL[q.groupBy]
    // Only the time + org/user scoping filters apply to an aggregate.
    const { where, params } = buildWhere({
      orgId: q.orgId,
      userId: q.userId,
      peerId: q.peerId,
      since: q.since,
      until: q.until,
    })
    const sql = `SELECT COALESCE(${col}, '(none)') AS key,
              COUNT(*) AS calls,
              COALESCE(SUM(input_tokens), 0) AS input_tokens,
              COALESCE(SUM(output_tokens), 0) AS output_tokens,
              COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
              COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
              COALESCE(SUM(cost_micros), 0) AS cost_micros
         FROM usage_ledger ${where}
        GROUP BY ${col}
        ORDER BY cost_micros DESC, key ASC`
    const rows = this.db.prepare(sql).all(...params) as AggRow[]
    return rows.map((r) => ({
      key: r.key,
      calls: r.calls,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      cacheCreationTokens: r.cache_creation_tokens,
      cacheReadTokens: r.cache_read_tokens,
      costMicros: r.cost_micros,
    }))
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Build the shared `WHERE … AND …` clause + bound params for a filter set. */
function buildWhere(q: {
  orgId?: string
  userId?: string
  peerId?: string
  agentId?: string
  workflowId?: string
  model?: string
  since?: number
  until?: number
}): { where: string; params: unknown[] } {
  const clauses: string[] = []
  const params: unknown[] = []
  if (q.orgId !== undefined) {
    clauses.push('org_id = ?')
    params.push(q.orgId)
  }
  if (q.userId !== undefined) {
    clauses.push('user_id = ?')
    params.push(q.userId)
  }
  if (q.peerId !== undefined) {
    clauses.push('peer_id = ?')
    params.push(q.peerId)
  }
  if (q.agentId !== undefined) {
    clauses.push('agent_id = ?')
    params.push(q.agentId)
  }
  if (q.workflowId !== undefined) {
    clauses.push('workflow_id = ?')
    params.push(q.workflowId)
  }
  if (q.model !== undefined) {
    clauses.push('model = ?')
    params.push(q.model)
  }
  if (q.since !== undefined) {
    assertNonNegInt(q.since, 'since')
    clauses.push('ts >= ?')
    params.push(q.since)
  }
  if (q.until !== undefined) {
    assertNonNegInt(q.until, 'until')
    clauses.push('ts < ?')
    params.push(q.until)
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  return { where, params }
}

/** undefined → default; provided → floored + clamped into [1, MAX]. */
function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return LEDGER_QUERY_DEFAULT_LIMIT
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 0) {
    throw new IdentityError({
      code: 'invalid_input',
      message: `query limit must be a non-negative number; got ${limit}`,
    })
  }
  const n = Math.floor(limit)
  if (n < 1) return LEDGER_QUERY_DEFAULT_LIMIT // 0 → default, not "no rows"
  return Math.min(n, LEDGER_QUERY_MAX_LIMIT)
}

/** `null`/`undefined` → null; else JSON, rejecting unserialisable / oversized. */
function serialiseMeta(meta: unknown): string | null {
  if (meta === null || meta === undefined) return null
  if (typeof meta !== 'object' || Array.isArray(meta)) {
    throw new IdentityError({
      code: 'invalid_input',
      message: 'ledger meta must be a plain object or null',
    })
  }
  let json: string
  try {
    json = JSON.stringify(meta)
  } catch (err) {
    throw new IdentityError({
      code: 'invalid_input',
      message: `ledger meta not JSON-serialisable: ${(err as Error).message}`,
    })
  }
  if (json.length > META_MAX_BYTES) {
    throw new IdentityError({
      code: 'invalid_input',
      message: `ledger meta too large (max ${META_MAX_BYTES} bytes serialised); got ${json.length}`,
    })
  }
  return json
}

function rowToEntry(r: LedgerRow): LedgerEntry {
  let meta: Record<string, unknown> | null = null
  if (r.meta_json != null) {
    try {
      const parsed = JSON.parse(r.meta_json)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        meta = parsed as Record<string, unknown>
      }
    } catch {
      // Tolerate a corrupt blob (manual db edit) — keep the row visible
      // rather than crashing the list / export endpoint.
      meta = null
    }
  }
  return {
    id: r.id,
    ts: r.ts,
    orgId: r.org_id,
    userId: r.user_id,
    peerId: r.peer_id,
    agentId: r.agent_id,
    workflowId: r.workflow_id,
    taskId: r.task_id,
    model: r.model,
    provider: r.provider,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    cacheCreationTokens: r.cache_creation_tokens,
    cacheReadTokens: r.cache_read_tokens,
    costMicros: r.cost_micros,
    unpriced: r.unpriced !== 0,
    meta,
  }
}

function assertNonEmptyStr(v: unknown, label: string): asserts v is string {
  if (typeof v !== 'string' || v.length === 0) {
    throw new IdentityError({
      code: 'invalid_input',
      message: `${label} must be a non-empty string`,
    })
  }
}

/** Assert a non-negative integer and return it (for inline use). */
function assertNonNegInt(v: unknown, label: string): number {
  if (
    typeof v !== 'number' ||
    !Number.isFinite(v) ||
    !Number.isInteger(v) ||
    v < 0
  ) {
    throw new IdentityError({
      code: 'invalid_input',
      message: `${label} must be a non-negative integer; got ${v}`,
    })
  }
  return v
}
