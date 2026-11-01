import { DOMParser } from '@xmldom/xmldom'
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'

import { planSlides } from '../src/butler-document-layout.js'
import { DOCUMENT_FONT, renderDocument } from '../src/butler-document-render.js'
import { parseDocumentSections, type DocumentSection, type DocumentSpec, type DocumentTheme } from '../src/butler-document-spec.js'

const NASTY = `A<b>&"'c 😀`
const chart = {
  type: 'bar' as const,
  title: `图<表>&"`,
  labels: [`一<月>&`, `二"月'`],
  series: [
    { name: `收<入>&`, values: [1, 2.5] },
    { name: `成"本'`, values: [3, 4] },
  ],
}

const fullSections: DocumentSection[] = [
  { heading: '第一部分' },
  { heading: `要点${NASTY}`, level: 1, bullets: [`条目一${NASTY}`, '条目二'], paragraphs: [`正文段落${NASTY}`], notes: `备注${NASTY}` },
  { heading: '表格', level: 2, table: { headers: [`列<1>`, '列2'], rows: [[`值&1`, '值2'], [`"引号"`, `'单引号'`]] } },
  { heading: '图表', level: 3, chart },
  { heading: '要点加图表', bullets: ['左边一条'], chart: { type: 'pie', labels: ['甲', '乙'], series: [{ name: '占比', values: [40, 60] }] } },
  { heading: '折线', chart: { type: 'line', labels: ['一', '二'], series: [{ name: '趋势', values: [1, 2] }] } },
]

const makeSpec = (format: 'pptx' | 'docx', theme: DocumentTheme = 'business'): DocumentSpec => ({
  format,
  title: `季度报告${NASTY}`,
  subtitle: `副标题${NASTY}`,
  theme,
  sections: fullSections,
})

/** 严格解析:任何 XML 错误都抛,不接受 xmldom 的尽力修复。 */
function parseStrict(xml: string, name: string): Document {
  const fail = (level: string) => (msg: string): never => {
    throw new Error(`${name} ${level}: ${msg}`)
  }
  return new DOMParser({
    errorHandler: { warning: () => undefined, error: fail('error'), fatalError: fail('fatal') },
  }).parseFromString(xml, 'text/xml') as unknown as Document
}

/** 文件里所有 XML 部件(含图表内嵌的工作簿)。 */
async function xmlParts(bytes: Uint8Array): Promise<Map<string, string>> {
  const zip = await JSZip.loadAsync(bytes)
  const out = new Map<string, string>()
  for (const [name, file] of Object.entries(zip.files)) {
    if (file.dir) continue
    if (/\.(xml|rels)$/.test(name)) out.set(name, await file.async('string'))
    if (name.endsWith('.xlsx')) {
      for (const [inner, xml] of await xmlParts(await file.async('uint8array'))) out.set(`${name}!${inner}`, xml)
    }
  }
  return out
}

function textOf(node: Node, into: string[] = []): string[] {
  if (node.nodeType === 3 && node.nodeValue) into.push(node.nodeValue)
  for (let c = node.firstChild; c; c = c.nextSibling) textOf(c, into)
  return into
}

const allText = (parts: Map<string, string>, match: RegExp): string =>
  [...parts]
    .filter(([name]) => match.test(name))
    .map(([name, xml]) => textOf(parseStrict(xml, name)).join(''))
    .join('\n')

