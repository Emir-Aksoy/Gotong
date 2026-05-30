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
 *   POST   /api/admin/mcp-servers          install / update one
 *   DELETE /api/admin/mcp-servers/<name>   uninstall one
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AdminRecord, HubMcpServerRecord, McpServerSpec } from '@aipehub/core'
import { createLogger } from '@aipehub/core'

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
  install(spec: McpServerSpec, description?: string): Promise<HubMcpServerRecord>
  uninstall(name: string): Promise<boolean>
}

export interface McpRoutesCtx {
  mcpRegistry?: McpRegistrySurface
  requireAdmin: (req: IncomingMessage, res: ServerResponse) => Promise<AdminRecord | null>
}

const PREFIX = '/api/admin/mcp-servers'

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
    let body: { spec?: unknown; description?: unknown }
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
    try {
      const stored = await surface.install(spec, body.description as string | undefined)
      log.info('mcp server installed', { by: admin.id, server: spec.name })
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
