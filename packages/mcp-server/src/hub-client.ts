/**
 * Thin HTTP client for the AipeHub admin API. Used by the MCP server
 * to translate MCP tool calls into REST calls against a running Hub.
 *
 * Auth is a Bearer admin token. We never store / cache responses — every
 * tool call is a fresh round-trip. That keeps the MCP server stateless
 * and lets multiple MCP clients hit the same Hub concurrently without
 * coordination.
 *
 * Errors are wrapped into `HubClientError` with `status` + `body`
 * preserved so the caller (MCP tool handler) can surface a useful
 * message to the LLM.
 */

export interface HubClientOptions {
  /** Base URL of the Hub web server, e.g. `http://127.0.0.1:3000`. No trailing slash. */
  baseUrl: string
  /** Admin Bearer token (printed once at first host launch). */
  adminToken: string
  /** Per-request fetch timeout in ms. Default 65s — slightly above the dispatch wait timeout. */
  timeoutMs?: number
}

export class HubClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message)
    this.name = 'HubClientError'
  }
}

/**
 * Strip the Bearer admin token out of any string before it reaches an
 * operator-visible surface (stderr, MCP tool result, log file).
 *
 * Why this is necessary: certain `undici`/Node fetch versions thread the
 * full request init object — including `headers.authorization` — into
 * `TypeError` instances they throw on transport failure. Pre-3.4 the
 * MCP server's top-level catch wrote `err.stack ?? err.message` straight
 * to stderr, which Claude Desktop / Cursor / Cline all capture into
 * their long-lived diagnostic logs. Anyone with read access to those
 * logs effectively held the Hub's admin token.
 *
 * The redactor is intentionally over-eager — anything matching
 * `Bearer\s+\S+` collapses to `Bearer ***`, and the configured token
 * literal is replaced everywhere. Costs nothing on the success path
 * (we never call it there).
 *
 * See AUDIT-v3.3.md finding H3.
 */
