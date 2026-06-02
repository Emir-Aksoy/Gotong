/**
 * v5 Stream C-M1 — the callable-knowledge-base gate.
 *
 * A federated peer reaches this hub's shared MCP servers (the B-stream
 * template "knowledge base" model: a KB slot == a shared MCP server) over the
 * link's rpc channel: `mcp.listShared` to discover, `mcp.listTools` /
 * `mcp.callTool` to use. Today a single peer-agnostic `McpProxyHost.respond`
 * answers all three and checks only `shared === true` — so ANY trusted peer
 * sees and calls EVERY shared server.
 *
 * The per-link contract's fourth dimension (alongside capabilities /
 * data-classes / quota) is WHICH shared servers a given peer may discover +
 * call. We enforce it by wrapping that shared responder per-link, keyed by the
 * server NAME — the only stable identifier that crosses the wire and the one
 * the KB template's slot name maps to one-for-one.
 *
 * This is a pure function (no hub / identity / io) so it unit-tests in
 * isolation, the same shape as `core/peer-acl.ts`. The peer-registry decides
 * WHEN to apply it (only when the row carries an explicit allowlist); a null
 * allowlist means "all callable" and is handled by NOT wrapping at all.
 */

import { MCP_PROXY_METHODS } from './mcp-proxy.js'

/** The `rpcResponder` shape `installPeerLink` consumes. */
export type RpcResponder = (call: {
  method: string
  params: unknown
}) => Promise<unknown>

/** Minimal `mcp.listShared` reply row — name is all the gate reads. */
interface NamedServer {
  name: string
}

/**
 * Wrap `inner` so a peer may only DISCOVER + CALL the shared MCP servers
 * (knowledge bases) named in `allowed`:
 *
 *   - `mcp.listShared`  → inner result, filtered to rows whose name ∈ allowed
 *                         (the peer never even learns the others exist)
 *   - `mcp.listTools` / `mcp.callTool` → denied (throw, surfaced as an rpc
 *                         rejection) when `params.server ∉ allowed`
 *   - every other method (`peer.manifest`, …) → passthrough, untouched
 *
 * `allowed` is an explicit list: `[]` denies all KB discovery + calls (a hard
 * lockdown). The peer-registry passes a null/undefined allowlist straight
 * through WITHOUT wrapping (→ all callable, the legacy default), so this
 * function is only ever invoked for the restrictive case.
 *
 * Filtering discovery rather than only blocking calls matters: a peer that
 * can't list a server can't be tempted to probe it, and the denial on
 * `callTool` is the fail-closed backstop for a peer that guesses a name.
 */
export function gateKnowledgeBaseRpc(
  inner: RpcResponder,
  allowed: readonly string[],
): RpcResponder {
  const allow = new Set(allowed)
  return async (call) => {
    switch (call.method) {
      case MCP_PROXY_METHODS.listShared: {
        const out = await inner(call)
        if (!Array.isArray(out)) return out
        return (out as NamedServer[]).filter(
          (r) => r != null && typeof r.name === 'string' && allow.has(r.name),
        )
      }
      case MCP_PROXY_METHODS.listTools:
      case MCP_PROXY_METHODS.callTool: {
        const server = (call.params as { server?: unknown } | null | undefined)
          ?.server
        if (typeof server !== 'string' || !allow.has(server)) {
          throw new Error(
            `knowledge base '${String(server)}' is not callable by this peer`,
          )
        }
        return inner(call)
      }
      default:
        return inner(call)
    }
  }
}
