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
 * (peer-registry → installPeerLink). The wire contract is three methods:
 *
 *   mcp.listShared { }                        → SharedMcpServerInfo[]
 *   mcp.listTools  { server }                 → LlmToolDefinition[]
 *   mcp.callTool   { server, name, args }     → LlmToolCallResult
 *
 * `listShared` is the discovery call: it returns the NAMES (+ optional
 * descriptions) of this hub's shared servers so a peer can browse them
 * before referencing one. It deliberately omits the spec — transport,
 * command, url, env all stay home; a peer never learns how a tool is
 * wired, only that it exists.
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

import type { HubLink, HubMcpServerRecord } from '@aipehub/core'
import { McpToolset, type McpServerConfig } from '@aipehub/mcp-client'
import type {
  LlmAgentToolset,
  LlmToolCallResult,
  LlmToolDefinition,
} from '@aipehub/llm'

import {
  resolveMcpServerConfig,
  envSecretSource,
  type SecretSource,
} from './mcp-config.js'

/** Wire method names for the cross-hub MCP proxy (shared with the consumer). */
export const MCP_PROXY_METHODS = {
  listShared: 'mcp.listShared',
  listTools: 'mcp.listTools',
  callTool: 'mcp.callTool',
} as const

/**
 * One entry in a `mcp.listShared` reply: the public face of a shared
 * server. Name + description only — never the spec (no credentials, no
 * internal command / url / path crosses the link).
 */
export interface SharedMcpServerInfo {
  name: string
  description?: string
}

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
      case MCP_PROXY_METHODS.listShared: {
        // Discovery: just the public face of every shared server. No ACL
        // beyond `shared` itself (an authenticated peer may already call
        // these tools — knowing their names is strictly less) and no spec.
        const records = await this.space.mcpServers()
        return records
          .filter((r) => r.shared === true)
          .map((r): SharedMcpServerInfo => ({
            name: r.spec.name,
            ...(r.description ? { description: r.description } : {}),
          }))
      }
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

// ─── consumer side ──────────────────────────────────────────────────────────

/**
 * A remote MCP reference written in an agent's `useMcpServers`, of the
 * form `<peer>:<server>` (e.g. `hub_a1b2c3d4:filesystem`) — "use the
 * server `filesystem` shared by peer hub `hub_a1b2c3d4`". A bare name
 * (no colon) is a LOCAL registry server and is NOT a remote ref.
 */
export interface RemoteMcpRef {
  peer: string
  server: string
}

/**
 * Parse a `useMcpServers` entry into a remote ref, or null when it's a
 * bare (local) name. Splits on the FIRST colon so the peer segment is
 * everything before it; the server segment must be non-empty.
 */
export function parseRemoteMcpRef(name: string): RemoteMcpRef | null {
  const idx = name.indexOf(':')
  if (idx < 1) return null
  const peer = name.slice(0, idx)
  const server = name.slice(idx + 1)
  if (!peer || !server) return null
  return { peer, server }
}

/**
 * Discovery (consumer side): ask a peer hub over its link which MCP
 * servers it shares. Thin wrapper over the `mcp.listShared` rpc — the
 * caller decides what to do when the link is closed / the call rejects
 * (the aggregating route skips offline peers). Returns [] when the peer
 * answers with nothing.
 */
export async function fetchPeerSharedMcp(link: HubLink): Promise<SharedMcpServerInfo[]> {
  const out = await link.rpc(MCP_PROXY_METHODS.listShared, {})
  return (out as SharedMcpServerInfo[]) ?? []
}

/**
 * Cross-hub MCP proxy — CONSUMER side (#2-M3.3). An `LlmAgentToolset`
 * whose `listTools` / `callTool` forward over the federation link to a
 * server shared by a peer hub. The agent sees the peer's tools exactly
 * as if they were local; the credentials / subprocess stay on the peer.
 *
 * The peer link is resolved LAZILY per call (peers connect/reconnect
 * asynchronously) — when it's absent or not open, `listTools` returns []
 * (so a momentarily-offline peer just contributes no tools that round)
 * and `callTool` returns an `isError` result (so the LLM sees a tool
 * failure rather than the whole task throwing).
 */
export class RemoteMcpToolset implements LlmAgentToolset {
  private readonly peer: string
  private readonly server: string
  private readonly resolveLink: (peerId: string) => HubLink | null
  private readonly logger?: { warn?: (msg: string, meta?: Record<string, unknown>) => void }

  constructor(opts: {
    /** Peer hub id (the `<peer>` segment of the ref). */
    peer: string
    /** Server name AS KNOWN ON THE PEER (the `<server>` segment). */
    server: string
    /** Lazy peer-link lookup; typically `peerRegistry.linkForHub`. */
    resolveLink: (peerId: string) => HubLink | null
    logger?: { warn?: (msg: string, meta?: Record<string, unknown>) => void }
  }) {
    this.peer = opts.peer
    this.server = opts.server
    this.resolveLink = opts.resolveLink
    this.logger = opts.logger
  }

  private openLink(): HubLink | null {
    const link = this.resolveLink(this.peer)
    return link && link.status === 'open' ? link : null
  }

  async listTools(): Promise<LlmToolDefinition[]> {
    const link = this.openLink()
    if (!link) return [] // peer offline → no remote tools this round
    try {
      const tools = await link.rpc(MCP_PROXY_METHODS.listTools, { server: this.server })
      return (tools as LlmToolDefinition[]) ?? []
    } catch (err) {
      this.logger?.warn?.('remote mcp listTools failed', {
        peer: this.peer,
        server: this.server,
        err: err instanceof Error ? err.message : String(err),
      })
      return []
    }
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<LlmToolCallResult> {
    const link = this.openLink()
    if (!link) {
      return {
        content: [{ type: 'text', text: `peer '${this.peer}' is offline` }],
        isError: true,
      }
    }
    try {
      const out = await link.rpc(MCP_PROXY_METHODS.callTool, {
        server: this.server,
        name,
        args,
      })
      return out as LlmToolCallResult
    } catch (err) {
      return {
        content: [
          {
            type: 'text',
            text: `remote tool '${name}' on '${this.peer}:${this.server}' failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          },
        ],
        isError: true,
      }
    }
  }
}
