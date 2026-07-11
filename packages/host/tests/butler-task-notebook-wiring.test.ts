/**
 * TN-M1 wiring — the task notebook reaches a REAL per-user butler built by the
 * REAL `buildButlerFactory`.
 *
 * Two load-bearing seams, proven end to end with a scripted provider:
 *
 *   1. The 4 notebook tools are OFFERED to the model (turn 1 opens a note via
 *      `open_task_note`, and the file lands in the member's own namespace —
 *      `<memoryRoot>/user/<userId>/tasks.json`, the same `ownerDir` boundary
 *      as STATUS.md / the jsonl).
 *   2. The recitation digest reaches the NEXT turn's system prompt through the
 *      composed CARE-M4 probe — a fresh task's `LlmRequest.system` carries
 *      「【任务笔记本】…下一步…」 while a member with no open tasks gets a
 *      byte-identical prompt (probe → null).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Hub, Logger, ParticipantId, Task } from '@gotong/core'
import type { LlmProvider, LlmRequest, LlmStreamChunk } from '@gotong/llm'

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
  peerRoster: undefined,
  wizard: undefined,
  providerBuilder: undefined,
  memoryView: undefined,
}

/**
 * Scripted provider: on a turn whose latest user text mentions 筹备, it calls
 * `open_task_note`; after a tool result it acknowledges; anything else is a
 * plain reply. Captures every request's `system` + offered tool names so the
 * test can assert the recitation seam.
 */
class NotebookScriptProvider implements LlmProvider {
  readonly name = 'tn-wiring-script'
  readonly systems: string[] = []
  readonly toolNames: string[][] = []

  async *stream(req: LlmRequest): AsyncIterable<LlmStreamChunk> {
    // NA-M3 — 探针/复述卡走 systemVolatile;这里捕获模型眼前的完整拼接。
    this.systems.push((req.system ?? '') + (req.systemVolatile ?? ''))
    this.toolNames.push((req.tools ?? []).map((t) => t.name))
    const last = [...req.messages].reverse().find((m) => m.role === 'user')
    const content = last?.content
    if (Array.isArray(content) && content.some((b) => (b as { type?: string }).type === 'tool_result')) {
      yield { type: 'text', text: '记下了。' }
      yield { type: 'end', stopReason: 'end_turn' }
      return
    }
    const text = typeof content === 'string' ? content : ''
    if (text.includes('筹备')) {
      yield {
        type: 'tool_use',
        toolUse: {
          type: 'tool_use',
          id: 'tn-call-1',
          name: 'open_task_note',
          input: { title: '筹备生日会', steps: ['订蛋糕', '发邀请'] },
        },
      }
      yield { type: 'end', stopReason: 'tool_use' }
      return
    }
    yield { type: 'text', text: '好的。' }
    yield { type: 'end', stopReason: 'end_turn' }
  }
}

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gotong-tn-wiring-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const task = (id: string, userId: string, payload: string): Task => ({
  id: id as Task['id'],
  from: `user:${userId}` as Task['from'],
  strategy: { kind: 'explicit', to: 'chat-agent' as ParticipantId },
  payload,
  origin: { orgId: 'local', userId },
  createdAt: 1,
})

describe('TN-M1 wiring — notebook through the real butler factory', () => {
  it('offers the 4 tools, writes the note into the member namespace, and recites it next turn', async () => {
    const provider = new NotebookScriptProvider()
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
    const butler = factory({
      id: 'chat-agent' as ParticipantId,
      provider,
      capabilities: ['chat'],
      system: '你是这位成员的管家。',
    })

    // Turn 1 — the member asks for a multi-step mission; the model opens a note.
    const r1 = await butler.onTask(task('t1', 'u1', '帮我筹备生日会,拆成几步记下来。'))
    expect((r1 as { kind: string }).kind).toBe('ok')
    // The 4 notebook tools were offered alongside the rest.
    for (const name of ['open_task_note', 'update_task_note', 'close_task_note', 'list_task_notes']) {
      expect(provider.toolNames[0]).toContain(name)
    }
    // The note landed in THIS member's own namespace (ownerDir boundary).
    expect(existsSync(join(root, 'user', 'u1', 'tasks.json'))).toBe(true)
    // Turn 1's system prompt had NO notebook card (nothing was open yet).
    expect(provider.systems[0]).not.toContain('【任务笔记本】')

    // Turn 2 — a FRESH task: the digest must arrive via the composed probe.
    const r2 = await butler.onTask(task('t2', 'u1', '早'))
    expect((r2 as { kind: string }).kind).toBe('ok')
    const sys2 = provider.systems[provider.systems.length - 1]!
    expect(sys2).toContain('【任务笔记本】')
    expect(sys2).toContain('筹备生日会')
    expect(sys2).toContain('下一步: 订蛋糕')

    // Another member shares the router but NOT the notebook (per-user isolation):
    const r3 = await butler.onTask(task('t3', 'u2', '早'))
    expect((r3 as { kind: string }).kind).toBe('ok')
    const sys3 = provider.systems[provider.systems.length - 1]!
    expect(sys3).not.toContain('【任务笔记本】')
  })
})
