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
 * Short ids: 8 hex chars of a hash over **这一次要批的这件事** — 见 `imShortId`,
 * 而且要**打全**(七轮 M4:下限=全长,前缀不再是有效的绑定)。Matching runs inside
 * the caller's OWN pending list only, so a code can never reach another user's
 * item even before `resolve` re-checks ownership. Ambiguity (≥2 matches) is an
 * explicit error listing the full short codes — never "first match wins".
 *
 * 同一串指纹还**跟着过权威边界**(七轮 H1):`resolve` 只收 itemId,而同一个 id 会被
 * 管家反复 park,所以判据以谓词形式交给 store,在它自己的原子 transition 里跑。
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

import { createHash } from 'node:crypto'

import type { InboxDecision, InboxItem } from '@gotong/inbox'

import { clipApprovalText, hasVisibleContent, sanitizeApprovalText } from './approval-text.js'

/** How many short-id chars the list view prints (enough to be unique in practice). */
export const IM_SHORT_ID_LEN = 8
/**
 * 短码必须**打全**(Codex 七轮 M4)。
 *
 * 曾经允许 4 位前缀图个好打,但短码是内容指纹之后,前缀就是把指纹削短:16 bit
 * 里,一个被重新 park 过的新动作有实打实的概率仍然唯一匹配上聊天记录里的旧码
 * ——匹配上了就没有歧义报错,人以为在批旧的那条。打全 8 位 ⇒ `startsWith` 退化
 * 成相等 ⇒ 旧码只可能匹配上**内容一模一样**的那条(那批它就是对的)。
 */
const MIN_SHORT_ID = IM_SHORT_ID_LEN

/**
 * 一条待批项的短码。**内容指纹,不是槽位号**(Codex 六轮 H1)。
 *
 * 收件箱按 `itemId = task.id` 寻址,而一个任务在同一个 id 下会**反复 park**:
 * 管家的 tool-loop 批准一次、跑完、接着又要批第二个动作,写的是同一个 itemId
 * (`FileInboxStore.write` 直接覆盖)。于是「短码 = itemId 前 8 位」这个做法有个
 * 洞:聊天记录里往上翻一条旧的 `/inbox`,那串短码今天仍然匹配得上,但它指向的
 * 已经是**另一个动作**了——人以为在批「读一个文件」,批下去的是「往外发」。
 *
 * 所以短码绑定的是内容:itemId + 入箱时刻 + 标题 + 正文。动作一变,短码就变,
 * 旧短码落到 `not_found`(桥会说「可能已被处理,发 /inbox 看最新列表」)。同一件事
 * 没变过 ⇒ 短码稳定,`/inbox` 抄下来直接能用。
 *
 * 各段**带长度前缀**再喂哈希:不用分隔符就不存在「把分隔符写进标题里凑出另一段
 * 组合」这种事,也不用在源码里写控制字符。
 *
 * 字节按 **UTF-16LE** 喂(Codex 七轮 L5):`hash.update(string)` 默认按 UTF-8 编,
 * 而 UTF-8 编不出落单的代理项——它们会被塞成 U+FFFD,于是「两条不同的 prompt
 * 得到同一个指纹」在 JS 字符串上是可构造的。`length` 前缀也按同一套算(UTF-16
 * 码元数 = `.length`),整个函数就在一个编码里自洽。
 */
