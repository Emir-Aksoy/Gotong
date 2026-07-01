/**
 * S1-M3 承重门 — the resident butler's approval PUSH-BACK.
 *
 * BF-M7 gave the butler governed actions (create/delete an agent, edit a
 * workflow) that PARK for a `/me` inbox approval. But over IM that left a member
 * hanging: they said "delete my helper", the bot said "I put it in your inbox",
 * and then — silence. They tapped approve in `/me` and never heard back through
 * the chat they were in. F1 built the outbound-push primitive; S1-M3 closes the
 * loop: once the member resolves a butler item, the butler's OWN closing message
 * is pushed back to their IM.
 *
 * This gate proves the wired behaviour end to end, plus the pure discriminator:
 *
 *   pure — `butlerResolvePushback(item, childResult)` is the single place that
 *     decides IF and WHAT to push: only `source:'butler'` items opt in; the
 *     resumed turn's ok text is forwarded (approve AND reject); a failure gets an
 *     apology; a re-park / unparked child stays silent.
 *
 *   e2e — a REAL butler governed park (`delete_agent`) → `HostInboxService.resolve`
 *     with the production `onResolved` hook wired to `butlerResolvePushback` + a
 *     fake push:
 *       ① approve → the deleted-agent outcome the butler phrases is pushed back;
 *       ② reject  → the "I left it alone" line the butler phrases is pushed back;
 *       ③ a workflow human step (source UNSET, via the real HumanInboxParticipant)
 *          resolves fine but pushes NOTHING — the push-back is butler-only.
 *
 * The hook, resolve mechanics, two-step resume, and butler tool-loop are all the
 * real code; only the LLM (keyword-scripted) and the agent spawn are faked, as in
 * every host butler gate.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  Hub,
  Space,
  type AgentRecord,
  type Logger,
  type ManagedAgentLifecycle,
  type ParticipantId,
  type TaskResult,
} from '@aipehub/core'
import {
  MASTER_KEY_LEN_BYTES,
  openIdentityStore,
  type IdentityStore,
} from '@aipehub/identity'
import { FileInboxStore, HUMAN_CAPABILITY, HumanInboxParticipant, type InboxItem } from '@aipehub/inbox'
import { PersonalButlerAgent } from '@aipehub/personal-butler'
import type { LlmMessage, LlmProvider, LlmRequest, LlmStreamChunk } from '@aipehub/llm'
import type { MemoryHandle } from '@aipehub/services-sdk'

import { buildButlerGovernedToolset } from '../src/personal-butler-governed.js'
import { butlerApprovalItemFor, butlerResolvePushback } from '../src/personal-butler-escalation.js'
import { openButlerMemory } from '../src/personal-butler-memory.js'
import { HostInboxService } from '../src/inbox-service.js'
import { HostMeAgentService } from '../src/me-agent-service.js'

const USER = 'u1'
const HELPER_ID = `me.${USER}.helper`

const silentLogger: Logger = {
  trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
  child() { return silentLogger },
}

const BUTLER_SYSTEM =
  '你是用户的私人管家。你有长期记忆,会主动帮忙;但凡要改动系统、花钱、对外发送或删除东西,先请示主人再做。'

// --- deterministic provider (same contract as personal-butler-governed-e2e) ---

function lastUserMessage(req: LlmRequest): LlmMessage | undefined {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    if (req.messages[i]!.role === 'user') return req.messages[i]
  }
  return undefined
}

class ButlerProvider implements LlmProvider {
  readonly name = 'butler-pushback-e2e'
  async *stream(req: LlmRequest): AsyncIterable<LlmStreamChunk> {
    const last = lastUserMessage(req)
    const content = last?.content

    // continuation: a tool ran this round → the butler phrases its OWN outcome.
    if (Array.isArray(content) && content.some((b) => (b as { type?: string }).type === 'tool_result')) {
      const blob = JSON.stringify(content)
      if (blob.includes('"isError":true')) yield { type: 'text', text: '好的,那我就不动它了。' }
      else if (blob.includes('已删除')) yield { type: 'text', text: '已经帮你删掉了。' }
      else yield { type: 'text', text: '好了。' }
      yield { type: 'end', stopReason: 'end_turn' }
      return
    }

    const text = typeof content === 'string' ? content : ''
    // sensitive: delete an agent (names it by full id) → governed → PARKS.
    if (/删|delete/i.test(text)) {
      const agentId = (text.match(/me\.[\w.:-]+/) ?? [])[0]
      if (agentId) {
        yield { type: 'tool_use', toolUse: { type: 'tool_use', id: 'g-del', name: 'delete_agent', input: { agentId } } }
        yield { type: 'end', stopReason: 'tool_use' }
        return
      }
    }
    yield { type: 'text', text: '好的,我记下了。' }
    yield { type: 'end', stopReason: 'end_turn' }
  }
}

class FakeLifecycle implements ManagedAgentLifecycle {
  started: AgentRecord[] = []
  removed: ParticipantId[] = []
  async start(record: AgentRecord): Promise<void> { this.started.push(record) }
  async stop(): Promise<void> {}
  async availableProviders(): Promise<readonly string[]> { return ['mock'] }
  async onAgentRemoved(id: ParticipantId): Promise<void> { this.removed.push(id) }
}

// --- rig --------------------------------------------------------------------

interface Rig {
  tmp: string
  memRoot: string
  hub: Hub
  identity: IdentityStore
  space: Space
  meAgents: HostMeAgentService
  lifecycle: FakeLifecycle
  inboxStore: FileInboxStore
  inboxService: HostInboxService
  /** Every push the resolve hook drove — the push-back target. */
  pushed: Array<{ userId: string; text: string }>
}

