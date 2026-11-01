/**
 * butler-document-runner.ts — 在一次性子进程里生成文档。
 *
 * 第三方库不进主进程:子进程环境变量从零拼(拿不到 hub 的 key),堆上限和超时钉死,
 * 全进程同一时刻只跑一个(小 VPS 上并发生成会把内存顶到 swap)。用完退出,内存全部归还。
 *
 * **这不是沙箱**:子进程和 hub 同一用户,文件系统仍可读。它防的是资源失控和环境变量
 * 外泄;模型代码本来就不会进这里,输入只有校验过的结构化内容。
 */

import { spawn } from 'node:child_process'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DOCUMENT_LIMITS, type DocumentSpec } from './butler-document-spec.js'

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_HEAP_MB = 192
const STDERR_TAIL_BYTES = 2048
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04]

export type DocumentRenderErrorCode = 'timeout' | 'output_too_large' | 'worker_failed' | 'bad_output'

export class DocumentRenderError extends Error {
  constructor(
    readonly code: DocumentRenderErrorCode,
    message: string,
    /** 子进程 stderr 的尾部,只进日志。GC 转储和路径不该让模型转述给成员。 */
    readonly detail?: string,
  ) {
    super(message)
    this.name = 'DocumentRenderError'
  }
}

export interface DocumentRunnerOptions {
  /** 测试缝:在 TS 源码上跑时指向 .ts 并配 `--import tsx`。 */
  workerEntry?: string
  execArgv?: string[]
  timeoutMs?: number
  maxOutputBytes?: number
}

const defaultWorkerEntry = (): string => fileURLToPath(new URL('./butler-document-worker.js', import.meta.url))

function runOnce(spec: DocumentSpec, options: DocumentRunnerOptions): Promise<Uint8Array> {
  const entry = options.workerEntry ?? defaultWorkerEntry()
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxOutput = options.maxOutputBytes ?? DOCUMENT_LIMITS.maxOutputBytes

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...(options.execArgv ?? []), `--max-old-space-size=${MAX_HEAP_MB}`, entry], {
      // 不继承任何变量,连 NODE_OPTIONS 也不留。Node 启动不需要环境变量。
      env: {},
      cwd: dirname(entry),
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let settled = false
    const finish = (err: Error | null, bytes?: Uint8Array): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (err) {
        child.kill('SIGKILL')
        reject(err)
      } else {
        resolve(bytes as Uint8Array)
      }
    }
    const timer = setTimeout(() => {
      finish(new DocumentRenderError('timeout', `生成超过 ${Math.round(timeoutMs / 1000)} 秒,已终止`))
    }, timeoutMs)

    const chunks: Buffer[] = []
    let size = 0
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > maxOutput) {
        finish(new DocumentRenderError('output_too_large', `生成的文件超过 ${Math.round(maxOutput / 1024 / 1024)}MB`))
        return
      }
      chunks.push(chunk)
    })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-STDERR_TAIL_BYTES)
    })
    child.on('error', (err) => finish(new DocumentRenderError('worker_failed', `无法启动生成进程:${err.message}`)))
    child.on('close', (code, signal) => {
      if (code !== 0) {
        // 堆撞到上限时 V8 直接 abort。重试同样的内容还会失败,要告诉模型换做法。
        const why =
          signal === 'SIGABRT'
            ? '内容太复杂,生成时内存不够,可以拆成两份文档'
            : `生成进程异常退出(${signal ? `信号 ${signal}` : `退出码 ${code}`})`
        finish(new DocumentRenderError('worker_failed', why, stderr.trim()))
        return
      }
      const bytes = Buffer.concat(chunks)
      // pptx / docx 都是 zip。这道检查挡住「退出码 0 但 stdout 被别的东西污染」。
      if (bytes.length < ZIP_MAGIC.length || ZIP_MAGIC.some((b, i) => bytes[i] !== b)) {
        finish(new DocumentRenderError('bad_output', '生成进程的输出不是有效文件'))
        return
      }
      finish(null, bytes)
    })

    // 子进程提前退出时 stdin 会 EPIPE;结果由 close 分支报告,这里不能让它变成未捕获异常。
    child.stdin.on('error', () => undefined)
    child.stdin.end(JSON.stringify(spec))
  })
}

// 一个 hub 进程一条队列。工厂按成员建工具实例,所以队列不能挂在实例上。
let queue: Promise<unknown> = Promise.resolve()

/** 排队渲染。超时只从真正开跑算起,排队的时间不算。 */
export function renderDocumentInWorker(spec: DocumentSpec, options: DocumentRunnerOptions = {}): Promise<Uint8Array> {
  const run = queue.then(() => runOnce(spec, options))
  queue = run.catch(() => undefined)
  return run
}
