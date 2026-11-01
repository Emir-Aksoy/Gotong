/**
 * butler-document-spec.ts — 阿同文档工具的内容形状、上限与校验(纯函数)。
 *
 * 模型交来的是结构化内容,这里把它变成可以放心渲染的东西:
 *
 *   - **清洗而不是截断**:XML 1.0 不允许的控制字符和孤立代理对会让整个文件打不开,
 *     所以删掉;别的一个字都不动。
 *   - **超限响亮拒绝**:截断等于悄悄丢内容,模型和成员都不知道。拒绝时指明位置,
 *     模型能自己改。
 *   - **不认识的字段也拒绝**:模型把正文放进 `body` 这种字段时,忽略它就是丢内容。
 *   - **宽进**:弱模型常把数字当字符串、把单段当字符串、把数组序列化成 JSON,
 *     这些意思明确的形状直接接受,省一轮重试。
 */

export type DocumentFormat = 'pptx' | 'docx'
export type DocumentTheme = 'business' | 'warm' | 'dark'
export type DocumentChartType = 'bar' | 'line' | 'pie'

export interface DocumentTable {
  headers: string[]
  rows: string[][]
}

export interface DocumentChart {
  type: DocumentChartType
  title?: string
  labels: string[]
  series: Array<{ name: string; values: number[] }>
}

export interface DocumentSection {
  heading?: string
  level?: 1 | 2 | 3
  paragraphs?: string[]
  bullets?: string[]
  table?: DocumentTable
  chart?: DocumentChart
  notes?: string
}

export interface DocumentMeta {
  format: DocumentFormat
  title: string
  subtitle?: string
  theme: DocumentTheme
}

export interface DocumentSpec extends DocumentMeta {
  sections: DocumentSection[]
}

export const DOCUMENT_LIMITS = Object.freeze({
  maxTitleChars: 200,
  maxHeadingChars: 200,
  /** 一段正文 / 一条要点 / 一段备注。 */
  maxTextChars: 8000,
  maxCellChars: 1000,
  /** 拆页时表头每页重复;太长的表头会把整页占满,正文永远排不下。 */
  maxHeaderChars: 60,
  maxItemsPerList: 200,
  maxTableCols: 12,
  maxTableRows: 300,
  maxChartLabels: 50,
  maxChartSeries: 8,
  maxSections: 300,
  /** 拆页之后的总页数。 */
  maxSlides: 120,
  /** 草稿序列化后的大小。 */
  maxDraftBytes: 1024 * 1024,
  /** 段落、要点、单元格的总数,见 {@link documentBlockCount}。 */
  maxContentBlocks: 8000,
  /** 飞书 `im/v1/files` 的上限;不带图片的文档碰不到,这里是兜底。 */
  maxOutputBytes: 30 * 1024 * 1024,
})

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string }

/** 段内换行拆成独立段落,空白行不占位。版面和 Word 都按它拆,内容块也按它数。 */
export function documentTextLines(text: string): string[] {
  return text.split('\n').filter((line) => line.trim())
}

/**
 * 生成时的内存跟对象个数走,不跟字节走:docx 给每个段落和单元格都建一棵对象树。
 * 在 192MB 堆上实测,6.7 万字节的短单元格(1.6 万个)就会撑爆,100 万字节的长段落
 * 不到 70MB,所以字节上限挡不住这一类,要单独数。段内每一行都会变成一个段落,所以
 * 按行数而不是按段数。上限取最后一次能生成的 1.2 万个再留余量:存得下的草稿必须
 * 生成得出来,不能等到发送那一步才失败。
 */
export function documentBlockCount(sections: readonly DocumentSection[]): number {
  let blocks = 0
  for (const section of sections) {
    if (section.heading) blocks += 1
    if (section.notes) blocks += documentTextLines(section.notes).length
    for (const text of [...(section.paragraphs ?? []), ...(section.bullets ?? [])]) {
      blocks += documentTextLines(text).length
    }
    if (section.table) blocks += section.table.headers.length * (section.table.rows.length + 1)
    // Word 里图表转成数据表,按转出来的格子算。
    if (section.chart) blocks += (section.chart.labels.length + 1) * (section.chart.series.length + 1)
  }
  return blocks
}

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error })

const FORMATS: readonly string[] = ['pptx', 'docx']
const THEMES: readonly string[] = ['business', 'warm', 'dark']
const CHART_TYPES: readonly string[] = ['bar', 'line', 'pie']
const SECTION_KEYS = new Set(['heading', 'level', 'paragraphs', 'bullets', 'table', 'chart', 'notes'])
const TABLE_KEYS = new Set(['headers', 'rows'])
const CHART_KEYS = new Set(['type', 'title', 'labels', 'series'])
const SERIES_KEYS = new Set(['name', 'values'])

