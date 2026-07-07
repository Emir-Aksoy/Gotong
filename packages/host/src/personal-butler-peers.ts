/**
 * personal-butler-peers.ts — NET-M1. The resident butler's BENIGN network eye:
 * "这台 hub 互联了哪些别的 hub".
 *
 * The butler can see runs / helpers / usage (BE-M1) but is blind to the mesh —
 * a member asking "咱们连着爸爸的 hub 吗?" gets an improvised answer. This
 * toolset is the read-only projection that grounds it, and NET-M2's `ask_peer`
 * will resolve its targets against the SAME surface (one roster, no drift).
 *
 * ── Read-only, org-level, sanitized ──────────────────────────────────────────
 * Peer topology is an org-level fact (BE-M1 precedent: "hub-wide but
 * sanitized"), so every member's butler sees the same roster. The sanitize
 * red line: `endpointUrl` / tokens / ACL / quota detail NEVER enter the
 * projection — a member should see that an edge exists and what it permits,
 * not the operator's wiring. Enforced structurally: the projection row has no
 * such fields, and the renderer only reads the fields it knows.
 *
 * ── The outbound posture is the honest payload ───────────────────────────────
 * Per edge we render `outboundCaps` with its REAL semantics (peer-acl.ts +
 * peer-registry G-M1, advertise = authorize):
 *   - `null`  → 未策展 — the ACL would allow anything, but the wrapper
 *               advertises NOTHING, so no locally-initiated ask can route to
 *               this edge until an admin curates outboundCaps. Rendering it
 *               as "可以直接发" would be a lie the member acts on.
 *   - `[]`    → 锁死 — a deliberate "send nothing" lockdown.
 *   - `[...]` → 白名单 — capability-addressed; the same list both routes and
 *               authorizes. This is the ONLY posture ask_peer can use.
 * That is exactly what a member needs to know before asking the butler to
 * reach the other side.
 */

import type {
  LlmAgentToolset,
  LlmToolCallResult,
  LlmToolDefinition,
} from '@gotong/llm'

/** One mesh edge, projected member-safe (no endpoint / token / ACL detail). */
export interface ButlerPeerRow {
  peerId: string
  label: string | null
  connected: boolean
  /** Liveness epoch-ms while connected; null when offline / untracked. */
  lastSeenAt: number | null
  /** Outbound posture: null = 未策展 / [] = 锁死 / list = 白名单(即广告). */
  outboundCaps: string[] | null
}

/** The roster the toolset (and NET-M2's target check) reads. */
export interface ButlerPeerSurface {
  listForButler(): Promise<ButlerPeerRow[]>
}

/**
 * The two narrow host inputs the surface joins — duck-typed slices of
 * `PeerRegistry.status()` and `identity.listPeers()`, so the module needs no
 * host/identity import and unit tests need no real registry.
 */
export interface ButlerPeerSurfaceDeps {
  status: () => Array<{
    peerRowId: string
    peerId: string
    label: string | null
    connected: boolean
    lastSeenAt: number | null
  }>
  rows: () => Array<{
    id: string
    enabled: boolean
    revocationState: string
    outboundCaps: string[] | null
  }>
}

/**
 * Join live registry status with the persisted trust rows into the member-safe
 * roster. Disabled / revoked edges are dropped — an edge the operator turned
 * off must not be offered as a reachable destination.
 */
export function buildButlerPeerSurface(deps: ButlerPeerSurfaceDeps): ButlerPeerSurface {
  return {
    async listForButler() {
      const byRowId = new Map(deps.rows().map((r) => [r.id, r]))
      const out: ButlerPeerRow[] = []
      for (const s of deps.status()) {
        const row = byRowId.get(s.peerRowId)
        if (!row || !row.enabled || row.revocationState !== 'active') continue
        out.push({
          peerId: s.peerId,
          label: s.label,
          connected: s.connected,
          lastSeenAt: s.lastSeenAt,
          // Copy defensively — the projection must never alias a mutable
          // identity row (and never carry fields beyond the declared shape).
          outboundCaps: row.outboundCaps ? [...row.outboundCaps] : null,
        })
      }
      return out
    },
  }
}

const LIST_TOOL: LlmToolDefinition = {
  name: 'list_peers',
  description:
    '看这台 hub 互联了哪些别的 hub(对端 id、名字、在线状态、这条边允许我们发过去什么)。成员问「咱们连着谁」「能不能联系到 XX 的 hub」时先用它。',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
}

export interface ButlerPeersDeps {
  peers: ButlerPeerSurface
  logger?: { error: (msg: string, meta?: Record<string, unknown>) => void }
}

class ButlerPeersToolset implements LlmAgentToolset {
  constructor(private readonly deps: ButlerPeersDeps) {}

  listTools(): LlmToolDefinition[] {
    return [LIST_TOOL]
  }

  async callTool(name: string): Promise<LlmToolCallResult> {
    if (name !== 'list_peers') return text(`未知工具:${name}`, true)
    let rows: ButlerPeerRow[]
    try {
      rows = await this.deps.peers.listForButler()
    } catch (err) {
      this.deps.logger?.error('butler peers: list failed', { err })
      return text('暂时读不到互联列表,稍后再试。', true)
    }
    if (rows.length === 0) return text('这台 hub 还没有互联任何对端 hub。')
    const lines = rows.map((r) => {
      const name = r.label ? `${r.peerId}(${r.label})` : r.peerId
      const state = r.connected ? '在线' : '离线'
      return `- ${name} — ${state};${capsLine(r.outboundCaps)}`
    })
    return text(`互联的 hub(${rows.length} 个):\n${lines.join('\n')}`)
  }
}

/** Render the outbound posture with its real semantics — never invent a fourth state. */
function capsLine(caps: string[] | null): string {
  if (caps === null) return '出站未策展(还派不了请求,要用得先请管理员配置可出站能力)'
  if (caps.length === 0) return '出站已锁死(这条边现在什么都不能发)'
  return `可请求能力:${caps.join('、')}`
}

function text(t: string, isError = false): LlmToolCallResult {
  return isError ? { content: [{ type: 'text', text: t }], isError: true } : { content: [{ type: 'text', text: t }] }
}

/**
 * Build the benign network eye. Add to the butler's `benign` set; the factory
 * drops it when the roster surface is absent (peer registry not wired).
 */
export function buildButlerPeersToolset(deps: ButlerPeersDeps): LlmAgentToolset {
  return new ButlerPeersToolset(deps)
}
