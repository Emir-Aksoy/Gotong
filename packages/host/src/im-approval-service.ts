/**
 * im-approval-service.ts — IMA-M2: resolve `/me` inbox items from a bound IM
 * chat (`/inbox`, `/approve <id>`, `/deny <id>`).
 *
 * This is a THIN adapter in front of the existing approval machinery, not a
 * second authority:
 *
 *   - identity   = the bridge's `im_bindings` lookup (same userId the web
 *     session would carry);
 *   - ownership / race guard / decision validation / two-step resume / the
 *     S1-M3 outcome push-back all stay inside `HostInboxService.resolve` —
 *     this service never touches the hub;
 *   - the plan-b risk gate is the `imApprovable` WHITELIST flag decided at
 *     item-WRITE time (human-step broker / butler escalation). We re-check it
 *     here server-side — the bridge layer renders text and is never trusted
 *     with the risk call.
 *
 * Short ids: an itemId PREFIX (min 4 chars; lists print the first 8). Matching
 * runs inside the caller's OWN pending list only, so a prefix can never reach
 * another user's item even before `resolve` re-checks ownership. Ambiguity
 * (≥2 matches) is an explicit error listing the full short codes — never
 * "first match wins".
 */

import type { InboxDecision, InboxItem } from '@gotong/inbox'

/** Minimum prefix length we accept — below this, collisions get silly. */
const MIN_SHORT_ID = 4
/** How many itemId chars the list view prints (enough to be unique in practice). */
export const IM_SHORT_ID_LEN = 8

export type ImApprovalErrorCode =
  | 'short_id_too_short'
  | 'not_found'
  | 'ambiguous'
  | 'web_only'
  | 'not_approval_kind'

export class ImApprovalError extends Error {
  readonly code: ImApprovalErrorCode
  constructor(code: ImApprovalErrorCode, message: string) {
    super(message)
    this.name = 'ImApprovalError'
    this.code = code
  }
}

/** One row of the `/inbox` list — pre-shaped for a plain-text IM rendering. */
export interface ImApprovalItemRow {
  shortId: string
  title: string
  kind: string
  /** false ⇒ the row is shown but must be handled on the web (`/me`). */
  imApprovable: boolean
  createdAt: number
}

/** What we need from the inbox store (read side). */
export interface ImApprovalStore {
  listPending(userId: string): Promise<InboxItem[]>
}

/** What we need from HostInboxService (write side — the real authority). */
export interface ImApprovalResolver {
  resolve(args: {
    itemId: string
    userId: string
    decision: unknown
    via?: string
  }): Promise<void>
}

export interface ImApprovalServiceOptions {
  store: ImApprovalStore
  inbox: ImApprovalResolver
}

export class ImApprovalService {
  private readonly store: ImApprovalStore
  private readonly inbox: ImApprovalResolver

  constructor(opts: ImApprovalServiceOptions) {
    this.store = opts.store
    this.inbox = opts.inbox
  }

  /** Pending items for the caller, newest first, pre-shaped for IM text. */
  async listForIm(userId: string): Promise<ImApprovalItemRow[]> {
    const items = await this.store.listPending(userId)
    return items
      .slice()
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((i) => ({
        shortId: i.itemId.slice(0, IM_SHORT_ID_LEN),
        title: titleOf(i),
        kind: i.kind,
        imApprovable: i.imApprovable === true && i.kind === 'approval',
        createdAt: i.createdAt,
      }))
  }

  /**
   * Approve / deny one item identified by an itemId prefix. Throws
   * `ImApprovalError` for the IM-specific gates; `HostInboxService.resolve`
   * errors (`already_resolved`, `forbidden`, …) pass through untouched so the
   * bridge maps ONE error vocabulary.
   */
  async resolveByShortId(args: {
    userId: string
    shortId: string
    approved: boolean
    /** Audit channel tag, e.g. `im:telegram` — recorded by resolve's audit row. */
    via: string
  }): Promise<{ title: string }> {
    const shortId = args.shortId.trim()
    if (shortId.length < MIN_SHORT_ID) {
      throw new ImApprovalError(
        'short_id_too_short',
        `short id must be at least ${MIN_SHORT_ID} characters`,
      )
    }
    // Match within the caller's own pending items only.
    const mine = await this.store.listPending(args.userId)
    const matches = mine.filter((i) => i.itemId.startsWith(shortId))
    if (matches.length === 0) {
      throw new ImApprovalError('not_found', `no pending item matches '${shortId}'`)
    }
    if (matches.length > 1) {
      const codes = matches.map((i) => i.itemId.slice(0, IM_SHORT_ID_LEN)).join(', ')
      throw new ImApprovalError('ambiguous', `more than one item matches '${shortId}': ${codes}`)
    }
    const item = matches[0]!
    // Server-side re-check of the write-time whitelist — the risk call is the
    // flag's, never the bridge's. Unset ⇒ web-only, fail-closed.
    if (item.imApprovable !== true) {
      throw new ImApprovalError(
        'web_only',
        `item '${item.itemId.slice(0, IM_SHORT_ID_LEN)}' must be handled on the web`,
      )
    }
    // v1 answers approval items only; choice/edit need a value, not a yes/no.
    if (item.kind !== 'approval') {
      throw new ImApprovalError(
        'not_approval_kind',
        `item '${item.itemId.slice(0, IM_SHORT_ID_LEN)}' needs a ${item.kind} answer — use the web`,
      )
    }
    const decision: InboxDecision = { kind: 'approval', approved: args.approved }
    await this.inbox.resolve({
      itemId: item.itemId,
      userId: args.userId,
      decision,
      via: args.via,
    })
    return { title: titleOf(item) }
  }
}

/** Short human line for a row: explicit title, else the prompt clipped. */
function titleOf(item: InboxItem): string {
  const t = item.title?.trim()
  if (t) return t.length > 80 ? t.slice(0, 79) + '…' : t
  const p = item.prompt.trim()
  return p.length > 80 ? p.slice(0, 79) + '…' : p
}
