/**
 * `StewardPort` — the small plan/apply seam the IM steward router talks to.
 *
 * It mirrors the host's `MeHubStewardSurface` (the duck-typed seam the web layer
 * uses — see `packages/web/src/me-routes.ts`): `plan` turns one plain-language
 * instruction into a CLASSIFIED proposal with ZERO side effects, and `apply`
 * executes ONE accepted action. A production IM host would point this at the
 * SAME host surface the admin / `/me` SPA uses (one steward, three transports:
 * admin console, `/me` SPA, IM). This example ships an in-process `FakeStewardPort`
 * so the demo runs offline.
 *
 * What is REAL here (not faked): the risk TIER each action gets. The port runs the
 * shipped `classifyStewardAction` from `@aipehub/hub-steward`, so a `delete_agent`
 * honestly tiers `dangerous`, an `edit_workflow` on a cross-hub workflow honestly
 * tiers `cross_hub`, and an out-of-scope ask honestly tiers `forbidden`. The only
 * faked bit is the "LLM" that turns an instruction into actions — exactly like
 * every other example that stands in a deterministic provider for a real one.
 *
 * The one production discipline this port keeps: `apply` RE-CLASSIFIES the action
 * server-side; it never trusts the tier `plan` returned. A forged tier can't make
 * a dangerous action run inline.
 */

import {
  classifyStewardAction,
  type StewardAction,
  type StewardActionTier,
  type StewardClassifyContext,
} from '@aipehub/hub-steward'

// ---------------------------------------------------------------------------
// Public seam — what the router depends on.
// ---------------------------------------------------------------------------

/** One proposed action + the host-assigned tier + a member-readable summary. */
export interface StewardClassifiedAction {
  action: StewardAction
  tier: StewardActionTier
  /** One-line zh description of what the action will do. */
  summary: string
}

export interface StewardPlanResult {
  /** The steward's conversational reply (always present). */
  reply: string
  /** The concrete actions proposed (may be empty for pure chit-chat). */
  actions: StewardClassifiedAction[]
}

/**
 * What `apply` resolves to. Each variant carries its own `status` so the router
 * branches without inspecting anything else (mirrors `MeHubStewardApplyResult`).
 */
export type StewardApplyResult =
  | { status: 'done'; tier: StewardActionTier; subject?: string }
  | { status: 'pending_approval'; tier: StewardActionTier; inboxItemId: string; subject?: string }
  | { status: 'refused'; reason: string }
  | { status: 'invalid'; reason: string }

export interface StewardPort {
  /** Propose: ZERO side effects. */
  plan(input: { userId: string; instruction: string }): Promise<StewardPlanResult>
  /** Apply ONE accepted action (re-classified server-side). */
  apply(input: { userId: string; action: StewardAction }): Promise<StewardApplyResult>
  /**
   * Optional notify-back seam (D-M2): the router subscribes here so that when a
   * parked action is resolved in the user's `/me` inbox, the bridge pushes an IM
   * message telling them the outcome. In production this is the existing
   * multi-channel inbox / alert delivery (F day-3 `im` channel, MC-M1..M7); the
   * example models it as a direct callback.
   */
  onInboxResolve?(cb: (ev: StewardInboxResolveEvent) => void | Promise<void>): void
}

/**
 * What the port emits when an approval-inbox item is resolved (in `/me`). The
 * router listens for this and pushes an async notify-back to the IM user (D-M2).
 * In production the inbox lives in `@aipehub/inbox` + `HostInboxService`; this
 * example keeps a tiny in-memory stand-in so the notify-back is demonstrable.
 */
export interface StewardInboxResolveEvent {
  userId: string
  itemId: string
  action: StewardAction
  tier: StewardActionTier
  decision: 'approved' | 'rejected'
  subject?: string
}

// ---------------------------------------------------------------------------
// Fixed snapshot — what the demo member "owns". Real plans build this from
// `HostMeAgentService.listOwned` + the workflow catalog; baking it keeps the
// example offline. The cross-hub workflow id is what makes the `cross_hub`
// classification REAL rather than hand-asserted.
// ---------------------------------------------------------------------------

/** The member steward's participant id (matches the shipped agent — A-M1). */
const MEMBER_STEWARD_ID = 'hub-steward'

/** The demo member's editable workflows; `cross-hub-review` leaves this hub. */
const LOCAL_WORKFLOW_ID = 'local-digest'
const CROSS_HUB_WORKFLOW_ID = 'cross-hub-review'
const CROSS_HUB_WORKFLOWS: ReadonlySet<string> = new Set([CROSS_HUB_WORKFLOW_ID])

