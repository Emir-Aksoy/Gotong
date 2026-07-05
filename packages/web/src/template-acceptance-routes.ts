/**
 * FDE-M2 — admin routes for golden-run acceptance of installed packs.
 *
 *   GET  /api/admin/templates/acceptance
 *     → { packs: [{ pack, installedAt, cases: [...] }] }
 *   POST /api/admin/templates/acceptance/:pack/run
 *     body: { caseId? }                 // absent = run every case in the pack
 *     → { ok, report: { pack, ranBy, allGreen, results: [...] } }
 *
 * The heavy lifting (member gate + dispatch-await + zero-LLM judging) lives
 * host-side in `createTemplateAcceptanceService`; this module is only the
 * HTTP seam over the injected duck surface (Surface pattern — web never
 * imports host). Absent surface → 503 and the panel hides, same contract as
 * resourceInventory / workflowWizard.
 *
 * The run executes AS THE CALLING ADMIN (their id is forced into the
 * workflow's member-scope key by the service) — acceptance can never do what
 * the caller couldn't do by clicking "run" in /me themselves. That's also why
 * there is no userId in the request body: identity comes from the session,
 * never from a payload.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import type { AdminRecord } from '@gotong/core'

import { readJsonBody, sendJson } from './http-helpers.js'

const LIST_PATH = '/api/admin/templates/acceptance'
const RUN_RE = /^\/api\/admin\/templates\/acceptance\/([^/]+)\/run$/

/**
 * Duck-typed surface the host injects (`createTemplateAcceptanceService`
 * satisfies it structurally). One object serves two consumers: the import
 * route records through the narrower `AcceptanceCaseSink` slice
 * (agents-routes.ts), these routes list + run.
 */
export interface TemplateAcceptanceSurface {
  record(
    pack: string,
    cases: readonly {
      id: string
      workflowId: string
      trigger: Record<string, unknown>
      assert: { sections?: string[]; contains?: string[]; forbid?: string[]; maxBytes?: number }
      note?: string
    }[],
  ): Promise<void>
  list(): Promise<
    readonly {
      pack: string
      installedAt: string
      cases: readonly {
        id: string
        workflowId: string
        trigger: Record<string, unknown>
        assert: Record<string, unknown>
        note?: string
      }[]
    }[]
  >
  run(
    pack: string,
    opts: { userId: string; caseId?: string },
  ): Promise<{
    pack: string
    ranBy: string
    allGreen: boolean
    /** Verdict rows, passed through to JSON verbatim (host owns the shape). */
    results: readonly unknown[]
  }>
}

export interface TemplateAcceptanceRoutesCtx {
  templateAcceptance: TemplateAcceptanceSurface | undefined
  requireAdmin(req: IncomingMessage, res: ServerResponse): Promise<AdminRecord | null>
}

export async function handleTemplateAcceptanceRoute(
  ctx: TemplateAcceptanceRoutesCtx,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
): Promise<boolean> {
  const runMatch = path === LIST_PATH ? null : RUN_RE.exec(path)
  if (path !== LIST_PATH && !runMatch) return false

  const admin = await ctx.requireAdmin(req, res)
  if (!admin) return true
  if (!ctx.templateAcceptance) {
    sendJson(res, { error: 'template acceptance not enabled on this host' }, 503)
    return true
  }

  if (path === LIST_PATH) {
    if (method !== 'GET') {
      sendJson(res, { error: `method ${method} not allowed on ${path}` }, 405)
      return true
    }
    sendJson(res, { packs: await ctx.templateAcceptance.list() })
    return true
  }

  // POST .../:pack/run
  if (method !== 'POST') {
    sendJson(res, { error: `method ${method} not allowed on ${path}` }, 405)
    return true
  }
  const pack = decodeURIComponent(runMatch![1]!)
  // readJsonBody RESOLVES undefined for an empty body (only malformed JSON
  // rejects) — the ?? matters or a body-less POST dies on `.caseId` below.
  const body = (await readJsonBody(req).catch(() => ({}))) ?? {}
  const caseIdRaw = (body as Record<string, unknown>).caseId
  if (caseIdRaw !== undefined && typeof caseIdRaw !== 'string') {
    sendJson(res, { error: 'caseId must be a string when present' }, 400)
    return true
  }
  try {
    const report = await ctx.templateAcceptance.run(pack, {
      // The session identity, never a payload field — see file header.
      userId: admin.id,
      ...(caseIdRaw !== undefined ? { caseId: caseIdRaw } : {}),
    })
    sendJson(res, { ok: true, report })
  } catch (err) {
    // Duck-typed host error (web never imports host classes): unknown
    // pack/case → 404; anything else is a real fault → 500.
    if ((err as { code?: string })?.code === 'acceptance_not_found') {
      sendJson(res, { error: err instanceof Error ? err.message : 'not found' }, 404)
    } else {
      sendJson(
        res,
        { error: err instanceof Error ? err.message : 'acceptance run failed' },
        500,
      )
    }
  }
  return true
}
