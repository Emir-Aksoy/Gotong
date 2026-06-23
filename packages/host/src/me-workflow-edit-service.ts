/**
 * WFEDIT-M2 — the host service that lets a MEMBER edit a workflow in plain
 * language (the OpenClaw-style `/me` editor), with the cross-hub 出入口 locked.
 *
 * WHY. A member should be able to reshape a workflow's LOCAL logic by just
 * describing the change ("把第二步的提示改成…", "加一步先让我确认") without
 * touching YAML. But a workflow that reaches ANOTHER hub carries a governed
 * contract at its edges — the trigger (入口) and every cross-hub egress hop
 * (出口) with its data classes — and those are NOT a member's to silently
 * repoint, add, drop, or re-classify. So this service runs the edit through one
 * fixed pipeline:
 *
 *   editor-grant gate  →  load current YAML  →  ask the AI to apply the change
 *   →  parse  →  ★ boundary lock (WFEDIT-M1) ★  →  structure hard-gate  →
 *   persist as a NEW revision (publish if live, saveDraft if authoring).
 *
 * The boundary lock ({@link enforceEditBoundary}) is the heart: it rejects any
 * edit that drifts the trigger or the cross-hub egress set, so "改自己这边" is
 * the only thing a member can do to a federated workflow. For a purely-local
 * workflow only the trigger is locked (the minimal contract), so members get the
 * full OpenClaw freedom there.
 *
 * Reuse, not reinvention:
 *   - the AI authoring surface is Phase 13's {@link WorkflowAssistSurface},
 *     called UNCHANGED — we just embed the current YAML in the description.
 *   - persistence + the structure hard-gate (`assertStructurallySound`) are the
 *     controller's existing `publish` / `saveDraft`, so this service adds no new
 *     write path and inherits run-drift-safe versioning (Phase 15).
 *   - cross-hub detection is the SAME `crossHubStepsOf` the admin pre-launch
 *     visibility uses (via the M1 guard), so "what the UI flags as cross-hub"
 *     and "what the editor locks" never drift.
 *
 * Duck-typed deps (host discipline): the real `WorkflowController`,
 * `IdentityStore`, `Hub`, and the assist surface satisfy these interfaces, but
 * the service is unit-testable with light fakes (no Hub, no LLM, no sqlite).
 */

import { isLiveState, parseWorkflow } from '@aipehub/workflow'
import type { LifecycleState, WorkflowDefinition } from '@aipehub/workflow'
import type { WorkflowAssistantOutput } from '@aipehub/workflow-assistant'

import {
  enforceEditBoundary,
  workflowBoundary,
  type BoundaryViolation,
  type PeerCapEntry,
  type WorkflowBoundary,
} from './workflow-edit-guard.js'
import { computeLineDiff, type WorkflowEditDiffLine } from './workflow-edit-diff.js'
import type { PeerCapabilityView } from './workflow-controller.js'

/** The reasons a member edit (or editable-view fetch) can be refused. */
export type MeWorkflowEditDenyReason =
  | 'forbidden' // no editor grant on this workflow
  | 'not_found' // no such workflow
  | 'no_source' // no editable YAML mirror (e.g. a built-in)
  | 'under_review' // state === 'review' — send back to draft first
  | 'archived' // state === 'archived' — read-only tombstone
  | 'assistant_unavailable' // the assist surface threw (no key / dispatch failed)
  | 'assistant_failed' // assistant produced no usable YAML (no_yaml / invalid)
  | 'parse_failed' // assistant's YAML didn't parse (defensive)
  | 'id_changed' // assistant changed the workflow id
  | 'boundary_locked' // ★ the edit touched the cross-hub 出入口 ★
  | 'structure_failed' // the structure hard-gate rejected the edited def

