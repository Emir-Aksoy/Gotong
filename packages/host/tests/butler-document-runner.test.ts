import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'

import { DocumentRenderError, renderDocumentInWorker } from '../src/butler-document-runner.js'
import { DOCUMENT_LIMITS, documentBlockCount, type DocumentSection, type DocumentSpec } from '../src/butler-document-spec.js'

const REAL_WORKER = fileURLToPath(new URL('../src/butler-document-worker.ts', import.meta.url))
const TSX = { workerEntry: REAL_WORKER, execArgv: ['--import', 'tsx'] }

const spec: DocumentSpec = {
  format: 'pptx',
  title: '子进程测试',
  theme: 'business',
  sections: [{ heading: '一', bullets: ['二'] }],
}

const scratch = mkdtempSync(join(tmpdir(), 'gotong-doc-runner-'))
function fakeWorker(name: string, source: string): string {
  const path = join(scratch, name)
  writeFileSync(path, source)
  return path
}

/** 每块最贵的形状:整张草稿都是表格单元格。 */
function cellSections(blocks: number, cell: string): DocumentSection[] {
  const COLUMNS = 12
  const sections: DocumentSection[] = []
  let left = blocks
  while (left >= COLUMNS * 2) {
    const rows = Math.min(DOCUMENT_LIMITS.maxTableRows, Math.floor(left / COLUMNS) - 1)
    sections.push({
      table: {
        headers: Array<string>(COLUMNS).fill('列'),
        rows: Array.from({ length: rows }, () => Array<string>(COLUMNS).fill(cell)),
      },
    })
    left -= COLUMNS * (rows + 1)
  }
  return sections
}

