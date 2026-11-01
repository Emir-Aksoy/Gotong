import { describe, expect, it } from 'vitest'

import {
  DOCUMENT_LIMITS,
  cleanDocumentText,
  documentBlockCount,
  documentFilename,
  documentWarnings,
  parseDocumentMeta,
  parseDocumentMetaPatch,
  parseDocumentSections,
  type DocumentSection,
} from '../src/butler-document-spec.js'

function sections(raw: unknown): DocumentSection[] {
  const r = parseDocumentSections(raw)
  if (!r.ok) throw new Error(r.error)
  return r.value
}

function refusal(raw: unknown): string {
  const r = parseDocumentSections(raw)
  if (r.ok) throw new Error('本应被拒绝')
  return r.error
}

describe('cleanDocumentText', () => {
  it('删掉 XML 1.0 不允许的控制字符,保留制表和换行', () => {
    expect(cleanDocumentText('a\u0000b\u0008c\u000bd\u000ce\u001ff\tg\nh')).toBe('abcdef\tg\nh')
  })

  it('删掉孤立代理对,保留成对的 emoji', () => {
    expect(cleanDocumentText('前\ud83d后')).toBe('前后')
    expect(cleanDocumentText('前\ude00后')).toBe('前后')
    expect(cleanDocumentText('笑😀脸')).toBe('笑😀脸')
    // 顺序反了的一对也是两个孤立代理。
    expect(cleanDocumentText('x\ude00\ud83dy')).toBe('xy')
  })

  it('统一 CRLF,不碰 XML 特殊字符(转义是渲染库的事)', () => {
    expect(cleanDocumentText('a\r\nb\rc')).toBe('a\nb\nc')
    expect(cleanDocumentText(`<>&"'`)).toBe(`<>&"'`)
  })
})

