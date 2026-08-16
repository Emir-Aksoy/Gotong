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

import { createHmac, randomBytes } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  writeSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

import type { InboxDecision, InboxItem } from '@gotong/inbox'

import {
  clipApprovalText,
  hasVisibleContent,
  sanitizeApprovalText,
} from './approval-text.js'

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
 *
 * **带密钥**(Codex 八轮 M2)。8 位十六进制只有 32 bit,不带密钥的话攻击者能自己
 * 算:被注入的阿同知道自己那次 park 的 title/prompt,`createdAt` 也就是它调用工具
 * 那一刻的几十毫秒之内——把候选逐个试过去,再磨一个新动作让它的指纹撞上人手里
 * 那串旧码,就把「旧码认不出新动作」这道闸整个绕过去了。而 HANDS-M2 之后**它有
 * 手**:tier 1 命令免审批、在监狱里就能跑一个磨哈希的脚本,算力不再是门槛。
 * 换成 HMAC 之后它连算都算不出来——磨谁都不知道,这条路结构性关掉;密钥只在
 * hub 盘上(`<space>/runtime/im-shortcode.key`,0600),永不出 hub、永不进模型上下文。
 */
export function imShortId(item: InboxItem, key: Buffer): string {
  const h = createHmac('sha256', key)
  for (const part of [item.itemId, String(item.createdAt), item.title ?? '', item.prompt]) {
    h.update(String(part.length)).update(':').update(Buffer.from(part, 'utf16le'))
  }
  return h.digest('hex').slice(0, IM_SHORT_ID_LEN)
}

/** 短码密钥的长度。32 字节 = HMAC-SHA256 的一整块,没有理由更短。 */
const SHORT_CODE_KEY_BYTES = 32

/**
 * 读出(或首次生成)这台 hub 的短码密钥。
 *
 * 镜像 `loadOrCreateSigningKey` 的姿态:0600、缺了就生成、**坏了就抛**。坏了不
 * 静默重建有两个理由——重建会让所有在飞的短码一起失效(人手里抄好的码全部落
 * `not_found`),而且「密钥被人动过」本身就是要说出来的事,不是要悄悄抹平的事。
 *
 * 生成走 `'wx'`(O_CREAT|O_EXCL,Codex 九轮 L):`existsSync` 之后再 `writeFileSync`
 * 中间有一条缝——两个 hub 同时首启会各写各的(后写的那把赢,先写那把签出去的码
 * 当场作废),而 `writeFileSync` 会**跟着符号链接**写到别处去。`wx` 把「不存在才
 * 创建」交给内核一次完成,EEXIST 就说明有人先到了:回头读那一把,不覆盖。
 *
 * 读的时候顺手把权限按回 0600。旧版本或搬迁把它留成了组可读,这里不是「发现了
 * 攻击」而是「把它修回该有的样子」——密钥的模式不该指望上一任写对。
 */
export function loadOrCreateShortCodeKey(spaceRoot: string): Buffer {
  const file = join(spaceRoot, 'runtime', 'im-shortcode.key')
  if (existsSync(file)) return readShortCodeKey(file)
  mkdirSync(dirname(file), { recursive: true })
  const key = randomBytes(SHORT_CODE_KEY_BYTES)
  let fd: number
  try {
    fd = openSync(file, 'wx', 0o600)
  } catch (err) {
    // 有人先到了(并发首启),或者那个名字已经是个链接。两种情况的正确答案都是
    // 「读它,别覆盖」——覆盖会作废另一边刚签出去的码。
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return readShortCodeKey(file)
    throw err
  }
  try {
    writeSync(fd, key)
  } finally {
    closeSync(fd)
  }
  // `mode` on openSync is masked by umask on some platforms; state it again.
  chmodSync(file, 0o600)
  return key
}

/** 读一把已存在的短码密钥:长度不够就抛,权限松了就按回 0600。 */
function readShortCodeKey(file: string): Buffer {
  const raw = readFileSync(file)
  if (raw.length < SHORT_CODE_KEY_BYTES) {
    throw new Error(
      `IM short-code key '${file}' is ${raw.length} bytes; expected at least ${SHORT_CODE_KEY_BYTES}. ` +
        'Refusing to start rather than silently minting a new one (every outstanding /approve code would change).',
    )
  }
  if ((statSync(file).mode & 0o077) !== 0) chmodSync(file, 0o600)
  return raw
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
  /**
   * 短码的 HMAC 密钥(Codex 八轮 M2)。**必填,没有静默回落**——回落成不带密钥的
   * 摘要就等于把这道防线悄悄关掉,而关掉与没关从外面看一模一样。
   * 生产由 `loadOrCreateShortCodeKey(spaceRoot)` 供给。
   */
  shortCodeKey: Buffer
}

