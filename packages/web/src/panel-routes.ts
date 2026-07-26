/**
 * panel-routes.ts — SDUI-M2/M3. The member panel's HTTP face.
 *
 *   GET /api/me/panel           →  { schemaVersion, config, source }
 *   PUT /api/me/panel           body { libraryId } | { reset: true }
 *   GET /api/me/panel/library   →  { panels: [{ id, title, description? }] }
 *
 *   PUT /api/admin/panel/users/:userId   same body — owner installs a shape
 *                                        for a member (fork D; the member can
 *                                        switch back any time via their own PUT)
 *
 * The config is the SDUI orchestration file. Every WRITE lands in the host
 * store's `setPanel` — the single `validatePanelConfig` choke point (web never
 * imports personal-butler; store errors surface via duck-typed `code`).
 * `source` on GET:
 *
 *   'default'   no per-member file — the built-in default panel
 *   'member'    the member's own stored config
 *   'fallback'  a stored config existed but was corrupt/invalid, so the
 *               default was served instead; the SPA shows a LOUD notice
 *               (file-first honesty: the reader degrades, never quarantines).
 *
 * The member write face is deliberately NARROW: {libraryId}|{reset} only —
 * free-form config PUT is not exposed over HTTP in M3 (the M4 butler tool
 * writes through the host store directly, same choke point). Duck-typed
 * surface (host `buildMePanelSurface` satisfies it) — web keeps zero host
 * runtime dependency (docs/zh/SURFACE-PATTERN.md). No surface wired → 503
 * (setting-ops posture). Auth: /api/me/* callers are resolved by
 * handleMeRoute's session gate (`userId` server-pinned); the admin route is
 * mounted behind server.ts `requireAdmin`.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import { readJsonBody, sendJson } from './http-helpers.js'

export interface MePanelResult {
  schemaVersion: number
  config: unknown
  source: 'default' | 'member' | 'fallback'
  /** SDUI-M4 attribution of the last mutation (host reads the undo slot).
   * `by:'butler'` drives the SPA's 「阿同调整了你的面板 [撤销]」 banner. */
  lastChange?: { by: 'butler' | 'human'; at: string }
}

export interface MePanelSurface {
  panel(userId: string): Promise<MePanelResult>
  resetPanel(userId: string): Promise<void>
  listLibrary(): Promise<{ id: string; title: string; description?: string }[]>
  applyLibrary(userId: string, libraryId: string): Promise<MePanelResult>
  /** SDUI-M4 one-slot undo (swap semantics; store throws duck `not_found`
   * when nothing was ever changed → 404). */
  restoreSnapshot(userId: string): Promise<MePanelResult>
}

export interface MePanelRouteDeps {
  panel: MePanelSurface | undefined
}

function storeErrorStatus(err: unknown): number {
  const code = (err as { code?: unknown } | null)?.code
  if (code === 'not_found') return 404
  if (code === 'invalid' || code === 'too_large') return 400
  return 500
}

/** Shared by the member and admin write faces:
 *  {libraryId} | {reset:true} | {restore:true} (M4 undo — banner's 撤销). */
async function applyPanelWrite(
  surface: MePanelSurface,
  req: IncomingMessage,
  res: ServerResponse,
  userId: string,
): Promise<void> {
  const body = (await readJsonBody(req).catch(() => null)) as
    | { libraryId?: unknown; reset?: unknown; restore?: unknown }
    | null
  try {
    if (body && body.restore === true) {
      sendJson(res, await surface.restoreSnapshot(userId))
      return
    }
    if (body && body.reset === true) {
      await surface.resetPanel(userId)
      sendJson(res, await surface.panel(userId))
      return
    }
    if (body && typeof body.libraryId === 'string' && body.libraryId.length > 0) {
      sendJson(res, await surface.applyLibrary(userId, body.libraryId))
      return
    }
    sendJson(res, { error: 'body must be { libraryId }, { reset: true } or { restore: true }' }, 400)
  } catch (err) {
    sendJson(
      res,
      { error: err instanceof Error ? err.message : String(err) },
      storeErrorStatus(err),
    )
  }
}

/** Returns true when the route was handled (mirrors handleMeWizardRoute). */
export async function handleMePanelRoute(
  deps: MePanelRouteDeps,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
  userId: string,
): Promise<boolean> {
  if (path !== '/api/me/panel' && path !== '/api/me/panel/library') return false
  if (!deps.panel) {
    sendJson(res, { error: 'panel surface not enabled on this host' }, 503)
    return true
  }
  try {
    if (path === '/api/me/panel/library') {
      if (method !== 'GET') {
        sendJson(res, { error: 'method not allowed' }, 405)
        return true
      }
      sendJson(res, { panels: await deps.panel.listLibrary() })
      return true
    }
    if (method === 'GET') {
      sendJson(res, await deps.panel.panel(userId))
      return true
    }
    if (method === 'PUT') {
      await applyPanelWrite(deps.panel, req, res, userId)
      return true
    }
    sendJson(res, { error: 'method not allowed' }, 405)
  } catch (err) {
    sendJson(res, { error: err instanceof Error ? err.message : String(err) }, 500)
  }
  return true
}

/**
 * Owner-installs-for-member (fork D). Mounted in server.ts BEHIND requireAdmin;
 * the target userId comes from the path. The store does not verify the user
 * exists — a stray id just leaves an orphan file the member never reads;
 * traversal is impossible (ownerDir runs assertSafeOwnerId).
 */
export async function handleAdminPanelRoute(
  deps: MePanelRouteDeps,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
): Promise<boolean> {
  const m = /^\/api\/admin\/panel\/users\/([^/]+)$/.exec(path)
  if (!m) return false
  if (method !== 'PUT') {
    sendJson(res, { error: 'method not allowed' }, 405)
    return true
  }
  if (!deps.panel) {
    sendJson(res, { error: 'panel surface not enabled on this host' }, 503)
    return true
  }
  await applyPanelWrite(deps.panel, req, res, decodeURIComponent(m[1]!))
  return true
}