describe('parseDocumentSections', () => {
  it('接受完整章节,清洗每个文字字段', () => {
    const [s] = sections([
      {
        heading: ' 第\u0000一章\n概览 ',
        level: 2,
        paragraphs: ['正文\ud83d。', '  ', '第二段'],
        bullets: ['要点'],
        table: { headers: ['列\n1', 2], rows: [['a', 1], [true]] },
        chart: { type: 'bar', title: '销量', labels: ['Q1', 'Q2'], series: [{ name: '甲', values: [1, '2.5'] }] },
        notes: '备注\u0001',
      },
    ])
    expect(s).toEqual({
      heading: '第一章 概览',
      level: 2,
      paragraphs: ['正文。', '第二段'],
      bullets: ['要点'],
      table: { headers: ['列 1', '2'], rows: [['a', '1'], ['true', '']] },
      chart: { type: 'bar', title: '销量', labels: ['Q1', 'Q2'], series: [{ name: '甲', values: [1, 2.5] }] },
      notes: '备注',
    })
  })

  it('宽进:单段字符串、JSON 字符串形式的 sections、null 字段', () => {
    expect(sections('[{"heading":"甲"}]')).toEqual([{ heading: '甲' }])
    expect(sections([{ paragraphs: '单段', bullets: null, level: null }])).toEqual([{ paragraphs: ['单段'] }])
  })

  it('不认识的字段响亮拒绝:忽略等于丢内容', () => {
    expect(refusal([{ heading: '甲', body: '正文放错地方' }])).toContain('body')
  })

  it('空章节被拒,因为它只会生成一张空白页', () => {
    expect(refusal([{}])).toContain('sections[0]')
    expect(refusal([{ paragraphs: ['  '], notes: '只有备注' }])).toContain('sections[0]')
  })

  it('错误指明下标,模型能自己改', () => {
    expect(refusal([{ heading: '好' }, { heading: {} }])).toContain('sections[1].heading')
    expect(refusal([{ bullets: ['a', 2] }])).toContain('sections[0].bullets[1]')
    expect(refusal([{ level: 4, heading: 'x' }])).toContain('level')
    expect(refusal('不是 JSON')).toContain('sections')
    expect(refusal({ heading: 'x' })).toContain('数组')
  })

  it('表格:行不能比表头宽,短行补齐', () => {
    expect(refusal([{ table: { headers: ['a'], rows: [['1', '2']] } }])).toContain('比表头多')
    expect(refusal([{ table: { headers: [], rows: [] } }])).toContain('headers')
    expect(refusal([{ table: { headers: ['a'], rows: [[{ x: 1 }]] } }])).toContain('文字或数字')
    expect(sections([{ table: { headers: ['a', 'b'], rows: [['1']] } }])[0]?.table?.rows).toEqual([['1', '']])
  })

  it('图表:数据和标签个数一致、值必须是有限数', () => {
    const chart = (over: object) => [{ chart: { type: 'bar', labels: ['a', 'b'], series: [{ name: 's', values: [1, 2] }], ...over } }]
    expect(refusal(chart({ type: 'radar' }))).toContain('type')
    expect(refusal(chart({ labels: [] }))).toContain('labels')
    expect(refusal(chart({ series: [] }))).toContain('series')
    expect(refusal(chart({ series: [{ name: 's', values: [1] }] }))).toContain('一样')
    expect(refusal(chart({ series: [{ name: 's', values: [1, Number.NaN] }] }))).toContain('不是数字')
    expect(refusal(chart({ series: [{ name: 's', values: [1, Number.POSITIVE_INFINITY] }] }))).toContain('不是数字')
    expect(refusal(chart({ series: [{ name: 's', values: [1, '多'] }] }))).toContain('不是数字')
    expect(refusal(chart({ series: [{ name: 's', values: [1, ''] }] }))).toContain('不是数字')
    expect(refusal(chart({ type: 'pie', series: [{ name: 'x', values: [1, 2] }, { name: 'y', values: [1, 2] }] }))).toContain('饼图')
  })

  it('图表系列缺名字给默认名,重名加后缀', () => {
    const series = (raw: object[]) =>
      sections([{ chart: { type: 'line', labels: ['a'], series: raw } }])[0]?.chart?.series.map((s) => s.name)
    expect(series([{ values: [1] }])).toEqual(['系列 1'])
    expect(series([{ name: '甲', values: [1] }, { name: '甲', values: [2] }])).toEqual(['甲', '甲 (2)'])
  })

  it('超限明确拒绝,不截断', () => {
    const L = DOCUMENT_LIMITS
    const big = 'x'.repeat(L.maxTextChars + 1)
    expect(refusal([{ paragraphs: [big] }])).toContain('太长')
    expect(refusal([{ notes: big }])).toContain('太长')
    expect(refusal([{ heading: 'x'.repeat(L.maxHeadingChars + 1) }])).toContain('太长')
    expect(refusal([{ bullets: Array(L.maxItemsPerList + 1).fill('x') }])).toContain('太多')
    expect(refusal([{ table: { headers: Array(L.maxTableCols + 1).fill('x'), rows: [] } }])).toContain('列太多')
    expect(refusal([{ table: { headers: ['x'], rows: Array(L.maxTableRows + 1).fill(['y']) } }])).toContain('行太多')
    expect(refusal([{ table: { headers: ['x'], rows: [['y'.repeat(L.maxCellChars + 1)]] } }])).toContain('太长')
    expect(refusal([{ table: { headers: ['x'.repeat(L.maxHeaderChars + 1)], rows: [] } }])).toContain('headers[0]')
    expect(refusal([{ chart: { type: 'bar', labels: Array(L.maxChartLabels + 1).fill('x'), series: [] } }])).toContain('太多')
    expect(
      refusal([{ chart: { type: 'bar', labels: ['x'], series: Array(L.maxChartSeries + 1).fill({ name: 's', values: [1] }) } }]),
    ).toContain('太多')
  })

  it('恰好踩线的内容不拒绝', () => {
    const L = DOCUMENT_LIMITS
    expect(sections([{ paragraphs: ['x'.repeat(L.maxTextChars)] }])[0]?.paragraphs?.[0]).toHaveLength(L.maxTextChars)
    expect(sections([{ table: { headers: Array(L.maxTableCols).fill('x'), rows: [] } }])[0]?.table?.headers).toHaveLength(L.maxTableCols)
  })
})

