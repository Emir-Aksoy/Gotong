/**
 * Checkpoint primitives for the ACP adapter — the INTERCEPT / HANDOFF / RESUME
 * control seams from AGENT-ADAPTER-CONTRACT.
 *
 * Pure policy + state types + a permission gate. The only runtime import is the
 * `TaskId` TYPE from core, so this stays a core-only leaf. The participant
 * (`acp-participant.ts`) imports these and wires the session's permission reverse
 * requests into park / resume.
 *
 * The model differs from cli-checkpoint in two ways:
 *   1. The gate is THREE-way. A cli action gate is pre-spawn (allow / park). An
 *      ACP permission can be answered RIGHT THEN — so the verdict is allow inline,
 *      DENY inline (fail-closed, the agent is refused without bothering a human),
 *      or ESCALATE to a human (park).
 *   2. The carried state references an in-memory `permissionToken`, NOT a
 *      re-runnable transcript. A cli park can be replayed by a fresh process; an
 *      ACP park rides an OPEN reverse request on a still-blocked subprocess, so
 *      resume must re-find that live handle by token. This is why an ACP park does
 *      NOT survive a hub restart — see the package README's durability boundary.
 */

import type { TaskId } from '@aipehub/core'

import type { AcpPermissionOption, AcpToolCall } from './acp-protocol.js'

/**
 * Sentinel `resumeAt` meaning "never auto-resume" — same value the inbox uses,
 * duplicated locally so this leaf stays core-only. A permission park is woken only
 * by a human decision (`hub.resumeTask`), never the 30s sweep, so its `resumeAt`
 * must sit beyond any real clock.
 */
export const ACP_NEVER_RESUME_AT = 9_999_999_999_000

/** Schema version for the carried checkpoint state (forward-safety). */
export const ACP_CHECKPOINT_STATE_V = 1

/** Why an ACP task parked. (One kind today; an enum for forward-safety.) */
export type AcpParkKind = 'permission'

/** The tool the agent wants to run, distilled for a human + the gate. */
export interface AcpToolContext {
  taskId: TaskId
  /** Agent-defined, e.g. 'edit' | 'execute' | 'read' | 'delete' (may be absent). */
  kind: string | undefined
  /** Short human title the agent gave (e.g. 'rm -rf build'). */
  title: string | undefined
  /** The agent's raw tool input — opaque; the gate searches it as a string. */
  rawInput: unknown
}

/** Distill a permission request's tool call into the gate/handoff context. */
export function toolContext(taskId: TaskId, toolCall: AcpToolCall): AcpToolContext {
  return {
    taskId,
    kind: toolCall.kind,
    title: toolCall.title,
    rawInput: toolCall.rawInput,
  }
}

/**
 * Gate verdict — three-way:
 *   - `allow`    → answer the reverse request "allow" inline; no human, no park.
 *   - `deny`     → answer "reject" inline (fail-closed); the agent is refused.
 *   - `escalate` → park for a human (the HANDOFF seam).
 */
export type AcpGateVerdict = { allow: true } | { deny: true; reason: string } | { escalate: true; reason: string }

/** What a destructive-pattern match does. Default escalates to a human; 'deny' refuses outright. */
export type AcpGateMatchAction = 'escalate' | 'deny'

/**
 * Default destructive-tool patterns. Coarse by intent: for a black-box agent the
 * contract says pin the side-effect surface at the hub edge (approve the whole
 * action), not parse the agent's internal plan. Matched against
 * `kind + title + rawInput` joined by newlines.
 *
 * Note what is NOT here: ordinary file edits. ACP agents only raise a permission
 * request when THEY think approval is warranted; auto-allowing the non-destructive
 * ones (and only escalating the destructive) is the no-nag default. Pass your own
 * patterns / `onMatch:'deny'` for a stricter posture.
 */
export const DEFAULT_DANGEROUS_TOOL_PATTERNS: readonly RegExp[] = [
  /\brm\s+-[a-z]*r[a-z]*f?\b/i,
  /\bgit\s+push\b/i,
  /\bforce[- ]?push\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\b(?:npm|pnpm|yarn)\s+publish\b/i,
  /\bsudo\b/i,
  /\bcurl\b[^\n]*\|\s*(?:ba)?sh\b/i,
  /\bdrop\s+(?:table|database)\b/i,
  /\bkubectl\s+delete\b/i,
]

/**
 * Build a permission gate that escalates (or denies) when the tool matches a
 * destructive pattern, and allows everything else inline. Default `onMatch` is
 * `escalate` — fail-closed toward a human.
 */
