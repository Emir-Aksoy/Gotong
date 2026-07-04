/**
 * butler-ask-agent-e2e — Track A BE-M4. The "问我自己的助手" switchboard end to end,
 * closing the seam the unit test can't: the butler, mid-tool-loop, dispatches to a
 * REAL registered participant through the REAL hub and folds its reply back into
 * its own answer — with the no-leak scope enforced by the REAL
 * `HostMeAgentService.listOwned` (Space record + owner grant), not a fake.
 *
 *   ① A member asks their butler to ask an agent they OWN → the butler dispatches
 *      to that live participant and the reply comes back in the butler's answer.
 *   ② no-leak: asking an agent the member does NOT own → the butler refuses and
 *      that participant is NEVER dispatched to (its onTask never runs).
 *
 * The butler loop, the benign ask tool, and the hub dispatch are the real code;
 * the LLM is a deterministic keyword provider and the target agents are tiny echo
 * participants (so the reply is verifiable without a real model).
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
  type Participant,
  type ParticipantId,
  type Task,
  type TaskResult,
} from '@gotong/core'
import { MASTER_KEY_LEN_BYTES, openIdentityStore, userPrincipal, type IdentityStore } from '@gotong/identity'
import { FileInboxStore } from '@gotong/inbox'
import { PersonalButlerAgent } from '@gotong/personal-butler'
import type { LlmMessage, LlmProvider, LlmRequest, LlmStreamChunk } from '@gotong/llm'
import type { MemoryHandle } from '@gotong/services-sdk'

import { buildButlerAskAgentToolset } from '../src/personal-butler-ask-agent.js'
import { openButlerMemory } from '../src/personal-butler-memory.js'
import { HostMeAgentService } from '../src/me-agent-service.js'

const USER = 'u1'
const OWNED_ID = `me.${USER}.helper`
const OTHER_ID = 'me.u2.secret'

const silentLogger: Logger = {
  trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
  child() { return silentLogger },
}

// A tiny echo participant that records whether it was dispatched to.
class EchoAgent implements Participant {
  calls = 0
  readonly capabilities = ['chat']
  constructor(readonly id: string, private readonly prefix: string) {}
  async onTask(task: Task): Promise<TaskResult> {
    this.calls++
    return { kind: 'ok', taskId: task.id, by: this.id, output: `${this.prefix}:${String(task.payload)}`, ts: 0 }
  }
}

function lastUserMessage(req: LlmRequest): LlmMessage | undefined {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    if (req.messages[i]!.role === 'user') return req.messages[i]
  }
  return undefined
}

// Emits ask_my_agent for the id named in the message; on the tool result, folds
// it into the final answer so the propagated reply is observable.
class AskProvider implements LlmProvider {
  readonly name = 'butler-ask-e2e'
  async *stream(req: LlmRequest): AsyncIterable<LlmStreamChunk> {
    const content = lastUserMessage(req)?.content
    if (Array.isArray(content) && content.some((b) => (b as { type?: string }).type === 'tool_result')) {
      yield { type: 'text', text: `我问了,结果是:${JSON.stringify(content)}` }
      yield { type: 'end', stopReason: 'end_turn' }
      return
    }
    const text = typeof content === 'string' ? content : ''
    const agentId = (text.match(/me\.[\w.:-]+/) ?? [])[0]
    if (/问|ask/i.test(text) && agentId) {
      yield { type: 'tool_use', toolUse: { type: 'tool_use', id: 'ask-1', name: 'ask_my_agent', input: { agentId, message: '你好' } } }
      yield { type: 'end', stopReason: 'tool_use' }
      return
    }
    yield { type: 'text', text: '好的。' }
    yield { type: 'end', stopReason: 'end_turn' }
  }
}

class FakeLifecycle implements ManagedAgentLifecycle {
  async start(_r: AgentRecord): Promise<void> {}
  async stop(): Promise<void> {}
  async availableProviders(): Promise<readonly string[]> { return ['mock'] }
  async onAgentRemoved(_id: ParticipantId): Promise<void> {}
}

interface Rig {
  tmp: string
  memRoot: string
  hub: Hub
  identity: IdentityStore
  space: Space
  meAgents: HostMeAgentService
  provider: AskProvider
}

async function boot(): Promise<Rig> {
  const tmp = await mkdtemp(join(tmpdir(), 'gotong-butler-ask-e2e-'))
  const { space } = await Space.init(tmp, { name: 'butler-ask-e2e' })
  const identity = openIdentityStore({ dbPath: join(tmp, 'identity.sqlite'), masterKey: randomBytes(MASTER_KEY_LEN_BYTES) })
  const inboxStore = new FileInboxStore(tmp)
  inboxStore.ensureDirs()
  const hub = new Hub({ space })
  await hub.start()
  const meAgents = new HostMeAgentService({ space, hub, identity, lifecycle: new FakeLifecycle() })
  return { tmp, memRoot: join(tmp, 'mem'), hub, identity, space, meAgents, provider: new AskProvider() }
}

describe('butler-ask-agent-e2e — BE-M4 (real hub dispatch + real listOwned scope)', () => {
  let r: Rig
  beforeEach(async () => { r = await boot() })
  afterEach(async () => {
    await r.hub.stop().catch(() => {})
    r.identity.close()
    await rm(r.tmp, { recursive: true, force: true })
  })

  // Seed an owned managed agent (Space record + owner grant) so the REAL listOwned
  // returns it — mirrors what create()/import leaves behind.
  async function seedOwned(id: string, owner: string): Promise<void> {
    await r.space.upsertAgent({ id, allowedCapabilities: ['chat'], managed: { kind: 'llm', provider: 'mock', system: 's' }, displayName: '我的助手' })
    r.identity.setResourceGrant({ resourceKind: 'agent', resourceId: id, principal: userPrincipal(owner), perm: 'owner', grantedBy: owner })
  }

  function butler(): PersonalButlerAgent {
    return new PersonalButlerAgent({
      id: 'butler:u1',
      provider: r.provider,
      memory: openButlerMemory({ rootDir: r.memRoot, userId: USER, logger: silentLogger }) as MemoryHandle,
      system: '你是用户的私人管家。',
      benign: buildButlerAskAgentToolset({ userId: USER, roster: r.meAgents, hub: r.hub }),
      maxToolRounds: 6,
    })
  }

  async function ask(prompt: string): Promise<TaskResult> {
    return r.hub.dispatch({ from: `user:${USER}`, strategy: { kind: 'explicit', to: 'butler:u1' }, payload: prompt, origin: { orgId: 'local', userId: USER } })
  }

  // The butler (an LlmAgent) returns its final answer as an `{ text }` output.
  function answerText(res: TaskResult): string {
    if (res.kind !== 'ok') return ''
    const out = res.output
    if (typeof out === 'string') return out
    return out && typeof out === 'object' && typeof (out as { text?: unknown }).text === 'string'
      ? (out as { text: string }).text
      : ''
  }

  // ① ask an OWNED agent → dispatched to it, reply folded back into the answer.
  it('① relays a question to an owned agent and returns its reply', async () => {
    await seedOwned(OWNED_ID, USER)
    const helper = new EchoAgent(OWNED_ID, 'helper-reply')
    r.hub.register(helper)
    r.hub.register(butler())

    const res = await ask(`问一下我的助手 ${OWNED_ID} 一个问题。`)
    expect(res.kind).toBe('ok')
    if (res.kind !== 'ok') throw new Error('expected ok')
    expect(helper.calls).toBe(1) // the live agent really ran
    expect(answerText(res)).toContain('helper-reply') // its reply propagated into the butler's answer
  })

  // ② ask an UNOWNED agent → refused, never dispatched (real listOwned scope).
  it('② refuses to ask an agent the member does not own — never dispatches to it', async () => {
    await seedOwned(OWNED_ID, USER) // u1 owns helper, but NOT me.u2.secret
    const secret = new EchoAgent(OTHER_ID, 'secret-reply')
    r.hub.register(secret)
    r.hub.register(butler())

    const res = await ask(`问一下 ${OTHER_ID} 的私密内容。`)
    expect(res.kind).toBe('ok')
    if (res.kind !== 'ok') throw new Error('expected ok')
    expect(secret.calls).toBe(0) // no-leak: the unowned agent was never dispatched to
    expect(answerText(res)).toContain('不是你的助手')
  })
})
