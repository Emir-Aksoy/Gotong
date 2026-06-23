/**
 * Admin routes for the hub-level MCP server registry (#2-M2).
 *
 * An MCP server installed here is persisted to the hub registry and
 * pushed live into every running agent that opts into it by name
 * (`useMcpServers`) — the host surface does the propagation via
 * LocalAgentPool. See docs/zh/MCP.md.
 *
 * Routes handled:
 *   GET    /api/admin/mcp-servers          list installed servers
 *   POST   /api/admin/mcp-servers          install / update one (+ `shared` toggle)
 *   DELETE /api/admin/mcp-servers/<name>   uninstall one
 *
 * Plus the cross-hub federation discovery route (#2-M3.4b), served by a
 * separate host-injected surface (the peer registry, not the local
 * registry):
 *
 *   GET    /api/admin/mcp-shared           browse peers' shared servers
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AdminRecord, HubMcpServerRecord, McpServerSpec } from '@aipehub/core'
import { createLogger } from '@aipehub/core'

import { BUILTIN_MCP_CONNECTORS } from './builtin-mcp-connectors.js'
import { readJsonBody, sendJson } from './http-helpers.js'
import { validateMcpServersArray, ManifestError } from './manifest.js'

const log = createLogger('mcp-routes')

/**
 * Host-injected registry surface (duck-typed; web has no dep on the
 * host's LocalAgentPool / Space). `install` persists + propagates;
 * `uninstall` returns false when the name wasn't installed.
 */
export interface McpRegistrySurface {
  list(): Promise<HubMcpServerRecord[]>
  /**
   * Install / upsert one server. `shared` is the cross-hub federation
   * toggle (#2-M3): `true` exposes it to peer hubs, `false` revokes,
   * `undefined` leaves the stored flag untouched (so re-installing to
   * change a command never silently un-shares).
   */
  install(spec: McpServerSpec, description?: string, shared?: boolean): Promise<HubMcpServerRecord>
  uninstall(name: string): Promise<boolean>
}

export interface McpRoutesCtx {
  mcpRegistry?: McpRegistrySurface
  requireAdmin: (req: IncomingMessage, res: ServerResponse) => Promise<AdminRecord | null>
}

/**
 * The public face of one server a peer shares (duck-typed mirror of the
 * host's `SharedMcpServerInfo` — web has no host dep). Name + optional
 * description only; the spec never crosses the federation link.
 */
export interface SharedMcpServerInfo {
  name: string
  description?: string
}

/** One peer's federation row in a `GET /api/admin/mcp-shared` reply. */
export interface PeerSharedMcp {
  /** Peer hub id — the `<peer>` segment of a `peer:server` ref. */
  peer: string
  /** Human label from the peers table, if any. */
  label: string | null
  /** Whether the peer link is connected right now. */
  online: boolean
  /** Servers the peer shares (empty when offline / it shares none). */
  servers: SharedMcpServerInfo[]
}

/**
 * Host-injected discovery surface for cross-hub MCP federation. Backed by
 * the peer registry + the `mcp.listShared` rpc — NOT the local registry.
 * Absent (→ 503) when peers are disabled.
 */
export interface McpFederationSurface {
  listPeerShared(): Promise<PeerSharedMcp[]>
}

export interface McpFederationRoutesCtx {
  mcpFederation?: McpFederationSurface
  requireAdmin: (req: IncomingMessage, res: ServerResponse) => Promise<AdminRecord | null>
}

const PREFIX = '/api/admin/mcp-servers'
const FED_PREFIX = '/api/admin/mcp-shared'
const CONNECTORS_PREFIX = '/api/admin/mcp-connectors'

/**
 * Handle `/api/admin/mcp-servers` routes. Returns `true` if the request
 * was handled, `false` otherwise.
 */
