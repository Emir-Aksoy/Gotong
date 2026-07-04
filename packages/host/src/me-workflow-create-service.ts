/**
 * ARCH-M5 — the host service that lets a MEMBER author a brand-new workflow in
 * plain language (the "工作流架构师" from the /me side), plus explain any
 * workflow at an adjustable depth. The sibling of `MeWorkflowEditService`: that
 * one RESHAPES an existing workflow's local logic; this one CREATES a new one
 * and NARRATES existing ones.
 *
 * WHY. A member should be able to go from a sentence ("每天早上让助手把我的待办
 * 整理一下发给我") to a runnable workflow without writing YAML — that's the
 * north-star "我的 AI 桌面:不写代码,AI 帮我做实际的事". But authoring carries two
 * governance constraints a member can't wave away:
 *
 *   1. ★ A member-authored workflow is LOCAL-ONLY. ★ A step that dispatches to
 *      ANOTHER hub is a cross-organization contract (peer trust + per-link data
 *      classes + outbound approval) that only an admin can establish. So if the
 *      authored YAML has ANY cross-hub egress hop, this service rejects it — a
 *      member builds workflows that stay on their own hub.
 *   2. It lands as a DRAFT, never auto-live. The member becomes its `owner`
 *      (an owner-as-grant row), so it shows up in their /me and they can refine
 *      it via the existing `MeWorkflowEditService` edit path (editor ⊆ owner) or
 *      submit it for publish through the Phase 15 lifecycle. Run-time gates
 *      (Phase 17 budget fail-closed, Phase 10 depth/cycle) still backstop it.
 *
 * Reuse, not reinvention — every heavy part is already built:
 *   - the AI authoring surface is Phase 13's `WorkflowAssistSurface`, in author
 *     mode (ARCH-M1/M2 just grew it `mode`/`detail`/`subjectYaml`/`graph`).
 *   - cross-hub detection is the SAME boundary primitive the editor's lock and
 *     the admin pre-launch visibility use (`workflowBoundary` → `crossHubStepsOf`),
 *     so "what the editor locks" and "what create rejects" can't drift.
 *   - persistence + the structure hard-gate are the controller's existing
 *     `saveDraft`, so this adds no new write path (run-drift-safe versioning).
 *   - the owner-seed mirrors Phase 19 P2 / the admin import path's
 *     `seedWorkflowOwner` (best-effort owner-as-grant).
 *
 * Duck-typed deps (host discipline): the real `WorkflowController`,
 * `IdentityStore`, `Hub`, and the assist surface satisfy these interfaces, but
 * the service is unit-testable with light fakes (no Hub, no LLM, no sqlite).
 */

import { parseWorkflow } from '@gotong/workflow'
import type { WorkflowDefinition, WorkflowGraphView } from '@gotong/workflow'
import type { WorkflowAssistantOutput, WorkflowDetailLevel } from '@gotong/workflow-assistant'

import { workflowBoundary, type PeerCapEntry } from './workflow-edit-guard.js'
import { sanitizeEditHistory, type MeWorkflowEditTurn } from './me-workflow-edit-service.js'
import type { PeerCapabilityView } from './workflow-controller.js'

// --- create -----------------------------------------------------------------

/** The reasons a member CREATE can be refused. */
export type MeWorkflowCreateDenyReason =
  | 'assistant_unavailable' // the assist surface threw (no key / dispatch failed)
  | 'assistant_failed' // assistant produced no usable YAML (no_yaml / invalid)
  | 'parse_failed' // assistant's YAML didn't parse (defensive)
  | 'cross_hub' // ★ the authored workflow dispatches off-hub — members are local-only ★
  | 'id_exists' // the authored id collides with an existing workflow (would clobber)
  | 'draft_cap' // optional per-member draft cap exceeded
  | 'structure_failed' // the structure hard-gate rejected the authored def

export interface MeWorkflowCreateOk {
  ok: true
  /** The id of the freshly-created draft. */
  workflowId: string
  /** The YAML now persisted as a draft. */
  yaml: string
  /** The architect's plain-language summary (depth follows `detail`). */
  explanation: string
  /** The DAG projection — the inline/downloadable flowchart. Present iff the YAML parsed. */
  graph?: WorkflowGraphView
  /** Advisory deep-check (unknown agent/capability warnings) — non-blocking. */
  deepCheck?: WorkflowAssistantOutput['deepCheck']
}