describe('parseDocumentMeta', () => {
  it('新建必须有 format 和 title,theme 默认 business', () => {
    expect(parseDocumentMeta({ format: 'pptx', title: ' 报告 ' })).toEqual({
      ok: true,
      value: { format: 'pptx', theme: 'business', title: '报告' },
    })
    expect(parseDocumentMeta({ title: '报告' }).ok).toBe(false)
    expect(parseDocumentMeta({ format: 'pdf', title: '报告' }).ok).toBe(false)
    expect(parseDocumentMeta({ format: 'docx' }).ok).toBe(false)
    expect(parseDocumentMeta({ format: 'docx', title: '\u0000 ' }).ok).toBe(false)
  })

  it('theme 只收枚举,subtitle 清洗', () => {
    const ok = parseDocumentMeta({ format: 'docx', title: 't', subtitle: '副\u0001标题', theme: 'dark' })
    expect(ok).toEqual({ ok: true, value: { format: 'docx', title: 't', subtitle: '副标题', theme: 'dark' } })
    expect(parseDocumentMeta({ format: 'docx', title: 't', theme: 'neon' }).ok).toBe(false)
  })

  it('标题超长拒绝', () => {
    const long = 'x'.repeat(DOCUMENT_LIMITS.maxTitleChars + 1)
    expect(parseDocumentMeta({ format: 'docx', title: long }).ok).toBe(false)
    expect(parseDocumentMetaPatch({ subtitle: long }).ok).toBe(false)
  })

  it('patch 只返回给了的字段', () => {
    expect(parseDocumentMetaPatch({})).toEqual({ ok: true, value: {} })
    expect(parseDocumentMetaPatch({ title: '新', theme: 'warm' })).toEqual({ ok: true, value: { title: '新', theme: 'warm' } })
  })
})

describe('documentFilename', () => {
  it('去掉路径分隔符、控制字符和开头的点', () => {
    expect(documentFilename('../../etc/passwd', 'pptx')).toBe('etc passwd.pptx')
    expect(documentFilename('a\\b:c*d?e"f<g>h|i', 'docx')).toBe('a b c d e f g h i.docx')
    expect(documentFilename('...隐藏\u0000', 'docx')).toBe('隐藏.docx')
  })

  it('空名字和 Windows 保留名有兜底', () => {
    expect(documentFilename('///', 'pptx')).toBe('文档.pptx')
    expect(documentFilename('CON', 'docx')).toBe('文档-CON.docx')
  })

  it('长度按码点截,不切开 emoji', () => {
    const name = documentFilename('😀'.repeat(100), 'pptx')
    expect(name).toBe(`${'😀'.repeat(60)}.pptx`)
  })
})

describe('documentWarnings', () => {
  const chart = { type: 'bar' as const, labels: ['a'], series: [{ name: 's', values: [1] }] }

  it('Word 里的图表要如实说明', () => {
    expect(
      documentWarnings({ format: 'docx', title: 't', theme: 'business', sections: [{ chart }, { chart }, { heading: 'x' }] }),
    ).toEqual(['Word 不支持原生图表,2 个图表已转成数据表格'])
  })

  it('PPT 和没有图表的 Word 没有警告', () => {
    expect(documentWarnings({ format: 'pptx', title: 't', theme: 'business', sections: [{ chart }] })).toEqual([])
    expect(documentWarnings({ format: 'docx', title: 't', theme: 'business', sections: [{ heading: 'x' }] })).toEqual([])
  })
})

