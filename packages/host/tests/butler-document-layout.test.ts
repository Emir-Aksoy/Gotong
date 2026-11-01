import { describe, expect, it } from 'vitest'

import {
  CELL_MARGIN_X_IN,
  CELL_MARGIN_Y_IN,
  SLIDE,
  TABLE_LINE_HEIGHT,
  TITLE_LINE_HEIGHT,
  planSlides,
  tableColumnWeights,
  textItemsHeightIn,
  wrapLineEnds,
  type ContentSlide,
  type SlidePlan,
  type SlideTableBlock,
  type SlideTextBlock,
} from '../src/butler-document-layout.js'
import type { DocumentSection, DocumentSpec } from '../src/butler-document-spec.js'

const spec = (sections: DocumentSection[], title = '报告'): DocumentSpec => ({ format: 'pptx', title, theme: 'business', sections })
const contents = (plan: SlidePlan[]): ContentSlide[] => plan.filter((s): s is ContentSlide => s.kind === 'content')
const noSpace = (s: string): string => s.replace(/\s+/g, '')
const textBlocks = (s: ContentSlide): SlideTextBlock[] => s.blocks.filter((b): b is SlideTextBlock => b.kind === 'text')
const tableBlocks = (s: ContentSlide): SlideTableBlock[] => s.blocks.filter((b): b is SlideTableBlock => b.kind === 'table')

/** 版面的硬约束:每个块都在正文区内,块内文字重新估算也放得下。 */
function assertFits(plan: SlidePlan[]): void {
  for (const slide of contents(plan)) {
    const where = `「${slide.title}」`
    const titleBottom = SLIDE.titleTopIn + slide.titleH
    for (const [i, block] of slide.blocks.entries()) {
      expect(block.y, `${where} 块压到标题`).toBeGreaterThanOrEqual(titleBottom - 1e-6)
      expect(block.y + block.h, `${where} 块越过页脚线`).toBeLessThanOrEqual(SLIDE.bodyBottomIn + 1e-6)
      expect(block.x + block.w, `${where} 块越过右边距`).toBeLessThanOrEqual(SLIDE.marginXIn + SLIDE.contentWIn + 1e-6)
      for (const other of slide.blocks.slice(i + 1)) {
        const apart =
          block.x + block.w <= other.x + 1e-6 ||
          other.x + other.w <= block.x + 1e-6 ||
          block.y + block.h <= other.y + 1e-6 ||
          other.y + other.h <= block.y + 1e-6
        expect(apart, `${where} 两个块重叠`).toBe(true)
      }
      if (block.kind === 'text') {
        expect(textItemsHeightIn(block.items, block.fontPt, block.w), `${where} 文字溢出`).toBeLessThanOrEqual(block.h + 1e-6)
      } else if (block.kind === 'table') {
        expect(block.rowH).toHaveLength(block.rows.length + 1)
        // 每行按它实际的折行数重新量一遍,不信规划器自己算的高度。
        const measured = [block.headers, ...block.rows].reduce((sum, cells) => {
          let lines = 1
          for (const [c, cell] of cells.entries()) {
            lines = Math.max(lines, wrapLineEnds(cell, block.fontPt, (block.colW[c] as number) - 2 * CELL_MARGIN_X_IN).length)
          }
          return sum + (lines * block.fontPt * TABLE_LINE_HEIGHT) / 72 + 2 * CELL_MARGIN_Y_IN
        }, 0)
        expect(measured, `${where} 表格溢出`).toBeLessThanOrEqual(block.h + 1e-6)
        expect(block.colW.reduce((a, b) => a + b, 0)).toBeCloseTo(block.w, 3)
        for (const w of block.colW) expect(w).toBeGreaterThan(2 * CELL_MARGIN_X_IN)
      }
    }
  }
}