export interface MeWorkflowEditOk {
  ok: true
  /** Lifecycle state at edit time (drove publish-vs-saveDraft). */
  state: LifecycleState
  /** Whether the edit went live (`published`) or stayed a draft. */
  applied: 'published' | 'draft'
  /** The new YAML now persisted. */
  yaml: string
  /** The assistant's plain-language summary of what it changed. */
  explanation: string
  /**
   * The cross-hub boundary that was preserved byte-for-byte — surfaced so the
   * member SEES what stayed locked (empty egress ⇒ a purely-local workflow).
   */
  boundary: WorkflowBoundary
  /**
   * WFEDIT-D1 — line diff pre-edit → persisted YAML, so the UI shows exactly
   * what the AI changed instead of two blobs to eyeball.
   */
  diff: WorkflowEditDiffLine[]
  /** Advisory deep-check (unknown agent/capability warnings) — non-blocking. */
  deepCheck?: WorkflowAssistantOutput['deepCheck']
}

export interface MeWorkflowEditDenied {
  ok: false
  reason: MeWorkflowEditDenyReason
  /** Member-readable (zh) explanation. */
  message: string
  /** Present for `boundary_locked`: the exact edges the edit tried to change. */
  violations?: BoundaryViolation[]
  /** Underlying detail for assistant/parse/structure failures. */
  detail?: string
  /** The assistant verdict when it produced unusable output. */
  draftStatus?: WorkflowAssistantOutput['draftStatus']
}

export type MeWorkflowEditResult = MeWorkflowEditOk | MeWorkflowEditDenied

/** The editor-view payload M3's `GET /api/me/workflows/:id/editable` forwards. */
export type MeWorkflowEditableResult =
  | {
      ok: true
      workflowId: string
      state: LifecycleState
      /** False for archived / under-review workflows — the UI disables the edit box. */
      editable: boolean
      /** The current authored YAML (what the member is about to change). */
      yaml: string
      /** The governed cross-hub boundary — the UI renders this as the "locked" notice. */
      boundary: WorkflowBoundary
      /** Convenience: does this workflow leave the hub at all? */
      crossHub: boolean
    }
  | { ok: false; reason: Extract<MeWorkflowEditDenyReason, 'forbidden' | 'not_found' | 'no_source'>; message: string }

/**
 * WFEDIT-D3 — one prior turn of this member's edit conversation. The CLIENT
 * holds the conversation (the hub stores nothing between requests, same as the
 * rest of the stateless editor); each request re-sends it and the server
 * re-sanitizes. `outcome` carries what happened — a success summary or the
 * refusal text — so the model knows a rejected approach shouldn't be retried.
 */
export interface MeWorkflowEditTurn {
  instruction: string
  outcome?: string
}

export interface MeWorkflowEditRequest {
  workflowId: string
  /** The member's plain-language change request. */
  instruction: string
  /** The authenticated member (server-resolved; NEVER client-supplied). */
  userId: string
  /**
   * WFEDIT-D3 — prior turns of this edit session (client-held). Advisory
   * context only: server-capped + sanitized, folded into the assistant prompt
   * so "再礼貌一点 / 还是改回去" style references resolve.
   */
  history?: ReadonlyArray<MeWorkflowEditTurn>
  /**
   * WFEDIT-D4 — live LLM chunks of THIS edit only. The chunks flow up the call
   * stack of the member's own request (per-call sink in the assist surface),
   * never via the admin transcript stream — so a member can watch the typing
   * without a path to anyone else's tasks. Best-effort; absent ⇒ no streaming.
   */
  onChunk?: (chunk: string) => void
}

// --- duck-typed dependencies ------------------------------------------------

/** The slice of `IdentityStore` we need: per-workflow RBAC for a user. */
export interface WorkflowGrantView {
  hasWorkflowGrant(workflowId: string, userId: string, min: 'viewer' | 'editor' | 'owner'): boolean
}

/**
 * The slice of `WorkflowController` we need. The real controller satisfies all
 * of it; `publish` / `saveDraft` run the structure hard-gate
 * (`assertStructurallySound`) + write the YAML mirror + append the revision, so
 * this service delegates persistence rather than re-implementing it.
 */
