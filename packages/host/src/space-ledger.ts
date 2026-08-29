/**
 * STOR-M1 — 空间账本:这台 hub 的磁盘占用长什么样。
 *
 * 存储自治的第一刀刻意只做一件事:**丈量**。`<space>` 按顶层类目分桶数一遍
 * (对话档 / 身份库 / 管家目录逐子目录 / 备份残档族 / 其余),落一份惰性事实
 * 文件 `runtime/space-ledger.json`——self-heal 台账与 M-HEALTH 记忆健康行的
 * 同族:**先落账,读者只读**。三个读者(admin 体检面板「空间」卡 / `my_status`
 * 空间行 / benign 工具 `space_report`)全吃这一份,判定与格式化永不两份。
 * 后面的删除(M2 死物清 / M3 阶梯)在这份账本之上才谈——**M1 一个字节不删,
 * 它的全部产出是数字**。
 *
 * ── 四条边界 ────────────────────────────────────────────────────────────────
 * ① **读不动 ≠ 零**(EFF-M3 判例):space 根打不开时返回 null + warn,绝不
 *    返回一排 0——那会把「我看不见」谎报成「空间是空的」。子树打不开则跳过
 *    (hands `measureTree` 同款读者姿态:观察者遇到打不开的角落继续走,
 *    证据原地留)。
 * ② **有界遍历**:栈式 `opendirSync` 流式走(不 readdir 整表),全局条目
 *    预算 20 万步防挂死;打满如实置 `truncated`——账本宁可说「这是下界」
 *    也不静默装全量(no silent caps)。字节数**刻意不设上限**:人口普查要的
 *    就是真实字节,截断字节数的账本没有意义。
 * ③ **丈量骑既有节律**:调用方(retention sweeper / 管家维护 sweep)每 6h
 *    顺带调一次 `measure`,boot 再量一次——不开新定时器,旋钮 114 冻结。
 * ④ **写盘失败不连累丈量**:账是派生物,量已经量完了;写不进去 warn 一次,
 *    照样把结果返回给调用方(`recordMaintenanceSweep` 同款 best-effort)。
 *
 * 分桶规则(顶层一刀,不做深层聚类——账本回答「哪一类占了多少」,
 * 逐文件明细是 M2 清扫器的事):
 *   - `transcript.jsonl` + `transcript-archive/`      → `transcript`
 *   - `identity.sqlite` 及其 `-wal`/`-shm` 前缀族     → `identity`
 *   - `butler/` 展开一层(子目录各自成 `butler/<子>`,散文件归 `butler`)
 *     ——生产上 butler 是最大的复合桶,不拆一层看不出谁在长
 *   - 根部名字含 `.bak-` 的(部署备份族)              → `bak`
 *   - 其余顶层目录                                     → 各自按名成桶
 *   - 其余根部散文件                                   → `other`
 *   - 顶层符号链接跳过(链接指向的空间不归这本账管)
 */

import { lstatSync, opendirSync, type Dir } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { Logger } from '@gotong/core'
import type { LlmAgentToolset, LlmToolCallResult, LlmToolDefinition } from '@gotong/llm'

/** 全局条目预算(所有桶共享):防病态目录树把 6h 节律的一次丈量走成挂死。 */
export const SPACE_LEDGER_MAX_ENTRIES = 200_000

/** 报告顶多列几个类目行(超出的折成一句「还有 N 个类目」——no silent caps)。 */
const MAX_REPORT_LINES = 12

export interface SpaceLedgerCategory {
  /** 桶名:`transcript` / `identity` / `butler/<子目录>` / `bak` / 顶层目录名 / `other`。 */
  id: string
  bytes: number
  entries: number
}

/** 落盘形状。文件不存在 = 还没量过(未知),**不等于**空间为空。 */
export interface SpaceLedgerFile {
  v: 1
  /** 丈量时刻(epoch ms)。 */
  at: number
  totalBytes: number
  totalEntries: number
  /** 条目预算打满 = 数字是下界不是全量。 */
  truncated: boolean
  /** 按 bytes 降序(并列按 id 升序,渲染确定性)。 */
  categories: SpaceLedgerCategory[]
}