/** 确定性随机:失败能复现。 */
function rng(seed: number): () => number {
  let s = seed
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

function randomText(next: () => number, maxLen: number): string {
  const pieces = ['这是一段中文内容', '。', 'Latin words and numbers 123', '，', '！', '？', ' ', '😀', 'x'.repeat(70), 'v3.14 a.com', '；', '长'.repeat(120), '一二三']
  let out = ''
  const target = Math.floor(next() * maxLen) + 1
  while (out.length < target) out += pieces[Math.floor(next() * pieces.length)]
  return out
}

describe('wrapLineEnds', () => {
  it('中文按字断,一行放不下就折', () => {
    // 72pt 字号、1 英寸宽 = 每行不到 1 字,但每行至少放一个字才能前进。
    expect(wrapLineEnds('一二三', 72, 1)).toEqual([1, 2, 3])
    expect(wrapLineEnds('一二三四', 36, 2.1)).toEqual([4])
  })

  it('西文词不从中间断,放不下整词才硬断', () => {
    const ends = wrapLineEnds('hello world', 36, 2)
    expect(ends).toEqual([6, 11])
    expect(wrapLineEnds('x'.repeat(100), 36, 1).length).toBeGreaterThan(1)
  })

  it('偏移总在码点边界,emoji 不被切开', () => {
    const text = '😀'.repeat(10)
    for (const end of wrapLineEnds(text, 72, 1)) expect(end % 2).toBe(0)
  })

  it('空串零行,换行符强制断行', () => {
    expect(wrapLineEnds('', 20, 5)).toEqual([])
    expect(wrapLineEnds('a\nb', 20, 5)).toEqual([2, 3])
  })

  it('折行结果拼回去等于原文', () => {
    const next = rng(7)
    for (let i = 0; i < 50; i++) {
      const text = randomText(next, 600)
      const ends = wrapLineEnds(text, 18, 5)
      expect(ends[ends.length - 1]).toBe(text.length)
      let prev = 0
      for (const end of ends) {
        expect(end).toBeGreaterThan(prev)
        prev = end
      }
    }
  })
})

describe('planSlides 版式选择', () => {
  it('第一页是封面,标题和副标题都在', () => {
    const plan = planSlides({ ...spec([]), subtitle: '副标题' })
    expect(plan).toEqual([{ kind: 'cover', title: '报告', subtitle: '副标题', titleFontPt: 40 }])
  })

  it('超长封面标题降字号后放得进盒子', () => {
    const [cover] = planSlides(spec([], '长'.repeat(200)))
    if (cover?.kind !== 'cover') throw new Error('expected cover')
    const lines = wrapLineEnds(cover.title, cover.titleFontPt, SLIDE.coverTitleBox.w).length
    expect((lines * cover.titleFontPt * TITLE_LINE_HEIGHT) / 72).toBeLessThanOrEqual(SLIDE.coverTitleBox.h)
  })

  it('只有标题的章节成为过渡页', () => {
    const plan = planSlides(spec([{ heading: '第一部分', notes: '开场白' }]))
    expect(plan[1]).toEqual({ kind: 'divider', title: '第一部分', fontPt: 36, notes: '开场白' })
  })

  it('段内换行拆成独立条目,空白行不占位', () => {
    const [slide] = contents(planSlides(spec([{ heading: '要点', paragraphs: ['段一\n\n段二'], bullets: ['点一\n  \n点二'] }])))
    const items = slide ? textBlocks(slide).flatMap((b) => b.items) : []
    expect(items).toEqual([
      { text: '段一', bullet: false },
      { text: '段二', bullet: false },
      { text: '点一', bullet: true },
      { text: '点二', bullet: true },
    ])
  })

  it('要点页:内容少用大字号', () => {
    const [slide] = contents(planSlides(spec([{ heading: '要点', bullets: ['一', '二'] }])))
    expect(textBlocks(slide as ContentSlide)[0]?.fontPt).toBe(20)
  })

  it('内容变多时字号逐级降到 16,再多才拆页', () => {
    const fontOf = (n: number): number[] =>
      contents(planSlides(spec([{ heading: 'x', paragraphs: Array(n).fill('句子'.repeat(30)) }]))).map(
        (s) => textBlocks(s)[0]?.fontPt as number,
      )
    expect(fontOf(1)).toEqual([20])
    const sizes = new Set([1, 4, 6, 7, 8, 9, 10].flatMap(fontOf))
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(16)
    expect([...sizes].some((f) => f < 20 && f > 16)).toBe(true)
    const many = fontOf(40)
    expect(many.length).toBeGreaterThan(1)
    expect(new Set(many)).toEqual(new Set([16]))
  })

  it('续页标题带「（续）」,没有标题的章节不造标题', () => {
    const slides = contents(planSlides(spec([{ heading: '长文', paragraphs: Array(40).fill('字'.repeat(200)) }])))
    expect(slides[0]?.title).toBe('长文')
    expect(slides[1]?.title).toBe('长文（续）')
    const untitled = contents(planSlides(spec([{ paragraphs: Array(40).fill('字'.repeat(200)) }])))
    expect(untitled.every((s) => s.title === '')).toBe(true)
  })

  it('短要点 + 图表并排', () => {
    const chart = { type: 'bar' as const, labels: ['a'], series: [{ name: 's', values: [1] }] }
    const plan = contents(planSlides(spec([{ heading: 'x', bullets: ['一', '二'], chart }])))
    expect(plan).toHaveLength(1)
    const [text, chartBlock] = plan[0]?.blocks ?? []
    expect(text?.kind).toBe('text')
    expect(chartBlock?.kind).toBe('chart')
    expect(chartBlock?.x).toBeGreaterThan((text?.x ?? 0) + (text?.w ?? 0))
    expect((chartBlock?.x ?? 0) + (chartBlock?.w ?? 0)).toBeCloseTo(SLIDE.marginXIn + SLIDE.contentWIn, 2)
  })

  it('长文本 + 图表分页,图表不被挤到看不见', () => {
    const chart = { type: 'line' as const, labels: ['a'], series: [{ name: 's', values: [1] }] }
    const plan = planSlides(spec([{ heading: 'x', paragraphs: Array(30).fill('字'.repeat(100)), chart }]))
    assertFits(plan)
    const chartBlocks = contents(plan).flatMap((s) => s.blocks).filter((b) => b.kind === 'chart')
    expect(chartBlocks).toHaveLength(1)
    expect(chartBlocks[0]?.h).toBeGreaterThanOrEqual(3.2)
  })

  it('备注挂在章节第一页', () => {
    const slides = contents(planSlides(spec([{ heading: 'x', paragraphs: Array(40).fill('字'.repeat(200)), notes: '备注' }])))
    expect(slides[0]?.notes).toBe('备注')
    expect(slides.slice(1).every((s) => s.notes === undefined)).toBe(true)
  })

  it('项目符号的续接半段不再画符号', () => {
    const slides = contents(planSlides(spec([{ heading: 'x', bullets: ['字'.repeat(1500) + '。' + '字'.repeat(1500)] }])))
    expect(slides.length).toBeGreaterThan(1)
    const items = slides.flatMap((s) => textBlocks(s).flatMap((b) => b.items))
    expect(items[0]?.bullet).toBe(true)
    expect(items.slice(1).every((i) => !i.bullet)).toBe(true)
  })

  it('长段落优先在句子边界切开', () => {
    const sentence = '这是一个完整的句子，用来测试切分。'
    const slides = contents(planSlides(spec([{ heading: 'x', paragraphs: [sentence.repeat(120)] }])))
    const items = slides.flatMap((s) => textBlocks(s).flatMap((b) => b.items))
    expect(items.length).toBeGreaterThan(1)
    for (const item of items) expect(item.text.endsWith('。')).toBe(true)
  })

  it('西文句号不被当成句子边界(3.14 不切开)', () => {
    const slides = contents(planSlides(spec([{ heading: 'x', paragraphs: ['pi 3.14159 and a.com '.repeat(400)] }])))
    const items = slides.flatMap((s) => textBlocks(s).flatMap((b) => b.items))
    expect(items.length).toBeGreaterThan(1)
    expect(items.map((i) => i.text).join('')).toBe('pi 3.14159 and a.com '.repeat(400))
    for (const item of items.slice(0, -1)) expect(item.text).not.toMatch(/3\.$/)
  })
})

describe('planSlides 表格', () => {
  it('长表拆页,每页重复表头,行顺序不变', () => {
    const rows = Array.from({ length: 80 }, (_, i) => [`第 ${i} 行`, '内容'])
    const plan = planSlides(spec([{ heading: '表', table: { headers: ['序号', '说明'], rows } }]))
    assertFits(plan)
    const tables = contents(plan).flatMap(tableBlocks)
    expect(tables.length).toBeGreaterThan(1)
    expect(tables.every((t) => t.headers[0] === '序号')).toBe(true)
    expect(tables.flatMap((t) => t.rows)).toEqual(rows)
  })

  it('短表用大字号,放在说明文字下方', () => {
    const plan = planSlides(spec([{ heading: '表', paragraphs: ['说明'], table: { headers: ['a'], rows: [['1']] } }]))
    assertFits(plan)
    const [slide] = contents(plan)
    expect(slide?.blocks.map((b) => b.kind)).toEqual(['text', 'table'])
    expect(tableBlocks(slide as ContentSlide)[0]?.fontPt).toBe(14)
  })

  it('比整页还高的行被切开,文字一个不少', () => {
    const cell = '字'.repeat(1000)
    const plan = planSlides(
      spec([{ heading: '表', table: { headers: Array(12).fill('列'), rows: [Array(12).fill(cell)] } }]),
    )
    assertFits(plan)
    const tables = contents(plan).flatMap(tableBlocks)
    expect(tables.length).toBeGreaterThan(1)
    for (let c = 0; c < 12; c++) {
      expect(tables.flatMap((t) => t.rows.map((r) => r[c])).join('')).toBe(cell)
    }
  })

  it('没有数据行的表也有一块', () => {
    const plan = planSlides(spec([{ heading: '表', table: { headers: ['a', 'b'], rows: [] } }]))
    assertFits(plan)
    expect(contents(plan).flatMap(tableBlocks)).toHaveLength(1)
  })

  it('列宽按内容比例分配,窄列也有保底', () => {
    const table = { headers: ['序号', '说明'], rows: [['1', '很长很长的说明文字'.repeat(4)]] }
    const [a, b] = tableColumnWeights(table)
    expect(b as number).toBeGreaterThan(a as number)
    const [t] = contents(planSlides(spec([{ table }]))).flatMap(tableBlocks)
    expect(t?.colW[1] as number).toBeGreaterThan(t?.colW[0] as number)
  })
})

describe('planSlides 随机用例(验收 4)', () => {
  function randomSection(next: () => number): DocumentSection {
    const out: DocumentSection = {}
    if (next() < 0.8) out.heading = randomText(next, next() < 0.1 ? 200 : 20).slice(0, 200)
    if (next() < 0.7) out.paragraphs = Array.from({ length: Math.floor(next() * 8) + 1 }, () => randomText(next, 2000))
    if (next() < 0.5) out.bullets = Array.from({ length: Math.floor(next() * 12) + 1 }, () => randomText(next, 300))
    if (next() < 0.4) {
      const cols = Math.floor(next() * 12) + 1
      out.table = {
        headers: Array.from({ length: cols }, () => randomText(next, 20).slice(0, 60).replace(/\s+/g, ' ')),
        rows: Array.from({ length: Math.floor(next() * 80) }, () =>
          Array.from({ length: cols }, () => randomText(next, next() < 0.05 ? 1000 : 40).slice(0, 1000)),
        ),
      }
    }
    if (next() < 0.3) out.chart = { type: 'bar', labels: ['a', 'b'], series: [{ name: 's', values: [1, 2] }] }
    if (!out.heading && !out.paragraphs && !out.bullets && !out.table && !out.chart) out.heading = '补'
    return out
  }

  it('每页估算不超版面,原文每个字都在', () => {
    const next = rng(20261101)
    for (let round = 0; round < 40; round++) {
      const sections = Array.from({ length: Math.floor(next() * 5) + 1 }, () => randomSection(next))
      const plan = planSlides(spec(sections))
      assertFits(plan)

      const blocks = contents(plan).flatMap((s) => s.blocks)
      const planned = blocks
        .filter((b): b is SlideTextBlock => b.kind === 'text')
        .flatMap((b) => b.items.map((i) => i.text))
        .join('')
      const expected = sections.flatMap((s) => [...(s.paragraphs ?? []), ...(s.bullets ?? [])]).join('')
      expect(noSpace(planned)).toBe(noSpace(expected))

      const tables = sections.flatMap((s) => (s.table ? [s.table] : []))
      const plannedTables = blocks.filter((b): b is SlideTableBlock => b.kind === 'table')
      const inPlan = (headers: string[]): string[][] => plannedTables.filter((t) => t.headers === headers).flatMap((t) => t.rows)
      for (const table of tables) {
        for (const col of table.headers.keys()) {
          const got = inPlan(table.headers).map((r) => r[col]).join('')
          const want = table.rows.map((r) => r[col]).join('')
          expect(noSpace(got)).toBe(noSpace(want))
        }
      }
    }
  })
})