describe('不静默丢内容', () => {
  const BAR = { type: 'bar', labels: ['一'], series: [{ name: '甲', values: [1] }] }

  it('表格、图表、系列里不认识的字段也要拒绝,而不是收下再丢掉', () => {
    const table = refusal([{ table: { headers: ['甲'], rows: [], caption: '要紧的说明' } }])
    expect(table).toContain('sections[0].table')
    expect(table).toContain('caption')
    const chart = refusal([{ chart: { ...BAR, subtitle: '要紧的说明' } }])
    expect(chart).toContain('sections[0].chart')
    expect(chart).toContain('subtitle')
    const series = refusal([{ chart: { ...BAR, series: [{ name: '甲', values: [1], note: '要紧的说明' }] } }])
    expect(series).toContain('sections[0].chart.series[0]')
    expect(series).toContain('note')
  })

  it('数字形式的名称和标题转成文字,不被默认值顶掉', () => {
    const [section] = sections([{ heading: 2024, chart: { ...BAR, title: 2024, series: [{ name: 2023, values: [1] }] } }])
    expect(section?.heading).toBe('2024')
    expect(section?.chart?.title).toBe('2024')
    expect(section?.chart?.series[0]?.name).toBe('2023')
    expect(parseDocumentMetaPatch({ title: 2024, subtitle: 2025 })).toEqual({ ok: true, value: { title: '2024', subtitle: '2025' } })
    const meta = parseDocumentMeta({ format: 'docx', title: 2024 })
    expect(meta.ok && meta.value.title).toBe('2024')
  })

  it('其他类型的名称和标题明确拒绝', () => {
    expect(refusal([{ chart: { ...BAR, title: { text: '标题' } } }])).toContain('sections[0].chart.title')
    expect(refusal([{ chart: { ...BAR, series: [{ name: ['甲'], values: [1] }] } }])).toContain('series[0].name')
    expect(refusal([{ chart: { ...BAR, series: [['甲', [1]]] } }])).toContain('series[0] 应该是 {name, values}')
    const title = parseDocumentMetaPatch({ title: { text: '新标题' } })
    expect(!title.ok && title.error).toContain('title')
    const subtitle = parseDocumentMetaPatch({ subtitle: ['副标题'] })
    expect(!subtitle.ok && subtitle.error).toContain('subtitle')
  })

  it('布尔值不当文字印进文档,表格单元格除外', () => {
    expect(refusal([{ heading: false }])).toContain('sections[0].heading')
    expect(refusal([{ chart: { ...BAR, title: false } }])).toContain('chart.title')
    expect(refusal([{ chart: { ...BAR, labels: [true] } }])).toContain('labels[0]')
    expect(refusal([{ chart: { ...BAR, series: [{ name: true, values: [1] }] } }])).toContain('series[0].name')
    const title = parseDocumentMetaPatch({ title: false })
    expect(!title.ok && title.error).toContain('title')
    const subtitle = parseDocumentMetaPatch({ subtitle: true })
    expect(!subtitle.ok && subtitle.error).toContain('subtitle')
    expect(parseDocumentMeta({ format: 'pptx', title: false }).ok).toBe(false)
    // 单元格里的 true 是数据本身。
    expect(sections([{ table: { headers: ['是否'], rows: [[true]] } }])[0]?.table?.rows).toEqual([['true']])
  })

  it('没给系列名才用默认名', () => {
    const [section] = sections([{ chart: { ...BAR, series: [{ values: [1] }, { name: null, values: [2] }] } }])
    expect(section?.chart?.series.map((x) => x.name)).toEqual(['系列 1', '系列 2'])
  })

  it('重名系列改名后不能再撞上已有的名字', () => {
    const named = (...names: string[]) => names.map((name) => ({ name, values: [1] }))
    const [section] = sections([{ chart: { ...BAR, series: named('a (3)', 'a', 'a', 'a') } }])
    const names = section?.chart?.series.map((x) => x.name) ?? []
    expect(names).toHaveLength(4)
    expect(new Set(names).size).toBe(4)
  })

  it('图表文字也有长度上限', () => {
    const tooLong = 'x'.repeat(DOCUMENT_LIMITS.maxHeaderChars + 1)
    expect(refusal([{ chart: { ...BAR, labels: [tooLong] } }])).toContain('labels[0]')
    expect(refusal([{ chart: { ...BAR, series: [{ name: tooLong, values: [1] }] } }])).toContain('series[0].name')
    const longTitle = 'x'.repeat(DOCUMENT_LIMITS.maxHeadingChars + 1)
    expect(refusal([{ chart: { ...BAR, title: longTitle } }])).toContain('chart.title')
  })
})

describe('documentBlockCount', () => {
  it('段内每一行都算一块,Word 会把它们拆成独立段落', () => {
    expect(documentBlockCount([{ paragraphs: ['一\n二\n\n  \n三'] }])).toBe(3)
    expect(documentBlockCount([{ bullets: ['一\n二'] }])).toBe(2)
    expect(documentBlockCount([{ heading: 'h', notes: '一\n二' }])).toBe(3)
  })

  it('段落、要点、单元格、标题、备注都算,表头和图表转成的格子也算', () => {
    expect(documentBlockCount([])).toBe(0)
    expect(documentBlockCount([{ heading: 'h' }])).toBe(1)
    expect(documentBlockCount([{ heading: 'h', notes: 'n', paragraphs: ['a', 'b'], bullets: ['c'] }])).toBe(5)
    expect(documentBlockCount([{ table: { headers: ['甲', '乙', '丙'], rows: [['1', '2', '3'], ['4', '5', '6']] } }])).toBe(9)
    const chart = { type: 'bar' as const, labels: ['一', '二', '三'], series: [{ name: '甲', values: [1, 2, 3] }, { name: '乙', values: [4, 5, 6] }] }
    expect(documentBlockCount([{ chart }])).toBe(12)
    expect(documentBlockCount([{ heading: 'h' }, { bullets: ['a'] }])).toBe(2)
  })
})
