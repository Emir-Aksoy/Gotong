/**
 * HANDS-M5 wiring —— 只读投影真的接在 hub 的落盘路径上,而不是只在纯核里自洽。
 *
 * 这份门存在的理由是 M3b 那条教训:**一条缝,如果它的测试全都自己手搭对面那一半,
 * 那它就是没测过**。所以下面每一条都从**真实装配**走进去:
 *
 *   1. 真 `buildButlerFactory` 建的管家写了一次笔记本 ⇒ vault 根出现 tasks.md。
 *   2. 真 `runButlerMaintenanceOnce` 跑完一轮 ⇒ memory/<cluster>.md 出现,
 *      且它重投的 tasks.md 与第 1 条那次**逐字节相同**(两条生成路径不能各投各的)。
 *   3. 真 `HostButlerMemoryService.forgetAll` ⇒ 记忆投影跟着没,tasks.md 留着。
 *   4. 知识库的链表真的被工厂接上了(不接的话 `[[…]]` 永远出不来,而单测看不出来)。
 */

import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Hub, Logger, ParticipantId, Task } from '@gotong/core'
import type { LlmProvider, LlmRequest, LlmStreamChunk } from '@gotong/llm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { HostButlerMemoryService } from '../src/butler-memory-service.js'
import { openButlerMemory } from '../src/personal-butler-memory.js'
import { buildButlerFactory, type ButlerFactoryRefs } from '../src/personal-butler-factory.js'
import {
  ButlerMaintenanceSweeper,
  runButlerMaintenanceOnce,
} from '../src/personal-butler-maintenance.js'

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

const EMPTY_REFS: ButlerFactoryRefs = {
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
  peerRoster: undefined,
  wizard: undefined,
  providerBuilder: undefined,
  memoryView: undefined,
}

/** 第一轮开一条任务笔记,之后随便回一句。 */
class NotebookProvider implements LlmProvider {
  readonly name = 'obsidian-wiring'
  private opened = false

  async *stream(req: LlmRequest): AsyncIterable<LlmStreamChunk> {
    const last = [...req.messages].reverse().find((m) => m.role === 'user')
    const content = last?.content
    const isToolResult =
      Array.isArray(content) && content.some((b) => (b as { type?: string }).type === 'tool_result')
    if (!this.opened && !isToolResult) {
      this.opened = true
      yield {
        type: 'tool_use',
        toolUse: {
          type: 'tool_use',
          id: 'call-1',
          name: 'open_task_note',
          input: {
            title: '筹备生日会',
            steps: ['订蛋糕', '发邀请'],
            note: '场地要能停车,详见 生活/聚会场地.md',
          },
        },
      }
      yield { type: 'end', stopReason: 'tool_use' }
      return
    }
    yield { type: 'text', text: '好的。' }
    yield { type: 'end', stopReason: 'end_turn' }
  }
}

let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gotong-obsidian-wiring-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const dispatchTask = (id: string, userId: string, payload: string): Task => ({
  id: id as Task['id'],
  from: `user:${userId}` as Task['from'],
  strategy: { kind: 'explicit', to: 'chat-agent' as ParticipantId },
  payload,
  origin: { orgId: 'local', userId },
  createdAt: 1,
})

function butlerFor(provider: LlmProvider) {
  const factory = buildButlerFactory({
    hub: { dispatch: async () => ({ kind: 'ok' }) } as unknown as Hub,
    logger: silentLogger,
    memoryRoot: root,
    governedOn: false,
    maintenanceOn: false,
    proactiveOn: false,
    runBroadcastOn: false,
    refs: () => EMPTY_REFS,
  })
  return factory({
    id: 'chat-agent' as ParticipantId,
    provider,
    capabilities: ['chat'],
    system: '你是这位成员的管家。',
  })
}