interface FakeInboxItem {
  id: string
  userId: string
  action: StewardAction
  tier: StewardActionTier
  subject?: string
  status: 'pending' | 'resolved'
}

export class FakeStewardPort implements StewardPort {
  /** Executed-action records, exposed so the demo can self-assert. */
  readonly createdAgents: string[] = []
  readonly deletedAgents: string[] = []
  readonly editedWorkflows: string[] = []

  private inbox = new Map<string, FakeInboxItem>()
  private seq = 0
  private resolveListener:
    | ((ev: StewardInboxResolveEvent) => void | Promise<void>)
    | null = null

  /** The router subscribes here to push the async notify-back (D-M2). */
  onInboxResolve(cb: (ev: StewardInboxResolveEvent) => void | Promise<void>): void {
    this.resolveListener = cb
  }

  /** How many approval items are still waiting — for self-assertion. */
  pendingInboxCount(): number {
    let n = 0
    for (const item of this.inbox.values()) if (item.status === 'pending') n++
    return n
  }

  /**
   * The id of the most-recently-parked still-pending item for a user — the demo
   * uses it to simulate the user resolving it in their `/me` inbox. (A real `/me`
   * resolve carries the item id from the inbox listing.)
   */
  latestPendingFor(userId: string): string | undefined {
    let found: string | undefined
    for (const item of this.inbox.values()) {
      if (item.userId === userId && item.status === 'pending') found = item.id
    }
    return found
  }

  /** The classify context for THIS caller — a member (never an operator). */
  private ctx(): StewardClassifyContext {
    return {
      crossHubWorkflowIds: CROSS_HUB_WORKFLOWS,
      stewardId: MEMBER_STEWARD_ID,
      // The member IM caller is NEVER an operator: sensitive writes tier
      // `forbidden`, so the steward only explains them, never proposes one.
      operator: false,
    }
  }

  async plan(input: { userId: string; instruction: string }): Promise<StewardPlanResult> {
    const actions = proposeActions(input.userId, input.instruction)
    const classified: StewardClassifiedAction[] = actions.map((action) => ({
      action,
      tier: classifyStewardAction(action, this.ctx()),
      summary: summarize(action),
    }))
    return { reply: buildReply(classified), actions: classified }
  }

  async apply(input: { userId: string; action: StewardAction }): Promise<StewardApplyResult> {
    // ★ Server re-classify — never trust a tier the caller passed in.
    const tier = classifyStewardAction(input.action, this.ctx())
    if (tier === 'forbidden') {
      return { status: 'refused', reason: refuseReason(input.action) }
    }
    if (tier === 'safe') {
      this.executeSilently(input.userId, input.action)
      return { status: 'done', tier, subject: subjectOf(input.action) }
    }
    // dangerous | cross_hub → the approval inbox (a human's SECOND confirmation).
    const id = `steward-inbox-${++this.seq}`
    this.inbox.set(id, {
      id,
      userId: input.userId,
      action: input.action,
      tier,
      subject: subjectOf(input.action),
      status: 'pending',
    })
    return { status: 'pending_approval', tier, inboxItemId: id, subject: subjectOf(input.action) }
  }

  /**
   * Demo-only: simulate the user resolving the parked item in their `/me`
   * inbox. On approve the action finally executes; either way the resolve event
   * fires so the router can notify the user back over IM (D-M2). Idempotent —
   * resolving the same item twice is a no-op.
   */
  async resolveInbox(itemId: string, decision: 'approved' | 'rejected'): Promise<void> {
    const item = this.inbox.get(itemId)
    if (!item || item.status !== 'pending') return
    item.status = 'resolved'
    if (decision === 'approved') this.executeSilently(item.userId, item.action)
    await this.resolveListener?.({
      userId: item.userId,
      itemId,
      action: item.action,
      tier: item.tier,
      decision,
      ...(item.subject ? { subject: item.subject } : {}),
    })
  }

  private executeSilently(userId: string, action: StewardAction): void {
    switch (action.kind) {
      case 'create_agent':
        this.createdAgents.push(`me.${userId}.${action.handle}`)
        break
      case 'delete_agent':
        this.deletedAgents.push(action.agentId)
        break
      case 'edit_workflow':
        this.editedWorkflows.push(action.workflowId)
        break
      default:
        // inspect / refuse / sensitive: nothing to execute here.
        break
    }
  }
}

// ---------------------------------------------------------------------------
// The deterministic "LLM" — keyword-routed instruction → actions. The host's
// real steward is an LlmAgent; this stand-in is the only faked part, and its
// output is fed through the REAL classifier above.
// ---------------------------------------------------------------------------