async function boot(): Promise<Rig> {
  const tmp = await mkdtemp(join(tmpdir(), 'aipe-butler-pushback-e2e-'))
  const { space } = await Space.init(tmp, { name: 'butler-pushback-e2e' })
  const identity = openIdentityStore({
    dbPath: join(tmp, 'identity.sqlite'),
    masterKey: randomBytes(MASTER_KEY_LEN_BYTES),
  })
  const inboxStore = new FileInboxStore(tmp)
  inboxStore.ensureDirs()

  // Mirror main.ts: persist the park, THEN (for a butler GOVERNED park only)
  // write the /me approval item tagged `source:'butler'`. A workflow human step
  // parks too, but butlerApprovalItemFor returns null for it — the broker wrote
  // its own (source-unset) item, so there's no double write.
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

  const lifecycle = new FakeLifecycle()
  const meAgents = new HostMeAgentService({ space, hub, identity, lifecycle })

  const pushed: Array<{ userId: string; text: string }> = []
  // The production onResolved hook, verbatim (main.ts): the extracted
  // `butlerResolvePushback` owns the discrimination + phrasing; the hook only
  // forwards its line to the push. Here the push is a fake recorder.
  const inboxService = new HostInboxService({
    hub,
    store: inboxStore,
    identity,
    onResolved: ({ item, childResult }) => {
      const text = butlerResolvePushback(item, childResult)
      if (text) pushed.push({ userId: item.userId, text })
    },
  })

  return { tmp, memRoot: join(tmp, 'mem'), hub, identity, space, meAgents, lifecycle, inboxStore, inboxService, pushed }
}

const provider = new ButlerProvider()

describe('butlerResolvePushback (pure) — the push-back discriminator + phrasing', () => {
  const butlerItem = (): InboxItem => ({
    itemId: 't', userId: USER, source: 'butler', kind: 'approval',
    prompt: 'p', parentKind: 'none', status: 'resolved', createdAt: 0,
  })
  const ok = (text?: string): TaskResult =>
    ({ kind: 'ok', output: text === undefined ? {} : { text }, by: 'butler' } as TaskResult)

  it('only a butler-sourced item opts in — a workflow human step (source unset) never pushes', () => {
    const humanStep: InboxItem = { ...butlerItem(), source: undefined }
    expect(butlerResolvePushback(humanStep, ok('别推我'))).toBeNull()
  })

  it('forwards the resumed turn’s ok text verbatim (both approve and reject phrase it)', () => {
    expect(butlerResolvePushback(butlerItem(), ok('已经帮你删掉了。'))).toBe('已经帮你删掉了。')
    expect(butlerResolvePushback(butlerItem(), ok('  好的,那我就不动它了。  '))).toBe('好的,那我就不动它了。')
  })

  it('falls back to a generic done line when the ok result carried no text', () => {
    expect(butlerResolvePushback(butlerItem(), ok())).toBe('好了,我已经照你的意思处理完了。')
  })

  it('apologises when the action failed AFTER approval (the butler promised a result)', () => {
    const failed = { kind: 'failed', error: '磁盘满了', by: 'butler' } as TaskResult
    expect(butlerResolvePushback(butlerItem(), failed)).toContain('磁盘满了')
  })

  it('stays silent when nothing settled (re-park or unparked child)', () => {
    const suspended = { kind: 'suspended', taskId: 't', resumeAt: 1 } as TaskResult
    expect(butlerResolvePushback(butlerItem(), suspended)).toBeNull()
    expect(butlerResolvePushback(butlerItem(), null)).toBeNull()
  })
})