function isCategory(v: unknown): v is SpaceLedgerCategory {
  if (!v || typeof v !== 'object') return false
  const c = v as Partial<SpaceLedgerCategory>
  return typeof c.id === 'string'
    && typeof c.bytes === 'number' && Number.isFinite(c.bytes)
    && typeof c.entries === 'number' && Number.isFinite(c.entries)
}

function isLedger(v: unknown): v is SpaceLedgerFile {
  if (!v || typeof v !== 'object') return false
  const l = v as Partial<SpaceLedgerFile>
  return l.v === 1
    && typeof l.at === 'number' && Number.isFinite(l.at)
    && typeof l.totalBytes === 'number' && Number.isFinite(l.totalBytes)
    && typeof l.totalEntries === 'number' && Number.isFinite(l.totalEntries)
    && typeof l.truncated === 'boolean'
    && Array.isArray(l.categories) && l.categories.every(isCategory)
}

/**
 * 读一次账本,**无缓存**(权威是盘上那份,旁观者每次拉最新——
 * `readButlerMemoryHealth` 同一纪律)。不存在 / 损坏 / 形状不对一律 null。
 */
export async function readSpaceLedger(file: string): Promise<SpaceLedgerFile | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'))
    return isLedger(parsed) ? parsed : null
  } catch {
    return null // 不存在或损坏当未知
  }
}

/** 所有桶共享的遍历预算(可变,打穿即置 truncated)。 */
interface WalkBudget {
  remaining: number
  truncated: boolean
}

/**
 * 量一棵子树(hands `measureTree` 同款姿态:栈 + `opendirSync` 流式 +
 * 符号链接跳过 + `lstatSync` 竞态吞掉 + finally 关句柄),区别两处:
 * 字节不设上限(边界②),条目预算是跨桶共享的注入值而非每树各一份。
 */
function measureSubtree(root: string, budget: WalkBudget): { bytes: number; entries: number } {
  let bytes = 0
  let entries = 0
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()!
    let handle: Dir
    try {
      handle = opendirSync(dir)
    } catch {
      continue // 打不开的子树跳过,证据原地留(读者姿态)
    }
    try {
      for (;;) {
        const e = handle.readSync()
        if (e === null) break
        if (budget.remaining <= 0) {
          budget.truncated = true
          return { bytes, entries }
        }
        budget.remaining--
        entries++
        if (e.isSymbolicLink()) continue
        const p = join(dir, e.name)
        if (e.isDirectory()) {
          stack.push(p)
        } else if (e.isFile()) {
          try {
            bytes += lstatSync(p).size
          } catch {
            /* 竞态消失的文件不计 */
          }
        }
      }
    } finally {
      try {
        handle.closeSync()
      } catch {
        /* ignore */
      }
    }
  }
  return { bytes, entries }
}

/** 根部一个文件计进某桶(同样消耗共享预算)。 */
function addFile(
  buckets: Map<string, { bytes: number; entries: number }>,
  budget: WalkBudget,
  id: string,
  path: string,
): void {
  if (budget.remaining <= 0) {
    budget.truncated = true
    return
  }
  budget.remaining--
  let size = 0
  try {
    size = lstatSync(path).size
  } catch {
    /* 竞态消失 */
  }
  merge(buckets, id, size, 1)
}

function merge(
  buckets: Map<string, { bytes: number; entries: number }>,
  id: string,
  bytes: number,
  entries: number,
): void {
  const cur = buckets.get(id)
  if (cur) {
    cur.bytes += bytes
    cur.entries += entries
  } else {
    buckets.set(id, { bytes, entries })
  }
}

/** 顶层条目按分桶规则归类(见文件头)。目录返回桶名;symlink 由调用方先滤。 */
function bucketForDir(name: string): string {
  if (name === 'transcript-archive') return 'transcript'
  if (name.includes('.bak-')) return 'bak'
  return name
}

function bucketForFile(name: string): string {
  if (name === 'transcript.jsonl') return 'transcript'
  if (name.startsWith('identity.sqlite')) return 'identity'
  if (name.includes('.bak-')) return 'bak'
  return 'other'
}

export interface MeasureSpaceLedgerOptions {
  spaceDir: string
  /** 账本落盘路径(通常 `<space>/runtime/space-ledger.json`,`spaceLedgerAt` 会拼好)。 */
  ledgerFile: string
  now?: () => number
  logger?: Logger
  /** 测试注入用;生产恒缺省。 */
  maxEntries?: number
}

