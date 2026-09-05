/**
 * EXCH-M1 — member exchange-envelope routes (`/api/me/exchange*`), split out of
 * me-routes.ts (line-budget relief, panel-routes precedent).
 *
 * Two-step confirm: POST /preview is ZERO side-effect (parse + signature
 * verdict + replay lookup + eligible-target list); POST /import is the
 * confirmed step. The import target must resolve through the SAME
 * `resolveMeWorkflow` gate `/api/me/dispatch` uses (fail-closed: null → 403),
 * so an envelope can never reach a workflow this member's role could not
 * dispatch by hand. userId comes from the SESSION only — the service pins the
 * scope field to it; nothing in the request body can act as someone else.
 *
 * Catalog discipline (handleMeListWorkflows precedent): the member-facing
 * target list carries ONLY { workflowId, label }. The workflow's capability
 * and scope field are internal enforcement details — they are matched
 * server-side against the envelope, never surfaced.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readJsonBody, sendJson } from './http-helpers.js'

/** Duck view of the host's MeExchangeService (no host import — surface pattern). */
export interface MeExchangeSurface {
  preview(userId: string, raw: string, requestRaw?: string): Promise<{
    valid: boolean
    errors?: string[]
    summary?: { id: string; kind: string; title: string; capability?: string; [k: string]: unknown }
    signature?: unknown
    evidence?: unknown
    replay?: { imported: true; mine: boolean; status?: string }
    dispatchable: boolean
  }>
  importRequest(userId: string, args: {
    raw: string
    workflowId: string
    capability: string
    inputFieldIds: string[]
    userScopeField: string
    label: string
  }): Promise<{ id: string }>
  result(userId: string, id: string): Promise<
    | { status: 'not_found' }
    | { status: 'running'; importedAt: string }
    | { status: 'suspended'; importedAt: string; note: string }
    | { status: 'done'; resultId: string; envelope: string }
  >
}

/** The gate facts one resolved surface.me workflow hands the import. */
export interface MeExchangeWorkflowLike {
  workflowId: string
  capability: string
  label: string
  inputFieldIds: string[]
  userScopeField: string
}

export interface MeExchangeRouteDeps {
  exchange: MeExchangeSurface | undefined
  /** The /api/me/dispatch gate, verbatim: null = not runnable by this member. */
  resolveWorkflow: (workflowId: string) => Promise<MeExchangeWorkflowLike | null>
  /** Every workflow runnable by this member (for the preview target list). */
  listWorkflows: () => Promise<MeExchangeWorkflowLike[]>
  /** Shared me-routes rate limiter (429 on false). */
  limit: (action: string) => boolean
}

/** Duck view of the service's typed error (no host import). */
interface ExchangeErrorLike {
  name?: string
  code?: string
  message?: string
  errors?: string[]
  replayStatus?: string
}

const RESULT_RE = /^\/api\/me\/exchange\/([a-z0-9-]+)\/result$/