export interface WorkflowEditTarget {
  readonly versioning: {
    has(id: string): Promise<boolean>
    headDefinition(id: string): Promise<WorkflowDefinition>
  }
  getState(id: string): Promise<{ state: LifecycleState }>
  exportDefinitionText(id: string): Promise<string | null>
  publish(id: string, opts: { text?: string; by?: string }): Promise<{ id: string }>
  saveDraft(text: string, opts: { by?: string }): Promise<{ id: string }>
}

/** Phase 13's assist surface (+ the D4 per-call chunk sink it grew). */
export interface WorkflowAssistView {
  assist(input: {
    description: string
    contextHints?: {
      agents?: ReadonlyArray<{ id: string; capabilities: ReadonlyArray<string>; description?: string }>
      existingWorkflowIds?: ReadonlyArray<string>
      // MCD-M4 — installed MCP server names. The assistant renders these as
      // "Available MCP servers:" so it edits around components that are already
      // wired. Names only (deepCheck never validates them — they're not
      // capabilities).
      mcpServers?: ReadonlyArray<string>
    }
    by: string
    onChunk?: (chunk: string) => void
  }): Promise<WorkflowAssistantOutput>
}

/** One local participant — id + its capabilities (for local-cap set + contextHints). */
export interface LocalParticipantView {
  id: string
  capabilities: Iterable<string>
}

/**
 * WFEDIT-S2 — the read slice of the sticky cross-hub marker store the boundary
 * lock consults. The real `FileCrossHubMarkerStore` satisfies it (the controller
 * holds the write side). Absent ⇒ the lock falls back to live detection only,
 * which is the pre-S2 behavior (and the gap S2 closes).
 */
export interface CrossHubMarkerReadView {
  get(workflowId: string): Promise<string[]>
}

export interface MeWorkflowEditDeps {
  /** RBAC source. */
  grants: WorkflowGrantView
  /** Versioning reads + lifecycle-aware persistence. */
  workflows: WorkflowEditTarget
  /** AI authoring surface (Phase 13). */
  assist: WorkflowAssistView
  /** Local participants — drives the local-capability set + assistant contextHints. */
  participants: () => ReadonlyArray<LocalParticipantView>
  /**
   * MCD-M4 — installed MCP server names for the assistant's contextHints.
   * Optional + best-effort: the architect prefers components that are already
   * wired. Names only (deepCheck never validates MCP server names — they're not
   * capabilities). Async because it reads the on-disk hub MCP registry.
   */
  mcpServerNames?: () => Promise<ReadonlyArray<string>> | ReadonlyArray<string>
  /**
   * Off-hub capability view (optional). Absent ⇒ single-hub: egress is empty so
   * only the trigger is locked. Present ⇒ the SAME view the controller's
   * cross-hub-step detection uses, so the lock matches what the UI flags.
   */
  peerCapabilities?: PeerCapabilityView
  /**
   * WFEDIT-S2 — sticky cross-hub marker reader (optional). Present ⇒ the boundary
   * lock reactivates any capability ever observed leaving THIS workflow off-hub,
   * so a member can't repoint/drop/re-classify a cross-hub hop while its peer is
   * offline at edit time. Absent ⇒ live detection only (the pre-S2 gap).
   */
  crossHubMarkers?: CrossHubMarkerReadView
}

// --- service ----------------------------------------------------------------

export class MeWorkflowEditService {
  constructor(private readonly deps: MeWorkflowEditDeps) {}

