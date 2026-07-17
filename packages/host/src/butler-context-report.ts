/**
 * butler-context-report.ts — LIB-M1 立尺。阿同每轮 prompt 上下文的**段级**
 * token 构成度量核:哪一段(稳定缓存段 vs 易变尾段)花了多少。
 *
 * # 为什么先量段,不量总量
 *
 * NA-M3 之后,上下文在 wire 上分两段,经济学完全不同:
 *   - **stable 段** = `req.system`(冻结记忆块 + 成员人设):anthropic provider
 *     给它挂 cache_control,轮间命中按 0.1× 计价——这段"贵在变更,不贵在存在"。
 *   - **volatile 段** = `req.systemVolatile`(composeContextProbes 探针尾卡):
 *     每轮内容可变,永不进缓存,每轮全价。
 *
 * LIB(图书馆员)track 的核心动作正是往 stable 段加一张索引卡(M3)、并约束
 * 它永不随知识总量增长。没有段级基线,"加了多少/省了多少"就是拍脑袋。
 * AFR-M1 已给工具面立过尺(butler-toolface-report.ts),本模块给**文本段**
 * 立同款尺,共用同一把 token 标尺(estimateTokens)保证前后可比。
 *
 * 零行为改动:运行时路径不 import 本模块,只有报告测试用它。
 */

import { estimateTokens } from './butler-toolface-report.js'

/** 段位:stable = req.system(缓存前缀);volatile = req.systemVolatile(每轮全价)。 */
export type ContextSegment = 'stable' | 'volatile'

/** 一张被度量的上下文卡(探针产物 / 人设样本 / 冻结块)。 */
export interface ContextCardEntry {
  segment: ContextSegment
  /** 卡名,对齐来源模块(如 'clock'、'frozen-block')。 */
  card: string
  /** 诚实标注这段文本是什么状态下产出的('恒在' / '满态' / '样本' …)。 */
  state: string
  text: string
}

/** 一张卡的度量行。 */
export interface ContextCardRow {
  segment: ContextSegment
  card: string
  state: string
  chars: number
  /** UTF-8 字节数(zh 卡片 chars 与 bytes 差 3×,两个都留)。 */
  bytes: number
  /** 与工具面同一把标尺的 token 估计(CJK≈1 tok/字)。 */
  estTokens: number
}

/** 段级小计(插入序保留)。 */
export interface ContextSegmentRollup {
  segment: ContextSegment
  cards: number
  chars: number
  bytes: number
  estTokens: number
}

export interface ContextReport {
  rows: readonly ContextCardRow[]
  segments: readonly ContextSegmentRollup[]
  totalChars: number
  totalBytes: number
  totalEstTokens: number
}

/**
 * 探针注册表:factory `composeContextProbes(...)` 里每个 **builder 形态**的
 * 探针 ↔ 报告卡名。tripwire(报告测试)正则扫 factory 源码的
 * `buildButler*Probe(` 调用点,与本表值集合比对——工厂加了探针不登记就红,
 * 报告永不无声漏量(AFR-M1 工具面同款纪律)。
 */
export const VOLATILE_PROBE_REGISTRY: Readonly<Record<string, string>> = {
  clock: 'buildButlerClockProbe',
  'last-seen': 'buildButlerLastSeenProbe',
  language: 'buildButlerLanguageProbe',
  source: 'buildButlerSourceProbe',
  pending: 'buildButlerPendingProbe',
  'hub-sense': 'buildButlerHubSenseProbe',
  onboarding: 'buildButlerOnboardingProbe',
}

/**
 * 内联探针(非 builder 命名形态,正则扫不到调用点)——每个用自己的源码
 * 标记钉住。新加内联探针必须同时登记在这,否则 tripwire 的
 * 「composeContextProbes 只出现一次」+ 本表无法证明它被量到。
 */
export const INLINE_PROBE_MARKERS: Readonly<Record<string, RegExp>> = {
  'notebook-digest': /taskNotebook\.digest\(\)/,
}

/**
 * 稳定段卡注册表(LIB-M3):factory 里 `buildButler*Card(` 形态的 stable 段
 * 注入源 ↔ 报告卡名。tripwire 正则扫 factory 源码的调用点与本表值集合比对,
 * 且 `stableContext:` 注入点全文件只准出现一次(volatile 侧
 * `composeContextProbes` 同款纪律)——加稳定段卡不登记就红。
 */
export const STABLE_CARD_REGISTRY: Readonly<Record<string, string>> = {
  'knowledge-index': 'buildButlerKnowledgeIndexCard',
}

const encoder = new TextEncoder()

/** 度量一组上下文卡(纯函数,入参顺序即行序)。 */
export function measureContextFace(entries: readonly ContextCardEntry[]): ContextReport {
  const rows: ContextCardRow[] = entries.map((e) => ({
    segment: e.segment,
    card: e.card,
    state: e.state,
    chars: [...e.text].length,
    bytes: encoder.encode(e.text).length,
    estTokens: estimateTokens(e.text),
  }))

  const segments: ContextSegmentRollup[] = []
  const bySegment = new Map<ContextSegment, ContextSegmentRollup>()
  for (const seg of ['stable', 'volatile'] as const) {
    const roll: ContextSegmentRollup = { segment: seg, cards: 0, chars: 0, bytes: 0, estTokens: 0 }
    segments.push(roll)
    bySegment.set(seg, roll)
  }
  let totalChars = 0
  let totalBytes = 0
  let totalEstTokens = 0
  for (const r of rows) {
    const roll = bySegment.get(r.segment)!
    roll.cards++
    roll.chars += r.chars
    roll.bytes += r.bytes
    roll.estTokens += r.estTokens
    totalChars += r.chars
    totalBytes += r.bytes
    totalEstTokens += r.estTokens
  }

  return { rows, segments, totalChars, totalBytes, totalEstTokens }
}

/**
 * 渲染纯文本报告(pnpm report:atong-context 打印这个)。`notes` 由调用方
 * 传入场景小结行(底价/满配/区间),渲染层不重算——数字只有一个来源。
 */
export function renderContextReport(report: ContextReport, notes: readonly string[] = []): string {
  const lines: string[] = []
  lines.push('=== 阿同上下文段级基线(LIB-M1)===')
  lines.push('segment   card             state          chars  bytes  ~tokens')
  for (const r of report.rows) {
    lines.push(
      `${r.segment.padEnd(9)} ${r.card.padEnd(16)} ${r.state.padEnd(14)} ${String(r.chars).padStart(5)}  ${String(r.bytes).padStart(5)}  ${String(r.estTokens).padStart(6)}`,
    )
  }
  lines.push('---- 按段 ----')
  for (const s of report.segments) {
    lines.push(
      `${s.segment.padEnd(9)} ${s.cards} cards  ${s.chars} chars  ${s.bytes} bytes  ~${s.estTokens} tokens`,
    )
  }
  lines.push('---- 合计 ----')
  lines.push(
    `cards=${report.rows.length}  chars=${report.totalChars}  bytes=${report.totalBytes}  ~tokens=${report.totalEstTokens}`,
  )
  for (const n of notes) lines.push(n)
  lines.push(
    '注:stable 段 = req.system(冻结块+人设,挂 cache_control,轮间命中 0.1×);volatile 段 = req.systemVolatile(探针尾卡,每轮全价)。',
  )
  lines.push(
    '注:工具面(~35 工具 schema)另有专尺 `pnpm report:atong-toolface`(AFR-M1),不在本表重量。',
  )
  return lines.join('\n')
}
