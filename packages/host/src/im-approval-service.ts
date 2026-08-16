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
 *
 * 行文本(`imRowText`)是**这一层自己的责任**,不是写入方的:
 *
 *   - 洗。`/inbox` 是一行一条的列表,一个换行就能伪造出第二条 `• [deadbeef] …`;
 *     不可见字符与双向覆盖能把真正的动作推到看不见的地方。四个写入方里
 *     `HumanInboxParticipant`(工作流 human 步)的 prompt/title 可以经 `$ref` 内联
 *     上一步的**模型输出**,原样过来。所以洗在这里做一次,覆盖今天的四个写入方和
 *     以后任何一个。
 *   - **看不全就不能在 IM 批**。一行放不下的动作,人在手机上读到的是省略号,
 *     `sh -c '<100 个空格>curl …'` 会长成一条空白的、看起来无害的命令。这种时候
 *     不是把字缩短,是**把这条降级成网页处理**:列表照列(要知道有东西等着),
 *     `/approve` 当场拒绝并指路 `/me`——那里显示完整的 prompt。
 */

import type { InboxDecision, InboxItem } from '@gotong/inbox'

import { clipApprovalText, sanitizeApprovalText } from './approval-text.js'

/** Minimum prefix length we accept — below this, collisions get silly. */
const MIN_SHORT_ID = 4
/** How many itemId chars the list view prints (enough to be unique in practice). */
export const IM_SHORT_ID_LEN = 8
/**
 * 一行字里留给动作的字符数。IM 的 `/inbox` 每条就是一行,再长的东西在手机上
 * 也读不成一行——所以这个数不是「显示预算」,它是**能不能在 IM 批**的判据(见
 * `imRowText`)。
 */
const IM_TITLE_CHARS = 80

export type ImApprovalErrorCode =
  | 'short_id_too_short'
  | 'not_found'
  | 'ambiguous'
  | 'web_only'
  | 'title_truncated'
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
      .map((i) => {
        const row = imRowText(i)
        return {
          shortId: i.itemId.slice(0, IM_SHORT_ID_LEN),
          title: row.text,
          kind: i.kind,
          // 三个条件缺一不可:写入时标了 / 是二值审批 / 这行字是完整的。
          imApprovable: i.imApprovable === true && i.kind === 'approval' && row.complete,
          createdAt: i.createdAt,
        }
      })
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
    // 再算一次而不是信列表:短码可能是从**上一次**列表里抄来的,那次列表甚至可能
    // 是这条被改长之前的。批准的前提是「现在这一刻,这行字读得全」。
    const row = imRowText(item)
    if (!row.complete) {
      throw new ImApprovalError(
        'title_truncated',
        `item '${item.itemId.slice(0, IM_SHORT_ID_LEN)}' is too long to show in one IM line — use the web`,
      )
    }
    const decision: InboxDecision = { kind: 'approval', approved: args.approved }
    await this.inbox.resolve({
      itemId: item.itemId,
      userId: args.userId,
      decision,
      via: args.via,
    })
    return { title: row.text }
  }
}

/**
 * 一条待批项在 IM 里的那行字 + 它读不读得全。
 *
 * `complete:false` 是**授权判据**不是排版结果:一行放不下 ⇒ 这条只能在网页上批。
 * 截断了就必须说自己截了(`clipApprovalText` 负责),不说的节选读起来就是全文。
 */
function imRowText(item: InboxItem): { text: string; complete: boolean } {
  const raw = item.title?.trim() ? item.title.trim() : item.prompt.trim()
  const clean = sanitizeApprovalText(raw)
  if (clean.length <= IM_TITLE_CHARS) return { text: clean, complete: true }
  return { text: clipApprovalText(raw, IM_TITLE_CHARS), complete: false }
}