  /**
   * Apply a member's plain-language change to a workflow, with the cross-hub
   * 出入口 locked. Returns a discriminated result; the web route maps `reason`
   * to an HTTP status and echoes `message` / `violations` to the member.
   */
  async edit(req: MeWorkflowEditRequest): Promise<MeWorkflowEditResult> {
    const { workflowId, instruction, userId } = req
    const history = sanitizeEditHistory(req.history)

    // 1. RBAC — editor+ on THIS workflow. (owner outranks editor.)
    if (!this.deps.grants.hasWorkflowGrant(workflowId, userId, 'editor')) {
      return deny('forbidden', '你没有改这个工作流的权限(需要 editor)。请让管理员给你授权。')
    }

    // 2. Existence.
    if (!(await this.deps.workflows.versioning.has(workflowId))) {
      return deny('not_found', '找不到这个工作流。')
    }

    // 3. State — decides publish-edit (live) vs saveDraft (authoring), and
    //    rejects the states a plain edit can't touch.
    const { state } = await this.deps.workflows.getState(workflowId)
    if (state === 'review') {
      return deny('under_review', '这个工作流正在审核中,先退回草稿再改。')
    }
    if (state === 'archived') {
      return deny('archived', '这个工作流已归档(只读),不能再改。')
    }

    // 4. Current definition + verbatim YAML (the assistant edits the YAML text).
    const currentYaml = await this.deps.workflows.exportDefinitionText(workflowId)
    if (!currentYaml) {
      return deny('no_source', '这个工作流没有可编辑的源文件(可能是内置的)。')
    }
    const original = await this.deps.workflows.versioning.headDefinition(workflowId)

    // 5. Ask the AI to apply the change to the CURRENT yaml (Phase 13 surface,
    //    unchanged — we just embed the current YAML + the member's request).
    let assist: WorkflowAssistantOutput
    try {
      assist = await this.deps.assist.assist({
        description: composeEditPrompt(currentYaml, instruction, history),
        contextHints: await this.contextHints(),
        by: userId,
        ...(req.onChunk ? { onChunk: req.onChunk } : {}),
      })
    } catch (err) {
      return deny('assistant_unavailable', 'AI 助手暂时不可用,请稍后再试。', { detail: errMsg(err) })
    }
    if (assist.draftStatus !== 'valid' || !assist.yaml) {
      return deny(
        'assistant_failed',
        assist.draftStatus === 'invalid'
          ? 'AI 改出来的工作流不合法,换个说法再试一次。'
          : 'AI 没能把你的说法变成工作流改动,把想改的地方说得更具体些。',
        { detail: assist.validationError ?? assist.explanation, draftStatus: assist.draftStatus },
      )
    }

    // 6. Parse the edited YAML (defensive — `draftStatus==='valid'` already parsed once).
    let edited: WorkflowDefinition
    try {
      edited = parseWorkflow(assist.yaml)
    } catch (err) {
      return deny('parse_failed', 'AI 改出来的工作流解析失败,请重试。', { detail: errMsg(err) })
    }

    // 7. Identity — an EDIT keeps the same id (changing it = a NEW workflow).
    if (edited.id !== workflowId) {
      return deny('id_changed', `不能改工作流的 id(原 "${workflowId}")— 这是在改同一个工作流,不是新建一个。`)
    }

    // 8. ★ THE BOUNDARY LOCK ★ — cross-hub 入口/出口 must be byte-invariant.
    //    Sticky caps (S2) reactivate an egress whose peer is offline right now,
    //    so the lock holds even when the destination hub is down at edit time.
    const { localCapabilities, peerEntries } = this.boundaryInputs()
    const sticky = await this.loadSticky(workflowId)
    const boundaryCheck = enforceEditBoundary(original, edited, localCapabilities, peerEntries, sticky)
    if (!boundaryCheck.ok) {
      return {
        ok: false,
        reason: 'boundary_locked',
        message:
          '这个工作流连着别的 hub。跨 hub 的出入口(谁能触发、发去哪个 hub、带什么数据)不能改 — 你只能改自己这边的步骤。',
        violations: boundaryCheck.violations,
      }
    }

    // 9. Persist as a new revision. Live (published/deprecated) → publish the
    //    edit (goes live, editor-gated above); authoring (draft) → saveDraft.
    //    The controller runs the structure hard-gate + YAML mirror + versioning.
    const goLive = isLiveState(state)
    try {
      if (goLive) {
        await this.deps.workflows.publish(workflowId, { text: assist.yaml, by: userId })
      } else {
        await this.deps.workflows.saveDraft(assist.yaml, { by: userId })
      }
    } catch (err) {
      return deny(
        'structure_failed',
        'AI 改出来的工作流有结构问题(比如引用了不存在的步骤或 agent),没有保存。',
        { detail: errMsg(err) },
      )
    }

    return {
      ok: true,
      state,
      applied: goLive ? 'published' : 'draft',
      yaml: assist.yaml,
      explanation: assist.explanation,
      boundary: workflowBoundary(edited, localCapabilities, peerEntries, sticky),
      diff: computeLineDiff(currentYaml, assist.yaml),
      ...(assist.deepCheck ? { deepCheck: assist.deepCheck } : {}),
    }
  }