const expectCode = async (p: Promise<unknown>, code: string): Promise<DocumentRenderError> => {
  const err = await p.then(
    () => {
      throw new Error('本应失败')
    },
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(DocumentRenderError)
  expect((err as DocumentRenderError).code).toBe(code)
  return err as DocumentRenderError
}

describe('renderDocumentInWorker', () => {
  it('真子进程生成 PPT 和 Word', async () => {
    for (const format of ['pptx', 'docx'] as const) {
      const bytes = await renderDocumentInWorker({ ...spec, format }, TSX)
      const zip = await JSZip.loadAsync(bytes)
      expect(Object.keys(zip.files).some((n) => n.startsWith(format === 'pptx' ? 'ppt/' : 'word/'))).toBe(true)
    }
  }, 60_000)

  it('子进程环境里没有 hub 的变量', async () => {
    process.env.GOTONG_TEST_SECRET = 'must-not-leak'
    process.env.NODE_OPTIONS = '--max-old-space-size=4096'
    try {
      const entry = fakeWorker(
        'env.mjs',
        `process.stdin.resume(); process.stdin.on('end', () => {
           process.stderr.write(JSON.stringify(process.env)); process.exitCode = 1 })`,
      )
      const err = await expectCode(renderDocumentInWorker(spec, { workerEntry: entry }), 'worker_failed')
      const env = JSON.parse(err.detail as string) as Record<string, string>
      expect(env.GOTONG_TEST_SECRET).toBeUndefined()
      expect(env.NODE_OPTIONS).toBeUndefined()
      expect(env.PATH).toBeUndefined()
      expect(env.HOME).toBeUndefined()
    } finally {
      delete process.env.GOTONG_TEST_SECRET
      delete process.env.NODE_OPTIONS
    }
  })

  it('子进程带堆上限启动', async () => {
    const entry = fakeWorker(
      'heap.mjs',
      `process.stdin.resume(); process.stdin.on('end', () => {
         process.stderr.write(JSON.stringify(process.execArgv)); process.exitCode = 1 })`,
    )
    const err = await expectCode(renderDocumentInWorker(spec, { workerEntry: entry }), 'worker_failed')
    expect(err.detail).toContain('--max-old-space-size=192')
  })

  it('超时被强杀,进程真的没了', async () => {
    const pidFile = join(scratch, 'pid')
    const entry = fakeWorker(
      'hang.mjs',
      `import { writeFileSync } from 'node:fs'
       writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))
       process.on('SIGTERM', () => {}) // 只有 SIGKILL 杀得掉
       setInterval(() => {}, 1000)`,
    )
    const started = Date.now()
    await expectCode(renderDocumentInWorker(spec, { workerEntry: entry, timeoutMs: 400 }), 'timeout')
    expect(Date.now() - started).toBeLessThan(5000)
    const pid = Number(readFileSync(pidFile, 'utf8'))
    await expect.poll(() => {
      try {
        process.kill(pid, 0)
        return 'alive'
      } catch {
        return 'gone'
      }
    }).toBe('gone')
  })

  it('同一时刻只跑一个,一个失败不阻塞后面的', async () => {
    const logFile = join(scratch, 'overlap.log')
    writeFileSync(logFile, '')
    const entry = fakeWorker(
      'serial.mjs',
      `import { appendFileSync } from 'node:fs'
       appendFileSync(${JSON.stringify(logFile)}, 'start\\n')
       setTimeout(() => {
         appendFileSync(${JSON.stringify(logFile)}, 'end\\n')
         process.stdout.write(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
       }, 120)`,
    )
    const bad = fakeWorker('bad.mjs', `process.exit(7)`)
    const results = await Promise.allSettled([
      renderDocumentInWorker(spec, { workerEntry: entry }),
      renderDocumentInWorker(spec, { workerEntry: bad }),
      renderDocumentInWorker(spec, { workerEntry: entry }),
      renderDocumentInWorker(spec, { workerEntry: entry }),
    ])
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled', 'fulfilled'])
    const lines = readFileSync(logFile, 'utf8').trim().split('\n')
    expect(lines).toEqual(['start', 'end', 'start', 'end', 'start', 'end'])
  })

  it('排队时间不算进超时', async () => {
    const slow = fakeWorker(
      'slow.mjs',
      `setTimeout(() => process.stdout.write(Buffer.from([0x50, 0x4b, 0x03, 0x04])), 500)`,
    )
    const quick = fakeWorker('quick.mjs', `process.stdout.write(Buffer.from([0x50, 0x4b, 0x03, 0x04]))`)
    const [a, b] = await Promise.all([
      renderDocumentInWorker(spec, { workerEntry: slow }),
      renderDocumentInWorker(spec, { workerEntry: quick, timeoutMs: 400 }),
    ])
    expect(a).toHaveLength(4)
    expect(b).toHaveLength(4)
  })

  it('输出超限被杀', async () => {
    const entry = fakeWorker(
      'big.mjs',
      `const chunk = Buffer.alloc(1024 * 1024, 0x50)
       const tick = () => process.stdout.write(chunk, tick)
       tick()`,
    )
    await expectCode(renderDocumentInWorker(spec, { workerEntry: entry, maxOutputBytes: 2 * 1024 * 1024 }), 'output_too_large')
  })

  it('stdout 被污染时不把垃圾当文件发出去', async () => {
    const entry = fakeWorker('noise.mjs', `process.stdout.write('warn: something happened')`)
    await expectCode(renderDocumentInWorker(spec, { workerEntry: entry }), 'bad_output')
    const empty = fakeWorker('empty.mjs', ``)
    await expectCode(renderDocumentInWorker(spec, { workerEntry: empty }), 'bad_output')
  })

  it('子进程崩溃:细节进 detail,给模型的文案里没有 stderr', async () => {
    const entry = fakeWorker('crash.mjs', `throw new Error('渲染炸了')`)
    const err = await expectCode(renderDocumentInWorker(spec, { workerEntry: entry }), 'worker_failed')
    expect(err.detail).toContain('渲染炸了')
    expect(err.message).not.toContain('渲染炸了')
    expect(err.message).toContain('退出码 1')
  })

  it('上限以内最吃内存的草稿,在真堆上限里生成得出来(验收 11)', async () => {
    // 存得下就要生成得出。有人调高块数上限或调低堆上限时,这条会红。
    const sections = cellSections(DOCUMENT_LIMITS.maxContentBlocks, '字'.repeat(40))
    expect(documentBlockCount(sections)).toBeGreaterThan(DOCUMENT_LIMITS.maxContentBlocks - 24)
    expect(documentBlockCount(sections)).toBeLessThanOrEqual(DOCUMENT_LIMITS.maxContentBlocks)
    expect(Buffer.byteLength(JSON.stringify(sections))).toBeLessThanOrEqual(DOCUMENT_LIMITS.maxDraftBytes)
    const bytes = await renderDocumentInWorker({ ...spec, format: 'docx', sections }, TSX)
    const zip = await JSZip.loadAsync(bytes)
    expect(zip.file('word/document.xml')).not.toBeNull()
  }, 60_000)

  it('全是段内换行的草稿撑到块数上限,也生成得出来', async () => {
    // Word 按行拆段落,一段 8000 字可以有 4000 行。按段数算的话这份只有 2 块。
    const half = DOCUMENT_LIMITS.maxContentBlocks / 2
    const paragraph = Array<string>(half).fill('字').join('\n')
    expect(paragraph.length).toBeLessThanOrEqual(DOCUMENT_LIMITS.maxTextChars)
    const sections: DocumentSection[] = [{ paragraphs: [paragraph, paragraph] }]
    expect(documentBlockCount(sections)).toBe(DOCUMENT_LIMITS.maxContentBlocks)
    const bytes = await renderDocumentInWorker({ ...spec, format: 'docx', sections }, TSX)
    const xml = await (await JSZip.loadAsync(bytes)).file('word/document.xml')?.async('string')
    expect(xml?.match(/<w:t[ >]/g)?.length).toBeGreaterThanOrEqual(DOCUMENT_LIMITS.maxContentBlocks)
  }, 60_000)

  it('真撑爆堆:如实报内存不够,GC 转储不进给模型的文案', async () => {
    const sections = cellSections(DOCUMENT_LIMITS.maxContentBlocks * 5, 'x')
    const err = await expectCode(renderDocumentInWorker({ ...spec, format: 'docx', sections }, TSX), 'worker_failed')
    expect(err.message).toContain('内存不够')
    expect(err.message).not.toMatch(/GC|FATAL|heap/)
    expect(err.detail?.length).toBeGreaterThan(0)
  }, 60_000)

  it('子进程不读 stdin 就退出,不会变成未捕获的 EPIPE', async () => {
    const entry = fakeWorker('noread.mjs', `process.stdout.write(Buffer.from([0x50, 0x4b, 0x03, 0x04])); process.exit(0)`)
    const big: DocumentSpec = { ...spec, sections: [{ paragraphs: ['字'.repeat(4 * 1024 * 1024)] }] }
    expect(await renderDocumentInWorker(big, { workerEntry: entry })).toHaveLength(4)
  })

  it('真 worker 不会把库日志写进 stdout', () => {
    const source = readFileSync(REAL_WORKER, 'utf8')
    expect(source).toMatch(/console\.log = console\.info = console\.debug = console\.error/)
  })
})

describe('源码扫描门:第三方文档库只在渲染模块里(验收 9)', () => {
  const REPO_PACKAGES = fileURLToPath(new URL('../../', import.meta.url))
  const LIBRARIES = ['pptxgenjs', 'docx', 'jszip']
  const importPattern = new RegExp(
    `(?:from\\s+|import\\s*\\(\\s*|import\\s+|require\\s*\\(\\s*|\\)\\(\\s*)['"\`](${LIBRARIES.join('|')})(?:/[^'"\`]*)?['"\`]`,
  )
  const ALLOWED = 'host/src/butler-document-render.ts'

  function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === 'dist') continue
      const path = join(dir, entry)
      if (statSync(path).isDirectory()) sourceFiles(path, out)
      else if (/\.(ts|mts|cts|js|mjs|cjs)$/.test(entry) && !/\.d\.ts$/.test(entry)) out.push(path)
    }
    return out
  }

  const productionFiles = (): string[] =>
    readdirSync(REPO_PACKAGES)
      .map((pkg) => join(REPO_PACKAGES, pkg, 'src'))
      .filter((dir) => {
        try {
          return statSync(dir).isDirectory()
        } catch {
          return false
        }
      })
      .flatMap((dir) => sourceFiles(dir))

  it('扫描式样本能抓到各种写法', () => {
    for (const bad of [
      `import PptxGenJS from 'pptxgenjs'`,
      `import * as d from "docx"`,
      `const m = await import('docx')`,
      `const m = require('pptxgenjs')`,
      `createRequire(import.meta.url)('pptxgenjs')`,
      `import 'jszip'`,
      `import x from 'docx/dist/foo.js'`,
    ]) {
      expect(importPattern.test(bad), bad).toBe(true)
    }
    for (const fine of [`format === 'docx'`, `const FORMATS = ['pptx', 'docx']`, `file_type: 'doc'`]) {
      expect(importPattern.test(fine), fine).toBe(false)
    }
  })

  it('全部生产源码里,只有渲染模块 import 文档库', () => {
    const files = productionFiles()
    expect(files.length).toBeGreaterThan(200)
    const offenders = files
      .filter((path) => importPattern.test(readFileSync(path, 'utf8')))
      .map((path) => relative(REPO_PACKAGES, path))
    expect(offenders).toEqual([ALLOWED])
  })

  it('主进程只能经子进程入口碰渲染模块', () => {
    const importers = productionFiles()
      .filter((path) => /butler-document-render\.js/.test(readFileSync(path, 'utf8')))
      .map((path) => relative(REPO_PACKAGES, path))
    expect(importers).toEqual(['host/src/butler-document-worker.ts'])
  })

  it('子进程入口只被 runner 按路径引用,不被 import', () => {
    const importers = productionFiles()
      .filter((path) => /butler-document-worker\.js/.test(readFileSync(path, 'utf8')))
      .map((path) => relative(REPO_PACKAGES, path))
    expect(importers).toEqual(['host/src/butler-document-runner.ts'])
    const runner = readFileSync(join(REPO_PACKAGES, 'host/src/butler-document-runner.ts'), 'utf8')
    expect(runner).not.toMatch(/import\s[^\n]*butler-document-worker/)
  })
})
