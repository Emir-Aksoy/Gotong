/**
 * Admin routes for cross-hub peer capability manifests (Phase 18 A-M2).
 *
 * A peer's manifest is the deduped capability list it advertises over the
 * authenticated mesh link (the `peer.manifest` rpc). These routes let the
 * admin browse what each connected peer offers and force an on-demand
 * refresh. Backed by a host-injected surface (the peer registry + an
 * in-process manifest cache) — web has no host dep, mirroring the
 * `mcp-shared` federation surface.
 *
 * Routes:
 *   GET  /api/admin/peer-manifests          list peers + cached manifests
 *   POST /api/admin/peer-manifests/refresh  refetch (body {peerId?}) → list
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AdminRecord } from '@aipehub/core'
import { createLogger } from '@aipehub/core'

import { readJsonBody, sendJson } from './http-helpers.js'

const log = createLogger('peer-routes')

/**
 * One peer's manifest row (duck-typed mirror of the host's `PeerManifestRow`
 * — web has no host dep). `stale` flags a cached-but-offline peer; an empty
 * `capabilities` + null `lastFetchedAt` means "never fetched" (unknown).
 */
export interface PeerManifestRow {
  peer: string
  label: string | null
  online: boolean
  stale: boolean
  capabilities: string[]
  lastFetchedAt: number | null
}

/**
 * Host-injected discovery surface for cross-hub peer manifests. Backed by
 * the peer registry + the `peer.manifest` rpc + an in-process cache — NOT a
 * persisted store. Absent (→ 503) when peers are disabled.
 */
export interface PeerManifestFederationSurface {
  list(): Promise<PeerManifestRow[]>
  refresh(peerId?: string): Promise<void>
}

export interface PeerManifestRoutesCtx {
  peerManifests?: PeerManifestFederationSurface
  requireAdmin: (req: IncomingMessage, res: ServerResponse) => Promise<AdminRecord | null>
}

const PREFIX = '/api/admin/peer-manifests'
const REFRESH = '/api/admin/peer-manifests/refresh'

/**
 * Handle the peer-manifest browse + refresh routes. Returns `true` if the
 * request was handled, `false` otherwise.
 */
export async function handlePeerManifestRoute(
  ctx: PeerManifestRoutesCtx,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
): Promise<boolean> {
  if (path !== PREFIX && path !== REFRESH) return false

  const admin = await ctx.requireAdmin(req, res)
  if (!admin) return true
  if (!ctx.peerManifests) {
    sendJson(res, { error: 'peer federation not enabled on this host' }, 503)
    return true
  }
  const surface = ctx.peerManifests

  // GET /api/admin/peer-manifests — list peers + cached manifests
  if (path === PREFIX && method === 'GET') {
    try {
      sendJson(res, { peers: await surface.list() })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error('peer-manifests list failed', { by: admin.id, err: msg })
      sendJson(res, { error: msg }, 500)
    }
    return true
  }

  // POST /api/admin/peer-manifests/refresh — refetch, then return the list
  if (path === REFRESH && method === 'POST') {
    let body: { peerId?: unknown }
    try {
      body = (await readJsonBody(req)) as typeof body
    } catch {
      // An empty / absent body means "refresh all" — tolerate it rather than
      // 400, since a refresh-all has no required parameters.
      body = {}
    }
    if (body.peerId !== undefined && typeof body.peerId !== 'string') {
      sendJson(res, { error: 'peerId must be a string' }, 400)
      return true
    }
    try {
      await surface.refresh(body.peerId as string | undefined)
      sendJson(res, { ok: true, peers: await surface.list() })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error('peer-manifests refresh failed', { by: admin.id, err: msg })
      sendJson(res, { error: msg }, 500)
    }
    return true
  }

  // Path matched a prefix but no method/shape did → 405.
  sendJson(res, { error: `method ${method} not allowed on ${path}` }, 405)
  return true
}
