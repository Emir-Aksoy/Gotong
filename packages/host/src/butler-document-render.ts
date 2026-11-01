/**
 * butler-document-render.ts — 结构化内容 → PPT / Word 字节。
 *
 * **全仓唯一加载 pptxgenjs / docx 的模块,而且只在子进程里跑**(见
 * `butler-document-runner.ts`)。主进程不能 import 这里:两个库加起来几十 MB 堆,
 * 又都是第三方代码,不该和持有 key 的 hub 同住一个进程。源码扫描门钉着这条。
 *
 * 版面决定全在 `butler-document-layout.ts`,这里只照着画。
 */

import { createRequire } from 'node:module'

import type PptxGenJS from 'pptxgenjs'

import {
  BULLET_INDENT_PT,
  CELL_MARGIN_X_IN,
  CELL_MARGIN_Y_IN,
  LINE_HEIGHT,
  PARA_GAP_PT,
  SLIDE,
  SUBTITLE_FONT_PT,
  TABLE_LINE_HEIGHT,
  TITLE_LINE_HEIGHT,
  planSlides,
  tableColumnWeights,
  type SlideChartBlock,
  type SlidePlan,
  type SlideTableBlock,
  type SlideTextBlock,
} from './butler-document-layout.js'
import { documentTextLines, type DocumentChart, type DocumentSection, type DocumentSpec, type DocumentTable, type DocumentTheme } from './butler-document-spec.js'

/**
 * 服务器不需要装这个字体:文件只写字体名,由打开文件的客户端渲染。
 * 没有雅黑的机器(Mac、手机)由 Office / WPS 回退到系统中文字体。
 */
export const DOCUMENT_FONT = 'Microsoft YaHei'

interface Palette {
  bg: string
  coverBg: string
  coverTitle: string
  coverSubtitle: string
  title: string
  text: string
  muted: string
  accent: string
  tableHead: string
  tableHeadText: string
  band: string
  border: string
  chart: string[]
  /** Word 的页面总是白底,深色主题的浅色标题不能照搬。 */
  wordHeading: string
  wordTableHead: string
}

const PALETTES: Record<DocumentTheme, Palette> = {
  business: {
    bg: 'FFFFFF',
    coverBg: '1F3A5F',
    coverTitle: 'FFFFFF',
    coverSubtitle: 'C9D6E6',
    title: '1F3A5F',
    text: '2B2F36',
    muted: '7A8594',
    accent: '2F6FB0',
    tableHead: '1F3A5F',
    tableHeadText: 'FFFFFF',
    band: 'F3F6FA',
    border: 'D5DCE5',
    chart: ['2F6FB0', 'E08A3C', '4FA67F', '9A6FB0', 'C95F5F', '5FB0C9', 'B0A04F', '7A8594'],
    wordHeading: '1F3A5F',
    wordTableHead: '1F3A5F',
  },
  warm: {
    bg: 'FFFBF5',
    coverBg: '7A3E1D',
    coverTitle: 'FFF8EF',
    coverSubtitle: 'EBD3BC',
    title: '7A3E1D',
    text: '3A2E26',
    muted: '9A8878',
    accent: 'C8692B',
    tableHead: '7A3E1D',
    tableHeadText: 'FFF8EF',
    band: 'FBF0E4',
    border: 'EAD9C6',
    chart: ['C8692B', '5F8A6B', 'D9A441', '8A5A44', 'B5533C', '6B8FA3', 'A3875F', '9A8878'],
    wordHeading: '7A3E1D',
    wordTableHead: '7A3E1D',
  },
  dark: {
    bg: '1B1F27',
    coverBg: '12151B',
    coverTitle: 'F2F4F8',
    coverSubtitle: 'A9B2C1',
    title: 'F2F4F8',
    text: 'DDE1E8',
    muted: '8A93A3',
    accent: '5AA9E6',
    tableHead: '2C3442',
    tableHeadText: 'F2F4F8',
    band: '242A35',
    border: '3A4352',
    chart: ['5AA9E6', 'F2A65A', '6CCB9F', 'B79AE6', 'E67A7A', '6CC6DB', 'D9C86C', 'A9B2C1'],
    wordHeading: '1F2937',
    wordTableHead: '2C3442',
  },
}

const FOOTER_TITLE_MAX_CHARS = 50

// pptxgenjs 的 ESM 入口是没有 "type":"module" 的 .es.js,能否加载取决于 Node 的语法探测;
// CJS 入口在所有版本上行为一致。
const loadPptxGen = (): typeof PptxGenJS => {
  const loaded = createRequire(import.meta.url)('pptxgenjs') as { default?: typeof PptxGenJS } & typeof PptxGenJS
  return loaded.default ?? loaded
}