// 孤立代理对在 UTF-8 里没有合法编码;\u007f-\u009f 虽合法但在文档里只会显示成方块。
const ILLEGAL_CHARS =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f￾￿]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g

/** 删掉会让文件打不开的字符,统一换行。别的一概不碰。 */
export function cleanDocumentText(raw: string): string {
  return raw.replace(/\r\n?/g, '\n').replace(ILLEGAL_CHARS, '')
}

/** 单行字段(标题、表格单元格):换行和连续空白收成一个空格。 */
function cleanInline(raw: string): string {
  return cleanDocumentText(raw).replace(/\s+/g, ' ').trim()
}

function asCellText(v: unknown): string | null {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return cleanInline(v)
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return null
}

/** 忽略不认识的字段就是丢内容,所以每一层都要查。 */
function rejectUnknownKeys(
  src: Record<string, unknown>,
  known: ReadonlySet<string>,
  where: string,
): { ok: false; error: string } | null {
  for (const key of Object.keys(src)) {
    if (!known.has(key)) return fail(`${where} 有不认识的字段「${key}」;可用字段:${[...known].join(' / ')}`)
  }
  return null
}

/**
 * 单行文字字段:数字转成文字,其他类型明确拒绝。悄悄换成默认值或丢掉,模型和成员都不知道。
 * 布尔值也算其他类型:`title: false` 多半是「不要标题」,转成文字就把 false 印进了文档。
 */
function parseInline(raw: unknown, where: string, max: number): ParseResult<string> {
  const text = typeof raw === 'boolean' ? null : asCellText(raw)
  if (text === null) return fail(`${where} 应该是文字或数字`)
  if (text.length > max) return fail(`${where} 太长(${text.length} > ${max} 字)`)
  return { ok: true, value: text }
}

function asNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/** `string | string[]` → 清洗过的非空字符串数组。 */
function parseTextList(raw: unknown, where: string): ParseResult<string[]> {
  const list = typeof raw === 'string' ? [raw] : raw
  if (!Array.isArray(list)) return fail(`${where} 应该是字符串数组`)
  if (list.length > DOCUMENT_LIMITS.maxItemsPerList) {
    return fail(`${where} 太多了(${list.length} > ${DOCUMENT_LIMITS.maxItemsPerList}),拆成几个章节`)
  }
  const out: string[] = []
  for (const [i, item] of list.entries()) {
    if (typeof item !== 'string') return fail(`${where}[${i}] 应该是字符串`)
    const text = cleanDocumentText(item).trim()
    if (text.length > DOCUMENT_LIMITS.maxTextChars) {
      return fail(`${where}[${i}] 太长(${text.length} > ${DOCUMENT_LIMITS.maxTextChars} 字),分成几段`)
    }
    if (text) out.push(text)
  }
  return { ok: true, value: out }
}

function parseTable(raw: unknown, where: string): ParseResult<DocumentTable> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail(`${where} 应该是 {headers, rows}`)
  const src = raw as Record<string, unknown>
  const unknownKey = rejectUnknownKeys(src, TABLE_KEYS, where)
  if (unknownKey) return unknownKey
  const { headers, rows } = src
  if (!Array.isArray(headers) || headers.length === 0) return fail(`${where}.headers 至少要有一列`)
  if (headers.length > DOCUMENT_LIMITS.maxTableCols) {
    return fail(`${where} 列太多(${headers.length} > ${DOCUMENT_LIMITS.maxTableCols}),拆成两张表`)
  }
  if (!Array.isArray(rows)) return fail(`${where}.rows 应该是二维数组`)
  if (rows.length > DOCUMENT_LIMITS.maxTableRows) {
    return fail(`${where} 行太多(${rows.length} > ${DOCUMENT_LIMITS.maxTableRows}),拆成几张表`)
  }
  const cell = (v: unknown, at: string): ParseResult<string> => {
    const text = asCellText(v)
    if (text === null) return fail(`${at} 应该是文字或数字`)
    if (text.length > DOCUMENT_LIMITS.maxCellChars) {
      return fail(`${at} 太长(${text.length} > ${DOCUMENT_LIMITS.maxCellChars} 字)`)
    }
    return { ok: true, value: text }
  }
  const outHeaders: string[] = []
  for (const [i, h] of headers.entries()) {
    const c = cell(h, `${where}.headers[${i}]`)
    if (!c.ok) return c
    if (c.value.length > DOCUMENT_LIMITS.maxHeaderChars) {
      return fail(`${where}.headers[${i}] 太长(${c.value.length} > ${DOCUMENT_LIMITS.maxHeaderChars} 字)`)
    }
    outHeaders.push(c.value)
  }
  const outRows: string[][] = []
  for (const [r, row] of rows.entries()) {
    if (!Array.isArray(row)) return fail(`${where}.rows[${r}] 应该是数组`)
    if (row.length > outHeaders.length) {
      return fail(`${where}.rows[${r}] 比表头多(${row.length} > ${outHeaders.length})`)
    }
    const out: string[] = []
    for (const [i, v] of row.entries()) {
      const c = cell(v, `${where}.rows[${r}][${i}]`)
      if (!c.ok) return c
      out.push(c.value)
    }
    // 短行补齐:表格渲染要求每行列数一致。
    while (out.length < outHeaders.length) out.push('')
    outRows.push(out)
  }
  return { ok: true, value: { headers: outHeaders, rows: outRows } }
}

