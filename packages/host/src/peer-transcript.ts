/**
 * Peer transcript — PROVIDER + consumer + per-link gate (v5 Stream G day-5).
 *
 * The cross-hub transcript CHAIN. When a hub's workflow step dispatches a task
 * over a peer link and the far hub's agent runs it, day-3 already shows the
 * caller WHO ran it (`executedBy`) and WHAT it returned. This closes the last
 * gap: on demand, fetch the far hub's transcript of THAT ONE task — its task,
 * result, the agent's actual LLM stream, and any resume markers — so the run
 * detail can chain the off-hub hop's execution trace instead of stopping at a
 * black box.
 *
 * The correlation key is `peerTaskId` (the id the far hub recorded the task
 * under in ITS OWN transcript), persisted on the workflow StepRecord (day-5 M1
 * stamps it pre-relabel; M2 records it). The caller passes it back here.
 *
 * Why this is GATED like `peer.summary` and not open like `peer.manifest`: a
 * manifest discloses capability NAMES an authenticated peer could already
 * dispatch; a transcript slice discloses the agent's actual work on a task —
 * more revealing than the summary's counts. So sharing is OPT-IN per link and
 * FAIL-CLOSED: `denyPeerTranscriptRpc` (applied by peer-registry) rejects
 * `peer.transcript` unless the peer row's `share_transcript` flag (identity v27)
 * is set. A hub that never flips it leaks nothing.
 *
 * Privacy scope — the slice carries ONLY the events of the ONE task the caller
 * dispatched (its task / result / llm_stream_chunk / task_resumed / evaluation,
 * matched by id). The far hub's OWN internal sub-dispatches run under DIFFERENT
 * task ids, so filtering by the single `taskId` excludes them by construction —
 * there is nowhere in the slice to put a neighbour's deeper hop. The caller
 * already sent the task payload and got the result; what's new is the trace.
 *
 * Wire contract — one method:
 *
 *   peer.transcript { taskId }  → PeerTranscriptSlice
 *
 * The link is authenticated (peerToken); this is mesh-internal, not the public
 * `/.well-known/agent-card.json`.
 */

import type { HubLink, TaskId, TranscriptEntry } from '@gotong/core'
import type { RpcResponder } from './peer-kb-gate.js'

/** Wire method names for the peer transcript (shared producer/consumer). */
export const PEER_TRANSCRIPT_METHODS = {
  get: 'peer.transcript',
} as const

/**
 * The transcript-slice schema version. Bumps when `PeerTranscriptSlice` changes
 * shape so a consumer can reason about an older peer's reply. Independent of the
 * summary / manifest / A2A protocol versions — this is the chain's own contract.
 */
export const PEER_TRANSCRIPT_VERSION = '1'

/**
 * Max events one slice carries. A task's trace is bounded by how chatty the
 * agent was (mostly `llm_stream_chunk` count); a generous default covers nearly
 * every real case. On overflow the slice keeps the chronological PREFIX and sets
 * `truncated` so the UI can say "see the peer directly for the full trace".
 */
const DEFAULT_EVENT_CAP = 1000

/** One transcript event in a slice — a thin, kind-tagged projection. */
export interface PeerTranscriptEvent {
  seq: number
  ts: number
  /** `task` | `task_result` | `llm_stream_chunk` | `task_resumed` | `evaluation`. */
  kind: string
  /** The entry's data, verbatim — the far hub's record of its own work on this task. */
  data: unknown
}

/** The far hub's transcript of one dispatched task. */
export interface PeerTranscriptSlice {
  /** The advertising hub's self id (== `orgId` on the federation wire). */
  hubId: string
  /** `PEER_TRANSCRIPT_VERSION` at emit time. */
  protocolVersion: string
  /** The task id the slice is for (the caller's `peerTaskId` handle). */
  taskId: string
  /** The matched events, chronological (ascending seq). */
  events: PeerTranscriptEvent[]
  /** True when the cap was hit and the trailing events were dropped. */
  truncated: boolean
  /** Epoch ms the slice was built — the only freshness signal. */
  generatedAt: number
}

// ─── producer side ──────────────────────────────────────────────────────────

/** The slice of `Hub` the producer reads (the real `Hub.transcript` satisfies it). */
export interface TranscriptHubView {
  transcript: { all(): TranscriptEntry[] }
}

/**
 * Extract the task id a transcript entry belongs to, or `null` when the entry
 * is not task-scoped. ONLY the five task-scoped kinds resolve to an id; every
 * other kind (messages, participant lifecycle, service calls, agent approvals)
 * returns null and is excluded from a slice. This is the privacy boundary: the
 * far hub's internal sub-dispatches carry DIFFERENT task ids, so a slice keyed
 * on one id can never include them.
 */
export function taskIdOfEntry(entry: TranscriptEntry): TaskId | null {
  switch (entry.kind) {
    case 'task':
      return entry.data.id
    case 'task_result':
      return entry.data.taskId
    case 'llm_stream_chunk':
      return entry.data.taskId
    case 'task_resumed':
      return entry.data.taskId
    case 'evaluation':
      return entry.data.taskId
    default:
      return null
  }
}

export interface BuildTranscriptSliceDeps {
  /** This hub's self id (stamped as `PeerTranscriptSlice.hubId`). */
  hubId: string
  hub: TranscriptHubView
  /** The task id to slice the transcript by. */
  taskId: TaskId
  /** Max events (default 1000). */
  cap?: number
  now?: () => number
}