function renderPptxText(slide: PptxGenJS.Slide, block: SlideTextBlock, color: string): void {
  const runs = block.items.map((item, i) => ({
    text: item.text,
    options: {
      ...(item.bullet ? { bullet: { indent: BULLET_INDENT_PT } } : {}),
      breakLine: i < block.items.length - 1,
      paraSpaceAfter: PARA_GAP_PT,
    },
  }))
  slide.addText(runs, {
    x: block.x,
    y: block.y,
    w: block.w,
    h: block.h,
    margin: 0,
    valign: 'top',
    fontFace: DOCUMENT_FONT,
    fontSize: block.fontPt,
    color,
    // 固定行距让估算和字体度量脱钩:客户端回退到别的字体时,行高也不变。
    lineSpacing: Math.round(block.fontPt * LINE_HEIGHT),
  })
}

function renderPptxTable(slide: PptxGenJS.Slide, block: SlideTableBlock, palette: Palette): void {
  const lineSpacing = block.fontPt * TABLE_LINE_HEIGHT
  const header = block.headers.map((text) => ({
    text,
    options: { bold: true, color: palette.tableHeadText, fill: { color: palette.tableHead }, lineSpacing },
  }))
  const body = block.rows.map((row, r) =>
    row.map((text) => ({
      text,
      options: { color: palette.text, fill: { color: r % 2 === 1 ? palette.band : palette.bg }, lineSpacing },
    })),
  )
  slide.addTable([header, ...body], {
    x: block.x,
    y: block.y,
    w: block.w,
    colW: block.colW,
    rowH: block.rowH,
    fontFace: DOCUMENT_FONT,
    fontSize: block.fontPt,
    valign: 'middle',
    margin: [CELL_MARGIN_Y_IN, CELL_MARGIN_X_IN, CELL_MARGIN_Y_IN, CELL_MARGIN_X_IN],
    border: { type: 'solid', pt: 0.5, color: palette.border },
    // 分页已由规划器做完;库自带的分页按西文估算,对中文不准。
    autoPage: false,
  })
}

function renderPptxChart(slide: PptxGenJS.Slide, block: SlideChartBlock, palette: Palette): void {
  const { chart } = block
  const data = chart.series.map((s) => ({ name: s.name, labels: chart.labels, values: s.values }))
  slide.addChart(chart.type as PptxGenJS.CHART_NAME, data, {
    x: block.x,
    y: block.y,
    w: block.w,
    h: block.h,
    chartColors: palette.chart,
    showTitle: Boolean(chart.title),
    ...(chart.title ? { title: chart.title } : {}),
    titleFontFace: DOCUMENT_FONT,
    titleFontSize: 16,
    titleColor: palette.text,
    showLegend: chart.series.length > 1 || chart.type === 'pie',
    legendPos: 'b',
    legendFontFace: DOCUMENT_FONT,
    legendFontSize: 12,
    legendColor: palette.text,
    catAxisLabelFontFace: DOCUMENT_FONT,
    catAxisLabelFontSize: 12,
    catAxisLabelColor: palette.text,
    valAxisLabelFontFace: DOCUMENT_FONT,
    valAxisLabelFontSize: 12,
    valAxisLabelColor: palette.muted,
    valGridLine: { color: palette.border, size: 0.5 },
    catGridLine: { style: 'none' },
    dataLabelFontFace: DOCUMENT_FONT,
    ...(chart.type === 'pie' ? { showPercent: true, dataLabelColor: 'FFFFFF', dataLabelFontSize: 12 } : {}),
    ...(chart.type === 'bar' ? { barDir: 'col' as const } : {}),
  })
}

