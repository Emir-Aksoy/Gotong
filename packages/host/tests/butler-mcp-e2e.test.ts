/**
 * butler-mcp-e2e — S1-M2. The resident butler's notes/calendar MCP toolset,
 * partitioned READ-benign / WRITE-governed, end to end through the PRODUCTION
 * splitter (`buildButlerMcpToolsets`) — exactly the object main.ts assembles in
 * the butler factory from the pool's `ButlerMcpHandoff`.
 *
 * What no earlier gate covers: before S1-M2 the row's WHOLE MCP toolset was
 * benign — the butler could silently create a calendar event or overwrite a
 * note. This proves the new split:
 *   1. the partition itself (server `annotations` win → read-verb name
 *      heuristic → ambiguous tools FAIL SAFE to governed);
 *   2. a READ (search notes) runs inline — no park, no inbox item;
 *   3. a WRITE (create note) PARKS at never-resume, blind to the sweep, with a
 *      `/me` approval item, and the underlying MCP call has NOT happened yet;
 *      approval runs the very same call exactly once;
 *   4. rejection is fail-closed — the MCP call never runs.
 *
 * The MCP side is a fake `callTool` + a resolved tool list (deterministic, no
 * child process) — the same seam the factory uses (`(n, a) =>
 * mcp.toolset.callTool(n, a)`); the butler's loop, gating, park, and two-step
 * resume are the real code. The LLM is a keyword-scripted provider (no key).
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Hub, Space, type Logger } from '@aipehub/core'
import {
  MASTER_KEY_LEN_BYTES,
  openIdentityStore,
  type IdentityStore,
} from '@aipehub/identity'
import { FileInboxStore } from '@aipehub/inbox'
import { BUTLER_NEVER_RESUME_AT, PersonalButlerAgent } from '@aipehub/personal-butler'
import type {
  LlmMessage,
  LlmProvider,
  LlmRequest,
  LlmStreamChunk,
  LlmToolCallResult,
} from '@aipehub/llm'

import {
  buildButlerMcpToolsets,
  defaultMcpToolClass,
  type ButlerMcpTool,
} from '../src/personal-butler-mcp.js'
import { butlerApprovalItemFor } from '../src/personal-butler-escalation.js'
import { openButlerMemory } from '../src/personal-butler-memory.js'
import { HostInboxService } from '../src/inbox-service.js'

const USER = 'u1'

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

// --- the fake resolved MCP toolset -------------------------------------------
// One notes server + one calendar server, covering every classification branch:
//   annotations.readOnlyHint:true            → read   (server declaration)
//   name matches a read verb, no annotations → read   (heuristic)
//   annotations.readOnlyHint:false           → write  (server declaration)
//   annotations.destructiveHint:true         → write  (server declaration)
//   no annotations, non-read verb            → write  (fail-safe default)

const MCP_TOOLS: ButlerMcpTool[] = [
  {
    name: 'notes__search_notes',
    description: 'Search notes by keyword.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'notes__list_recent',
    description: 'List recently edited notes.',
    inputSchema: { type: 'object' },
  },
  {
    name: 'notes__create_note',
    description: 'Create a new note.',
    inputSchema: { type: 'object', properties: { title: { type: 'string' }, content: { type: 'string' } } },
    annotations: { readOnlyHint: false },
  },
  {
    name: 'calendar__delete_event',
    description: 'Delete a calendar event.',
    inputSchema: { type: 'object', properties: { eventId: { type: 'string' } } },
    annotations: { destructiveHint: true },
  },
  {
    name: 'notes__sync_vault',
    description: 'Force-sync the vault.',
    inputSchema: { type: 'object' },
  },
]

const CREATE_INPUT = { title: '奶茶店笔记', content: '环境不错,珍珠偏甜' }

class FakeMcp {
  calls: Array<{ name: string; args: Record<string, unknown> }> = []

  async callTool(name: string, args: Record<string, unknown>): Promise<LlmToolCallResult> {
    this.calls.push({ name, args })
    if (name === 'notes__search_notes') {
      return { content: [{ type: 'text', text: '找到 1 条:《奶茶店笔记》— 珍珠偏甜' }] }
    }
    if (name === 'notes__create_note') {
      return { content: [{ type: 'text', text: '已创建 note-1' }] }
    }
    return { content: [{ type: 'text', text: 'ok' }] }
  }

  named(name: string): Array<{ name: string; args: Record<string, unknown> }> {
    return this.calls.filter((c) => c.name === name)
  }
}

// --- deterministic provider ---------------------------------------------------

function lastUserMessage(req: LlmRequest): LlmMessage | undefined {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    if (req.messages[i]!.role === 'user') return req.messages[i]
  }
  return undefined
}

class ButlerMcpProvider implements LlmProvider {
  readonly name = 'butler-mcp-e2e'

  async *stream(req: LlmRequest): AsyncIterable<LlmStreamChunk> {
    const last = lastUserMessage(req)
    const content = last?.content

    // ── continuation: a tool already ran this round → close out on its result ──
    if (Array.isArray(content) && content.some((b) => (b as { type?: string }).type === 'tool_result')) {
      const blob = JSON.stringify(content)
      if (blob.includes('"isError":true')) {
        yield { type: 'text', text: '好的,那我就不写了。' }
      } else if (blob.includes('已创建')) {
        yield { type: 'text', text: '已经帮你记到笔记里了。' }
      } else if (blob.includes('找到')) {
        yield { type: 'text', text: '搜到了:《奶茶店笔记》,珍珠偏甜。' }
      } else {
        yield { type: 'text', text: '好了。' }
      }
      yield { type: 'end', stopReason: 'end_turn' }
      return
    }

    const text = typeof content === 'string' ? content : ''

    // ── read: search the member's notes → benign proxy, runs inline ──
    if (/搜|search/i.test(text)) {
      yield {
        type: 'tool_use',
        toolUse: { type: 'tool_use', id: 'm-read', name: 'notes__search_notes', input: { query: '奶茶' } },
      }
      yield { type: 'end', stopReason: 'tool_use' }
      return
    }

    // ── write: create a note → governed MCP gate → PARKS ──
    if (/记到笔记|create/i.test(text)) {
      yield {
        type: 'tool_use',
        toolUse: { type: 'tool_use', id: 'm-write', name: 'notes__create_note', input: CREATE_INPUT },
      }
      yield { type: 'end', stopReason: 'tool_use' }
      return
    }

    yield { type: 'text', text: '好的。' }
    yield { type: 'end', stopReason: 'end_turn' }
  }
}

// --- rig ------------------------------------------------------------------------

interface Rig {
  tmp: string
  hub: Hub
  identity: IdentityStore
  inboxStore: FileInboxStore
  inboxService: HostInboxService
  mcp: FakeMcp
}

async function boot(): Promise<Rig> {
  const tmp = await mkdtemp(join(tmpdir(), 'aipe-butler-mcp-e2e-'))
  const { space } = await Space.init(tmp, { name: 'butler-mcp-e2e' })
  const identity = openIdentityStore({
    dbPath: join(tmp, 'identity.sqlite'),
    masterKey: randomBytes(MASTER_KEY_LEN_BYTES),
  })
  const inboxStore = new FileInboxStore(tmp)
  inboxStore.ensureDirs()

  // Mirror main.ts exactly: persist the park, THEN turn a butler GOVERNED park
  // into a /me approval item. For a personal butler the approver is the member.
  const hub = new Hub({
    space,
    suspendNotifier: async (task, by, s) => {
      identity.persistSuspendedTask({
        taskId: task.id,
        agentId: by,
        hubId: 'local',
        originUserId: task.origin?.userId ?? null,
        resumeAt: s.resumeAt,
        state: s.state,
        taskJson: JSON.stringify(task),
      })
      const approver = task.origin?.userId
      if (approver) {
        const item = butlerApprovalItemFor(task, by, s.state, { approver })
        if (item) await inboxStore.write(item)
      }
    },
  })
  await hub.start()

  return {
    tmp,
    hub,
    identity,
    inboxStore,
    inboxService: new HostInboxService({ hub, store: inboxStore, identity }),
    mcp: new FakeMcp(),
  }
}

describe('butler-mcp-e2e — S1-M2 (READ inline / WRITE parks for a /me approval)', () => {
  let r: Rig
  beforeEach(async () => {
    r = await boot()
  })
  afterEach(async () => {
    await r.hub.stop().catch(() => {})
    r.identity.close()
    await rm(r.tmp, { recursive: true, force: true })
  })

  /** A resident butler wired the way main.ts wires it: the MCP split's READ half
   *  in `benign`, its WRITE half as one gate in the `governed` array. */
  function butlerFor(id: string, userId: string): PersonalButlerAgent {
    const split = buildButlerMcpToolsets({
      tools: MCP_TOOLS,
      callTool: (name, args) => r.mcp.callTool(name, args),
    })
    if (!split.writeGoverned) throw new Error('expected a write half')
    return new PersonalButlerAgent({
      id,
      provider: new ButlerMcpProvider(),
      memory: openButlerMemory({ rootDir: join(r.tmp, 'mem'), userId, logger: silentLogger }),
      system: '你是用户的私人管家。',
      benign: [split.readBenign],
      governed: [split.writeGoverned],
      maxToolRounds: 6,
    })
  }

  async function dispatchTo(butlerId: string, prompt: string) {
    return r.hub.dispatch({
      from: `user:${USER}`,
      strategy: { kind: 'explicit', to: butlerId },
      payload: prompt,
      origin: { orgId: 'local', userId: USER },
    })
  }

  // ① The partition itself: annotations win, then the read-verb heuristic, and
  //    anything still ambiguous fails SAFE to the governed side.
  it('① partitions reads/writes: annotations → heuristic → fail-safe write', async () => {
    expect(MCP_TOOLS.map(defaultMcpToolClass)).toEqual(['read', 'read', 'write', 'write', 'write'])

    const split = buildButlerMcpToolsets({
      tools: MCP_TOOLS,
      callTool: (name, args) => r.mcp.callTool(name, args),
    })
    const readNames = (await split.readBenign.listTools()).map((t) => t.name).sort()
    expect(readNames).toEqual(['notes__list_recent', 'notes__search_notes'])
    for (const name of ['notes__create_note', 'calendar__delete_event', 'notes__sync_vault']) {
      expect(split.writeGoverned!.governs(name)).toBe(true)
    }
    // The two halves are disjoint — a read is never governed.
    expect(split.writeGoverned!.governs('notes__search_notes')).toBe(false)
  })

  // A read-only server yields NO write half at all — the butler carries no MCP gate.
  it('① a read-only toolset has no governed half', () => {
    const split = buildButlerMcpToolsets({
      tools: MCP_TOOLS.filter((t) => defaultMcpToolClass(t) === 'read'),
      callTool: (name, args) => r.mcp.callTool(name, args),
    })
    expect(split.writeGoverned).toBeUndefined()
  })

  // ② READ runs inline: no park, no inbox item, and the underlying MCP call ran.
  it('② searching notes runs inline through the benign proxy', async () => {
    r.hub.register(butlerFor('butler:u1', USER))

    const fired = await dispatchTo('butler:u1', '帮我搜一下笔记里关于奶茶的记录。')
    expect(fired.kind).toBe('ok')
    if (fired.kind !== 'ok') throw new Error('expected ok')
    expect((fired.output as { text: string }).text).toContain('奶茶店笔记')

    expect(r.mcp.named('notes__search_notes')).toHaveLength(1)
    expect(r.mcp.named('notes__search_notes')[0]!.args).toEqual({ query: '奶茶' })
    expect(await r.inboxStore.listPending(USER)).toHaveLength(0)
  })

  // ③ WRITE parks at NEVER with a /me item; the MCP call has NOT happened yet;
  //    approval runs the very same call exactly once.
  it('③ creating a note parks, then approval runs the same MCP call once', async () => {
    r.hub.register(butlerFor('butler:u1', USER))

    const parked = await dispatchTo('butler:u1', '把这个记到笔记里:环境不错,珍珠偏甜。')
    expect(parked.kind).toBe('suspended')
    if (parked.kind !== 'suspended') throw new Error('expected a park')

    // The gate held BEFORE the side effect — nothing written yet.
    expect(r.mcp.named('notes__create_note')).toHaveLength(0)

    // A /me approval item, titled by the MCP gate's describe (server · tool).
    const pending = await r.inboxStore.listPending(USER)
    expect(pending).toHaveLength(1)
    expect(pending[0]!.itemId).toBe(parked.taskId)
    expect(pending[0]!.kind).toBe('approval')
    expect(pending[0]!.prompt).toContain('notes · create_note')
    expect(pending[0]!.prompt).toContain('在你的笔记/日历上执行')

    // Parked at never-resume → the timer sweep can never wake it.
    expect(r.identity.getSuspendedTask(parked.taskId)?.resumeAt).toBe(BUTLER_NEVER_RESUME_AT)
    expect(
      r.identity.listDueSuspendedTasks({ now: Date.now() }).some((d) => d.taskId === parked.taskId),
    ).toBe(false)

    // Approve → the held turn runs the REAL call, with the ORIGINAL args.
    await r.inboxService.resolve({
      itemId: parked.taskId,
      userId: USER,
      decision: { kind: 'approval', approved: true },
    })
    expect(r.mcp.named('notes__create_note')).toHaveLength(1)
    expect(r.mcp.named('notes__create_note')[0]!.args).toEqual(CREATE_INPUT)
    expect(r.hub.taskResult(parked.taskId)?.kind).toBe('ok')
    expect(await r.inboxStore.listPending(USER)).toHaveLength(0)
  })

  // ④ Rejection is fail-closed — the MCP call never runs.
  it('④ rejecting the parked write never touches the MCP server', async () => {
    r.hub.register(butlerFor('butler:u1', USER))

    const parked = await dispatchTo('butler:u1', '把这个记到笔记里。')
    if (parked.kind !== 'suspended') throw new Error('expected a park')

    await r.inboxService.resolve({
      itemId: parked.taskId,
      userId: USER,
      decision: { kind: 'approval', approved: false },
    })

    expect(r.mcp.named('notes__create_note')).toHaveLength(0)
    const done = r.hub.taskResult(parked.taskId)
    expect(done?.kind).toBe('ok')
    if (done?.kind === 'ok') expect((done.output as { text: string }).text).toContain('不写')
  })
})
