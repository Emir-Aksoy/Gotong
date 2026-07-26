/**
 * panel-routes.ts — SDUI-M2. The member panel's HTTP face.
 *
 * One route (for now — the M3 store adds PUT/install):
 *
 *   GET /api/me/panel   →  { schemaVersion, config, source }
 *
 * The config is the SDUI orchestration file (validated by
 * `@gotong/personal-butler` `validatePanelConfig` on every WRITE path — this
 * GET only projects what the host resolved). `source` tells the SPA how the
 * config was arrived at:
 *
 *   'default'   no per-member file — the built-in default panel
 *   'member'    the member's own stored config
 *   'fallback'  a stored config existed but was corrupt / wrong version, so
 *               the default was served instead; the SPA shows a LOUD notice
 *               (file-first honesty: quarantine + degrade, never blank).
 *
 * Duck-typed surface (host `buildMePanelSurface` satisfies it) — web keeps
 * zero host runtime dependency (docs/zh/SURFACE-PATTERN.md). No surface wired
 * → 503 and the SPA hides the panel tab content (setting-ops posture: don't
 * render a console that can't work). Auth: the caller is already resolved by
 * handleMeRoute's session gate; `userId` is server-pinned, never client input.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import { sendJson } from './http-helpers.js'

export interface MePanelSurface {
  panel(userId: string): Promise<{
    schemaVersion: number
    config: unknown
    source: 'default' | 'member' | 'fallback'
  }>
}

export interface MePanelRouteDeps {
  panel: MePanelSurface | undefined
}

/** Returns true when the route was handled (mirrors handleMeWizardRoute). */
export async function handleMePanelRoute(
  deps: MePanelRouteDeps,
  _req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
  userId: string,
): Promise<boolean> {
  if (path !== '/api/me/panel') return false
  if (method !== 'GET') {
    sendJson(res, { error: 'method not allowed' }, 405)
    return true
  }
  if (!deps.panel) {
    sendJson(res, { error: 'panel surface not enabled on this host' }, 503)
    return true
  }
  try {
    const out = await deps.panel.panel(userId)
    sendJson(res, out)
  } catch (err) {
    sendJson(res, { error: err instanceof Error ? err.message : String(err) }, 500)
  }
  return true
}