describe('renderDocument pptx', () => {
  it('所有 XML 部件都能严格解析,特殊字符和 emoji 不破坏文件', async () => {
    const parts = await xmlParts(await renderDocument(makeSpec('pptx')))
    expect(parts.size).toBeGreaterThan(20)
    for (const [name, xml] of parts) parseStrict(xml, name)
  })

  it('文件真的压缩过', async () => {
    const sections = Array.from({ length: 12 }, (_, i) => ({ heading: `第 ${i} 节`, paragraphs: ['正文内容'.repeat(40)] }))
    const bytes = await renderDocument({ ...makeSpec('pptx'), sections })
    const zip = await JSZip.loadAsync(bytes)
    let raw = 0
    for (const file of Object.values(zip.files)) if (!file.dir) raw += (await file.async('uint8array')).length
    // 不压缩时比值至少是 1;小部件多,压缩后也只到 0.35 左右。
    expect(bytes.length).toBeLessThan(raw / 2)
  })

  it('大表格的页数完全由规划器决定,库不再自己加页', async () => {
    const rows = Array.from({ length: 80 }, (_, i) => [`第 ${i} 行`, '这一格的内容足够长,会让行高变大,'.repeat(4)])
    const spec: DocumentSpec = { ...makeSpec('pptx'), sections: [{ heading: '大表', table: { headers: ['序号', '说明'], rows } }] }
    const planned = planSlides(spec).length
    expect(planned).toBeGreaterThan(3)
    const parts = await xmlParts(await renderDocument(spec))
    expect([...parts.keys()].filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))).toHaveLength(planned)
  })

  it('页数、原生图表、原生表格、备注都对', async () => {
    const parts = await xmlParts(await renderDocument(makeSpec('pptx')))
    const slides = [...parts.keys()].filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    expect(slides).toHaveLength(planSlides(makeSpec('pptx')).length)
    expect([...parts.keys()].filter((n) => /^ppt\/charts\/chart\d+\.xml$/.test(n))).toHaveLength(3)
    expect([...parts.values()].some((x) => x.includes('<a:tbl>'))).toBe(true)
    expect(allText(parts, /^ppt\/notesSlides\/.*\.xml$/)).toContain(`备注${NASTY}`)
  })

  it('文字完整写入:标题、正文、要点、表格、图表标签都在', async () => {
    const parts = await xmlParts(await renderDocument(makeSpec('pptx')))
    const slideText = allText(parts, /^ppt\/slides\/slide\d+\.xml$/)
    for (const want of [`季度报告${NASTY}`, `副标题${NASTY}`, '第一部分', `要点${NASTY}`, `条目一${NASTY}`, `正文段落${NASTY}`, '列<1>', '值&1', '"引号"']) {
      expect(slideText).toContain(want)
    }
    const chartText = allText(parts, /^ppt\/charts\/chart\d+\.xml$/)
    for (const want of ['图<表>&"', '一<月>&', '二"月\'', '收<入>&', '成"本\'']) expect(chartText).toContain(want)
    expect(allText(parts, /^docProps\/core\.xml$/)).toContain(`季度报告${NASTY}`)
  })

  it('东亚字体写进每一段正文', async () => {
    const parts = await xmlParts(await renderDocument(makeSpec('pptx')))
    const bodySlides = [...parts].filter(([n]) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    for (const [name, xml] of bodySlides) {
      expect(xml, name).toContain(`<a:ea typeface="${DOCUMENT_FONT}"`)
      // 没有 ea 的 run 会落到主题字体;每个带文字的 run 都要显式指定。
      for (const run of xml.match(/<a:r>[\s\S]*?<\/a:r>/g) ?? []) {
        expect(run, `${name} 缺东亚字体`).toContain(`<a:ea typeface="${DOCUMENT_FONT}"`)
      }
    }
  })

  it('固定行距和零内边距写进文件,版面估算才成立', async () => {
    const parts = await xmlParts(await renderDocument(makeSpec('pptx')))
    const xml = [...parts].filter(([n]) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).map(([, x]) => x).join('')
    expect(xml).toContain('<a:lnSpc><a:spcPts')
    expect(xml).toContain('lIns="0"')
    expect(xml).not.toMatch(/<a:normAutofit/)
  })

  it('页码是真字段,封面没有页脚', async () => {
    const parts = await xmlParts(await renderDocument(makeSpec('pptx')))
    expect(parts.get('ppt/slides/slide1.xml')).not.toContain('type="slidenum"')
    expect(parts.get('ppt/slides/slide2.xml')).toContain('type="slidenum"')
  })

  it.each(['business', 'warm', 'dark'] as const)('%s 主题生成的文件有效', async (theme) => {
    const parts = await xmlParts(await renderDocument(makeSpec('pptx', theme)))
    for (const [name, xml] of parts) parseStrict(xml, name)
  })

  it('经过校验层的控制字符和孤立代理不进文件', async () => {
    const parsed = parseDocumentSections([{ heading: '坏\u0000字\ud83d符', paragraphs: ['段\u0008落\ude00'] }])
    if (!parsed.ok) throw new Error(parsed.error)
    const parts = await xmlParts(await renderDocument({ format: 'pptx', title: 't', theme: 'business', sections: parsed.value }))
    for (const [name, xml] of parts) parseStrict(xml, name)
    const text = allText(parts, /^ppt\/slides\/slide2\.xml$/)
    expect(text).toContain('坏字符')
    expect(text).toContain('段落')
  })

  it('空内容也能生成(只有封面)', async () => {
    const parts = await xmlParts(await renderDocument({ format: 'pptx', title: '只有封面', theme: 'business', sections: [] }))
    expect(parts.has('ppt/slides/slide1.xml')).toBe(true)
    expect(parts.has('ppt/slides/slide2.xml')).toBe(false)
  })
})