describe('butler-approval-pushback-e2e — S1-M3 (real park → resolve → push back)', () => {
  let r: Rig
  beforeEach(async () => { r = await boot() })
  afterEach(async () => {
    await r.hub.stop().catch(() => {})
    r.identity.close()
    await rm(r.tmp, { recursive: true, force: true })
  })

  function memFor(userId: string): MemoryHandle {
    return openButlerMemory({ rootDir: r.memRoot, userId, logger: silentLogger })
  }
  function butlerFor(id: string, userId: string): PersonalButlerAgent {
    return new PersonalButlerAgent({
      id, provider, memory: memFor(userId), system: BUTLER_SYSTEM,
      governed: buildButlerGovernedToolset({ userId, agents: r.meAgents }),
      maxToolRounds: 6,
    })
  }
  async function dispatchTo(butlerId: string, userId: string, prompt: string) {
    return r.hub.dispatch({
      from: `user:${userId}`, strategy: { kind: 'explicit', to: butlerId },
      payload: prompt, origin: { orgId: 'local', userId },
    })
  }
  async function resolve(itemId: string, approved: boolean): Promise<void> {
    await r.inboxService.resolve({ itemId, userId: USER, decision: { kind: 'approval', approved } })
  }
  async function seedHelper(): Promise<void> {
    await r.meAgents.create(USER, { id: 'helper', label: '小助手', provider: 'mock', system: 's', capabilities: ['chat'] })
  }

  // ① approve → the butler's own "done" line is pushed back to the member's IM.
  it('① approving a butler governed park pushes the butler’s closing message back', async () => {
    await seedHelper()
    r.hub.register(butlerFor('butler:u1', USER))

    const parked = await dispatchTo('butler:u1', USER, `帮我把 ${HELPER_ID} 删了。`)
    expect(parked.kind).toBe('suspended')
    if (parked.kind !== 'suspended') throw new Error('expected a park')
    // Nothing pushed yet — the action is still waiting on the member.
    expect(r.pushed).toHaveLength(0)

    await resolve(parked.taskId, true)

    // The butler resumed, ran the real delete, phrased its outcome, and THAT line
    // was pushed back to the member (not a generic host string).
    expect(r.pushed).toEqual([{ userId: USER, text: '已经帮你删掉了。' }])
    expect(r.hub.taskResult(parked.taskId)?.kind).toBe('ok')
    expect((await r.space.agents()).some((a) => a.id === HELPER_ID)).toBe(false)
  })

  // ② reject → the butler's own "left it alone" line is pushed back (fail-closed).
  it('② rejecting a butler governed park pushes the butler’s fail-closed line back', async () => {
    await seedHelper()
    r.hub.register(butlerFor('butler:u1', USER))
    const parked = await dispatchTo('butler:u1', USER, `帮我把 ${HELPER_ID} 删了。`)
    if (parked.kind !== 'suspended') throw new Error('expected a park')

    await resolve(parked.taskId, false)

    expect(r.pushed).toEqual([{ userId: USER, text: '好的,那我就不动它了。' }])
    // Fail-closed: the agent survives the declined confirmation.
    expect((await r.space.agents()).some((a) => a.id === HELPER_ID)).toBe(true)
  })

  // ③ a workflow human step (source UNSET) resolves fine but pushes NOTHING — the
  //    push-back is butler-only. Uses the REAL HumanInboxParticipant broker.
  it('③ a workflow human step resolves without any push-back (butler-only)', async () => {
    r.hub.register(new HumanInboxParticipant({ store: r.inboxStore }))

    const parked = await r.hub.dispatch({
      from: 'workflow:approvals',
      strategy: { kind: 'capability', capabilities: [HUMAN_CAPABILITY] },
      payload: { assignee: USER, kind: 'approval', prompt: '批准这一步?' },
      origin: { orgId: 'local', userId: USER },
    })
    expect(parked.kind).toBe('suspended')
    if (parked.kind !== 'suspended') throw new Error('expected a park')

    // The broker wrote its own item with `source` unset (no butler tag).
    const pending = await r.inboxStore.listPending(USER)
    expect(pending).toHaveLength(1)
    expect(pending[0]!.source).toBeUndefined()

    await resolve(parked.taskId, true)

    // Resolved (the human step's output is the decision), but NOTHING pushed —
    // the onResolved hook early-returned on the unset source.
    expect(r.hub.taskResult(parked.taskId)?.kind).toBe('ok')
    expect(r.pushed).toHaveLength(0)
  })
})