function renderPptxSlide(pptx: PptxGenJS, plan: SlidePlan, palette: Palette, footerTitle: string): void {
  const slide = pptx.addSlide()
  const heading = { margin: 0, fontFace: DOCUMENT_FONT, bold: true }

  if (plan.kind === 'cover') {
    slide.background = { color: palette.coverBg }
    slide.addText(plan.title, {
      ...SLIDE.coverTitleBox,
      ...heading,
      fontSize: plan.titleFontPt,
      color: palette.coverTitle,
      valign: 'bottom',
      lineSpacing: Math.round(plan.titleFontPt * TITLE_LINE_HEIGHT),
    })
    slide.addShape(pptx.ShapeType.rect, {
      x: SLIDE.coverTitleBox.x,
      y: SLIDE.coverTitleBox.y + SLIDE.coverTitleBox.h + 0.1,
      w: 1.2,
      h: 0.05,
      fill: { color: palette.accent },
      line: { color: palette.accent, width: 0 },
    })
    if (plan.subtitle) {
      slide.addText(plan.subtitle, {
        ...SLIDE.coverSubtitleBox,
        margin: 0,
        fontFace: DOCUMENT_FONT,
        fontSize: SUBTITLE_FONT_PT,
        color: palette.coverSubtitle,
        valign: 'top',
        lineSpacing: Math.round(SUBTITLE_FONT_PT * LINE_HEIGHT),
      })
    }
    return
  }

  const footer = { fontFace: DOCUMENT_FONT, fontSize: 10, color: palette.muted }
  slide.slideNumber = { x: 12.0, y: SLIDE.footerTopIn, w: 0.733, h: SLIDE.footerHIn, align: 'right', ...footer }

  if (plan.kind === 'divider') {
    slide.background = { color: palette.coverBg }
    slide.addText(plan.title, {
      ...SLIDE.dividerBox,
      ...heading,
      fontSize: plan.fontPt,
      color: palette.coverTitle,
      valign: 'middle',
      lineSpacing: Math.round(plan.fontPt * TITLE_LINE_HEIGHT),
    })
    if (plan.notes) slide.addNotes(plan.notes)
    return
  }

  slide.background = { color: palette.bg }
  if (plan.title) {
    slide.addText(plan.title, {
      ...heading,
      x: SLIDE.marginXIn,
      y: SLIDE.titleTopIn,
      w: SLIDE.contentWIn,
      h: plan.titleH,
      fontSize: plan.titleFontPt,
      color: palette.title,
      valign: 'top',
      lineSpacing: Math.round(plan.titleFontPt * TITLE_LINE_HEIGHT),
    })
    slide.addShape(pptx.ShapeType.rect, {
      x: SLIDE.marginXIn,
      y: SLIDE.titleTopIn + plan.titleH + 0.05,
      w: 0.6,
      h: 0.04,
      fill: { color: palette.accent },
      line: { color: palette.accent, width: 0 },
    })
  }
  for (const block of plan.blocks) {
    if (block.kind === 'text') renderPptxText(slide, block, palette.text)
    else if (block.kind === 'table') renderPptxTable(slide, block, palette)
    else renderPptxChart(slide, block, palette)
  }
  slide.addText(footerTitle, {
    x: SLIDE.marginXIn,
    y: SLIDE.footerTopIn,
    w: 9,
    h: SLIDE.footerHIn,
    margin: 0,
    valign: 'middle',
    ...footer,
  })
  if (plan.notes) slide.addNotes(plan.notes)
}

async function renderPptx(spec: DocumentSpec): Promise<Uint8Array> {
  const Pptx = loadPptxGen()
  const pptx = new Pptx()
  pptx.layout = 'LAYOUT_WIDE'
  pptx.title = spec.title
  pptx.subject = spec.subtitle ?? ''
  pptx.author = 'Atong'
  pptx.company = 'Gotong'
  pptx.theme = { headFontFace: DOCUMENT_FONT, bodyFontFace: DOCUMENT_FONT }
  const palette = PALETTES[spec.theme]
  const chars = [...spec.title]
  // 页脚只是提示这是哪份文档,完整标题在封面上。
  const footerTitle = chars.length > FOOTER_TITLE_MAX_CHARS ? `${chars.slice(0, FOOTER_TITLE_MAX_CHARS).join('')}…` : spec.title
  for (const plan of planSlides(spec)) renderPptxSlide(pptx, plan, palette, footerTitle)
  // 库只在 STREAM 分支把 compression 传给 JSZip;写 nodebuffer 会静默存成不压缩的 zip。
  return (await pptx.write({ outputType: 'STREAM', compression: true })) as Uint8Array
}

const WORD_CONTENT_WIDTH_DXA = 9026
const WORD_LINE_15 = 360
const BULLET_REF = 'atong-bullets'

