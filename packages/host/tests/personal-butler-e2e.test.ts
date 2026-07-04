/**
 * personal-butler-e2e — the §七 acceptance gate for the resident butler.
 *
 * The example demo (`examples/personal-butler`) proves the PARTICIPANT seam
 * (memory across sessions, benign-inline, sensitive-park) with a hand-rolled
 * inline approval. This drives the PRODUCTION wiring main.ts assembles, end to
 * end, and pins the four load-bearing claims of the butler design (§七):
 *
 *   1. CROSS-SESSION MEMORY — session 1 captures episodic turns → consolidate →
 *      a durable semantic profile; a BRAND-NEW session (fresh agent instance,
 *      same per-user memory) reads that profile from its frozen block and recalls.
 *   2. BENIGN FLEXIBLE INVOCATION — "起一个 onboarding 工作流" runs its tool
 *      INLINE, no suspend, no friction.
 *   3. SENSITIVE ACTION GATED — "把 mailer 删了" → classify dangerous → PARK
 *      (→ a /me inbox approval) → approve = real delete / reject = fail-closed.
 *   4. NO-LEAK — another member's butler CANNOT recall the first member's facts
 *      (per-user memory namespace isolation).
 *
 * The production glue under test, exactly as main.ts wires it:
 *   - an ASYNC `suspendNotifier` persists every park to identity AND runs the
 *     `butlerApprovalItemFor` sink → an `approval` InboxItem in the member's queue;
 *   - `HostInboxService.resolve` runs the real two-step recovery (`{...row.state,
 *     answer}`, so the butler re-reads the verdict via `readButlerDecision`);
 *   - per-user memory comes from `openButlerMemory` (the no-leak namespace seam).
 *
 * The LLM is a deterministic keyword-scripted provider (no API key); the butler's
 * loop, gating, capture, and frozen-block injection are the real code.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Hub, InMemoryStorage, type Logger } from '@gotong/core'
import { openIdentityStore, type IdentityStore } from '@gotong/identity'
import { FileInboxStore } from '@gotong/inbox'
import { consolidate } from '@gotong/personal-memory'
import {
  BUTLER_NEVER_RESUME_AT,
  GovernedActionToolset,
  PersonalButlerAgent,
} from '@gotong/personal-butler'
import type {
  LlmAgentToolset,
  LlmMessage,
  LlmProvider,
  LlmRequest,
  LlmStreamChunk,
  LlmToolCallResult,
  LlmToolDefinition,
} from '@gotong/llm'
import type { MemoryHandle } from '@gotong/services-sdk'

import { butlerApprovalItemFor } from '../src/personal-butler-escalation.js'
import { openButlerMemory } from '../src/personal-butler-memory.js'
import { HostInboxService } from '../src/inbox-service.js'

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

const BUTLER_SYSTEM =
  '你是用户的私人管家。你有长期记忆,会主动帮忙;但凡要改动系统、花钱、对外发送或删除东西,先请示主人再做。'

// ── deterministic provider ────────────────────────────────────────────────
// Reads the request the butler builds and scripts its tool calls by keyword.
// In production this is any LlmProvider; the loop and gating are identical.
function lastUserMessage(req: LlmRequest): LlmMessage | undefined {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    if (req.messages[i]!.role === 'user') return req.messages[i]
  }
  return undefined
}

class ButlerE2eProvider implements LlmProvider {
  readonly name = 'butler-e2e'

  async *stream(req: LlmRequest): AsyncIterable<LlmStreamChunk> {
    const last = lastUserMessage(req)
    const content = last?.content

    // ── continuation: a tool already ran this round → close out ──
    if (Array.isArray(content) && content.some((b) => (b as { type?: string }).type === 'tool_result')) {
      const blob = JSON.stringify(content)
      if (blob.includes('"isError":true')) {
        yield { type: 'text', text: '好的,那我就不动它了。' }
      } else if (blob.includes('deleted ')) {
        yield { type: 'text', text: '已经帮你删掉了。' }
      } else if (blob.includes('工作流')) {
        yield { type: 'text', text: '工作流已经帮你起好了。' }
      } else {
        yield { type: 'text', text: '好了。' }
      }
      yield { type: 'end', stopReason: 'end_turn' }
      return
    }

    const text = typeof content === 'string' ? content : ''

    // ── sensitive: delete an agent → governed tool (PARKS for approval) ──
    if (/删|delete/i.test(text)) {
      const handle = (text.match(/[a-zA-Z][\w-]+/) ?? [])[0]
      if (handle) {
        yield { type: 'tool_use', toolUse: { type: 'tool_use', id: 'g1', name: 'delete_agent', input: { handle } } }
        yield { type: 'end', stopReason: 'tool_use' }
        return
      }
    }

    // ── benign: start a workflow → inline tool (no approval) ──
    if (/工作流|workflow|onboarding/i.test(text)) {
      yield {
        type: 'tool_use',
        toolUse: { type: 'tool_use', id: 'b1', name: 'start_workflow', input: { id: 'cafe-staff-onboarding' } },
      }
      yield { type: 'end', stopReason: 'tool_use' }
      return
    }

    // ── recall: answer from the frozen memory block in the system prompt ──
    if (/项目|之前|记得|叫啥/.test(text)) {
      const sys = req.system ?? ''
      yield {
        type: 'text',
        text: sys.includes('奶茶店') ? '你之前在忙的是那个奶茶店项目。' : '抱歉,我这边没有相关记忆。',
      }
      yield { type: 'end', stopReason: 'end_turn' }
      return
    }

    // ── otherwise: acknowledge; `captureTurns` records this turn to episodic ──
    yield { type: 'text', text: '好的,我记下了。' }
    yield { type: 'end', stopReason: 'end_turn' }
  }
}

// A benign tool — runs inline, no approval.
function benignToolset(): LlmAgentToolset {
  return {
    listTools(): LlmToolDefinition[] {
      return [
        {
          name: 'start_workflow',
          description: '发起一个工作流',
          inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
        },
      ]
    },
    async callTool(): Promise<LlmToolCallResult> {
      return { content: [{ type: 'text', text: '已起工作流 cafe-staff-onboarding' }] }
    },
  }
}

// The sensitive actions. `delete_agent` is classified dangerous → it parks for a
// human; the executor mutates the (shared) agent registry only after approval.
function governedToolset(registry: Set<string>): GovernedActionToolset {
  return new GovernedActionToolset({
    tools: [
      {
        name: 'delete_agent',
        description: '永久删除一个托管 agent',
        inputSchema: { type: 'object', properties: { handle: { type: 'string' } }, required: ['handle'] },
      },
    ],
    classify: async (name) =>
      name === 'delete_agent'
        ? { decision: 'approve', reason: '危险动作——会永久删除一个 agent' }
        : { decision: 'allow' },
    execute: async (_name, args) => {
      const handle = String(args.handle)
      if (!registry.has(handle)) return { text: `没有名为 ${handle} 的 agent`, isError: true }
      registry.delete(handle)
      return { text: `deleted ${handle}` }
    },
  })
}

describe('personal-butler-e2e — §七 acceptance gate (4 claims)', () => {
  let tmp: string
  let memRoot: string
  let identity: IdentityStore
  let hub: Hub
  let inboxStore: FileInboxStore
  let hostInbox: HostInboxService
  let provider: ButlerE2eProvider
  let registry: Set<string>

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'host-butler-e2e-'))
    memRoot = join(tmp, 'mem')
    identity = openIdentityStore({ dbPath: join(tmp, 'identity.sqlite') })
    inboxStore = new FileInboxStore(tmp)
    inboxStore.ensureDirs()
    provider = new ButlerE2eProvider()
    registry = new Set(['mailer', 'billing', 'notifier'])

    hub = new Hub({
      storage: new InMemoryStorage(),
      // Mirror main.ts: persist the park, THEN turn a butler governed park into a
      // /me approval item. For a PERSONAL butler the approver is the member
      // themselves (you clear your own butler's dangerous moves). Awaited, so the
      // item exists before dispatch returns suspended.
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
    hostInbox = new HostInboxService({ hub, store: inboxStore, identity })
  })

  afterEach(async () => {
    await hub.stop().catch(() => {})
    identity.close()
    rmSync(tmp, { recursive: true, force: true })
  })

  function memFor(userId: string): MemoryHandle {
    return openButlerMemory({ rootDir: memRoot, userId, logger: silentLogger })
  }

  function butlerFor(id: string, memory: MemoryHandle): PersonalButlerAgent {
    return new PersonalButlerAgent({
      id,
      provider,
      memory,
      system: BUTLER_SYSTEM,
      benign: benignToolset(),
      governed: governedToolset(registry),
      maxToolRounds: 6,
    })
  }

  async function dispatchTo(butlerId: string, userId: string, prompt: string) {
    return hub.dispatch({
      from: `user:${userId}`,
      strategy: { kind: 'explicit', to: butlerId },
      payload: prompt,
      origin: { orgId: 'local', userId },
    })
  }

  it('claim 1 — remembers across sessions (capture → consolidate → fresh-session recall)', async () => {
    const aliceMem = memFor('alice')

    // Session 1: two turns the butler captures to episodic (M2).
    const s1 = butlerFor('butler:alice:s1', aliceMem)
    hub.register(s1)
    const r1 = await dispatchTo('butler:alice:s1', 'alice', '记住:我叫阿明。')
    expect(r1.kind).toBe('ok')
    const r2 = await dispatchTo('butler:alice:s1', 'alice', '另外,我最近在忙一个奶茶店的创业。')
    expect(r2.kind).toBe('ok')
    hub.unregister('butler:alice:s1')

    const episodic = await aliceMem.recall({ kinds: ['episodic'], k: 50 })
    expect(episodic.length).toBeGreaterThanOrEqual(2)

    // Consolidate (M3): the heartbeat reviewer's job — distill episodic into a
    // durable semantic profile. Summarizer is the LLM call; deterministic here.
    const result = await consolidate({
      memory: aliceMem,
      force: true,
      keepRecent: 1,
      now: () => 2_000_000,
      summarize: async () => '主人名叫阿明;正在做一个奶茶店创业项目。',
    })
    expect(result).not.toBeNull()
    const semantic = await aliceMem.recall({ kinds: ['semantic'], k: 50 })
    expect(semantic.some((p) => p.text.includes('奶茶店'))).toBe(true)

    // Session 2: a BRAND-NEW butler instance, same per-user memory. Its frozen
    // block carries the profile; the recall comes back from a fresh session.
    const s2 = butlerFor('butler:alice:s2', aliceMem)
    hub.register(s2)
    const res = await dispatchTo('butler:alice:s2', 'alice', '我之前那个项目叫啥来着?')
    expect(res.kind).toBe('ok')
    if (res.kind !== 'ok') throw new Error('unreachable')
    expect((res.output as { text: string }).text).toContain('奶茶店')
  })

  it('claim 2 — a benign flexible invocation runs inline (no suspend)', async () => {
    const m = memFor('alice')
    const b = butlerFor('butler:alice', m)
    hub.register(b)

    const res = await dispatchTo('butler:alice', 'alice', '帮我起一个 onboarding 工作流。')
    expect(res.kind).toBe('ok') // NOT suspended — benign tools need no approval
    if (res.kind !== 'ok') throw new Error('unreachable')
    expect((res.output as { text: string }).text).toContain('工作流')
  })

  it('claim 3 — a sensitive action parks for /me approval; approve deletes, reject is fail-closed', async () => {
    const m = memFor('alice')
    const b = butlerFor('butler:alice', m)
    hub.register(b)

    // ── approve path ──
    const parked = await dispatchTo('butler:alice', 'alice', '帮我把 mailer 这个 agent 删了。')
    expect(parked.kind).toBe('suspended')
    if (parked.kind !== 'suspended') throw new Error('expected a park')
    const taskId = parked.taskId

    // Nothing happened yet — the gate held before any side effect.
    expect(registry.has('mailer')).toBe(true)

    // The member has a pending /me approval for exactly this parked task.
    const pending = await inboxStore.listPending('alice')
    expect(pending).toHaveLength(1)
    expect(pending[0]!.itemId).toBe(taskId)
    expect(pending[0]!.kind).toBe('approval')
    // The prompt names WHAT action and ON WHAT — the real GovernedActionToolset
    // titles a park as `<tool>(<json args>)`, so both the tool and target show.
    expect(pending[0]!.prompt).toContain('delete_agent')
    expect(pending[0]!.prompt).toContain('mailer')

    // Parked at never-resume → the sweep can never wake it; only a resolve can.
    const row = identity.getSuspendedTask(taskId)
    expect(row?.resumeAt).toBe(BUTLER_NEVER_RESUME_AT)
    expect(identity.listDueSuspendedTasks({ now: Date.now() }).some((d) => d.taskId === taskId)).toBe(false)

    // Approve → the held turn runs the executor → mailer is really gone.
    await hostInbox.resolve({ itemId: taskId, userId: 'alice', decision: { kind: 'approval', approved: true } })
    expect(registry.has('mailer')).toBe(false)
    expect(hub.taskResult(taskId)?.kind).toBe('ok')
    expect((await inboxStore.get(taskId))?.status).toBe('resolved')
    expect(identity.getSuspendedTask(taskId)).toBeNull()

    // ── reject path → fail-closed ──
    const parked2 = await dispatchTo('butler:alice', 'alice', '顺便把 billing 也删了。')
    expect(parked2.kind).toBe('suspended')
    if (parked2.kind !== 'suspended') throw new Error('expected a park')
    await hostInbox.resolve({
      itemId: parked2.taskId,
      userId: 'alice',
      decision: { kind: 'approval', approved: false },
    })
    expect(registry.has('billing')).toBe(true) // declined → NOTHING deleted
    expect(hub.taskResult(parked2.taskId)?.kind).toBe('ok')
  })

  it("claim 4 — another member's butler cannot recall the first member's memory (no-leak)", async () => {
    // Seed alice's consolidated profile directly (the state claim 1 builds up).
    const aliceMem = memFor('alice')
    await aliceMem.remember({ kind: 'semantic', text: '主人名叫阿明;正在做一个奶茶店创业项目。' })

    // Bob's butler — a DIFFERENT per-user namespace, an empty tree.
    const bobMem = memFor('bob')
    const bob = butlerFor('butler:bob', bobMem)
    hub.register(bob)
    const resBob = await dispatchTo('butler:bob', 'bob', '我之前那个项目叫啥来着?')
    expect(resBob.kind).toBe('ok')
    if (resBob.kind !== 'ok') throw new Error('unreachable')
    expect((resBob.output as { text: string }).text).not.toContain('奶茶店')

    // Sanity: alice's OWN butler can recall it — proving bob's miss is isolation,
    // not a broken provider.
    const alice = butlerFor('butler:alice', aliceMem)
    hub.register(alice)
    const resAlice = await dispatchTo('butler:alice', 'alice', '我之前那个项目叫啥来着?')
    expect(resAlice.kind).toBe('ok')
    if (resAlice.kind !== 'ok') throw new Error('unreachable')
    expect((resAlice.output as { text: string }).text).toContain('奶茶店')
  })
})