describe('HANDS-M5 wiring — 投影接在真实落盘路径上', () => {
  it('管家写完笔记本,vault 根就出现 tasks.md,而 tasks.json 仍是真相', async () => {
    const butler = butlerFor(new NotebookProvider())
    await butler.onTask(dispatchTask('t1', 'u1', '帮我筹备生日会。'))

    const md = readFileSync(join(root, 'user', 'u1', 'tasks.md'), 'utf8')
    expect(md.startsWith('---\n')).toBe(true)
    expect(md).toContain('筹备生日会')
    expect(md).toContain('订蛋糕')
    // 真相原封不动:投影是从它派生的,不是替代它。
    const truth = JSON.parse(readFileSync(join(root, 'user', 'u1', 'tasks.json'), 'utf8'))
    expect(truth.tasks[0].title).toBe('筹备生日会')
  })

  it('工厂真的把知识库链表接上了(架上有那篇才连)', async () => {
    const kdir = join(root, 'user', 'u1', 'knowledge', '生活')
    mkdirSync(kdir, { recursive: true })
    writeFileSync(join(kdir, '聚会场地.md'), '# 场地\n', 'utf8')

    const butler = butlerFor(new NotebookProvider())
    await butler.onTask(dispatchTask('t1', 'u1', '帮我筹备生日会。'))

    const md = readFileSync(join(root, 'user', 'u1', 'tasks.md'), 'utf8')
    expect(md).toContain('[[knowledge/生活/聚会场地]]')
  })

  it('6h 维护兜底投出记忆,并且它重投的 tasks.md 与写路径那次逐字节相同', async () => {
    const butler = butlerFor(new NotebookProvider())
    await butler.onTask(dispatchTask('t1', 'u1', '帮我筹备生日会。'))
    const fromWritePath = readFileSync(join(root, 'user', 'u1', 'tasks.md'), 'utf8')

    // 盘上先有一条真事实(维护那条路要从真磁盘读它)
    const mem = openButlerMemory({ rootDir: root, userId: 'u1', logger: silentLogger })
    await mem.remember({ kind: 'semantic', text: '用户最爱的饮料是珍珠奶茶', meta: { tier: 'persona' } })

    await runButlerMaintenanceOnce({
      rootDir: root,
      userId: 'u1',
      summarize: async () => '', // 维护本身不产出新东西:这一条量的是投影兜底
      logger: silentLogger,
    })

    const memMd = readFileSync(join(root, 'user', 'u1', 'memory', 'persona.md'), 'utf8')
    expect(memMd).toContain('珍珠奶茶')
    expect(memMd).toContain('generated: true')
    // 同一份真相,两条路,同样的字节 —— 否则投影每 6h 自己抖一次。
    expect(readFileSync(join(root, 'user', 'u1', 'tasks.md'), 'utf8')).toBe(fromWritePath)
  })

  it('forget-all 把记忆投影一起清掉,但不碰 tasks.md', async () => {
    const butler = butlerFor(new NotebookProvider())
    await butler.onTask(dispatchTask('t1', 'u1', '帮我筹备生日会。'))
    const mem = openButlerMemory({ rootDir: root, userId: 'u1', logger: silentLogger })
    await mem.remember({ kind: 'semantic', text: '用户住在槟城', meta: { tier: 'persona' } })
    await runButlerMaintenanceOnce({
      rootDir: root,
      userId: 'u1',
      summarize: async () => '',
      logger: silentLogger,
    })
    expect(existsSync(join(root, 'user', 'u1', 'memory', 'persona.md'))).toBe(true)

    const service = new HostButlerMemoryService({ rootDir: root, logger: silentLogger })
    await service.forgetAll('u1')

    // 被要求忘掉的事实不该还在 vault 里摆着,而且看起来像现状。
    expect(existsSync(join(root, 'user', 'u1', 'memory', 'persona.md'))).toBe(false)
    expect(existsSync(join(root, 'user', 'u1', 'tasks.md'))).toBe(true)
  })

  // ── Codex 轮 C 补课 ───────────────────────────────────────────────────────

  it('忘掉**一条**也会重投 —— 否则那条事实还在 vault 里摆最多 6 小时', async () => {
    const mem = openButlerMemory({ rootDir: root, userId: 'u1', logger: silentLogger })
    await mem.remember({ kind: 'semantic', text: '用户住在槟城', meta: { tier: 'persona' } })
    await mem.remember({ kind: 'semantic', text: '用户最爱的饮料是珍珠奶茶', meta: { tier: 'persona' } })
    await runButlerMaintenanceOnce({
      rootDir: root,
      userId: 'u1',
      summarize: async () => '',
      logger: silentLogger,
    })
    const before = readFileSync(join(root, 'user', 'u1', 'memory', 'persona.md'), 'utf8')
    expect(before).toContain('槟城')

    const service = new HostButlerMemoryService({ rootDir: root, logger: silentLogger })
    const target = (await mem.list({ limit: 50 })).find((e) => e.text.includes('槟城'))!
    expect(await service.forget('u1', target.id)).toBe(true)

    const after = readFileSync(join(root, 'user', 'u1', 'memory', 'persona.md'), 'utf8')
    expect(after).not.toContain('槟城')
    expect(after).toContain('珍珠奶茶') // 只少了被忘掉的那一条
  })

  it('没有 provider 的那一趟照样投影 —— 渲染 md 不需要模型', async () => {
    // 蒸馏要 provider,把盘上已有的真相渲染成 md 不要。没有 key 的 hub 一份
    // tasks.md 也拿不到,而那两份真相本来就在盘上。
    const butler = butlerFor(new NotebookProvider())
    await butler.onTask(dispatchTask('t1', 'u1', '帮我筹备生日会。'))
    rmSync(join(root, 'user', 'u1', 'tasks.md'))

    const mem = openButlerMemory({ rootDir: root, userId: 'u1', logger: silentLogger })
    await mem.remember({ kind: 'semantic', text: '用户住在槟城', meta: { tier: 'persona' } })

    let asked = 0
    const sweeper = new ButlerMaintenanceSweeper({
      rootDir: root,
      logger: silentLogger,
      buildProvider: async () => {
        asked += 1
        return null // 没建管家行 / 解析不出 key
      },
    })
    await sweeper.runOnce()

    expect(asked).toBe(1)
    expect(existsSync(join(root, 'user', 'u1', 'tasks.md'))).toBe(true)
    expect(readFileSync(join(root, 'user', 'u1', 'memory', 'persona.md'), 'utf8')).toContain('槟城')
  })

  it('STATUS.md 里写清了这些 .md 是投影、手改会被覆盖', async () => {
    await runButlerMaintenanceOnce({
      rootDir: root,
      userId: 'u1',
      summarize: async () => '',
      logger: silentLogger,
    })
    const status = readFileSync(join(root, 'user', 'u1', 'STATUS.md'), 'utf8')
    expect(status).toContain('tasks.md')
    expect(status).toContain('只读投影')
    expect(status).toContain('会被覆盖')
    expect(status).toContain('knowledge/')
  })
})