export interface MeWorkflowCreateDenied {
  ok: false
  reason: MeWorkflowCreateDenyReason
  /** Member-readable (zh) explanation. */
  message: string
  /** Underlying detail for assistant/parse/structure failures. */
  detail?: string
  /** The assistant verdict when it produced unusable output. */
  draftStatus?: WorkflowAssistantOutput['draftStatus']
}

export type MeWorkflowCreateResult = MeWorkflowCreateOk | MeWorkflowCreateDenied

export interface MeWorkflowCreateRequest {
  /** The member's plain-language description of the workflow they want. */
  instruction: string
  /** The authenticated member (server-resolved; NEVER client-supplied). */
  userId: string
  /**
   * ARCH-M1 — explanation depth ('oneliner' | 'brief' | 'detailed'). Default
   * `brief`. Affects only the prose; the yaml + graph are unaffected by depth.
   */
  detail?: WorkflowDetailLevel
  /**
   * Prior turns of this authoring conversation (client-held, same stateless
   * model as the editor). Advisory context only: server-capped + sanitized,
   * folded into the prompt so "再加一步让我确认 / 改成每天触发" style refinements
   * resolve before the member submits.
   */
  history?: ReadonlyArray<MeWorkflowEditTurn>
  /**
   * Live LLM chunks of THIS call only (per-call sink — flows up the member's
   * own request, never the admin transcript stream). Best-effort.
   */
  onChunk?: (chunk: string) => void
}

// --- explain -----------------------------------------------------------------

/** The reasons a member EXPLAIN can be refused. */
export type MeWorkflowExplainDenyReason =
  | 'not_found' // no such workflow
  | 'no_source' // no readable YAML mirror (e.g. a built-in)
  | 'assistant_unavailable' // the assist surface threw
  | 'assistant_failed' // the subject YAML couldn't be narrated (defensive — stored defs parse)

export interface MeWorkflowExplainOk {
  ok: true
  workflowId: string
  /** The workflow's YAML (the subject — explain mode never regenerates it). */
  yaml: string
  /** The architect's narration at the requested depth. */
  explanation: string
  /** The depth that was used. */
  detail: WorkflowDetailLevel
  /** The DAG projection of the subject — inline/downloadable flowchart. */
  graph?: WorkflowGraphView
  /** Advisory deep-check (unknown agent/capability warnings) — non-blocking. */
  deepCheck?: WorkflowAssistantOutput['deepCheck']
}

export interface MeWorkflowExplainDenied {
  ok: false
  reason: MeWorkflowExplainDenyReason
  message: string
  detail?: string
}

export type MeWorkflowExplainResult = MeWorkflowExplainOk | MeWorkflowExplainDenied

export interface MeWorkflowExplainRequest {
  workflowId: string
  /** The authenticated member (server-resolved). */
  userId: string
  /** Explanation depth — default `brief`. */
  detail?: WorkflowDetailLevel
  /** Optional focus question for the explanation (may be empty). */
  focus?: string
  /** Live LLM chunks of THIS call only. Best-effort. */
  onChunk?: (chunk: string) => void
}

// --- duck-typed dependencies ------------------------------------------------

/** The slice of `IdentityStore` we need: seed the member's owner grant on the new draft. */
export interface WorkflowGrantWriteView {
  setWorkflowGrant(input: {
    workflowId: string
    userId: string
    perm: 'viewer' | 'editor' | 'owner'
    grantedBy?: string | null
  }): unknown
}

/**
 * The slice of `WorkflowController` we need. `saveDraft` runs the structure
 * hard-gate (`assertStructurallySound`) + writes the YAML mirror + appends the
 * genesis revision, so this service delegates persistence rather than
 * re-implementing it. `exportDefinitionText` backs explain.
 */
export interface WorkflowCreateTarget {
  readonly versioning: {
    has(id: string): Promise<boolean>
  }
  saveDraft(text: string, opts: { by?: string }): Promise<{ id: string }>
  exportDefinitionText(id: string): Promise<string | null>
}

/**
 * Phase 13's assist surface, with the ARCH-M1/M2 author+explain fields. The
 * real `WorkflowAssistSurface` satisfies it. `graph` rides the output.
 */