export function imShortId(item: InboxItem): string {
  const h = createHash('sha256')
  for (const part of [item.itemId, String(item.createdAt), item.title ?? '', item.prompt]) {
    h.update(String(part.length)).update(':').update(Buffer.from(part, 'utf16le'))
  }
  return h.digest('hex').slice(0, IM_SHORT_ID_LEN)
}
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
    /** 代际判据,由权威在自己的原子 transition 里跑(Codex 七轮 H1)。 */
    expect?: (item: InboxItem) => boolean
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
          shortId: imShortId(i),
          title: row.text,
          kind: i.kind,
          // 三个条件缺一不可:写入时标了 / 是二值审批 / 这行字是完整的。
          imApprovable: i.imApprovable === true && i.kind === 'approval' && row.complete,
          createdAt: i.createdAt,
        }
      })
  }

  /**
   * Approve / deny one item identified by its short code (a content
   * fingerprint — see {@link imShortId} — never an itemId prefix). Throws
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
    // Match within the caller's own pending items only. 短码是**内容指纹**:同一个
    // itemId 被后来的动作覆盖过 ⇒ 指纹变了 ⇒ 旧短码匹配不上,落 not_found。
    // 下限=全长之后 `startsWith` 实际上就是相等(多打几位 ⇒ 谁也不匹配 ⇒ not_found,
    // 和打错一样),`ambiguous` 那一支只剩真·8 位十六进制撞车这一条路。
    const mine = await this.store.listPending(args.userId)
    const matches = mine.filter((i) => imShortId(i).startsWith(shortId))
    if (matches.length === 0) {
      throw new ImApprovalError('not_found', `no pending item matches '${shortId}'`)
    }
    if (matches.length > 1) {
      const codes = matches.map((i) => imShortId(i)).join(', ')
      throw new ImApprovalError('ambiguous', `more than one item matches '${shortId}': ${codes}`)
    }
    const item = matches[0]!
    const code = imShortId(item)
    // Server-side re-check of the write-time whitelist — the risk call is the
    // flag's, never the bridge's. Unset ⇒ web-only, fail-closed.
    if (item.imApprovable !== true) {
      throw new ImApprovalError('web_only', `item '${code}' must be handled on the web`)
    }
    // v1 answers approval items only; choice/edit need a value, not a yes/no.
    if (item.kind !== 'approval') {
      throw new ImApprovalError(
        'not_approval_kind',
        `item '${code}' needs a ${item.kind} answer — use the web`,
      )
    }
    // 再算一次而不是信列表:批准的前提是「现在这一刻,这行字读得全」。
    const row = imRowText(item)
    if (!row.complete) {
      throw new ImApprovalError(
        'title_truncated',
        `item '${code}' is too long to show in one IM line — use the web`,
      )
    }
    const decision: InboxDecision = { kind: 'approval', approved: args.approved }
    await this.inbox.resolve({
      itemId: item.itemId,
      userId: args.userId,
      decision,
      via: args.via,
      // 指纹**跟着过权威边界**(Codex 七轮 H1)。上面这一路检查读的是快照,而
      // resolve 只拿到 itemId——同一个 id 在这中间被管家重新 park 一次,那边的
      // pending 判据照样放行(新的一条也是 pending),批下去的就是另一个动作了。
      // 判据必须在 store 的原子 transition 里跑,所以把它传进去,而不是在这里
      // 多算一遍。
      expect: (fresh) => imShortId(fresh) === code,
    })
    return { title: row.text }
  }
}

/**
 * 一条待批项在 IM 里的那行字 + 它读不读得全。
 *
 * `complete:false` 是**授权判据**不是排版结果:一行放不下 ⇒ 这条只能在网页上批。
 * 截断了就必须说自己截了(`clipApprovalText` 负责),不说的节选读起来就是全文。
 *
 * **正文永远在这行字里**(Codex 七轮 M3)。网页 `/me` 的审批卡显示 title + prompt
 * 两个字段,而 prompt 才是权威的那一段;只渲染 title 会把正文藏起来——
 * `{title:'排班确认', prompt:<整张表>}` 那种形状读起来短、批下去是另一回事。两段
 * 一起量之后,那种形状自然超过一行预算、自然落网页,**判据只有一个**:一行放得下
 * 的、说全了的,才能在手机上批。
 *
 * 标题只在**它说了正文没说的话**时才加进来。管家 park 的 prompt 是一整句
 * `管家「X」想执行一个敏感动作:「<title>」。原因:「<why>」。`——title 是它的子串,
 * 两段拼起来只会把同一件事说两遍,还平白多花掉一行预算里的二十来个字。
 */
function imRowText(item: InboxItem): { text: string; complete: boolean } {
  const title = item.title?.trim() ?? ''
  const body = item.prompt.trim()
  const raw = title === '' || body.includes(title) ? body : `${title} · ${body}`
  const clean = sanitizeApprovalText(raw)
  // 洗完读不出东西 ⇒ 不是「一行短短的动作」,是**一行看不见的东西**(Codex 六轮 H2:
  // `title` 写成一个零宽字符就能得到一条近乎空白、却仍然可批的行)。空白永远不是
  // 一个完整的故事,所以降级成网页处理,并把这件事说出来。
  if (!hasVisibleContent(clean)) return { text: '(这条没有可显示的内容)', complete: false }
  if (clean.length <= IM_TITLE_CHARS) return { text: clean, complete: true }
  return { text: clipApprovalText(raw, IM_TITLE_CHARS), complete: false }
}
