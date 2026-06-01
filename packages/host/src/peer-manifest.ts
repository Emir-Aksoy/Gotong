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
 *
 * `'2'` (Phase 19 P4-M3): `capabilities` became rich descriptors
 * (`PeerCapability[]`) instead of bare `string[]`. The consumer normalises
 * BOTH, so a `'1'` peer (string list) still parses.
 */
export const PEER_MANIFEST_VERSION = '2'

/**
 * Phase 19 P4-M3 — one advertised capability as a rich descriptor. Only `id`
 * is guaranteed; the rest are optional metadata a hub MAY publish so a peer can
 * reason about WHAT a capability does, not just its name. `buildLocalManifest`
 * emits `{ id }` today (participants expose only capability strings); the richer
 * fields fill in as sources appear — e.g. P4-M4's data-class config populates
 * `dataClasses`, and workflow trigger schemas can later supply `inputSchema`.
 */
export interface PeerCapability {
  /** Capability id — the dispatch key. Always present. */
  id: string
  /** Optional semantic version of the capability's contract. */
  version?: string
  /** Optional descriptor of the expected task payload (JSON-schema-ish). */
  inputSchema?: unknown
  /** Optional descriptor of the result shape. */
  outputSchema?: unknown
  /** Optional free-form cost hint (e.g. `'low'`, `'~$0.01/call'`). */
  costHint?: string
  /** Optional data classes this capability handles (see P4-M4). */
  dataClasses?: string[]
}

/** A peer's advertised capabilities — the public face of a hub on the mesh. */
export interface PeerManifest {
  /** The advertising hub's self id (== `orgId` on the federation wire). */
  hubId: string
  /** Rich capability descriptors this hub's local participants serve (sorted by id). */
  capabilities: PeerCapability[]
  /** `PEER_MANIFEST_VERSION` at emit time. */
  protocolVersion: string
}

/**
 * Phase 19 P4-M3 — normalise a peer's advertised capabilities into rich
 * descriptors, accepting BOTH the new `PeerCapability[]` and a legacy `string[]`
 * (a `'1'`-manifest peer). Unknown / malformed entries are dropped; defensive
 * field typing keeps a hostile peer from injecting non-string ids or classes.
 */
export function normalizePeerCapabilities(raw: unknown): PeerCapability[] {
  if (!Array.isArray(raw)) return []
  const out: PeerCapability[] = []
  for (const item of raw) {
    if (typeof item === 'string') {
      out.push({ id: item })
      continue
    }
    if (item && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string') {
      const o = item as Record<string, unknown>
      const cap: PeerCapability = { id: o.id as string }
      if (typeof o.version === 'string') cap.version = o.version
      if (o.inputSchema !== undefined) cap.inputSchema = o.inputSchema
      if (o.outputSchema !== undefined) cap.outputSchema = o.outputSchema
      if (typeof o.costHint === 'string') cap.costHint = o.costHint
      if (Array.isArray(o.dataClasses)) {
        cap.dataClasses = o.dataClasses.filter((d): d is string => typeof d === 'string')
      }
      out.push(cap)
    }
    // else: drop a malformed entry rather than poison the whole manifest.
  }
  return out
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
  // Emit `{ id }` descriptors — the data participants actually expose. Richer
  // fields (version / schema / cost / dataClasses) fill in as sources appear.
  return {
    hubId,
    capabilities: [...caps].sort().map((id) => ({ id })),
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
  if (!out || typeof out !== 'object') return null
  // Normalise defensively: a `'1'` peer sends `capabilities: string[]`, a `'2'`
  // peer sends `PeerCapability[]`; both land as rich descriptors here.
  const raw = out as { hubId?: unknown; capabilities?: unknown; protocolVersion?: unknown }
  return {
    hubId: typeof raw.hubId === 'string' ? raw.hubId : '',
    capabilities: normalizePeerCapabilities(raw.capabilities),
    protocolVersion:
      typeof raw.protocolVersion === 'string' ? raw.protocolVersion : PEER_MANIFEST_VERSION,
  }
}

// ─── federation surface (host → admin UI, Phase 18 A-M2) ────────────────────

/** The slice of the host `PeerRegistry` the federation surface reads. */
export interface ManifestPeerRegistryView {
  status(): Array<{ peerId: ParticipantId; label: string | null; connected: boolean }>
  linkForHub(peerId: ParticipantId): HubLink | null
}

/** One peer's manifest row served to the admin UI (web mirrors this shape). */
export interface PeerManifestRow {
  /** Peer hub id. */
  peer: string
  /** Human label from the peers table, if any. */
  label: string | null
  /** Whether the peer link is connected right now. */
  online: boolean
  /**
   * A cached manifest exists but the peer is offline — its capabilities may
   * be out of date. (Online peers never read stale; an admin who wants the
   * freshest list clicks refresh.)
   */
  stale: boolean
  /** Advertised capability descriptors (empty when never fetched / nothing cached). */
  capabilities: PeerCapability[]
  /** Epoch ms of the last successful manifest fetch, or null if never. */
  lastFetchedAt: number | null
}

export interface PeerManifestFederation {
  /** Join the registry's live connection state with the manifest cache. */
  list(): Promise<PeerManifestRow[]>
  /** Refetch `peer.manifest` from connected peers (all, or one by id). */
  refresh(peerId?: string): Promise<void>
}

/**
 * Build the on-demand peer manifest federation surface: an in-process cache
 * (lost on restart BY DESIGN — "unknown until first refresh" is more honest
 * than serving a stale boot cache) over the peer registry. `list` joins the
 * registry's live connection state with the cache; `refresh` refetches from
 * connected peers and updates the cache, keeping the prior entry on a fetch
 * error so a transient blip doesn't blank the UI.
 */
export function createPeerManifestFederation(
  registry: ManifestPeerRegistryView,
  opts: {
    now?: () => number
    logger?: { warn?: (msg: string, meta?: Record<string, unknown>) => void }
  } = {},
): PeerManifestFederation {
  const now = opts.now ?? (() => Date.now())
  const cache = new Map<string, { manifest: PeerManifest; lastFetchedAt: number }>()
  return {
    async list() {
      return registry.status().map((row) => {
        const cached = cache.get(row.peerId)
        return {
          peer: row.peerId,
          label: row.label,
          online: row.connected,
          stale: cached ? !row.connected : false,
          capabilities: cached?.manifest.capabilities ?? [],
          lastFetchedAt: cached?.lastFetchedAt ?? null,
        }
      })
    },
    async refresh(peerId?: string) {
      const rows = registry
        .status()
        .filter((r) => r.connected && (peerId === undefined || r.peerId === peerId))
      await Promise.all(
        rows.map(async (row) => {
          const link = registry.linkForHub(row.peerId)
          if (!link) return
          try {
            const manifest = await fetchPeerManifest(link)
            if (manifest) cache.set(row.peerId, { manifest, lastFetchedAt: now() })
          } catch (err) {
            opts.logger?.warn?.('peer manifest: fetch failed', {
              peer: row.peerId,
              err: err instanceof Error ? err.message : String(err),
            })
          }
        }),
      )
    },
  }
}