/**
 * Build the transcript slice for one task. Best-effort: a transcript read that
 * throws leaves an empty slice rather than rejecting. Events are returned in
 * stored (seq-ascending) order; on overflow the chronological prefix is kept and
 * `truncated` is set.
 */
export function buildTaskTranscriptSlice(deps: BuildTranscriptSliceDeps): PeerTranscriptSlice {
  const now = deps.now ?? (() => Date.now())
  const cap = deps.cap && deps.cap > 0 ? deps.cap : DEFAULT_EVENT_CAP

  let all: TranscriptEntry[]
  try {
    all = deps.hub.transcript.all()
  } catch {
    all = []
  }

  const matched: PeerTranscriptEvent[] = []
  for (const e of all) {
    if (taskIdOfEntry(e) === deps.taskId) {
      matched.push({ seq: e.seq, ts: e.ts, kind: e.kind, data: (e as { data: unknown }).data })
    }
  }

  const truncated = matched.length > cap
  const events = truncated ? matched.slice(0, cap) : matched
  return {
    hubId: deps.hubId,
    protocolVersion: PEER_TRANSCRIPT_VERSION,
    taskId: deps.taskId,
    events,
    truncated,
    generatedAt: now(),
  }
}

export class PeerTranscriptHost {
  private readonly deps: { hubId: string; hub: TranscriptHubView; cap?: number; now?: () => number }

  constructor(deps: { hubId: string; hub: TranscriptHubView; cap?: number; now?: () => number }) {
    this.deps = deps
  }

  /**
   * Bound `rpcResponder` fragment, composed onto the host's single rpcResponder
   * alongside the MCP proxy + manifest + summary hosts. A throw here surfaces as
   * an rpc rejection on the calling peer.
   */
  readonly respond = async (call: { method: string; params: unknown }): Promise<unknown> => {
    switch (call.method) {
      case PEER_TRANSCRIPT_METHODS.get: {
        const taskId = (call.params as { taskId?: unknown } | null | undefined)?.taskId
        if (typeof taskId !== 'string' || taskId.length === 0) {
          throw new Error('peer.transcript requires a non-empty string taskId param')
        }
        return buildTaskTranscriptSlice({ ...this.deps, taskId: taskId as TaskId })
      }
      default:
        throw new Error(`unknown peer transcript method '${call.method}'`)
    }
  }
}

// ─── per-link gate ──────────────────────────────────────────────────────────

/**
 * The per-link transcript gate (pure function, like `denyPeerSummaryRpc`). Wrap
 * `inner` so `peer.transcript` is DENIED (throws → rpc rejection on the caller)
 * while every other method passes through untouched. The peer-registry applies
 * this ONLY when the row has NOT opted into sharing (`share_transcript` false /
 * unset), so the default — and any link that never flips the flag — is
 * fail-closed by omission of the share.
 */
export function denyPeerTranscriptRpc(inner: RpcResponder): RpcResponder {
  return async (call) => {
    if (call.method === PEER_TRANSCRIPT_METHODS.get) {
      throw new Error('peer transcript is not shared by this peer')
    }
    return inner(call)
  }
}

// ─── consumer side ──────────────────────────────────────────────────────────

/**
 * Coerce a peer's reply into a well-formed `PeerTranscriptSlice`, defending
 * against a hostile / older peer: a non-array `events` becomes `[]`, each event
 * is shape-checked, numeric fields fall back to 0. The fetching surface can
 * render these without per-event guards.
 */
export function normalizePeerTranscriptSlice(raw: unknown): PeerTranscriptSlice {
  const o = (raw ?? {}) as Record<string, unknown>
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

  const eventsRaw = Array.isArray(o.events) ? o.events : []
  const events: PeerTranscriptEvent[] = []
  for (const ev of eventsRaw) {
    if (!ev || typeof ev !== 'object') continue
    const e = ev as Record<string, unknown>
    events.push({
      seq: num(e.seq),
      ts: num(e.ts),
      kind: typeof e.kind === 'string' ? e.kind : 'unknown',
      data: e.data,
    })
  }

  return {
    hubId: typeof o.hubId === 'string' ? o.hubId : '',
    protocolVersion:
      typeof o.protocolVersion === 'string' ? o.protocolVersion : PEER_TRANSCRIPT_VERSION,
    taskId: typeof o.taskId === 'string' ? o.taskId : '',
    events,
    truncated: o.truncated === true,
    generatedAt: num(o.generatedAt),
  }
}

/**
 * Discovery (consumer side): ask a peer hub over its link for the transcript of
 * one task. Thin wrapper over the `peer.transcript` rpc — the caller decides
 * what to do when the link is closed, the call rejects (e.g. the peer hasn't
 * opted into sharing → the gate throws), or an older peer lacks the method.
 * Returns `null` when the peer answers nothing.
 */
export async function fetchPeerTranscript(
  link: HubLink,
  taskId: string,
): Promise<PeerTranscriptSlice | null> {
  const out = await link.rpc(PEER_TRANSCRIPT_METHODS.get, { taskId })
  if (!out || typeof out !== 'object') return null
  return normalizePeerTranscriptSlice(out)
}