export async function handleMcpRoute(
  ctx: McpRoutesCtx,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
): Promise<boolean> {
  if (path !== PREFIX && !path.startsWith(`${PREFIX}/`)) return false

  const admin = await ctx.requireAdmin(req, res)
  if (!admin) return true
  if (!ctx.mcpRegistry) {
    sendJson(res, { error: 'MCP registry not enabled on this host' }, 503)
    return true
  }
  const surface = ctx.mcpRegistry

  // GET /api/admin/mcp-servers — list
  if (path === PREFIX && method === 'GET') {
    sendJson(res, { servers: await surface.list() })
    return true
  }

  // POST /api/admin/mcp-servers — install / update
  if (path === PREFIX && method === 'POST') {
    let body: { spec?: unknown; description?: unknown; shared?: unknown }
    try {
      body = (await readJsonBody(req)) as typeof body
    } catch {
      sendJson(res, { error: 'invalid JSON body' }, 400)
      return true
    }
    let spec: McpServerSpec
    try {
      // Reuse the manifest validator: validate a 1-element array and
      // take the single entry. Throws ManifestError on a bad shape.
      spec = validateMcpServersArray([body.spec], 'spec')[0]!
    } catch (err) {
      const msg = err instanceof ManifestError ? err.message : 'invalid server spec'
      sendJson(res, { error: msg }, 400)
      return true
    }
    if (body.description !== undefined && typeof body.description !== 'string') {
      sendJson(res, { error: 'description must be a string' }, 400)
      return true
    }
    if (body.shared !== undefined && typeof body.shared !== 'boolean') {
      sendJson(res, { error: 'shared must be a boolean' }, 400)
      return true
    }
    try {
      const stored = await surface.install(
        spec,
        body.description as string | undefined,
        body.shared as boolean | undefined,
      )
      log.info('mcp server installed', { by: admin.id, server: spec.name, shared: stored.shared === true })
      sendJson(res, { ok: true, server: stored })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error('mcp install failed', { by: admin.id, server: spec.name, err: msg })
      sendJson(res, { error: msg }, 500)
    }
    return true
  }

  // DELETE /api/admin/mcp-servers/<name> — uninstall
  if (path.startsWith(`${PREFIX}/`) && method === 'DELETE') {
    const name = decodeURIComponent(path.slice(PREFIX.length + 1))
    if (!name) {
      sendJson(res, { error: 'missing server name' }, 400)
      return true
    }
    try {
      const removed = await surface.uninstall(name)
      if (!removed) {
        sendJson(res, { error: `no MCP server named '${name}'` }, 404)
        return true
      }
      log.info('mcp server uninstalled', { by: admin.id, server: name })
      sendJson(res, { ok: true })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error('mcp uninstall failed', { by: admin.id, server: name, err: msg })
      sendJson(res, { error: msg }, 500)
    }
    return true
  }

  // Path matched the prefix but no method/shape did → 405.
  sendJson(res, { error: `method ${method} not allowed on ${path}` }, 405)
  return true
}

/**
 * Handle `GET /api/admin/mcp-shared` — browse the MCP servers shared by
 * connected peer hubs, so the admin can add a `peer:server` ref to an
 * agent by picking rather than typing. Returns `true` if handled.
 */
export async function handleMcpFederationRoute(
  ctx: McpFederationRoutesCtx,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
): Promise<boolean> {
  if (path !== FED_PREFIX) return false

  const admin = await ctx.requireAdmin(req, res)
  if (!admin) return true
  if (!ctx.mcpFederation) {
    sendJson(res, { error: 'MCP federation not enabled on this host' }, 503)
    return true
  }
  if (method !== 'GET') {
    sendJson(res, { error: `method ${method} not allowed on ${path}` }, 405)
    return true
  }
  try {
    const peers = await ctx.mcpFederation.listPeerShared()
    sendJson(res, { peers })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.error('mcp-shared list failed', { by: admin.id, err: msg })
    sendJson(res, { error: msg }, 500)
  }
  return true
}

/** Ctx for the built-in connector directory — admin gate only, no host surface. */
export interface McpConnectorsRoutesCtx {
  requireAdmin: (req: IncomingMessage, res: ServerResponse) => Promise<AdminRecord | null>
}

/**
 * Handle `GET /api/admin/mcp-connectors/catalog` — the built-in MCP connector
 * directory (MCD-M2). Pure web constant (`BUILTIN_MCP_CONNECTORS`), so unlike
 * the registry route there's NO host surface to inject and never a 503: the
 * directory is always available to browse. Installing one of these is the
 * existing `POST /api/admin/mcp-servers` route — the directory only suggests.
 *
 * Admin-gated like the rest of `/api/admin/*`: browsing the directory is the
 * front door to installing an MCP server, which is an operator action.
 */
export async function handleMcpConnectorsRoute(
  ctx: McpConnectorsRoutesCtx,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
): Promise<boolean> {
  if (path !== CONNECTORS_PREFIX && !path.startsWith(`${CONNECTORS_PREFIX}/`)) return false

  const admin = await ctx.requireAdmin(req, res)
  if (!admin) return true

  if (path === `${CONNECTORS_PREFIX}/catalog` && method === 'GET') {
    sendJson(res, { connectors: BUILTIN_MCP_CONNECTORS })
    return true
  }

  sendJson(res, { error: `method ${method} not allowed on ${path}` }, 405)
  return true
}