export function redactToken(str: string, token: string): string {
  if (typeof str !== 'string') return str
  let out = str
  if (token) {
    // The token literal can appear naked (e.g. printed via toString of
    // a fetch-init dump) or right after `Bearer`. Replace BOTH paths.
    // `replaceAll` with a string operand is literal — no regex meta —
    // so the token can safely contain regex-special characters.
    out = out.split(token).join('***')
  }
  // Catch any other `Bearer …` form (e.g. an attacker-supplied token
  // showing up in a server-side error reflected back). Anything from
  // `Bearer ` up to the next whitespace / quote / backtick / brace is
  // collapsed; we err on the side of redacting too much.
  out = out.replace(/Bearer\s+[^\s'"`{}]+/g, 'Bearer ***')
  return out
}

/**
 * Rebuild an Error with its message + stack + nested cause all
 * redacted. Returns a fresh Error so the original object — which may
 * be held by an awaiting MCP SDK frame — is left untouched.
 *
 * Recursive on `cause` so wrapped undici TypeErrors get cleaned too.
 *
 * See AUDIT-v3.3.md finding H3.
 */
export function redactError(err: unknown, token: string): Error {
  if (err instanceof Error) {
    const cleaned = new Error(redactToken(err.message, token))
    cleaned.name = err.name
    if (typeof err.stack === 'string') {
      cleaned.stack = redactToken(err.stack, token)
    }
    // `cause` is a 1-deep chain in practice (undici TypeError → AbortError).
    // Recurse to redact whatever shape it carries.
    if ('cause' in err && (err as { cause?: unknown }).cause !== undefined) {
      ;(cleaned as Error & { cause?: unknown }).cause = redactError(
        (err as { cause: unknown }).cause,
        token,
      )
    }
    return cleaned
  }
  return new Error(redactToken(String(err), token))
}

export class HubClient {
  constructor(private readonly opts: HubClientOptions) {
    if (!opts.baseUrl) throw new Error('HubClient: baseUrl is required')
    if (!opts.adminToken) throw new Error('HubClient: adminToken is required')
  }

  /** Health check — returns true if the Hub answers on /healthz. */
  async ping(): Promise<boolean> {
    try {
      const r = await this.raw('GET', '/healthz', null, { auth: false })
      return r.status === 200
    } catch {
      return false
    }
  }

  /** Full state snapshot — participants + transcript tail + tasks + pending applications. */
  async state(): Promise<HubState> {
    return this.get<HubState>('/api/state')
  }

  /**
   * Dispatch a task and wait for the result. Uses the `wait: true` /
   * `timeoutMs` extension on `/api/admin/dispatch` so we get a concrete
   * `TaskResult` back instead of fire-and-forget.
   */
  async dispatchAndWait(body: DispatchBody, waitTimeoutMs = 60_000): Promise<DispatchResult> {
    return this.post<DispatchResult>('/api/admin/dispatch', {
      ...body,
      wait: true,
      timeoutMs: waitTimeoutMs,
    })
  }

  async leaderboard(opts: { from?: number; to?: number } = {}): Promise<Leaderboard> {
    const qs = new URLSearchParams()
    if (opts.from != null) qs.set('from', String(opts.from))
    if (opts.to != null) qs.set('to', String(opts.to))
    const path = qs.size > 0 ? `/api/leaderboard?${qs}` : '/api/leaderboard'
    return this.get<Leaderboard>(path)
  }

  async evaluate(body: { taskId: string; rating?: number; comment?: string }): Promise<{ ok: true }> {
    return this.post<{ ok: true }>('/api/admin/evaluate', body)
  }

  // --- internals ------------------------------------------------------

  private async get<T>(path: string): Promise<T> {
    const r = await this.raw('GET', path, null)
    return this.unwrap<T>(r, path)
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const r = await this.raw('POST', path, body)
    return this.unwrap<T>(r, path)
  }

  private async raw(
    method: string,
    path: string,
    body: unknown,
    { auth = true }: { auth?: boolean } = {},
  ): Promise<Response> {
    const url = `${this.opts.baseUrl}${path}`
    const headers: Record<string, string> = { accept: 'application/json' }
    if (auth) headers.authorization = `Bearer ${this.opts.adminToken}`
    if (body !== null && body !== undefined) headers['content-type'] = 'application/json'
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(new Error('hub-client request timeout')), this.opts.timeoutMs ?? 65_000)
    try {
      return await fetch(url, {
        method,
        headers,
        body: body !== null && body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      })
    } catch (err: unknown) {
      // H3 — undici/Node fetch can stash the full init object (including
      // `headers.authorization: Bearer <TOKEN>`) into a TypeError it
      // throws on transport failure. Without this redaction the
      // original error reaches `main.ts`'s top-level catch and gets
      // written to stderr — straight into Claude Desktop / Cursor /
      // Cline diagnostic logs. Rebuild the error with token literals
      // and any `Bearer …` substrings stripped before letting it
      // escape this method. See AUDIT-v3.3.md finding H3.
      throw redactError(err, this.opts.adminToken)
    } finally {
      clearTimeout(t)
    }
  }

  private async unwrap<T>(r: Response, path: string): Promise<T> {
    const text = await r.text()
    let parsed: unknown
    try { parsed = text.length > 0 ? JSON.parse(text) : null } catch { parsed = text }
    if (!r.ok) {
      const rawMsg = (parsed && typeof parsed === 'object' && 'error' in parsed && typeof parsed.error === 'string')
        ? parsed.error
        : `Hub returned ${r.status} for ${path}`
      // H3 — even legitimate server-side error strings have been seen
      // to reflect the inbound `Authorization` header on certain
      // misconfigured proxies (e.g. an `nginx_error_log` style entry
      // bouncing back as the upstream's response body). Redact every
      // message before it leaves the HubClient surface.
      let msg = redactToken(rawMsg, this.opts.adminToken)
      // Belt-and-braces: if the redactor missed something (e.g. a
      // future token format we didn't anticipate), fall back to a
      // generic stub rather than risk a leak.
      if (this.opts.adminToken && msg.includes(this.opts.adminToken)) {
        msg = `Hub returned ${r.status} for ${path} (details redacted)`
      }
      throw new HubClientError(msg, r.status, parsed)
    }
    return parsed as T
  }
}

// --- response shape echoes ---
// We don't import these from @aipehub/core so the MCP server stays a
// pure HTTP client with zero workspace deps. The fields we use are
// stable across v2.x; if they drift we'd notice in the integration smoke.

export interface HubState {
  participants: Array<{ id: string; kind: 'agent' | 'human'; capabilities: string[]; load: number }>
  transcript: Array<{ seq: number; ts: number; kind: string; data: unknown }>
  tasks?: Array<unknown>
  pendingApplications?: Array<unknown>
  known?: { admins: unknown[]; workers: unknown[] }
  config?: { defaultLang?: string }
}

export interface DispatchBody {
  // Mirrors the core `DispatchStrategy` union exactly. Pre-3.1 this
  // shape was hand-written and drifted from core — used `'direct'` /
  // `recipient` while core only ever accepted `'explicit'` / `to`.
  // Every dispatch from the MCP server therefore hit the scheduler's
  // unmatched-kind branch and hung the awaiting MCP tool call.
  strategy:
    | { kind: 'explicit'; to: string }
    | { kind: 'capability'; capabilities: string[] }
    | { kind: 'broadcast'; capabilities?: string[] }
  payload?: unknown
  title?: string
  weight?: number
  priority?: number
  countContribution?: boolean
}

export interface DispatchResult {
  ok: boolean
  result?: {
    kind: 'ok' | 'failed' | 'cancelled' | 'no_participant'
    taskId: string
    by?: string
    ts: number
    output?: unknown
    error?: string
    reason?: string
  }
  error?: string
}

export interface Leaderboard {
  from: number
  to: number
  rows: Array<{
    participantId: string
    taskCount: number
    totalWeight: number
    totalContribution: number
    averageRating: number
    lastActivityTs: number
    byCapability: Record<string, { count: number; contribution: number }>
  }>
  unratedTaskCount: number
  totalTaskCount: number
}
