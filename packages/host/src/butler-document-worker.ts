/**
 * butler-document-worker.ts — 文档渲染子进程入口。
 *
 * 协议:stdin 一份 `DocumentSpec` JSON,stdout 原始文件字节,退出码 0。
 * 失败时退出码非 0,错误写 stderr。环境、内存和超时都由 `butler-document-runner.ts` 钉死。
 */

import type { DocumentSpec } from './butler-document-spec.js'
import { renderDocument } from './butler-document-render.js'

// stdout 是文件字节通道,第三方库打一行日志就会把文件写坏。
console.log = console.info = console.debug = console.error

async function main(): Promise<void> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  const spec = JSON.parse(Buffer.concat(chunks).toString('utf8')) as DocumentSpec
  const bytes = await renderDocument(spec)
  process.stdout.write(bytes)
}

main().catch((err: unknown) => {
  process.stderr.write(err instanceof Error ? (err.stack ?? err.message) : String(err))
  process.exitCode = 1
})
