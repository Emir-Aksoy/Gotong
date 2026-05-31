/**
 * Peer capability manifest — PROVIDER + consumer (Phase 18 A-M1).
 *
 * A peer hub asks "what capabilities do you offer?" over the same
 * authenticated HubLink RPC seam that already carries cross-hub MCP
 * (see `mcp-proxy.ts`). This host answers with the deduped capability list
 * of its LOCALLY-owned participants — deliberately EXCLUDING the
 * peer-wrapper participants (`RemoteHubViaLink`), so we advertise our own
 * agents and never re-advertise a neighbour's capabilities as ours.
 *
 * `PeerManifestHost.respond` is composed alongside `McpProxyHost.respond`
 * as the link's `rpcResponder` (peer-registry → installPeerLink): the host
 * routes `mcp.*` to the MCP proxy and everything else here (`main.ts`).
 *
 * Wire contract — one method:
 *
 *   peer.manifest { }  → PeerManifest
 *
 * Unlike the MCP proxy's `listShared` (which gates on a `shared` flag), the
 * manifest has no per-capability ACL: an authenticated peer that can already
 * dispatch a capability learns strictly less by seeing its name. The inbound
 * ACL (Track B) still governs what that peer may actually CALL. The link is
 * authenticated (peerToken) — this is mesh-internal discovery, not the
 * public `/.well-known/agent-card.json` (whose conservatism is about the
 * UNauthenticated A2A endpoint).
 */

import type { HubLink, Participant, ParticipantId } from '@aipehub/core'

/** Wire method names for the peer capability manifest (shared producer/consumer). */
export const PEER_MANIFEST_METHODS = {
  get: 'peer.manifest',
} as const

/**
 * The manifest schema version. Bumps when `PeerManifest` changes shape so a
 * consumer can reason about an older peer's reply. Independent of the A2A
 * protocol version — this is the AipeHub mesh's own discovery contract.
 */
export const PEER_MANIFEST_VERSION = '1'

/** A peer's advertised capabilities — the public face of a hub on the mesh. */
export interface PeerManifest {
  /** The advertising hub's self id (== `orgId` on the federation wire). */
  hubId: string
  /** Deduped, sorted capability ids this hub's local participants serve. */
  capabilities: string[]
  /** `PEER_MANIFEST_VERSION` at emit time. */
  protocolVersion: string
}

/** The slice of `Hub` that `buildLocalManifest` reads (tests inject a stub). */
export interface ManifestHubView {
  participants(): Participant[]
}

/**
 * Aggregate the capabilities of this hub's LOCALLY-owned participants.
 * `peerWrapperIds` are the ids of installed peer wrappers (`RemoteHubViaLink`,
 * registered under the peer's hub id) — excluded so we never re-advertise a
 * neighbour's capabilities as our own.
 */
export function buildLocalManifest(
  hub: ManifestHubView,
  hubId: string,
  peerWrapperIds: ReadonlySet<ParticipantId>,
): PeerManifest {
  const caps = new Set<string>()
  for (const p of hub.participants()) {
    if (peerWrapperIds.has(p.id)) continue
    for (const c of p.capabilities) caps.add(c)
  }
  return {
    hubId,
    capabilities: [...caps].sort(),
    protocolVersion: PEER_MANIFEST_VERSION,
  }
}

export interface PeerManifestHostOptions {
  hub: ManifestHubView
  /** This hub's self id (stamped as `PeerManifest.hubId`). */
  hubId: string
  /**
   * The set of installed peer-wrapper ids to exclude from the manifest. A
   * thunk so it reflects the registry's CURRENT peers on every call (peers
   * connect / disconnect over the host's lifetime).
   */
  peerWrapperIds: () => ReadonlySet<ParticipantId>
}

export class PeerManifestHost {
  private readonly hub: ManifestHubView
  private readonly hubId: string
  private readonly peerWrapperIds: () => ReadonlySet<ParticipantId>

  constructor(opts: PeerManifestHostOptions) {
    this.hub = opts.hub
    this.hubId = opts.hubId
    this.peerWrapperIds = opts.peerWrapperIds
  }

  /**
   * Bound `rpcResponder` fragment, composed with `McpProxyHost.respond`. A
   * throw here surfaces as an rpc rejection on the calling peer.
   */
  readonly respond = async (call: {
    method: string
    params: unknown
  }): Promise<unknown> => {
    switch (call.method) {
      case PEER_MANIFEST_METHODS.get:
        return buildLocalManifest(this.hub, this.hubId, this.peerWrapperIds())
      default:
        throw new Error(`unknown peer manifest method '${call.method}'`)
    }
  }
}

// ─── consumer side ──────────────────────────────────────────────────────────

/**
 * Discovery (consumer side): ask a peer hub over its link for its capability
 * manifest. Thin wrapper over the `peer.manifest` rpc — the caller decides
 * what to do when the link is closed / the call rejects (the aggregating
 * surface marks the peer stale). Returns `null` when the peer answers nothing
 * (e.g. an older peer without the method, after its rpc rejects upstream).
 */
export async function fetchPeerManifest(link: HubLink): Promise<PeerManifest | null> {
  const out = await link.rpc(PEER_MANIFEST_METHODS.get, {})
  return (out as PeerManifest) ?? null
}