/**
 * 量一遍 `<space>`,写账本,返回落盘的那份。**永不抛**:
 * 根打不开 → warn + null(边界①);写盘失败 → warn + 照样返回结果(边界④)。
 */
export async function measureSpaceLedger(
  opts: MeasureSpaceLedgerOptions,
): Promise<SpaceLedgerFile | null> {
  const budget: WalkBudget = {
    remaining: opts.maxEntries ?? SPACE_LEDGER_MAX_ENTRIES,
    truncated: false,
  }
  const buckets = new Map<string, { bytes: number; entries: number }>()

  let rootHandle: Dir
  try {
    rootHandle = opendirSync(opts.spaceDir)
  } catch (err) {
    // 读不动 ≠ 零:根都打不开时没有任何数字是诚实的,如实交白卷。
    opts.logger?.warn('space ledger: space root unreadable, skipping census', {
      spaceDir: opts.spaceDir,
      err: err instanceof Error ? err.message : String(err),
    })
    return null
  }
  try {
    for (;;) {
      let e
      try {
        e = rootHandle.readSync()
      } catch {
        break // 根迭代中途坏掉:已量到的照记,truncated 由预算面负责
      }
      if (e === null) break
      if (e.isSymbolicLink()) continue
      const p = join(opts.spaceDir, e.name)
      if (e.isDirectory()) {
        if (e.name === 'butler') {
          // butler 展开一层:子目录各自成桶,散文件归 `butler`。
          let sub: Dir
          try {
            sub = opendirSync(p)
          } catch {
            continue
          }
          try {
            for (;;) {
              const c = sub.readSync()
              if (c === null) break
              if (c.isSymbolicLink()) continue
              const cp = join(p, c.name)
              if (c.isDirectory()) {
                const m = measureSubtree(cp, budget)
                merge(buckets, `butler/${c.name}`, m.bytes, m.entries)
              } else if (c.isFile()) {
                addFile(buckets, budget, 'butler', cp)
              }
            }
          } finally {
            try {
              sub.closeSync()
            } catch {
              /* ignore */
            }
          }
        } else {
          const m = measureSubtree(p, budget)
          merge(buckets, bucketForDir(e.name), m.bytes, m.entries)
        }
      } else if (e.isFile()) {
        addFile(buckets, budget, bucketForFile(e.name), p)
      }
    }
  } finally {
    try {
      rootHandle.closeSync()
    } catch {
      /* ignore */
    }
  }

  const categories = [...buckets.entries()]
    .map(([id, m]) => ({ id, bytes: m.bytes, entries: m.entries }))
    .sort((a, b) => (b.bytes - a.bytes) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const row: SpaceLedgerFile = {
    v: 1,
    at: opts.now?.() ?? Date.now(),
    totalBytes: categories.reduce((a, c) => a + c.bytes, 0),
    totalEntries: categories.reduce((a, c) => a + c.entries, 0),
    truncated: budget.truncated,
    categories,
  }
  try {
    await mkdir(dirname(opts.ledgerFile), { recursive: true })
    await writeFile(opts.ledgerFile, JSON.stringify(row, null, 2), 'utf8')
  } catch (err) {
    opts.logger?.warn('space ledger: write failed', {
      err: err instanceof Error ? err.message : String(err),
    })
  }
  return row
}

export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0 B'
  if (n < 1024) return `${n} B`
  const kb = n / 1024
  if (kb < 1024) return `${kb.toFixed(1)} KB`
  const mb = kb / 1024
  if (mb < 1024) return `${mb.toFixed(1)} MB`
  return `${(mb / 1024).toFixed(2)} GB`
}

/** 相对时长(向下取整):账本要的是量级,不是时间戳(self-status fmtAgo 同形)。 */
function fmtAgo(deltaMs: number): string {
  const d = Math.max(0, deltaMs)
  if (d < 60_000) return '刚刚'
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} 分钟前`
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} 小时前`
  return `${Math.floor(d / 86_400_000)} 天前`
}

/**
 * 纯投影渲染(零 LLM 决策)。null = 接了但还没量过——是诚实答案不是错误。
 * 尾句刻意只说「只丈量不删除」,**不指** `set_retention` 之类还不存在的路
 * (HANDS-M3b 判例:指一条可能不存在的路,比说「这儿干不了」更坏)。
 */