function parseChart(raw: unknown, where: string): ParseResult<DocumentChart> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return fail(`${where} 应该是 {type, labels, series}`)
  }
  const src = raw as Record<string, unknown>
  const unknownKey = rejectUnknownKeys(src, CHART_KEYS, where)
  if (unknownKey) return unknownKey
  const { type, title, labels, series } = src
  if (typeof type !== 'string' || !CHART_TYPES.includes(type)) {
    return fail(`${where}.type 只能是 ${CHART_TYPES.join(' / ')}`)
  }
  if (!Array.isArray(labels) || labels.length === 0) return fail(`${where}.labels 至少要有一项`)
  if (labels.length > DOCUMENT_LIMITS.maxChartLabels) {
    return fail(`${where}.labels 太多(${labels.length} > ${DOCUMENT_LIMITS.maxChartLabels})`)
  }
  const outLabels: string[] = []
  for (const [i, l] of labels.entries()) {
    const label = parseInline(l, `${where}.labels[${i}]`, DOCUMENT_LIMITS.maxHeaderChars)
    if (!label.ok) return label
    outLabels.push(label.value)
  }
  if (!Array.isArray(series) || series.length === 0) return fail(`${where}.series 至少要有一组`)
  if (series.length > DOCUMENT_LIMITS.maxChartSeries) {
    return fail(`${where}.series 太多(${series.length} > ${DOCUMENT_LIMITS.maxChartSeries})`)
  }
  if (type === 'pie' && series.length > 1) return fail(`${where}: 饼图只能有一组数据`)
  const outSeries: DocumentChart['series'] = []
  for (const [s, item] of series.entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return fail(`${where}.series[${s}] 应该是 {name, values}`)
    }
    const seriesSrc = item as Record<string, unknown>
    const unknownSeriesKey = rejectUnknownKeys(seriesSrc, SERIES_KEYS, `${where}.series[${s}]`)
    if (unknownSeriesKey) return unknownSeriesKey
    const { name, values } = seriesSrc
    if (!Array.isArray(values) || values.length !== outLabels.length) {
      return fail(`${where}.series[${s}].values 的个数要和 labels 一样(${outLabels.length} 个)`)
    }
    const nums: number[] = []
    for (const [i, v] of values.entries()) {
      const n = asNumber(v)
      if (n === null) return fail(`${where}.series[${s}].values[${i}] 不是数字`)
      nums.push(n)
    }
    const seriesName = parseInline(name, `${where}.series[${s}].name`, DOCUMENT_LIMITS.maxHeaderChars)
    if (!seriesName.ok) return seriesName
    const base = seriesName.value || `系列 ${s + 1}`
    // 图表内嵌工作簿把系列名当表格列名,重名时 Office 编辑数据会报错。
    const taken = new Set(outSeries.map((x) => x.name))
    let unique = base
    for (let n = s + 1; taken.has(unique); n++) unique = `${base} (${n})`
    outSeries.push({ name: unique, values: nums })
  }
  const chartTitle = parseInline(title, `${where}.title`, DOCUMENT_LIMITS.maxHeadingChars)
  if (!chartTitle.ok) return chartTitle
  const cleanTitle = chartTitle.value
  return {
    ok: true,
    value: {
      type: type as DocumentChartType,
      ...(cleanTitle ? { title: cleanTitle } : {}),
      labels: outLabels,
      series: outSeries,
    },
  }
}