export class ImApprovalService {
  private readonly store: ImApprovalStore
  private readonly inbox: ImApprovalResolver
  private readonly key: Buffer

  constructor(opts: ImApprovalServiceOptions) {
    this.store = opts.store
    this.inbox = opts.inbox
    this.key = opts.shortCodeKey
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
          shortId: imShortId(i, this.key),
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
    const matches = mine.filter((i) => imShortId(i, this.key).startsWith(shortId))
    if (matches.length === 0) {
      throw new ImApprovalError('not_found', `no pending item matches '${shortId}'`)
    }
    if (matches.length > 1) {
      const codes = matches.map((i) => imShortId(i, this.key)).join(', ')
      throw new ImApprovalError('ambiguous', `more than one item matches '${shortId}': ${codes}`)
    }
    const item = matches[0]!
    const code = imShortId(item, this.key)
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
      // `imApprovable` 也一起钉(九轮 L):上面那道 web-only 闸读的是快照。指纹
      // 盖住 itemId/createdAt/title/prompt——重新 park 一定换 `createdAt`,所以
      // park 这条路已经被盖住了;但「谁把这一项标成可在 IM 批」这个判断本身,
      // 应该在它被执行的那一刻仍然成立,而不是靠另一个字段间接推出来。
      expect: (fresh) => fresh.imApprovable === true && imShortId(fresh, this.key) === code,
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
 * 标题只在**它说了正文没说的话**时才加进来,而这个判断锚在**框架的定界符**上
 * (Codex 八轮 M1)。七轮那版问的是「正文里有没有出现标题这串字」——那是拿一个
 * 攻击者两头都能写的子串关系当判据:`title:'删除生产数据库'` 配
 * `prompt:'不要删除生产数据库;这里只批准查看健康状态'`,`includes` 成立,标题就被
 * 它自己藏掉了。改成找 `「<title>」`:`sanitizeApprovalText` 会把不可信文本里的
 * `「」` 一律降级成 `『』`,所以洗完的正文里出现的框架定界符**只可能是框架自己
 * 放的**——去重于是只在「框架把标题原样嵌进了自己的句子」时发生(管家 park 的
 * `…敏感动作:「<title>」。` 正是这一种),攻击者拼不出这个条件。
 */
function imRowText(item: InboxItem): { text: string; complete: boolean } {
  const rawTitle = item.title?.trim() ?? ''
  const rawBody = item.prompt.trim()
  // 去重靠**写入方的结构性声明**,不靠在正文里找框架的定界符(Codex 九轮 A-H1)。
  //
  // 上一版的判据是「正文里出现框架亲手加的 `「<title>」`」,前提是「不可信文本里
  // 的 `「」` 已经被降级过」——那对**管家写入方**成立,而且只对它成立:
  // `HumanInboxParticipant` 把 prompt/title 逐字节存下来,工作流 human 步的 prompt
  // 还可以 `$ref` 内联上一步的模型输出。于是那对定界符是可以被伪造的,伪造成功
  // 的效果是**把人写的标题从这行字里抹掉**。写入方知道这件事,渲染层只能猜。
  //
  // 另一条仍留着,因为它不可伪造:正文与标题完全相同 ⇒ 只有一份内容,说一遍即可
  // (攻击者这么做也只是把自己那段话少印一次)。**子串包含**永远不在此列 —— 那是
  // 攻击者两头都能写的关系。
  const embedded = rawTitle !== '' && (item.titleInPrompt === true || rawBody === rawTitle)
  const title = sanitizeApprovalText(rawTitle)
  const body = sanitizeApprovalText(rawBody)
  const clean = rawTitle === '' || embedded ? body : `${title} · ${body}`
  // 洗完读不出东西 ⇒ 不是「一行短短的动作」,是**一行看不见的东西**(Codex 六轮 H2:
  // `title` 写成一个零宽字符就能得到一条近乎空白、却仍然可批的行)。空白永远不是
  // 一个完整的故事,所以降级成网页处理,并把这件事说出来。
  if (!hasVisibleContent(clean)) return { text: '(这条没有可显示的内容)', complete: false }
  // 预算按**码点**量(Codex 八轮 L1)。`.length` 是 UTF-16 码元数,41 个 emoji 会
  // 报 82 > 80 判成截断,而下面的 `clipApprovalText` 按码点看是 41 ≤ 80 原样返回
  // ——列表显示得好好的、没有截断标记,`/approve` 却报「太长」。两处必须用同一把尺。
  if (Array.from(clean).length <= IM_TITLE_CHARS) return { text: clean, complete: true }
  return { text: clipApprovalText(clean, IM_TITLE_CHARS), complete: false }
}