export function dangerousToolGate(
  patterns: readonly RegExp[] = DEFAULT_DANGEROUS_TOOL_PATTERNS,
  opts: { onMatch?: AcpGateMatchAction } = {},
): (ctx: AcpToolContext) => AcpGateVerdict {
  const action = opts.onMatch ?? 'escalate'
  return (ctx) => {
    const haystack = [ctx.kind ?? '', ctx.title ?? '', stringifyRaw(ctx.rawInput)].join('\n')
    const hit = patterns.find((p) => p.test(haystack))
    if (!hit) return { allow: true }
    const reason = `matched destructive pattern ${String(hit)}`
    return action === 'deny' ? { deny: true, reason } : { escalate: true, reason }
  }
}

export type AcpPermissionWant = 'allow' | 'reject'

/**
 * Pick the option id to answer with. ACP options carry a `kind`
 * (`allow_once`/`allow_always`/`reject_once`/`reject_always`); we prefer the
 * "once" variant, fall back to "always", then to a name/id text match, else
 * undefined (the caller then cancels rather than guess wrong).
 */
export function pickOptionId(options: readonly AcpPermissionOption[], want: AcpPermissionWant): string | undefined {
  const prefer = want === 'allow' ? ['allow_once', 'allow_always'] : ['reject_once', 'reject_always']
  for (const kind of prefer) {
    const opt = options.find((o) => o.kind === kind)
    if (opt) return opt.optionId
  }
  const rx = want === 'allow' ? /allow|approve|accept|yes/i : /reject|deny|cancel|no/i
  const byText = options.find((o) => rx.test(o.name) || rx.test(o.optionId))
  return byText?.optionId
}

/** A reviewer's decision, delivered on resume. */
export interface AcpReviewDecision {
  /** Allow the parked tool? Permission parks are fail-closed (default deny). */
  approved: boolean
  /** Optional free-text note (audit / transcript). */
  note?: string
}

/**
 * Pull an `AcpReviewDecision` out of whatever the resume path injected. Tolerates
 * both conventions: the persisted state verbatim (`decision`) and an inbox-style
 * resolve (`{ answer: <decision> }`). Returns null when no decision is present.
 */
export function readPermissionDecision(state: unknown): AcpReviewDecision | null {
  if (!state || typeof state !== 'object') return null
  const s = state as Record<string, unknown>
  const raw = (s.decision ?? s.answer) as unknown
  if (!raw || typeof raw !== 'object') return null
  const d = raw as Record<string, unknown>
  if (typeof d.approved !== 'boolean') return null
  const out: AcpReviewDecision = { approved: d.approved }
  if (typeof d.note === 'string') out.note = d.note
  return out
}

/**
 * Persisted across a park — rides `SuspendTaskError.state`. The host writes an
 * approval inbox item from `reason`/`tool` and, on resume, hands this back merged
 * with the reviewer's decision. `permissionToken` keys the IN-MEMORY open reverse
 * request; it is meaningless after a hub restart (the subprocess is gone).
 */
export interface AcpCheckpointState {
  v: number
  kind: AcpParkKind
  reason: string
  /** In-memory handle key — the participant re-finds the open reverse request by this. */
  permissionToken: string
  /** Human-readable tool context for the inbox item (NOT used to re-run anything). */
  tool: { kind: string | undefined; title: string | undefined }
}

/** Build the park state carried by `SuspendTaskError`. */
export function acpParkState(args: {
  permissionToken: string
  reason: string
  tool: { kind: string | undefined; title: string | undefined }
}): AcpCheckpointState {
  return {
    v: ACP_CHECKPOINT_STATE_V,
    kind: 'permission',
    reason: args.reason,
    permissionToken: args.permissionToken,
    tool: args.tool,
  }
}

/** Read the carried checkpoint state out of a resume payload, if present. */
export function readAcpCheckpointState(state: unknown): AcpCheckpointState | null {
  if (!state || typeof state !== 'object') return null
  const s = state as Record<string, unknown>
  // The host merges `{ ...persistedState, decision }`, so fields sit at the top
  // level; a nested `state` shape is also tolerated.
  const candidate = (typeof s.v === 'number' ? s : s.state) as Record<string, unknown> | undefined
  if (!candidate || typeof candidate.permissionToken !== 'string') return null
  return candidate as unknown as AcpCheckpointState
}

function stringifyRaw(raw: unknown): string {
  if (raw == null) return ''
  if (typeof raw === 'string') return raw
  try {
    return JSON.stringify(raw)
  } catch {
    return ''
  }
}