function parseSection(raw: unknown, where: string): ParseResult<DocumentSection> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail(`${where} 应该是对象`)
  const src = raw as Record<string, unknown>
  const unknownKey = rejectUnknownKeys(src, SECTION_KEYS, where)
  if (unknownKey) return unknownKey
  const out: DocumentSection = {}
  const heading = parseInline(src.heading, `${where}.heading`, DOCUMENT_LIMITS.maxHeadingChars)
  if (!heading.ok) return heading
  if (heading.value) out.heading = heading.value
  if (src.level !== undefined && src.level !== null) {
    if (src.level !== 1 && src.level !== 2 && src.level !== 3) return fail(`${where}.level 只能是 1、2、3`)
    out.level = src.level
  }
  for (const key of ['paragraphs', 'bullets'] as const) {
    if (src[key] === undefined || src[key] === null) continue
    const list = parseTextList(src[key], `${where}.${key}`)
    if (!list.ok) return list
    if (list.value.length > 0) out[key] = list.value
  }
  if (src.table !== undefined && src.table !== null) {
    const table = parseTable(src.table, `${where}.table`)
    if (!table.ok) return table
    out.table = table.value
  }
  if (src.chart !== undefined && src.chart !== null) {
    const chart = parseChart(src.chart, `${where}.chart`)
    if (!chart.ok) return chart
    out.chart = chart.value
  }
  if (src.notes !== undefined && src.notes !== null) {
    if (typeof src.notes !== 'string') return fail(`${where}.notes 应该是字符串`)
    const notes = cleanDocumentText(src.notes).trim()
    if (notes.length > DOCUMENT_LIMITS.maxTextChars) {
      return fail(`${where}.notes 太长(${notes.length} > ${DOCUMENT_LIMITS.maxTextChars} 字)`)
    }
    if (notes) out.notes = notes
  }
  if (!out.heading && !out.paragraphs && !out.bullets && !out.table && !out.chart) {
    return fail(`${where} 是空的,至少要有 heading、paragraphs、bullets、table、chart 之一`)
  }
  return { ok: true, value: out }
}

/** 解析一次调用带来的章节。下标是本次调用内的,模型照着就能改。 */
export function parseDocumentSections(raw: unknown): ParseResult<DocumentSection[]> {
  let list = raw
  if (typeof list === 'string') {
    try {
      list = JSON.parse(list)
    } catch {
      return fail('sections 应该是数组,这里收到的字符串也不是合法 JSON')
    }
  }
  if (!Array.isArray(list)) return fail('sections 应该是数组')
  const out: DocumentSection[] = []
  for (const [i, item] of list.entries()) {
    const section = parseSection(item, `sections[${i}]`)
    if (!section.ok) return section
    out.push(section.value)
  }
  return { ok: true, value: out }
}

/** 新建草稿时的元信息;`format` 和 `title` 必填。 */
export function parseDocumentMeta(args: Record<string, unknown>): ParseResult<DocumentMeta> {
  const { format } = args
  if (typeof format !== 'string' || !FORMATS.includes(format)) {
    return fail('新建文档要说明 format:pptx 或 docx')
  }
  const rest = parseDocumentMetaPatch(args)
  if (!rest.ok) return rest
  if (!rest.value.title) return fail('新建文档要有 title')
  return {
    ok: true,
    value: {
      format: format as DocumentFormat,
      theme: rest.value.theme ?? 'business',
      ...rest.value,
      title: rest.value.title,
    },
  }
}

/** 续写时可改的元信息(`title` / `subtitle` / `theme`);`format` 由调用方另行核对。 */
export function parseDocumentMetaPatch(
  args: Record<string, unknown>,
): ParseResult<Partial<Pick<DocumentMeta, 'title' | 'subtitle' | 'theme'>>> {
  const out: Partial<Pick<DocumentMeta, 'title' | 'subtitle' | 'theme'>> = {}
  for (const key of ['title', 'subtitle'] as const) {
    const field = parseInline(args[key], key, DOCUMENT_LIMITS.maxTitleChars)
    if (!field.ok) return field
    if (field.value) out[key] = field.value
  }
  if (args.theme !== undefined && args.theme !== null) {
    if (typeof args.theme !== 'string' || !THEMES.includes(args.theme)) {
      return fail(`theme 只能是 ${THEMES.join(' / ')}`)
    }
    out.theme = args.theme as DocumentTheme
  }
  return { ok: true, value: out }
}

const RESERVED_WINDOWS_NAME = /^(con|prn|aux|nul|com\d|lpt\d)$/i
const MAX_FILENAME_CHARS = 60

/** 标题 → 飞书上看到的文件名。只影响显示;盘上路径从不含成员内容。 */
export function documentFilename(title: string, format: DocumentFormat): string {
  let name = cleanInline(title)
    .replace(/[/\\:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
  // 按码点截,不把 emoji 切成半个。
  name = [...name].slice(0, MAX_FILENAME_CHARS).join('').trim()
  if (!name) name = '文档'
  if (RESERVED_WINDOWS_NAME.test(name)) name = `文档-${name}`
  return `${name}.${format}`
}

/** 产物和内容不完全对应的地方,工具结果要如实告诉模型。 */
export function documentWarnings(spec: DocumentSpec): string[] {
  if (spec.format !== 'docx') return []
  const charts = spec.sections.filter((s) => s.chart).length
  return charts > 0 ? [`Word 不支持原生图表,${charts} 个图表已转成数据表格`] : []
}