function proposeActions(userId: string, instruction: string): StewardAction[] {
  const text = instruction.toLowerCase()
  const has = (...needles: string[]): boolean =>
    needles.some((n) => instruction.includes(n) || text.includes(n))

  // Sensitive (operator-only) asks: a member steward NEVER proposes the write —
  // it proposes a `refuse` that explains + points to the settings panel. The
  // classifier tiers `refuse` as `forbidden`, so apply returns `refused`.
  if (has('凭证', '密钥', 'credential', 'api key', 'apikey', 'token', 'peer', '配额', 'quota')) {
    return [
      {
        kind: 'refuse',
        reason:
          '凭证 / 对端 / 安全配额属于 operator 级敏感设置，我不能替你写。请让管理员在设置面板里配置（密钥永远走环境变量，绝不经聊天）。',
      },
    ]
  }

  // Delete an owned agent → DESTRUCTIVE → dangerous tier → approval inbox.
  if (has('删', '移除', 'delete', 'remove')) {
    return [{ kind: 'delete_agent', agentId: `me.${userId}.mailer` }]
  }

  // Edit the cross-hub workflow → leaves this hub → cross_hub tier → inbox.
  if (has('跨 hub', '跨hub', 'cross', '评审', 'review')) {
    return [
      {
        kind: 'edit_workflow',
        workflowId: CROSS_HUB_WORKFLOW_ID,
        instruction,
      },
    ]
  }

  // Edit the purely-local workflow → safe → inline.
  if (has('摘要', 'digest', '改工作流', 'edit workflow')) {
    return [{ kind: 'edit_workflow', workflowId: LOCAL_WORKFLOW_ID, instruction }]
  }

  // Build a new agent → safe → inline.
  if (has('建', '新建', '创建', 'create', '助手', 'agent', 'bot')) {
    return [
      {
        kind: 'create_agent',
        handle: 'support',
        label: '客服助手',
        provider: 'mock',
        system: '你是一个礼貌、简洁的客服助手。',
        capabilities: ['chat'],
      },
    ]
  }

  // Anything else: a read-only answer about what the member owns.
  return [
    {
      kind: 'inspect',
      answer:
        '你现在有 2 个助手（mailer、notes）和 2 个工作流（local-digest 本地、cross-hub-review 跨 hub）。想建助手、删助手、还是改工作流？',
    },
  ]
}

// ---------------------------------------------------------------------------
// Small renderers (zh) — all derived from the action object, never from a
// client-supplied string.
// ---------------------------------------------------------------------------

function summarize(action: StewardAction): string {
  switch (action.kind) {
    case 'inspect':
      return action.answer
    case 'create_agent':
      return `新建助手 ${action.handle}（${action.label}）`
    case 'edit_agent':
      return `修改助手 ${action.agentId}`
    case 'delete_agent':
      return `删除助手 ${action.agentId}`
    case 'edit_workflow':
      return `用大白话修改工作流 ${action.workflowId}`
    case 'set_credential_ref':
      return `登记 ${action.provider} 凭证（读环境变量 ${action.envVarName}）`
    case 'revoke_credential':
      return `撤销凭证 ${action.credentialId}`
    case 'set_peer_policy':
      return `修改对端 ${action.peerId} 的信任契约`
    case 'set_security_quota':
      return `设置安全配额 ${action.scope}/${action.metric}`
    case 'refuse':
      return action.reason
  }
}

function subjectOf(action: StewardAction): string | undefined {
  switch (action.kind) {
    case 'create_agent':
      return action.handle
    case 'edit_agent':
    case 'delete_agent':
      return action.agentId
    case 'edit_workflow':
      return action.workflowId
    case 'set_credential_ref':
      return action.provider
    case 'revoke_credential':
      return action.credentialId
    case 'set_peer_policy':
      return action.peerId
    case 'set_security_quota':
      return action.scope
    default:
      return undefined
  }
}

function refuseReason(action: StewardAction): string {
  return action.kind === 'refuse'
    ? action.reason
    : '这件事超出我的权限，我只能说明、不能替你执行。'
}

function buildReply(actions: StewardClassifiedAction[]): string {
  if (actions.length === 0) return '我没什么要替你改的，随时找我。'
  if (actions.length === 1 && actions[0]!.action.kind === 'inspect') {
    return actions[0]!.summary
  }
  if (actions.every((a) => a.tier === 'forbidden')) {
    return '这件事超出我的权限，我只能说明：'
  }
  return '我准备了下面的动作，请挑选执行：'
}