describe('renderDocument docx', () => {
  it('所有 XML 部件都能严格解析', async () => {
    const parts = await xmlParts(await renderDocument(makeSpec('docx')))
    for (const [name, xml] of parts) parseStrict(xml, name)
  })

  it('标题样式、项目符号、表头重复、页码、A4 都写进去了', async () => {
    const parts = await xmlParts(await renderDocument(makeSpec('docx')))
    const doc = parts.get('word/document.xml') as string
    for (const style of ['Title', 'Heading1', 'Heading2', 'Heading3']) expect(doc).toContain(`w:pStyle w:val="${style}"`)
    expect(doc).toContain('<w:numPr>')
    expect(doc).toContain('<w:tblHeader/>')
    expect(doc).toContain('w:w="11906"')
    expect(doc).toContain('w:h="16838"')
    const footers = [...parts].filter(([n]) => /^word\/footer\d+\.xml$/.test(n)).map(([, x]) => x).join('')
    expect(footers).toContain('PAGE')
  })

  it('东亚字体和 1.5 倍行距写进样式', async () => {
    const styles = (await xmlParts(await renderDocument(makeSpec('docx')))).get('word/styles.xml') as string
    expect(styles).toContain(`w:eastAsia="${DOCUMENT_FONT}"`)
    expect(styles).toContain('w:line="360"')
    // 标题样式自己也要带字体,否则 Word 会用主题里的西文字体。
    const heading1 = styles.match(/<w:style [^>]*w:styleId="Heading1"[\s\S]*?<\/w:style>/)?.[0] ?? ''
    expect(heading1).toContain(`w:eastAsia="${DOCUMENT_FONT}"`)
  })

  it('段落和要点里的换行变成独立段落,空白行不占位', async () => {
    const out = await renderDocument({ ...makeSpec('docx'), sections: [{ paragraphs: ['段一\n\n段二'], bullets: ['点一\n  \n点二'] }] })
    const xml = (await (await JSZip.loadAsync(out)).file('word/document.xml')?.async('string')) ?? ''
    const paragraphs = xml.split('</w:p>')
    for (const want of ['段一', '段二', '点一', '点二']) {
      expect(paragraphs.filter((p) => p.includes(`>${want}<`))).toHaveLength(1)
    }
    expect(paragraphs.filter((p) => p.includes('<w:numPr>'))).toHaveLength(2)
  })

  it('备注里的换行变成独立段落,只有第一行带前缀', async () => {
    const out = await renderDocument({ ...makeSpec('docx'), sections: [{ heading: 'h', notes: '第一行\n\n第二行' }] })
    const xml = await (await JSZip.loadAsync(out)).file('word/document.xml')?.async('string')
    const texts = [...(xml ?? '').matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1])
    expect(texts).toContain('备注:第一行')
    expect(texts).toContain('第二行')
  })

  it('内容完整:图表转成数据表格,备注不丢', async () => {
    const parts = await xmlParts(await renderDocument(makeSpec('docx')))
    const text = allText(parts, /^word\/document\.xml$/)
    for (const want of [`季度报告${NASTY}`, `副标题${NASTY}`, `条目一${NASTY}`, `正文段落${NASTY}`, '列<1>', '值&1', '图<表>&"', '收<入>&', '一<月>&', '2.5', `备注${NASTY}`]) {
      expect(text).toContain(want)
    }
    const doc = parseStrict(parts.get('word/document.xml') as string, 'document')
    // 显式表格 1 张 + 图表转的 3 张。
    expect(doc.getElementsByTagName('w:tbl').length).toBe(4)
    expect([...parts.keys()].some((n) => n.includes('charts/'))).toBe(false)
  })

  it('深色主题的标题不用浅色,白纸上要看得见', async () => {
    const styles = (await xmlParts(await renderDocument(makeSpec('docx', 'dark')))).get('word/styles.xml') as string
    const heading1 = styles.match(/<w:style [^>]*w:styleId="Heading1"[\s\S]*?<\/w:style>/)?.[0] ?? ''
    expect(heading1).toContain('w:color w:val="1F2937"')
  })
})
