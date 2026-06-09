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

export interface MeWorkflowEditRequest {
  workflowId: string
  /** The member's plain-language change request. */
  instruction: string
  /** The authenticated member (server-resolved; NEVER client-supplied). */
  userId: string
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

/** Phase 13's assist surface, consumed UNCHANGED. */
export interface WorkflowAssistView {
  assist(input: {
    description: string
    contextHints?: {
      agents?: ReadonlyArray<{ id: string; capabilities: ReadonlyArray<string>; description?: string }>
      existingWorkflowIds?: ReadonlyArray<string>
    }
    by: string
  }): Promise<WorkflowAssistantOutput>
}

/** One local participant — id + its capabilities (for local-cap set + contextHints). */
export interface LocalParticipantView {
  id: string
  capabilities: Iterable<string>
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
   * Off-hub capability view (optional). Absent ⇒ single-hub: egress is empty so
   * only the trigger is locked. Present ⇒ the SAME view the controller's
   * cross-hub-step detection uses, so the lock matches what the UI flags.
   */
  peerCapabilities?: PeerCapabilityView
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
        description: composeEditPrompt(currentYaml, instruction),
        contextHints: this.contextHints(),
        by: userId,
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
    const { localCapabilities, peerEntries } = this.boundaryInputs()
    const boundaryCheck = enforceEditBoundary(original, edited, localCapabilities, peerEntries)
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
      boundary: workflowBoundary(edited, localCapabilities, peerEntries),
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
    const boundary = workflowBoundary(original, localCapabilities, peerEntries)
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
   * Real local agent capabilities → assistant `contextHints`, so it edits using
   * the hub's actual capability names AND the deep-check has a live inventory.
   */
  private contextHints(): { agents: Array<{ id: string; capabilities: string[] }> } {
    return {
      agents: this.deps.participants().map((p) => ({ id: p.id, capabilities: [...p.capabilities] })),
    }
  }
}

// --- helpers ----------------------------------------------------------------

/**
 * The prompt the assistant sees: the current YAML + the member's request, with
 * a hint to keep schema/id/trigger stable. The hint is belt; the boundary lock
 * is suspenders — a model that ignores the hint is rejected, not trusted.
 */
function composeEditPrompt(currentYaml: string, instruction: string): string {
  return [
    '下面是一个已经存在的工作流 YAML。请根据用户的修改要求改写它,然后输出**完整的**修改后 YAML(不要只输出改动片段)。',
    '除非用户明确要求,否则保持 schema、工作流 id、trigger(入口能力)不变,也不要新增或改动任何派发到别的 hub 的步骤。',
    '',
    '=== 当前工作流 YAML ===',
    currentYaml.trim(),
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
