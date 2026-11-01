/**
 * 工厂级端到端:真 `buildButlerFactory` 拼出的阿同,脚本模型调 `write_document`,
 * 经真子进程生成,再经真可达表和假桥发出。除了模型和飞书网络,其余都是真件。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Hub, Logger, ParticipantId, Task } from '@gotong/core'
import type { ImBridge, ImOutboundFile, ImUser } from '@gotong/im-adapter'
import type { LlmProvider, LlmRequest, LlmStreamChunk } from '@gotong/llm'
import JSZip from 'jszip'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { renderDocumentInWorker } from '../src/butler-document-runner.js'
import { ButlerReachableRegistry } from '../src/butler-reachable.js'
import { buildButlerFactory, type ButlerFactoryRefs } from '../src/personal-butler-factory.js'

const silentLogger: Logger = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
  child() {
    return silentLogger
  },
}

const WORKER = fileURLToPath(new URL('../src/butler-document-worker.ts', import.meta.url))

class ScriptProvider implements LlmProvider {
  readonly name = 'documents-e2e-script'
  readonly toolResults: string[] = []
  faceNames: string[] = []

  constructor(private readonly plan: Array<Record<string, unknown> | null>) {}


  async *stream(req: LlmRequest): AsyncIterable<LlmStreamChunk> {
    this.faceNames = (req.tools ?? []).map((t) => t.name)
    for (const m of req.messages) {
      if (!Array.isArray(m.content)) continue
      for (const b of m.content) {
        if ((b as { type?: string }).type === 'tool_result') {
          this.toolResults.push(JSON.stringify((b as { content?: unknown }).content))
        }
      }
    }
    const next = this.plan.shift()
    if (next) {
      yield {
        type: 'tool_use',
        toolUse: { type: 'tool_use', id: `call-${this.plan.length}`, name: 'write_document', input: next },
      }
      yield { type: 'end', stopReason: 'tool_use' }
      return
    }
    yield { type: 'text', text: '好的。' }
    yield { type: 'end', stopReason: 'end_turn' }
  }
}

class FileBridge implements ImBridge {
  readonly platform = 'lark'
  readonly files: Array<{ to: ImUser; filename: string; bytes: Uint8Array; chatId?: string }> = []
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async sendMessage(): Promise<void> {}
  async sendFile(to: ImUser, file: ImOutboundFile, options?: { chatId?: string }): Promise<void> {
    this.files.push({ to, filename: file.filename, bytes: file.bytes, ...(options?.chatId ? { chatId: options.chatId } : {}) })
  }
  onMessage(): () => void {
    return () => {}
  }
}

const task = (id: string, userId: string): Task => ({
  id: id as Task['id'],
  from: `user:${userId}` as Task['from'],
  strategy: { kind: 'explicit', to: 'atong' as ParticipantId },
  payload: '帮我做个文档',
  origin: { orgId: 'local', userId },
  createdAt: 1,
})

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gotong-doc-e2e-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function buildAtong(provider: LlmProvider, memberFiles: () => ButlerFactoryRefs['memberFiles']) {
  const refs = (): ButlerFactoryRefs => ({
    governedAgents: undefined,
    workflowEditor: undefined,
    workflowCreate: undefined,
    workflows: undefined,
    observeRuns: undefined,
    observeAgents: undefined,
    observeUsage: undefined,
    diagnoseOwned: undefined,
    diagnoseAdapt: undefined,
    askRoster: undefined,
    memberPush: undefined,
    memberFiles: memberFiles(),
    peerRoster: undefined,
    llmRoster: undefined,
    schedules: undefined,
    pendingInbox: undefined,
    wizard: undefined,
    providerBuilder: undefined,
    memoryView: undefined,
  })
  const factory = buildButlerFactory({
    hub: { dispatch: async () => ({ kind: 'ok' }) } as unknown as Hub,
    logger: silentLogger,
    memoryRoot: join(root, 'butler', 'memory'),
    governedOn: false,
    maintenanceOn: false,
    proactiveOn: false,
    runBroadcastOn: false,
    refs,
    documentRender: (spec) => renderDocumentInWorker(spec, { workerEntry: WORKER, execArgv: ['--import', 'tsx'] }),
  })
  return factory({ id: 'atong' as ParticipantId, provider, capabilities: ['chat'], system: '你是管家。' })
}

function memberFilesOver(bridge: ImBridge | undefined): ButlerFactoryRefs['memberFiles'] {
  const registry = new ButlerReachableRegistry({
    isBoundTo: () => true,
    dir: join(root, 'butler', 'reachable'),
    bridgeFor: () => bridge,
    logger: silentLogger,
  })
  registry.record({ userId: 'alice', platform: 'lark', platformUserId: 'ou_alice', chatId: 'oc_alice_dm' })
  return {
    canPush: (userId) => registry.canPushFile(userId),
    push: (userId, file) => registry.pushFile(userId, file),
  }
}

const chart = { type: 'bar', title: '销量', labels: ['Q1', 'Q2'], series: [{ name: '甲', values: [1, 2] }] }

describe('阿同 write_document 端到端', () => {
  it('工具在一等工具面上,不用查目录', async () => {
    const provider = new ScriptProvider([])
    await buildAtong(provider, () => undefined).onTask(task('t-face', 'alice'))
    expect(provider.faceNames).toContain('write_document')
  })

  it('模型一次调用 → 真子进程 → 假桥收到 PPT,含原生图表和表格', async () => {
    const bridge = new FileBridge()
    const provider = new ScriptProvider([
      {
        format: 'pptx',
        title: '季度复盘',
        sections: [
          { heading: '要点', bullets: ['收入增长', '成本下降'] },
          { heading: '数据', table: { headers: ['项目', '金额'], rows: [['收入', '100']] } },
          { heading: '趋势', chart },
        ],
        finish: true,
      },
    ])
    const files = memberFilesOver(bridge)
    await buildAtong(provider, () => files).onTask(task('t-ppt', 'alice'))

    expect(bridge.files).toHaveLength(1)
    const [sent] = bridge.files
    expect(sent?.filename).toBe('季度复盘.pptx')
    expect(sent?.to.platformUserId).toBe('ou_alice')
    expect(sent?.chatId).toBe('oc_alice_dm')
    const zip = await JSZip.loadAsync(sent?.bytes as Uint8Array)
    expect(zip.file('ppt/slides/slide4.xml')).not.toBeNull()
    expect(zip.file('ppt/charts/chart1.xml')).not.toBeNull()
    expect(await zip.file('ppt/slides/slide3.xml')?.async('string')).toContain('<a:tbl>')
    expect(provider.toolResults.join('')).toContain('飞书私聊')
  }, 60_000)

  it('分批写 Word:草稿跨实例保留,最后才发送', async () => {
    const bridge = new FileBridge()
    const files = memberFilesOver(bridge)
    const first = new ScriptProvider([{ format: 'docx', title: '报告', sections: [{ heading: '第一章', paragraphs: ['正文'] }] }])
    await buildAtong(first, () => files).onTask(task('t-doc-1', 'alice'))
    expect(bridge.files).toHaveLength(0)
    const draftId = first.toolResults.join('').match(/d_[0-9a-f]{16}/)?.[0]
    expect(draftId).toBeDefined()

    const second = new ScriptProvider([{ draft_id: draftId, sections: [{ heading: '第二章', chart }], finish: true }])
    await buildAtong(second, () => files).onTask(task('t-doc-2', 'alice'))
    expect(bridge.files).toHaveLength(1)
    expect(bridge.files[0]?.filename).toBe('报告.docx')
    const zip = await JSZip.loadAsync(bridge.files[0]?.bytes as Uint8Array)
    const xml = (await zip.file('word/document.xml')?.async('string')) ?? ''
    expect(xml).toContain('第一章')
    expect(xml).toContain('第二章')
    expect(second.toolResults.join('')).toContain('已转成数据表格')
  }, 60_000)

  it('通道现读:实例建好之后才接上桥,也能发', async () => {
    const bridge = new FileBridge()
    let files: ButlerFactoryRefs['memberFiles']
    const provider = new ScriptProvider([
      { format: 'pptx', title: '第一次', sections: [{ heading: '一' }], finish: true },
      null, // 第一个任务到此收尾
      { format: 'pptx', title: '第二次', sections: [{ heading: '二' }], finish: true },
    ])
    const atong = buildAtong(provider, () => files)
    await atong.onTask(task('t-late-1', 'alice'))
    expect(provider.toolResults.join('')).toContain('连接现在不可用')
    expect(bridge.files).toHaveLength(0)

    files = memberFilesOver(bridge)
    await atong.onTask(task('t-late-2', 'alice'))
    expect(bridge.files.map((f) => f.filename)).toEqual(['第二次.pptx'])
  }, 60_000)

  it('别的成员绑定不影响这个成员:没有路由就如实报告', async () => {
    const bridge = new FileBridge()
    const files = memberFilesOver(bridge)
    const provider = new ScriptProvider([{ format: 'pptx', title: 't', sections: [{ heading: '一' }], finish: true }])
    await buildAtong(provider, () => files).onTask(task('t-bob', 'bob'))
    expect(bridge.files).toHaveLength(0)
    expect(provider.toolResults.join('')).toContain('还没绑定飞书')
  })
})
