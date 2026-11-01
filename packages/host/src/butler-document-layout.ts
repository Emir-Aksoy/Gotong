/**
 * butler-document-layout.ts — PPT 版面规划(纯函数,不碰第三方库)。
 *
 * 确定性生成最大的质量风险是文字溢出。这里按字宽估算折行和高度,决定字号、分页和
 * 每个内容块的位置;渲染层只照着画。
 *
 * 纪律:**只拆不删**。放不下就降字号,再放不下就拆成「标题(续)」页,长段按句切,
 * 长表拆页并重复表头,超高的行拆成两行。原文每个非空白字符都留在计划里。
 *
 * 这是估算,不是真实渲染。估算靠得住有两个前提:渲染层用固定行距(与字体度量无关),
 * 文本框内边距为零。
 */

import { documentTextLines, type DocumentChart, type DocumentSection, type DocumentSpec, type DocumentTable } from './butler-document-spec.js'

export const SLIDE = Object.freeze({
  widthIn: 13.333,
  heightIn: 7.5,
  marginXIn: 0.6,
  contentWIn: 12.133,
  titleTopIn: 0.35,
  /** 页脚从这里开始,正文不能过线。 */
  bodyBottomIn: 6.8,
  footerTopIn: 6.95,
  footerHIn: 0.35,
  coverTitleBox: { x: 0.9, y: 1.55, w: 11.5, h: 3.0 },
  coverSubtitleBox: { x: 0.9, y: 4.8, w: 11.5, h: 1.9 },
  dividerBox: { x: 0.9, y: 1.6, w: 11.5, h: 4.3 },
})

const TITLE_FONTS = [28, 24, 20] as const
const COVER_TITLE_FONTS = [40, 36, 32, 28, 24] as const
const DIVIDER_FONTS = [36, 32, 28, 24, 20] as const
export const SUBTITLE_FONT_PT = 20
const BODY_FONTS = [20, 19, 18, 17, 16] as const
const SPLIT_BODY_FONTS = [18, 17, 16] as const
const TABLE_FONTS = [14, 13, 12] as const

/** 固定行距的倍数。雅黑自身行高约 1.32em,取 1.35 既不挤也和字体度量脱钩。 */
export const LINE_HEIGHT = 1.35
export const PARA_GAP_PT = 8
export const BULLET_INDENT_PT = 18
export const TITLE_LINE_HEIGHT = 1.25
export const TABLE_LINE_HEIGHT = 1.3
export const CELL_MARGIN_X_IN = 0.08
export const CELL_MARGIN_Y_IN = 0.05
const BLOCK_GAP_IN = 0.18
const TITLE_GAP_IN = 0.2
const LEFT_COLUMN_W_IN = 5.6
const COLUMN_GAP_IN = 0.3
const MIN_CHART_H_IN = 3.2
const MIN_COL_W_IN = 0.7
/** 换行禁则和字形差异会多占一点宽度;留余量宁可早折行。 */
const WRAP_SAFETY = 0.97

export interface SlideTextItem {
  text: string
  bullet: boolean
}

export interface SlideTextBlock {
  kind: 'text'
  x: number
  y: number
  w: number
  h: number
  fontPt: number
  items: SlideTextItem[]
}

export interface SlideTableBlock {
  kind: 'table'
  x: number
  y: number
  w: number
  h: number
  fontPt: number
  colW: number[]
  rowH: number[]
  headers: string[]
  rows: string[][]
}

export interface SlideChartBlock {
  kind: 'chart'
  x: number
  y: number
  w: number
  h: number
  chart: DocumentChart
}

export type SlideBlock = SlideTextBlock | SlideTableBlock | SlideChartBlock

export interface CoverSlide {
  kind: 'cover'
  title: string
  subtitle?: string
  titleFontPt: number
}

export interface DividerSlide {
  kind: 'divider'
  title: string
  fontPt: number
  notes?: string
}

export interface ContentSlide {
  kind: 'content'
  title: string
  titleFontPt: number
  titleH: number
  blocks: SlideBlock[]
  notes?: string
}