  /**
   * The editor view for `GET /api/me/workflows/:id/editable`: the current YAML
   * + the governed boundary + whether the workflow is editable at all. Gated on
   * editor+ (you only open the editor if you can edit). The UI renders
   * `boundary` as the "🔒 跨 hub 出入口(锁住)" notice.
   */
  async editableView(workflowId: string, userId: string): Promise<MeWorkflowEditableResult> {
    if (!this.deps.grants.hasWorkflowGrant(workflowId, userId, 'editor')) {
      return { ok: false, reason: 'forbidden', message: '你没有改这个工作流的权限(需要 editor)。' }
    }
    if (!(await this.deps.workflows.versioning.has(workflowId))) {
      return { ok: false, reason: 'not_found', message: '找不到这个工作流。' }
    }
    const { state } = await this.deps.workflows.getState(workflowId)
    const currentYaml = await this.deps.workflows.exportDefinitionText(workflowId)
    if (!currentYaml) {
      return { ok: false, reason: 'no_source', message: '这个工作流没有可编辑的源文件(可能是内置的)。' }
    }
    const original = await this.deps.workflows.versioning.headDefinition(workflowId)
    const { localCapabilities, peerEntries } = this.boundaryInputs()
    const sticky = await this.loadSticky(workflowId)
    const boundary = workflowBoundary(original, localCapabilities, peerEntries, sticky)
    return {
      ok: true,
      workflowId,
      state,
      // review/archived can't be plain-edited (the edit pipeline refuses them).
      editable: state !== 'review' && state !== 'archived',
      yaml: currentYaml,
      boundary,
      crossHub: boundary.egress.length > 0,
    }
  }

  /**
   * Build the cross-hub boundary inputs EXACTLY like the controller's
   * `computeCrossHubSteps`: the local-capability set excludes the off-hub
   * destinations' own participant ids, so a capability a peer/A2A agent itself
   * advertises isn't mistaken for "served locally".
   */
  private boundaryInputs(): { localCapabilities: Set<string>; peerEntries: PeerCapEntry[] } {
    const peerEntries = this.deps.peerCapabilities?.peerCapabilities() ?? []
    const peerIds = new Set(peerEntries.map((e) => e.peer))
    const localCapabilities = new Set<string>()
    for (const p of this.deps.participants()) {
      if (peerIds.has(p.id)) continue
      for (const c of p.capabilities) localCapabilities.add(c)
    }
    return { localCapabilities, peerEntries }
  }

  /**
   * WFEDIT-S2 — the sticky cross-hub capabilities recorded for this workflow.
   * Best-effort: a marker read must never block an edit, so a missing store or a
   * read error yields `[]` (the lock falls back to live-only detection — the
   * pre-S2 behavior). Empty ⇒ no sticky reactivation.
   */
  private async loadSticky(workflowId: string): Promise<string[]> {
    if (!this.deps.crossHubMarkers) return []
    try {
      return await this.deps.crossHubMarkers.get(workflowId)
    } catch {
      return []
    }
  }

  /**
   * Real local agent capabilities → assistant `contextHints`, so it edits using
   * the hub's actual capability names AND the deep-check has a live inventory.
   * MCD-M4: also feed installed MCP server names so the architect edits around
   * components that are already wired (best-effort — a registry read failure
   * just omits the MCP hint).
   */
  private async contextHints(): Promise<{
    agents: Array<{ id: string; capabilities: string[] }>
    mcpServers?: string[]
  }> {
    const hints: { agents: Array<{ id: string; capabilities: string[] }>; mcpServers?: string[] } = {
      agents: this.deps.participants().map((p) => ({ id: p.id, capabilities: [...p.capabilities] })),
    }
    if (this.deps.mcpServerNames) {
      try {
        const names = await this.deps.mcpServerNames()
        const filtered = (names || []).filter(Boolean)
        if (filtered.length > 0) hints.mcpServers = filtered
      } catch {
        // best-effort — a registry read failure just omits the MCP hint.
      }
    }
    return hints
  }
}