async function renderDocx(spec: DocumentSpec): Promise<Uint8Array> {
  const d = await import('docx')
  const palette = PALETTES[spec.theme]
  const font = { ascii: DOCUMENT_FONT, eastAsia: DOCUMENT_FONT, hAnsi: DOCUMENT_FONT, cs: DOCUMENT_FONT }
  const heading = (size: number, before: number) => ({
    run: { font, size, bold: true, color: palette.wordHeading },
    paragraph: { spacing: { before, after: 120, line: WORD_LINE_15 } },
  })

  const table = (src: DocumentTable): InstanceType<typeof d.Table> => {
    const weights = tableColumnWeights(src)
    const total = weights.reduce((a, b) => a + b, 0)
    const columnWidths = weights.map((w) => Math.floor((WORD_CONTENT_WIDTH_DXA * w) / total))
    const cell = (text: string, col: number, isHeader: boolean): InstanceType<typeof d.TableCell> =>
      new d.TableCell({
        width: { size: columnWidths[col] as number, type: d.WidthType.DXA },
        margins: { top: 60, bottom: 60, left: 100, right: 100 },
        verticalAlign: d.VerticalAlignTable.CENTER,
        ...(isHeader ? { shading: { type: d.ShadingType.CLEAR, color: 'auto', fill: palette.wordTableHead } } : {}),
        children: [
          new d.Paragraph({
            spacing: { before: 0, after: 0, line: 276 },
            children: [new d.TextRun({ text, ...(isHeader ? { bold: true, color: 'FFFFFF' } : {}) })],
          }),
        ],
      })
    return new d.Table({
      width: { size: WORD_CONTENT_WIDTH_DXA, type: d.WidthType.DXA },
      columnWidths,
      layout: d.TableLayoutType.FIXED,
      rows: [
        new d.TableRow({ tableHeader: true, children: src.headers.map((h, c) => cell(h, c, true)) }),
        ...src.rows.map((row) => new d.TableRow({ children: row.map((text, c) => cell(text, c, false)) })),
      ],
    })
  }

  const chartAsTable = (chart: DocumentChart): DocumentTable => ({
    headers: ['', ...chart.series.map((s) => s.name)],
    rows: chart.labels.map((label, i) => [label, ...chart.series.map((s) => String(s.values[i]))]),
  })

  // 空段落把紧邻的表格和下文隔开,否则 Word 把它们贴在一起。
  const spacer = (): InstanceType<typeof d.Paragraph> => new d.Paragraph({ spacing: { before: 0, after: 60 } })
  const headingLevels = [d.HeadingLevel.HEADING_1, d.HeadingLevel.HEADING_2, d.HeadingLevel.HEADING_3]

  const sectionChildren = (section: DocumentSection): Array<InstanceType<typeof d.Paragraph> | InstanceType<typeof d.Table>> => {
    const out: Array<InstanceType<typeof d.Paragraph> | InstanceType<typeof d.Table>> = []
    if (section.heading) {
      out.push(new d.Paragraph({ text: section.heading, heading: headingLevels[(section.level ?? 1) - 1] as never }))
    }
    for (const para of section.paragraphs ?? []) {
      for (const text of documentTextLines(para)) out.push(new d.Paragraph({ children: [new d.TextRun(text)] }))
    }
    for (const bullet of section.bullets ?? []) {
      for (const text of documentTextLines(bullet)) {
        out.push(new d.Paragraph({ numbering: { reference: BULLET_REF, level: 0 }, children: [new d.TextRun(text)] }))
      }
    }
    if (section.table) out.push(table(section.table), spacer())
    if (section.chart) {
      const caption = section.chart.title ?? '图表数据'
      out.push(new d.Paragraph({ children: [new d.TextRun({ text: caption, bold: true })] }))
      out.push(table(chartAsTable(section.chart)), spacer())
    }
    // Word 没有演讲者备注这回事,但丢掉就是丢内容。
    for (const [i, line] of documentTextLines(section.notes ?? '').entries()) {
      out.push(new d.Paragraph({ children: [new d.TextRun({ text: i === 0 ? `备注:${line}` : line, color: palette.muted, size: 20 })] }))
    }
    return out
  }

  const doc = new d.Document({
    title: spec.title,
    ...(spec.subtitle ? { subject: spec.subtitle } : {}),
    creator: 'Atong',
    styles: {
      default: {
        document: {
          run: { font, size: 22, color: '2B2F36' },
          paragraph: { spacing: { after: 120, line: WORD_LINE_15 } },
        },
        title: { run: { font, size: 48, bold: true, color: palette.wordHeading }, paragraph: { spacing: { after: 160 } } },
        heading1: heading(32, 360),
        heading2: heading(28, 280),
        heading3: heading(24, 200),
      },
    },
    numbering: {
      config: [
        {
          reference: BULLET_REF,
          levels: [
            {
              level: 0,
              format: d.LevelFormat.BULLET,
              text: '•',
              alignment: d.AlignmentType.LEFT,
              style: { paragraph: { indent: { left: 420, hanging: 260 } } },
            },
          ],
        },
      ],
    },
    sections: [
      {
        properties: {
          page: {
            size: { width: 11906, height: 16838 },
            margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
          },
        },
        footers: {
          default: new d.Footer({
            children: [
              new d.Paragraph({
                alignment: d.AlignmentType.CENTER,
                children: [new d.TextRun({ children: [d.PageNumber.CURRENT], size: 18, color: palette.muted })],
              }),
            ],
          }),
        },
        children: [
          new d.Paragraph({ text: spec.title, heading: d.HeadingLevel.TITLE }),
          ...(spec.subtitle
            ? [new d.Paragraph({ children: [new d.TextRun({ text: spec.subtitle, color: palette.muted, size: 26 })] })]
            : []),
          ...spec.sections.flatMap(sectionChildren),
        ],
      },
    ],
  })
  return d.Packer.toBuffer(doc)
}

export async function renderDocument(spec: DocumentSpec): Promise<Uint8Array> {
  return spec.format === 'pptx' ? renderPptx(spec) : renderDocx(spec)
}