export interface WorkflowAssistAuthorView {
  assist(input: {
    description: string
    mode?: 'author' | 'explain'
    detail?: WorkflowDetailLevel
    subjectYaml?: string
    contextHints?: {
      agents?: ReadonlyArray<{ id: string; capabilities: ReadonlyArray<string>; description?: string }>
      mcpServers?: ReadonlyArray<string>
      existingWorkflowIds?: ReadonlyArray<string>
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

export interface MeWorkflowCreateDeps {
  /** Identity write — seed the member's owner grant. */
  grants: WorkflowGrantWriteView
  /** Versioning reads + draft persistence + YAML export (for explain). */
  workflows: WorkflowCreateTarget
  /** AI authoring surface (Phase 13, ARCH-M1/M2). */
  assist: WorkflowAssistAuthorView
  /** Local participants — drives the local-capability set + assistant contextHints. */
  participants: () => ReadonlyArray<LocalParticipantView>
  /**
   * MCD-M4 — installed hub MCP server names (optional). When present, fed to the
   * architect's contextHints so it prefers already-assemblable MCP backends over
   * invented ones (the assistant renders them as "Available MCP servers:").
   * Best-effort: a throw or empty list just omits the hint. Names only — a
   * server name isn't a capability, so deepCheck never validates against it.
   * Async because the host reads the registry from disk (space.mcpServers()).
   */
  mcpServerNames?: () => Promise<ReadonlyArray<string>> | ReadonlyArray<string>
  /**
   * Off-hub capability view (optional). Absent ⇒ single-hub: nothing is off-hub
   * so the cross-hub reject never fires. Present ⇒ the SAME view the controller's
   * cross-hub-step detection uses, so "is this step cross-hub" matches the UI.
   */
  peerCapabilities?: PeerCapabilityView
  /**
   * Optional anti-abuse cap: the max number of workflows one member may own.
   * Enforced ONLY when BOTH this and `countOwnedDrafts` are set (so it's a true
   * opt-in — main.ts leaves it off by default, no cap). Mirrors the /me agents
   * 20-per-member ceiling in spirit.
   */
  perMemberDraftCap?: number
  /** Counts the workflows this member already owns. Required to enforce the cap. */
  countOwnedDrafts?: (userId: string) => Promise<number> | number
}

// --- service ----------------------------------------------------------------

export class MeWorkflowCreateService {
  constructor(private readonly deps: MeWorkflowCreateDeps) {}

  /**
   * Author a brand-new workflow from a member's plain-language description. The
   * result is a DRAFT owned by the member, on THIS hub only (cross-hub egress
   * rejected). Returns a discriminated result; the web route maps `reason` to
   * an HTTP status and echoes `message` to the member.
   */
  async create(req: MeWorkflowCreateRequest): Promise<MeWorkflowCreateResult> {
    const { instruction, userId } = req
    const history = sanitizeEditHistory(req.history)

    // 0. Optional anti-abuse cap — opt-in (both knobs must be wired).
    const capDeny = await this.checkDraftCap(userId)
    if (capDeny) return capDeny

    // 1. Ask the AI to author a workflow from the description (author mode).
    let assist: WorkflowAssistantOutput
    try {
      assist = await this.deps.assist.assist({
        description: composeCreatePrompt(instruction, history),
        mode: 'author',
        ...(req.detail ? { detail: req.detail } : {}),
        contextHints: await this.contextHints(),
        by: userId,
        ...(req.onChunk ? { onChunk: req.onChunk } : {}),
      })
    } catch (err) {
      return denyCreate('assistant_unavailable', 'AI 助手暂时不可用,请稍后再试。', { detail: errMsg(err) })
    }
    if (assist.draftStatus !== 'valid' || !assist.yaml) {
      return denyCreate(
        'assistant_failed',
        assist.draftStatus === 'invalid'
          ? 'AI 生成的工作流不合法,换个说法再试一次。'
          : 'AI 没能把你的描述变成工作流,把想做的事说得更具体些(谁来做、按什么顺序、用什么数据)。',
        { detail: assist.validationError ?? assist.explanation, draftStatus: assist.draftStatus },
      )
    }

    // 2-6. Shared gate tail (parse → local-only → collision → save → owner seed).
    const persisted = await this.gateAndPersist(assist.yaml, userId)
    if (!persisted.ok) return persisted

    return {
      ok: true,
      workflowId: persisted.workflowId,
      yaml: assist.yaml,
      explanation: assist.explanation,
      ...(assist.graph ? { graph: assist.graph } : {}),
      ...(assist.deepCheck ? { deepCheck: assist.deepCheck } : {}),
    }
  }

  /**
   * WIZ-M4 — persist an ALREADY-AUTHORED yaml (the wizard's user-approved
   * proposal) through exactly the same member gates as `create()`: draft cap →
   * parse → ★local-only★ → id-collision → saveDraft (structure hard-gate) →
   * owner seed. Deliberately NO LLM call — the wizard already ran authoring +
   * the bounded repair loop; re-running `create(instruction)` here would burn
   * tokens AND could drift from the exact YAML the member approved.
   */
  async createFromYaml(req: { yaml: string; userId: string }): Promise<MeWorkflowCreateResult> {
    const capDeny = await this.checkDraftCap(req.userId)
    if (capDeny) return capDeny
    const persisted = await this.gateAndPersist(req.yaml, req.userId)
    if (!persisted.ok) return persisted
    // explanation 由向导的 compose 结果携带（同意面已经给用户看过），这里不再复述。
    return { ok: true, workflowId: persisted.workflowId, yaml: req.yaml, explanation: '' }
  }

  /** Optional anti-abuse cap — opt-in (both knobs must be wired). Null = pass. */
  private async checkDraftCap(userId: string): Promise<MeWorkflowCreateDenied | null> {
    if (typeof this.deps.perMemberDraftCap !== 'number' || !this.deps.countOwnedDrafts) return null
    let owned: number
    try {
      owned = await this.deps.countOwnedDrafts(userId)
    } catch {
      owned = 0 // a counting hiccup must never wrongly block creation
    }
    if (owned >= this.deps.perMemberDraftCap) {
      return denyCreate(
        'draft_cap',
        `你已经有 ${owned} 个工作流了(上限 ${this.deps.perMemberDraftCap})。先删掉一些再新建。`,
      )
    }
    return null
  }

  /**
   * The gate tail shared by `create()` and `createFromYaml()` — every member
   * write lands through the SAME sequence so the two entrances cannot drift:
   * parse (defensive) → ★LOCAL-ONLY★ → id collision → saveDraft → owner seed.
   */
  private async gateAndPersist(
    yaml: string,
    userId: string,
  ): Promise<{ ok: true; workflowId: string } | MeWorkflowCreateDenied> {
    // 2. Parse (defensive — assist paths already parsed once).
    let def: WorkflowDefinition
    try {
      def = parseWorkflow(yaml)
    } catch (err) {
      return denyCreate('parse_failed', 'AI 生成的工作流解析失败,请重试。', { detail: errMsg(err) })
    }

    // 3. ★ LOCAL-ONLY GATE ★ — a member-authored workflow must not leave the hub.
    //    Uses the SAME boundary primitive the editor's cross-hub lock uses, so a
    //    step the UI would flag as cross-hub is exactly a step we reject here.
    const { localCapabilities, peerEntries } = this.boundaryInputs()
    const boundary = workflowBoundary(def, localCapabilities, peerEntries)
    if (boundary.egress.length > 0) {
      const hops = boundary.egress.map((e) => e.capability).join('、')
      return denyCreate(
        'cross_hub',
        `这个工作流里有派发到别的 hub 的步骤(${hops})。新建工作流暂时只能用本 hub 的能力 —— 跨 hub 协作需要管理员先配置对端信任。`,
      )
    }

    // 4. Id collision — never clobber an existing workflow (another member's
    //    draft or a published one). The structure gate would also catch a publish
    //    collision, but a draft id reused here would APPEND a revision to someone
    //    else's draft, so we reject up front.
    if (await this.deps.workflows.versioning.has(def.id)) {
      return denyCreate(
        'id_exists',
        `已经有一个叫 "${def.id}" 的工作流了。换个说法让 AI 取个不一样的名字再试。`,
      )
    }

    // 5. Persist as a draft (never auto-live). The controller runs the structure
    //    hard-gate + writes the YAML mirror + appends the genesis revision.
    let saved: { id: string }
    try {
      saved = await this.deps.workflows.saveDraft(yaml, { by: userId })
    } catch (err) {
      return denyCreate(
        'structure_failed',
        'AI 生成的工作流有结构问题(比如引用了不存在的步骤或 agent),没有保存。',
        { detail: errMsg(err) },
      )
    }

    // 6. Seed the member as OWNER (owner-as-grant). Best-effort, mirroring the
    //    admin import path's `seedWorkflowOwner`: the draft is already saved; a
    //    grant write hiccup just means it must be re-granted to show in /me.
    try {
      this.deps.grants.setWorkflowGrant({ workflowId: saved.id, userId, perm: 'owner', grantedBy: userId })
    } catch {
      /* best-effort */
    }

    return { ok: true, workflowId: saved.id }
  }

  /**
   * Narrate an existing workflow at an adjustable depth — the "讲解" the user
   * asked for, plus its flowchart. VISIBILITY is the web layer's job: the /me
   * route gates the id through `resolveMeWorkflow` (published + allowedRoles)
   * before calling this, exactly like dispatch. This executor only fetches the
   * YAML + runs the architect in explain mode (which never regenerates it).
   */
  async explain(req: MeWorkflowExplainRequest): Promise<MeWorkflowExplainResult> {
    const { workflowId, userId } = req
    const detail: WorkflowDetailLevel = req.detail ?? 'brief'

    if (!(await this.deps.workflows.versioning.has(workflowId))) {
      return denyExplain('not_found', '找不到这个工作流。')
    }
    const yaml = await this.deps.workflows.exportDefinitionText(workflowId)
    if (!yaml) {
      return denyExplain('no_source', '这个工作流没有可读的源文件(可能是内置的)。')
    }

    let assist: WorkflowAssistantOutput
    try {
      assist = await this.deps.assist.assist({
        description: (req.focus ?? '').trim(),
        mode: 'explain',
        detail,
        subjectYaml: yaml,
        contextHints: await this.contextHints(),
        by: userId,
        ...(req.onChunk ? { onChunk: req.onChunk } : {}),
      })
    } catch (err) {
      return denyExplain('assistant_unavailable', 'AI 助手暂时不可用,请稍后再试。', errMsg(err))
    }
    // Explain mode echoes `subjectYaml` verbatim, so a non-valid verdict means the
    // STORED workflow's YAML didn't parse — shouldn't happen, but stay defensive.
    if (assist.draftStatus !== 'valid') {
      return denyExplain('assistant_failed', '这个工作流的内容暂时没法讲解。', assist.validationError)
    }

    return {
      ok: true,
      workflowId,
      yaml: assist.yaml,
      explanation: assist.explanation,
      detail,
      ...(assist.graph ? { graph: assist.graph } : {}),
      ...(assist.deepCheck ? { deepCheck: assist.deepCheck } : {}),
    }
  }

  /**
   * Build the cross-hub boundary inputs EXACTLY like the controller's
   * `computeCrossHubSteps` / the editor's `boundaryInputs`: the local-capability
   * set excludes the off-hub destinations' own participant ids, so a capability
   * a peer/A2A agent itself advertises isn't mistaken for "served locally".
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
   * Real local agent capabilities → assistant `contextHints`, so it authors
   * using the hub's actual capability names AND the deep-check has a live
   * inventory to flag fabricated capabilities against. MCD-M4: also the
   * installed MCP server names (best-effort) so the architect prefers already-
   * assemblable backends. Async because the MCP names come from the on-disk
   * registry.
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

/**
 * The prompt the architect sees in author mode: the member's description + (if
 * present) the prior turns of this authoring conversation, with a hint to stay
 * local. The hint is belt; the cross-hub reject (step 3) is suspenders — a model
 * that ignores the hint produces a workflow we refuse, not one we trust.
 */
function composeCreatePrompt(instruction: string, history: ReadonlyArray<MeWorkflowEditTurn> = []): string {
  const conversation = history.length
    ? [
        '',
        '=== 之前的对话(仅供理解上下文) ===',
        '这段对话只用来理解用户这次描述里的指代(比如「再加一步审批」「改成每天触发」);标了失败的要求说明那种做法被拒绝了,不要原样重试。',
        ...history.map((t, i) => `${i + 1}. 用户: ${t.instruction}${t.outcome ? `\n   结果: ${t.outcome}` : ''}`),
      ]
    : []
  return [
    '请根据用户的描述新建一个 Gotong 工作流,然后输出**完整的** YAML。',
    '只能用这个 hub 本地已有的能力(见 contextHints 里列出的 agent 能力),**不要**派发到别的 hub。',
    ...conversation,
    '',
    '=== 用户的描述 ===',
    instruction.trim(),
  ].join('\n')
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function denyCreate(
  reason: MeWorkflowCreateDenyReason,
  message: string,
  extra?: { detail?: string; draftStatus?: WorkflowAssistantOutput['draftStatus'] },
): MeWorkflowCreateDenied {
  return {
    ok: false,
    reason,
    message,
    ...(extra?.detail ? { detail: extra.detail } : {}),
    ...(extra?.draftStatus ? { draftStatus: extra.draftStatus } : {}),
  }
}

function denyExplain(
  reason: MeWorkflowExplainDenyReason,
  message: string,
  detail?: string,
): MeWorkflowExplainDenied {
  return { ok: false, reason, message, ...(detail ? { detail } : {}) }
}