// --- helpers ----------------------------------------------------------------

/** WFEDIT-D3 history caps — advisory context, not a transcript store. */
const MAX_HISTORY_TURNS = 6
const MAX_HISTORY_FIELD_CHARS = 500

/**
 * WFEDIT-D3 — server-authoritative history sanitizer. The client re-sends the
 * conversation on every request (the hub stores nothing between edits), so
 * nothing in it is trusted: non-object / blank-instruction turns are dropped,
 * fields are trimmed + clipped, and only the LAST N turns survive — the recent
 * turns are the ones "再…一点 / 改回去" style references actually point at.
 */
export function sanitizeEditHistory(history: unknown): MeWorkflowEditTurn[] {
  if (!Array.isArray(history)) return []
  const out: MeWorkflowEditTurn[] = []
  for (const t of history) {
    if (!t || typeof t !== 'object') continue
    const rawInstruction = (t as { instruction?: unknown }).instruction
    const instruction = typeof rawInstruction === 'string' ? rawInstruction.trim() : ''
    if (!instruction) continue
    const rawOutcome = (t as { outcome?: unknown }).outcome
    const outcome = typeof rawOutcome === 'string' ? rawOutcome.trim() : ''
    out.push({ instruction: clip(instruction), ...(outcome ? { outcome: clip(outcome) } : {}) })
  }
  return out.slice(-MAX_HISTORY_TURNS)
}

function clip(s: string): string {
  return s.length > MAX_HISTORY_FIELD_CHARS ? `${s.slice(0, MAX_HISTORY_FIELD_CHARS)}…` : s
}

/**
 * The prompt the assistant sees: the current YAML + (D3) the prior turns of
 * this edit session + the member's request, with a hint to keep
 * schema/id/trigger stable. The hint is belt; the boundary lock is suspenders —
 * a model that ignores the hint is rejected, not trusted.
 */
function composeEditPrompt(
  currentYaml: string,
  instruction: string,
  history: ReadonlyArray<MeWorkflowEditTurn> = [],
): string {
  // The conversation is context, not instructions to re-apply: the YAML above
  // ALREADY contains every successful prior edit, and a failed turn documents a
  // rejected approach (e.g. boundary-locked) the model must not retry verbatim.
  const conversation = history.length
    ? [
        '',
        '=== 之前的修改对话(仅供理解上下文) ===',
        '注意:上面的 YAML **已经包含**这些对话里成功的改动;标了失败的要求说明那种改法被拒绝了,不要原样重试。这段对话只用来理解用户这次说法里的指代(比如「再礼貌一点」「还是改回去」)。',
        ...history.map(
          (t, i) => `${i + 1}. 用户: ${t.instruction}${t.outcome ? `\n   结果: ${t.outcome}` : ''}`,
        ),
      ]
    : []
  return [
    '下面是一个已经存在的工作流 YAML。请根据用户的修改要求改写它,然后输出**完整的**修改后 YAML(不要只输出改动片段)。',
    '除非用户明确要求,否则保持 schema、工作流 id、trigger(入口能力)不变,也不要新增或改动任何派发到别的 hub 的步骤。',
    '',
    '=== 当前工作流 YAML ===',
    currentYaml.trim(),
    ...conversation,
    '',
    '=== 用户的修改要求 ===',
    instruction.trim(),
  ].join('\n')
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function deny(
  reason: MeWorkflowEditDenyReason,
  message: string,
  extra?: { detail?: string; draftStatus?: WorkflowAssistantOutput['draftStatus'] },
): MeWorkflowEditDenied {
  return {
    ok: false,
    reason,
    message,
    ...(extra?.detail ? { detail: extra.detail } : {}),
    ...(extra?.draftStatus ? { draftStatus: extra.draftStatus } : {}),
  }
}
