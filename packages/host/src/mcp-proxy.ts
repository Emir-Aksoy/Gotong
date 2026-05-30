/**
 * Cross-hub MCP proxy — PROVIDER side (#2-M3.2).
 *
 * Hub A installs an MCP server, marks it `shared`, and exposes its tools
 * to authenticated peer hubs WITHOUT the credentials / subprocess ever
 * leaving A ("凭证各归各家"). A peer's agent calls the tools over the
 * federation link via the generic HubLink RPC seam (M3.1); this host
 * answers those calls.
 *
 * `McpProxyHost.respond` is wired as the link's `rpcResponder`
 * (peer-registry → installPeerLink). The wire contract is two methods:
 *
 *   mcp.listTools  { server }                 → LlmToolDefinition[]
 *   mcp.callTool   { server, name, args }     → LlmToolCallResult
 *
 * ACL: a call resolves a server only when a registry record with that
 * name exists AND has `shared: true`. The check runs on EVERY call (a
 * cheap registry read) so an un-share / uninstall takes effect at once,
 * even for an already-connected (cached) toolset. Credentials are
 * expanded here, locally, via `resolveMcpServerConfig` + this host's
 * SecretSource — the peer never sees a `${ENV}` value.
 *
 * The toolset per shared server is built lazily and cached (one stdio
 * subprocess / http client per shared server, reused across calls and
 * across peers). `close()` disconnects them all on shutdown.
 */

import type { HubMcpServerRecord } from '@aipehub/core'
import { McpToolset, type McpServerConfig } from '@aipehub/mcp-client'
import type { LlmAgentToolset } from '@aipehub/llm'

import {
  resolveMcpServerConfig,
  envSecretSource,
  type SecretSource,
} from './mcp-config.js'

/** Wire method names for the cross-hub MCP proxy (shared with the consumer). */
export const MCP_PROXY_METHODS = {
  listTools: 'mcp.listTools',
  callTool: 'mcp.callTool',
} as const

export interface McpListToolsParams {
  server: string
}
export interface McpCallToolParams {
  server: string
  name: string
  args?: Record<string, unknown>
}

/**
 * The slice of `McpToolset` the proxy depends on. `McpToolset` satisfies
 * it; tests inject a stub so they don't spawn a real subprocess.
 */
export interface ProxyToolset extends LlmAgentToolset {
  connect?(): Promise<void>
  disconnect?(): Promise<void>
}

export interface McpProxyHostOptions {
  /** Reads the hub registry to resolve + ACL-check shared servers. */
  space: { mcpServers(): Promise<HubMcpServerRecord[]> }
  /** Secret source for `${ENV}` expansion; defaults to process.env. */
  secrets?: SecretSource
  /** Injectable; defaults to a real (single-server) `McpToolset`. */
  toolsetFactory?: (config: McpServerConfig) => ProxyToolset
  /** Optional structured logger (warn used for evictions). */
  logger?: { warn?: (msg: string, meta?: Record<string, unknown>) => void }
}

const defaultToolsetFactory = (config: McpServerConfig): ProxyToolset =>
  new McpToolset({ servers: [config] })

export class McpProxyHost {
  private readonly space: McpProxyHostOptions['space']
  private readonly secrets: SecretSource
  private readonly toolsetFactory: (config: McpServerConfig) => ProxyToolset
  private readonly logger?: McpProxyHostOptions['logger']
  /** server name → connected toolset (lazy, reused across calls/peers). */
  private readonly cache = new Map<string, ProxyToolset>()

  constructor(opts: McpProxyHostOptions) {
    this.space = opts.space
    this.secrets = opts.secrets ?? envSecretSource
    this.toolsetFactory = opts.toolsetFactory ?? defaultToolsetFactory
    this.logger = opts.logger
  }

  /**
   * Bound `rpcResponder` to hand to `installPeerLink`. A throw here
   * surfaces as an rpc rejection on the calling peer.
   */
  readonly respond = async (call: {
    method: string
    params: unknown
  }): Promise<unknown> => {
    switch (call.method) {
      case MCP_PROXY_METHODS.listTools: {
        const { server } = call.params as McpListToolsParams
        const ts = await this.toolsetFor(server)
        return ts.listTools()
      }
      case MCP_PROXY_METHODS.callTool: {
        const { server, name, args } = call.params as McpCallToolParams
        if (typeof name !== 'string' || name.length === 0) {
          throw new Error('mcp.callTool requires a tool name')
        }
        const ts = await this.toolsetFor(server)
        return ts.callTool(name, args ?? {})
      }
      default:
        throw new Error(`unknown mcp proxy method '${call.method}'`)
    }
  }

  /**
   * Resolve a shared server's toolset, (re)checking the ACL each call.
   * Throws on unknown / not-shared (and evicts a now-stale cache entry).
   */
  private async toolsetFor(serverName: string): Promise<ProxyToolset> {
    if (typeof serverName !== 'string' || serverName.length === 0) {
      throw new Error('mcp proxy call missing a server name')
    }
    const records = await this.space.mcpServers()
    const rec = records.find((r) => r.spec.name === serverName)
    if (!rec || !rec.shared) {
      // ACL no longer holds (uninstalled or un-shared) — drop any cached
      // toolset so a later re-share starts a fresh connection.
      await this.evict(serverName)
      throw new Error(
        rec
          ? `mcp server '${serverName}' is not shared with peers`
          : `mcp server '${serverName}' not found`,
      )
    }
    const cached = this.cache.get(serverName)
    if (cached) return cached
    const config = resolveMcpServerConfig(rec.spec, this.secrets)
    const ts = this.toolsetFactory(config)
    if (ts.connect) await ts.connect()
    this.cache.set(serverName, ts)
    return ts
  }

  private async evict(serverName: string): Promise<void> {
    const ts = this.cache.get(serverName)
    if (!ts) return
    this.cache.delete(serverName)
    try {
      if (ts.disconnect) await ts.disconnect()
    } catch (err) {
      this.logger?.warn?.('mcp proxy: toolset disconnect failed on evict', {
        server: serverName,
        err: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /** Disconnect every cached toolset. Call on host shutdown. */
  async close(): Promise<void> {
    const names = [...this.cache.keys()]
    for (const name of names) {
      await this.evict(name)
    }
  }
}