export function renderSpaceReport(row: SpaceLedgerFile | null, now: number): string {
  if (!row) {
    return '还没有丈量记录。空间账本随 6 小时维护节律更新,开机也会先量一次——稍后再问我一次。'
  }
  const lines = [
    `hub 空间账本(丈量于 ${fmtAgo(now - row.at)}):`,
    `总占用 ${fmtBytes(row.totalBytes)},共 ${row.totalEntries} 个条目。`,
  ]
  for (const c of row.categories.slice(0, MAX_REPORT_LINES)) {
    lines.push(`- ${c.id}:${fmtBytes(c.bytes)}(${c.entries} 条)`)
  }
  if (row.categories.length > MAX_REPORT_LINES) {
    lines.push(`(还有 ${row.categories.length - MAX_REPORT_LINES} 个更小的类目未列出。)`)
  }
  if (row.truncated) {
    lines.push('(条目数超过丈量上限,以上数字是下界,不是全量。)')
  }
  lines.push('这份账本只丈量、不删除任何东西。')
  return lines.join('\n')
}

/** `my_status` 空间行(只处理有账本的情形;缺席/未量由自检卡自己的词汇答)。 */
export function spaceSummaryLine(row: SpaceLedgerFile, now: number): string {
  const top = row.categories[0]
  const topPart = top ? `,最大类目 ${top.id}(${fmtBytes(top.bytes)})` : ''
  const bound = row.truncated ? ',丈量被截断(数字是下界)' : ''
  return `总 ${fmtBytes(row.totalBytes)}${topPart}${bound};丈量于 ${fmtAgo(now - row.at)}`
}

// ── benign 工具 space_report ────────────────────────────────────────────────

const SPACE_TOOL: LlmToolDefinition = {
  name: 'space_report',
  description:
    '看这台 hub 的磁盘空间账本:总占用、按类目分桶(对话档 / 身份库 / 管家目录 / 备份残档等)。成员问「hub 占了多少地方」「磁盘是不是快满了」时用它。只读账本,不丈量、不删除任何东西。',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
}

export interface ButlerSpaceReportDeps {
  /** 账本读者(`() => readSpaceLedger(file)`;`spaceLedgerAt(...).read` 结构性满足)。 */
  ledger: () => Promise<SpaceLedgerFile | null>
  now?: () => number
  logger?: Logger
}

class ButlerSpaceReportToolset implements LlmAgentToolset {
  constructor(private readonly deps: ButlerSpaceReportDeps) {}

  listTools(): LlmToolDefinition[] {
    return [SPACE_TOOL]
  }

  async callTool(name: string): Promise<LlmToolCallResult> {
    if (name !== SPACE_TOOL.name) {
      return { content: [{ type: 'text', text: `未知工具:${name}` }], isError: true }
    }
    try {
      const row = await this.deps.ledger()
      // null 走 renderSpaceReport 的诚实分支——「还没量过」是正常回答,不是错误。
      return {
        content: [{ type: 'text', text: renderSpaceReport(row, this.deps.now?.() ?? Date.now()) }],
      }
    } catch (err) {
      this.deps.logger?.warn('butler space report: ledger read failed', { err })
      return { content: [{ type: 'text', text: '暂时读不到空间账本,稍后再试。' }], isError: true }
    }
  }
}

/** benign 理由:只读盘上账本的投影,不丈量不写盘不碰任何成员数据。 */
export function buildButlerSpaceReportToolset(deps: ButlerSpaceReportDeps): LlmAgentToolset {
  return new ButlerSpaceReportToolset(deps)
}

/**
 * 装配便利:一处拼路径,measure/read 两只 thunk 直接可挂——main.ts 的接线
 * 只需一行构造 + 按需散步(维护 sweep / retention sweeper / 体检 / 工厂)。
 */
export function spaceLedgerAt(
  spaceDir: string,
  logger?: Logger,
): {
  ledgerFile: string
  measure: () => Promise<SpaceLedgerFile | null>
  read: () => Promise<SpaceLedgerFile | null>
} {
  const ledgerFile = join(spaceDir, 'runtime', 'space-ledger.json')
  return {
    ledgerFile,
    measure: () => measureSpaceLedger({ spaceDir, ledgerFile, logger }),
    read: () => readSpaceLedger(ledgerFile),
  }
}
