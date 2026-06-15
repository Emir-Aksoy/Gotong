/**
 * `FamilyOversightPort` — the parent-side approval inbox for off-whitelist / flagged
 * lessons, modelled over a REAL `FileInboxStore`.
 *
 * This is the family-learning twin of im-steward-bridge's `FakeStewardPort`. The steward
 * port modelled its inbox in memory; here we use the REAL `@aipehub/inbox` `FileInboxStore`
 * so the race guard is genuine — a second resolve of the same item throws
 * `InboxError('already_resolved')` (file-inbox-store.ts:159), exactly the teeth the
 * production `HostInboxService.resolve` relies on. The bridge demo asserts that directly.
 *
 * Scope (C-M2): this is the IM OVERSIGHT half in isolation. A real off-whitelist lesson
 * parks through C-M1's federation outbound gate (which carries a workflow / agent parent for
 * the two-step resume that actually wakes the cross-hub lesson). Here `parkLessonApproval`
 * stands in for "C-M1's outbound gate just parked an off-whitelist topic", and
 * `parentKind: 'none'` is honest — the standalone oversight demo only needs to RECORD the
 * parent's decision and push it back over IM; waking the lesson is C-M1's job (proven there).
 * One concern per milestone.
 */

import { FileInboxStore, InboxError, type InboxItem } from '@aipehub/inbox'

/** A lesson that needs the parent's blessing before it may cross to the tutor. */
export interface LessonApprovalRequest {
  /** The 家长 user whose inbox this lands in (and who must act). */
  parentUserId: string
  /** The 孩子 the lesson is for. */
  learnerId: string
  /** The requested topic (off-whitelist, or one a moderation rule flagged). */
  topic: string
  /** Why it needs review (off-whitelist / flagged keyword / …). */
  reason: string
}

/** Fired when a lesson parks — the router pushes it to the bound parent's IM. */
export interface OversightParkEvent extends LessonApprovalRequest {
  itemId: string
}

/** Fired when a parked lesson is resolved (from IM OR /me) — the router pushes the result back. */
export interface OversightResolveEvent {
  parentUserId: string
  itemId: string
  decision: 'approved' | 'rejected'
  learnerId: string
  topic: string
}

/** The discriminated outcome of a resolve attempt (no throw on the common paths). */
export type OversightResolveOutcome =
  | { status: 'done'; decision: 'approved' | 'rejected' }
  | { status: 'not_found' }
  | { status: 'forbidden' } // someone else's child — never resolvable by this parent
  | { status: 'already_resolved' } // the race guard caught a double-resolve

interface ParkMeta {
  learnerId: string
  topic: string
  reason: string
  parentUserId: string
}

export class FamilyOversightPort {
  private readonly store: FileInboxStore
  /** itemId → the lesson context (the inbox item itself only carries a prompt string). */
  private readonly meta = new Map<string, ParkMeta>()
  private seq = 0

  /** D-M2 hooks — the router subscribes to push park notifications / resolve results to IM. */
  public onParked?: (ev: OversightParkEvent) => void | Promise<void>
  public onResolve?: (ev: OversightResolveEvent) => void | Promise<void>

  /** Lessons that crossed to the tutor after parent approval (self-assertion anchor). */
  public readonly crossed: Array<{ learnerId: string; topic: string }> = []

  constructor(store: FileInboxStore) {
    this.store = store
  }

  /** Park a lesson for the parent's approval. Writes a real inbox item + notifies IM. */
  async parkLessonApproval(req: LessonApprovalRequest): Promise<string> {
    const id = ++this.seq
    const itemId = `family-lesson-${id}`
    const item: InboxItem = {
      itemId,
      userId: req.parentUserId,
      kind: 'approval',
      prompt: `孩子「${req.learnerId}」想学「${req.topic}」（${req.reason}）。批准这节课吗？`,
      title: `课程审批：${req.topic}`,
      // 'none' — see the file header: the standalone oversight demo records the decision;
      // the cross-hub lesson it gates is woken by C-M1's two-step resume, not here.
      parentKind: 'none',
      status: 'pending',
      createdAt: Date.now() + id, // +id keeps multiple parks strictly ordered for listPending
    }
    await this.store.write(item)
    this.meta.set(itemId, { ...req })
    await this.onParked?.({ ...req, itemId })
    return itemId
  }

  /** The parent's pending lesson approvals (newest first, matching FileInboxStore order). */
  async pending(parentUserId: string): Promise<InboxItem[]> {
    return this.store.listPending(parentUserId)
  }

  async pendingCount(parentUserId: string): Promise<number> {
    return (await this.store.listPending(parentUserId)).length
  }

  /** Look up the lesson context for an item (for rendering the pending list / push text). */
  metaFor(itemId: string): ParkMeta | undefined {
    return this.meta.get(itemId)
  }

  /**
   * Resolve a parked lesson. Ownership-checked, then `markResolved` (the real race guard).
   * On approval the lesson is recorded as crossed; either way `onResolve` fires so the
   * router pushes ONE result message back over IM — whether the resolve came from IM or /me.
   */
  async resolve(input: {
    parentUserId: string
    itemId: string
    decision: 'approved' | 'rejected'
  }): Promise<OversightResolveOutcome> {
    const item = await this.store.get(input.itemId)
    if (!item) return { status: 'not_found' }
    // A parent may only resolve their OWN child's lesson (anti-cross-parent isolation).
    if (item.userId !== input.parentUserId) return { status: 'forbidden' }

    const approved = input.decision === 'approved'
    try {
      await this.store.markResolved(input.itemId, { kind: 'approval', approved })
    } catch (err) {
      // The race guard: a second resolve of an already-resolved item throws
      // InboxError('already_resolved') BEFORE anything downstream runs.
      if (err instanceof InboxError && err.code === 'already_resolved') {
        return { status: 'already_resolved' }
      }
      throw err
    }

    const meta = this.meta.get(input.itemId)
    if (approved && meta) this.crossed.push({ learnerId: meta.learnerId, topic: meta.topic })
    await this.onResolve?.({
      parentUserId: input.parentUserId,
      itemId: input.itemId,
      decision: input.decision,
      learnerId: meta?.learnerId ?? 'unknown',
      topic: meta?.topic ?? 'unknown',
    })
    return { status: 'done', decision: input.decision }
  }
}