export type SlidePlan = CoverSlide | DividerSlide | ContentSlide

const isWordChar = (cp: number): boolean =>
  (cp >= 0x30 && cp <= 0x39) ||
  (cp >= 0x41 && cp <= 0x5a) ||
  (cp >= 0x61 && cp <= 0x7a) ||
  (cp >= 0xc0 && cp <= 0x24f) ||
  (cp >= 0x370 && cp <= 0x4ff)

const NARROW_ASCII = new Set([...'iljI.,:;!|\'`'].map((c) => c.charCodeAt(0)))
const WIDE_ASCII = new Set([...'mwMW@%'].map((c) => c.charCodeAt(0)))

/** 单个码点的估算宽度(em)。宁可偏宽:估宽多折一行,估窄就溢出。 */
function charEm(cp: number): number {
  if (cp === 0x20) return 0.3
  if (cp < 0x7f) {
    if (NARROW_ASCII.has(cp)) return 0.32
    if (WIDE_ASCII.has(cp)) return 0.92
    if (cp >= 0x41 && cp <= 0x5a) return 0.7
    return 0.58
  }
  // 组合附加符、零宽连接符、变体选择符。
  if ((cp >= 0x300 && cp <= 0x36f) || cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0
  if (cp <= 0x24f) return 0.65
  if (cp >= 0x370 && cp <= 0x4ff) return 0.68
  if (cp >= 0x1f000) return 1.25
  return 1
}

/**
 * 每一行结束的 UTF-16 偏移。西文词不从中间断(真实渲染也不会),CJK 逐字可断;
 * 单词比整行还宽时才硬断。偏移总落在码点边界,不会把 emoji 切成半个。
 */
export function wrapLineEnds(text: string, fontPt: number, widthIn: number): number[] {
  const maxEm = (widthIn * 72 * WRAP_SAFETY) / fontPt
  const ends: number[] = []
  let lineEm = 0
  let lineStart = 0
  let breakAt = 0
  let emAtBreak = 0
  let i = 0
  while (i < text.length) {
    const cp = text.codePointAt(i) as number
    const len = cp > 0xffff ? 2 : 1
    if (cp === 0x0a) {
      ends.push(i + 1)
      i += 1
      lineStart = breakAt = i
      lineEm = emAtBreak = 0
      continue
    }
    const em = charEm(cp)
    if (lineEm + em > maxEm && lineEm > 0) {
      if (isWordChar(cp) && breakAt > lineStart) {
        ends.push(breakAt)
        lineStart = breakAt
        lineEm -= emAtBreak
      } else {
        ends.push(i)
        lineStart = breakAt = i
        lineEm = 0
      }
      emAtBreak = 0
    }
    lineEm += em
    i += len
    if (!isWordChar(cp)) {
      breakAt = i
      emAtBreak = lineEm
    }
  }
  if (lineStart < text.length) ends.push(text.length)
  return ends
}

const lineCount = (text: string, fontPt: number, widthIn: number): number =>
  Math.max(1, wrapLineEnds(text, fontPt, widthIn).length)

const SENTENCE_END = new Set([...'。！？!?；;…\n'])

/** `limit` 之前最后一个句子边界;没有则返回 0。 */
function lastSentenceEnd(text: string, limit: number): number {
  for (let i = limit; i > 0; i--) {
    const prev = text[i - 1] as string
    if (SENTENCE_END.has(prev)) return i
    // 西文句号必须后跟空白才算句末,否则 3.14 和 a.com 都会被当成句子边界。
    if (prev === '.' && (i === text.length || /\s/.test(text[i] as string))) return i
  }
  return 0
}

const toIn = (pt: number): number => pt / 72

const textItemHeightIn = (lines: number, fontPt: number): number =>
  toIn(lines * Math.round(fontPt * LINE_HEIGHT) + PARA_GAP_PT)

const itemWidth = (item: SlideTextItem, widthIn: number): number =>
  item.bullet ? widthIn - toIn(BULLET_INDENT_PT) : widthIn

/** 估算一组文字项的总高度,测试和分页共用同一把尺。 */
export function textItemsHeightIn(items: SlideTextItem[], fontPt: number, widthIn: number): number {
  let h = 0
  for (const item of items) h += textItemHeightIn(lineCount(item.text, fontPt, itemWidth(item, widthIn)), fontPt)
  return h
}

function sectionTextItems(section: DocumentSection): SlideTextItem[] {
  const out: SlideTextItem[] = []
  const add = (raw: string[] | undefined, bullet: boolean): void => {
    for (const text of raw ?? []) {
      for (const line of documentTextLines(text)) out.push({ text: line, bullet })
    }
  }
  add(section.paragraphs, false)
  add(section.bullets, true)
  return out
}

function fitTitle(title: string): { fontPt: number; h: number } {
  if (!title) return { fontPt: TITLE_FONTS[0], h: 0 }
  const last = TITLE_FONTS[TITLE_FONTS.length - 1] as number
  const fontPt = TITLE_FONTS.find((f) => lineCount(title, f, SLIDE.contentWIn) <= 2) ?? last
  const lines = lineCount(title, fontPt, SLIDE.contentWIn)
  return { fontPt, h: toIn(lines * fontPt * TITLE_LINE_HEIGHT) + 0.06 }
}

/** 列宽按内容比例分配,保底不至于窄到一个字一行。 */
export function tableColumnWeights(table: DocumentTable): number[] {
  const longest = table.headers.map((h, col) =>
    Math.max(emWidth(h), ...table.rows.map((row) => Math.min(emWidth(row[col] ?? ''), 40))),
  )
  // 开方压低极端差距:一列很长时不把其他列挤没。
  return longest.map((w) => Math.sqrt(Math.max(w, 1)))
}

function emWidth(text: string): number {
  let em = 0
  for (const ch of text) em += charEm(ch.codePointAt(0) as number)
  return em
}

function tableColumnWidths(table: DocumentTable): number[] {
  const weights = tableColumnWeights(table)
  const total = weights.reduce((a, b) => a + b, 0)
  const raw = weights.map((w) => (SLIDE.contentWIn * w) / total)
  const short = raw.reduce((sum, w) => sum + Math.max(0, MIN_COL_W_IN - w), 0)
  const spare = raw.reduce((sum, w) => sum + Math.max(0, w - MIN_COL_W_IN), 0)
  return raw.map((w) => (w <= MIN_COL_W_IN ? MIN_COL_W_IN : w - ((w - MIN_COL_W_IN) * short) / spare))
}

const cellLineH = (fontPt: number): number => toIn(fontPt * TABLE_LINE_HEIGHT)

const cellInnerW = (colW: number): number => colW - 2 * CELL_MARGIN_X_IN

function tableRowHeightIn(cells: string[], colW: number[], fontPt: number): number {
  let lines = 1
  for (const [c, cell] of cells.entries()) {
    lines = Math.max(lines, lineCount(cell, fontPt, cellInnerW(colW[c] as number)))
  }
  return lines * cellLineH(fontPt) + 2 * CELL_MARGIN_Y_IN
}

/** 比一整页还高的行从第 `maxLines` 行处切开,余下的成为新的一行。 */
function splitTableRow(cells: string[], colW: number[], fontPt: number, maxLines: number): [string[], string[]] {
  const head: string[] = []
  const tail: string[] = []
  for (const [c, cell] of cells.entries()) {
    const ends = wrapLineEnds(cell, fontPt, cellInnerW(colW[c] as number))
    const cut = ends.length > maxLines ? (ends[maxLines - 1] as number) : cell.length
    head.push(cell.slice(0, cut))
    tail.push(cell.slice(cut))
  }
  return [head, tail]
}

interface Page {
  slide: ContentSlide
  bodyTop: number
  bodyH: number
  /** 本页已占用的正文高度。 */
  used: number
}

function planSection(section: DocumentSection, out: SlidePlan[]): void {
  const heading = section.heading ?? ''
  const items = sectionTextItems(section)
  const { table, chart } = section

  if (items.length === 0 && !table && !chart) {
    const last = DIVIDER_FONTS[DIVIDER_FONTS.length - 1] as number
    const { w, h } = SLIDE.dividerBox
    const fontPt =
      DIVIDER_FONTS.find((f) => toIn(lineCount(heading, f, w) * f * TITLE_LINE_HEIGHT) <= h) ?? last
    out.push({ kind: 'divider', title: heading, fontPt, ...(section.notes ? { notes: section.notes } : {}) })
    return
  }

  const firstIndex = out.length
  let page!: Page
  const newPage = (): void => {
    const isFirst = out.length === firstIndex
    const title = heading ? (isFirst ? heading : `${heading}（续）`) : ''
    const fit = fitTitle(title)
    const slide: ContentSlide = { kind: 'content', title, titleFontPt: fit.fontPt, titleH: fit.h, blocks: [] }
    out.push(slide)
    const bodyTop = SLIDE.titleTopIn + (fit.h > 0 ? fit.h + TITLE_GAP_IN : 0)
    page = { slide, bodyTop, bodyH: SLIDE.bodyBottomIn - bodyTop, used: 0 }
  }
  newPage()

  const nextY = (): number => page.bodyTop + page.used + (page.used > 0 ? BLOCK_GAP_IN : 0)
  const remaining = (): number => SLIDE.bodyBottomIn - nextY()

  const placeSideBySide = (): boolean => {
    if (!chart || table || items.length === 0) return false
    const fontPt = SPLIT_BODY_FONTS.find((f) => textItemsHeightIn(items, f, LEFT_COLUMN_W_IN) <= page.bodyH)
    if (fontPt === undefined) return false
    const x = SLIDE.marginXIn
    const h = page.bodyH
    page.slide.blocks.push(
      { kind: 'text', x, y: page.bodyTop, w: LEFT_COLUMN_W_IN, h, fontPt, items },
      {
        kind: 'chart',
        x: x + LEFT_COLUMN_W_IN + COLUMN_GAP_IN,
        y: page.bodyTop,
        w: SLIDE.contentWIn - LEFT_COLUMN_W_IN - COLUMN_GAP_IN,
        h,
        chart,
      },
    )
    page.used = h
    return true
  }

  const placeText = (): void => {
    if (items.length === 0) return
    const w = SLIDE.contentWIn
    const last = BODY_FONTS[BODY_FONTS.length - 1] as number
    const fontPt = BODY_FONTS.find((f) => textItemsHeightIn(items, f, w) <= page.bodyH) ?? last
    const lineH = toIn(Math.round(fontPt * LINE_HEIGHT))
    const gap = toIn(PARA_GAP_PT)

    let block: SlideTextBlock | null = null
    const add = (item: SlideTextItem, h: number): void => {
      if (!block) {
        block = { kind: 'text', x: SLIDE.marginXIn, y: page.bodyTop, w, h: 0, fontPt, items: [] }
        page.slide.blocks.push(block)
      }
      block.items.push(item)
      block.h += h
      page.used += h
    }
    const turnPage = (): void => {
      newPage()
      block = null
    }

    for (const item of items) {
      let rest = item.text
      let bullet = item.bullet
      while (rest) {
        const width = itemWidth({ text: rest, bullet }, w)
        const ends = wrapLineEnds(rest, fontPt, width)
        const h = ends.length * lineH + gap
        if (page.used + h <= page.bodyH) {
          add({ text: rest, bullet }, h)
          break
        }
        const capacity = Math.floor((page.bodyH - page.used - gap) / lineH)
        let cut = 0
        if (capacity >= 1) {
          const limit = ends[capacity - 1] as number
          cut = lastSentenceEnd(rest, limit)
          // 整页都放不下一句时才硬切;否则翻页让这句完整。
          if (cut === 0 && page.used === 0) cut = limit
        }
        if (cut > 0) {
          const head = rest.slice(0, cut)
          const headLines = wrapLineEnds(head, fontPt, width).length
          add({ text: head, bullet }, headLines * lineH + gap)
          rest = rest.slice(cut)
          // 续接的半段不再画项目符号,否则看起来像新的一条。
          bullet = false
        }
        turnPage()
      }
    }
  }

  const placeTable = (): void => {
    if (!table) return
    const colW = tableColumnWidths(table)
    const totalH = (fontPt: number): number =>
      tableRowHeightIn(table.headers, colW, fontPt) +
      table.rows.reduce((sum, row) => sum + tableRowHeightIn(row, colW, fontPt), 0)
    const last = TABLE_FONTS[TABLE_FONTS.length - 1] as number
    const fontPt = TABLE_FONTS.find((f) => totalH(f) <= page.bodyH) ?? last
    const headerH = tableRowHeightIn(table.headers, colW, fontPt)

    const firstRowH = table.rows[0] ? tableRowHeightIn(table.rows[0], colW, fontPt) : 0
    if (page.used > 0 && remaining() < headerH + firstRowH) newPage()

    let y = nextY()
    let rows: string[][] = []
    let rowH: number[] = []
    let used = headerH
    const flush = (): void => {
      page.slide.blocks.push({
        kind: 'table',
        x: SLIDE.marginXIn,
        y,
        w: SLIDE.contentWIn,
        h: used,
        fontPt,
        colW,
        rowH: [headerH, ...rowH],
        headers: table.headers,
        rows,
      })
      page.used = y + used - page.bodyTop
    }
    const turn = (): void => {
      flush()
      newPage()
      y = nextY()
      rows = []
      rowH = []
      used = headerH
    }

    const queue = [...table.rows]
    for (let row = queue.shift(); row; row = queue.shift()) {
      const h = tableRowHeightIn(row, colW, fontPt)
      const avail = SLIDE.bodyBottomIn - y
      if (used + h <= avail) {
        rows.push(row)
        rowH.push(h)
        used += h
        continue
      }
      const pageIsFresh = rows.length === 0 && page.used === 0
      if (!pageIsFresh) {
        queue.unshift(row)
        if (rows.length > 0) turn()
        else {
          newPage()
          y = nextY()
        }
        continue
      }
      // 这一行比整页还高,切开。表头长度有上限,这里至少放得下一行。
      const maxLines = Math.max(1, Math.floor((avail - used - 2 * CELL_MARGIN_Y_IN) / cellLineH(fontPt)))
      const [head, tail] = splitTableRow(row, colW, fontPt, maxLines)
      queue.unshift(tail)
      const headH = tableRowHeightIn(head, colW, fontPt)
      rows.push(head)
      rowH.push(headH)
      used += headH
      turn()
    }
    flush()
  }

  const placeChart = (): void => {
    if (!chart) return
    if (page.used > 0 && remaining() < MIN_CHART_H_IN) newPage()
    const y = nextY()
    const h = SLIDE.bodyBottomIn - y
    page.slide.blocks.push({ kind: 'chart', x: SLIDE.marginXIn, y, w: SLIDE.contentWIn, h, chart })
    page.used = y + h - page.bodyTop
  }

  if (!placeSideBySide()) {
    placeText()
    placeTable()
    placeChart()
  }

  const first = out[firstIndex]
  if (section.notes && first?.kind === 'content') first.notes = section.notes
}

/** 文档 → 每一页的版面。 */
export function planSlides(spec: DocumentSpec): SlidePlan[] {
  const { w, h } = SLIDE.coverTitleBox
  const last = COVER_TITLE_FONTS[COVER_TITLE_FONTS.length - 1] as number
  const titleFontPt =
    COVER_TITLE_FONTS.find((f) => toIn(lineCount(spec.title, f, w) * f * TITLE_LINE_HEIGHT) <= h) ?? last
  const out: SlidePlan[] = [
    { kind: 'cover', title: spec.title, ...(spec.subtitle ? { subtitle: spec.subtitle } : {}), titleFontPt },
  ]
  for (const section of spec.sections) planSection(section, out)
  return out
}