/** Returns true when the path was handled here. */
export async function handleMeExchangeRoute(
  deps: MeExchangeRouteDeps,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
  userId: string,
): Promise<boolean> {
  // Availability probe — the SPA hides the card when the host wired no surface.
  if (method === 'GET' && path === '/api/me/exchange') {
    sendJson(res, { available: deps.exchange !== undefined })
    return true
  }

  if (method === 'POST' && path === '/api/me/exchange/preview') {
    if (!deps.exchange) {
      sendJson(res, { error: '交付物导入未启用。', code: 'not_wired' }, 503)
      return true
    }
    if (!deps.limit('me-exchange')) {
      sendJson(res, { error: '操作太频繁了,过一会儿再试。', code: 'rate_limited' }, 429)
      return true
    }
    const body = (await readJsonBody(req).catch(() => null)) as { raw?: unknown; requestRaw?: unknown } | null
    const raw = body?.raw
    if (typeof raw !== 'string' || raw.length === 0) {
      sendJson(res, { error: 'raw (the envelope file text) is required', code: 'bad_request' }, 400)
      return true
    }
    if (body?.requestRaw !== undefined && typeof body.requestRaw !== 'string') {
      sendJson(res, { error: 'requestRaw must be a string', code: 'bad_request' }, 400)
      return true
    }
    const view = await deps.exchange.preview(userId, raw, body?.requestRaw as string | undefined)
    // Eligible import targets: workflows this member can run, narrowed to the
    // envelope's capability when it names one. Only id + label go out.
    let targets: Array<{ workflowId: string; label: string }> = []
    if (view.valid && view.dispatchable) {
      const cap = view.summary?.capability
      const all = await deps.listWorkflows().catch(() => [])
      targets = all
        .filter((w) => cap === undefined || w.capability === cap)
        .map((w) => ({ workflowId: w.workflowId, label: w.label }))
    }
    sendJson(res, { ...view, targets })
    return true
  }

  if (method === 'POST' && path === '/api/me/exchange/import') {
    if (!deps.exchange) {
      sendJson(res, { error: '交付物导入未启用。', code: 'not_wired' }, 503)
      return true
    }
    if (!deps.limit('me-exchange')) {
      sendJson(res, { error: '操作太频繁了,过一会儿再试。', code: 'rate_limited' }, 429)
      return true
    }
    const body = (await readJsonBody(req).catch(() => null)) as { raw?: unknown; workflowId?: unknown } | null
    const raw = body?.raw
    const workflowId = body?.workflowId
    if (typeof raw !== 'string' || raw.length === 0 || typeof workflowId !== 'string' || workflowId.length === 0) {
      sendJson(res, { error: 'raw and workflowId are required', code: 'bad_request' }, 400)
      return true
    }
    const wf = await deps.resolveWorkflow(workflowId)
    if (!wf) {
      // Same 403 the dispatch route gives: not published / not member-facing /
      // role excluded / unknown id are all indistinguishable (fail-closed).
      sendJson(res, { error: '这个工作流没有对你开放。', code: 'workflow_not_allowed' }, 403)
      return true
    }
    try {
      const { id } = await deps.exchange.importRequest(userId, {
        raw,
        workflowId: wf.workflowId,
        capability: wf.capability,
        inputFieldIds: wf.inputFieldIds,
        userScopeField: wf.userScopeField,
        label: wf.label,
      })
      sendJson(res, { ok: true, id })
    } catch (err) {
      const e = err as ExchangeErrorLike
      if (e?.name === 'ExchangeError') {
        if (e.code === 'replay') {
          sendJson(res, { error: '这份交付物已经导入过了。', code: 'replay', ...(e.replayStatus !== undefined ? { status: e.replayStatus } : {}) }, 409)
        } else {
          sendJson(res, { error: e.message ?? 'envelope rejected', code: e.code, ...(e.errors !== undefined ? { errors: e.errors } : {}) }, 400)
        }
        return true
      }
      throw err
    }
    return true
  }

  if (method === 'GET') {
    const m = RESULT_RE.exec(path)
    if (m) {
      if (!deps.exchange) {
        sendJson(res, { error: '交付物导入未启用。', code: 'not_wired' }, 503)
        return true
      }
      const view = await deps.exchange.result(userId, m[1]!)
      if (view.status === 'not_found') {
        sendJson(res, { error: 'not found', code: 'not_found' }, 404)
        return true
      }
      if (view.status === 'done' && new URL(req.url ?? '/', 'http://x').searchParams.get('download') === '1') {
        // The downloadable artifact is the EXACT archived result bytes — what
        // the member forwards back over IM.
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'content-disposition': `attachment; filename="${view.resultId}.json"`,
          'cache-control': 'no-store',
        })
        res.end(view.envelope)
        return true
      }
      sendJson(res, view)
      return true
    }
  }

  return false
}
