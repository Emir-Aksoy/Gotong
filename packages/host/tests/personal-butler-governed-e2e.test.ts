/**
 * personal-butler-governed-e2e — BF-M7-M3. The resident butler's SENSITIVE-action
 * path, end to end, through the PRODUCTION builder + a REAL member service.
 *
 * Two earlier gates already cover pieces of this:
 *   - personal-butler-e2e.test.ts proves the park → /me-inbox → approve/reject
 *     MECHANISM, but with a HAND-ROLLED governed toolset over a `Set<string>`;
 *   - hub-steward-e2e.test.ts drives a real `HostMeAgentService` (real Space
 *     `upsertAgent` + real `resource_grants`), but through the `/me` STEWARD's
 *     plan→apply engine, not the resident butler's tool-loop.
 *
 * This closes the seam neither does: the resident butler's own bounded tool-loop
 * (`PersonalButlerAgent`) wired to the PRODUCTION `buildButlerGovernedToolset`
 * (steward action vocabulary + `performStewardAction` chokepoint) executing
 * against a REAL `HostMeAgentService` — exactly the objects main.ts assembles in
 * `createForUser`. So a member, by TALKING to their butler, can create / delete
 * their OWN managed agent, and every such action:
 *   1. PARKS at never-resume (even `create_agent` — the resident IM butler has no
 *      plan/apply preview, so the /me inbox IS the review step; stricter than the
 *      steward's `safe` create), blind to the sweep, with a `/me` approval item;
 *   2. runs the REAL effect only on approval (Space record appears / disappears +
 *      `resource_grants` owner row + lifecycle spawn / teardown);
 *   3. is fail-closed on rejection (nothing created / nothing removed).
 *
 * Wired with agents-only (NO workflow editor) — the honest shape of a hub with
 * identity but no `workflowAssist` (main.ts's Option-B branch): agent actions
 * work, `edit_workflow` simply isn't advertised.
 *
 * The LLM is a deterministic keyword-scripted provider (no API key); the butler's
 * loop, gating, park, and two-step resume are the real code.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  Hub,
  Space,
  createLogger,
  type AgentRecord,
  type Logger,
  type ManagedAgentLifecycle,
  type ParticipantId,
} from '@gotong/core'
import {
  MASTER_KEY_LEN_BYTES,
  openIdentityStore,
  userPrincipal,
  type IdentityStore,
} from '@gotong/identity'
import { FileInboxStore } from '@gotong/inbox'
import { BUTLER_NEVER_RESUME_AT, PersonalButlerAgent } from '@gotong/personal-butler'
import type {
  LlmMessage,
  LlmProvider,
  LlmRequest,
  LlmStreamChunk,
} from '@gotong/llm'
import type { MemoryHandle } from '@gotong/services-sdk'

import { buildButlerGovernedToolset } from '../src/personal-butler-governed.js'
import { butlerApprovalItemFor } from '../src/personal-butler-escalation.js'
import { openButlerMemory } from '../src/personal-butler-memory.js'
import { HostInboxService } from '../src/inbox-service.js'
import { HostMeAgentService } from '../src/me-agent-service.js'

const USER = 'u1'
const HELPER_ID = `me.${USER}.helper`

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

// --- deterministic provider -------------------------------------------------
// Reads the request the butler builds and scripts its tool calls by keyword. The
// tool INPUTS match the production builder's contract: `create_agent` carries the
// full field set (handle/label/provider/system/capabilities) and `delete_agent`
// carries an `agentId` (validateStewardAction rejects a bare `handle`).

function lastUserMessage(req: LlmRequest): LlmMessage | undefined {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    if (req.messages[i]!.role === 'user') return req.messages[i]
  }
  return undefined
}

class ButlerGovernedProvider implements LlmProvider {
  readonly name = 'butler-governed-e2e'

  async *stream(req: LlmRequest): AsyncIterable<LlmStreamChunk> {
    const last = lastUserMessage(req)
    const content = last?.content

    // ── continuation: a tool already ran this round → close out on its result ──
    if (Array.isArray(content) && content.some((b) => (b as { type?: string }).type === 'tool_result')) {
      const blob = JSON.stringify(content)
      if (blob.includes('"isError":true')) {
        yield { type: 'text', text: '好的,那我就不动它了。' }
      } else if (blob.includes('已删除')) {
        yield { type: 'text', text: '已经帮你删掉了。' }
      } else if (blob.includes('已创建')) {
        yield { type: 'text', text: '已经帮你建好了。' }
      } else {
        yield { type: 'text', text: '好了。' }
      }
      yield { type: 'end', stopReason: 'end_turn' }
      return
    }

    const text = typeof content === 'string' ? content : ''

    // ── sensitive: delete an agent (names it by full id) → governed → PARKS ──
    if (/删|delete/i.test(text)) {
      const agentId = (text.match(/me\.[\w.:-]+/) ?? [])[0]
      if (agentId) {
        yield { type: 'tool_use', toolUse: { type: 'tool_use', id: 'g-del', name: 'delete_agent', input: { agentId } } }
        yield { type: 'end', stopReason: 'tool_use' }
        return
      }
    }

    // ── sensitive: create an agent → governed → PARKS (stricter than steward) ──
    if (/建|新建|create/i.test(text)) {
      yield {
        type: 'tool_use',
        toolUse: {
          type: 'tool_use',
          id: 'g-new',
          name: 'create_agent',
          input: {
            handle: 'helper',
            label: '小助手',
            provider: 'mock',
            system: '你帮我把邮件总结成要点。',
            capabilities: ['chat'],
          },
        },
      }
      yield { type: 'end', stopReason: 'tool_use' }
      return
    }

    // ── otherwise: acknowledge ──
    yield { type: 'text', text: '好的,我记下了。' }
    yield { type: 'end', stopReason: 'end_turn' }
  }
}

// --- faked spawn (every host agent test fakes the LLM spawn) ----------------

class FakeLifecycle implements ManagedAgentLifecycle {
  started: AgentRecord[] = []
  removed: ParticipantId[] = []
  async start(record: AgentRecord): Promise<void> {
    this.started.push(record)
  }
  async stop(): Promise<void> {}
  async availableProviders(): Promise<readonly string[]> {
    return ['mock']
  }
  async onAgentRemoved(id: ParticipantId): Promise<void> {
    this.removed.push(id)
  }
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
  provider: ButlerGovernedProvider
}

async function boot(): Promise<Rig> {
  const tmp = await mkdtemp(join(tmpdir(), 'gotong-butler-gov-e2e-'))
  const { space } = await Space.init(tmp, { name: 'butler-gov-e2e' })
  const identity = openIdentityStore({
    dbPath: join(tmp, 'identity.sqlite'),
    masterKey: randomBytes(MASTER_KEY_LEN_BYTES),
  })
  const inboxStore = new FileInboxStore(tmp)
  inboxStore.ensureDirs()

  // Mirror main.ts exactly: persist the park, THEN turn a butler GOVERNED park
  // into a /me approval item (butlerApprovalItemFor returns null for any other
  // suspend). For a personal butler the approver is the member themselves. Async
  // + awaited, so the item exists before dispatch returns suspended.
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
  const inboxService = new HostInboxService({ hub, store: inboxStore, identity })

  return { tmp, memRoot: join(tmp, 'mem'), hub, identity, space, meAgents, lifecycle, inboxStore, inboxService, provider: new ButlerGovernedProvider() }
}

describe('personal-butler-governed-e2e — BF-M7-M3 (production builder + real HostMeAgentService)', () => {
  let r: Rig
  beforeEach(async () => {
    r = await boot()
  })
  afterEach(async () => {
    await r.hub.stop().catch(() => {})
    r.identity.close()
    await rm(r.tmp, { recursive: true, force: true })
  })

  function memFor(userId: string): MemoryHandle {
    return openButlerMemory({ rootDir: r.memRoot, userId, logger: silentLogger })
  }

  /** A resident butler wired the way main.ts wires it: agents-only governed set
   *  (no workflow editor — the Option-B branch), the production builder, per-user
   *  memory. */
  function butlerFor(id: string, userId: string): PersonalButlerAgent {
    return new PersonalButlerAgent({
      id,
      provider: r.provider,
      memory: memFor(userId),
      system: BUTLER_SYSTEM,
      governed: buildButlerGovernedToolset({ userId, agents: r.meAgents }),
      maxToolRounds: 6,
    })
  }

  async function dispatchTo(butlerId: string, userId: string, prompt: string) {
    return r.hub.dispatch({
      from: `user:${userId}`,
      strategy: { kind: 'explicit', to: butlerId },
      payload: prompt,
      origin: { orgId: 'local', userId },
    })
  }

  async function hasAgent(id: string): Promise<boolean> {
    return (await r.space.agents()).some((a) => a.id === id)
  }

  async function resolve(itemId: string, approved: boolean): Promise<void> {
    await r.inboxService.resolve({ itemId, userId: USER, decision: { kind: 'approval', approved } })
  }

  // The agents-only production shape: main.ts's Option-B branch (identity present,
  // workflowAssist absent). Agent actions are advertised; edit_workflow is not, and
  // the operator-only sensitive writes never exist on a member butler.
  it('agents-only butler advertises create/edit/delete_agent but not edit_workflow or operator writes', () => {
    const gov = buildButlerGovernedToolset({ userId: USER, agents: r.meAgents })
    expect(gov.listTools().map((t) => t.name).sort()).toEqual(['create_agent', 'delete_agent', 'edit_agent'])
    for (const name of ['set_credential_ref', 'revoke_credential', 'set_peer_policy', 'set_security_quota', 'edit_workflow']) {
      expect(gov.governs(name)).toBe(false)
    }
  })

  // ① create — even a CREATE parks (stricter than the /me steward's inline safe
  //    create); on approval a REAL owned agent lands (Space + owner grant + spawn).
  it('① creating an agent via the butler parks, then approval builds a real owned agent', async () => {
    const b = butlerFor('butler:u1', USER)
    r.hub.register(b)

    const parked = await dispatchTo('butler:u1', USER, '帮我建一个总结邮件的小助手。')
    expect(parked.kind).toBe('suspended')
    if (parked.kind !== 'suspended') throw new Error('expected a park')

    // Nothing created yet — the gate held before any side effect.
    expect(await hasAgent(HELPER_ID)).toBe(false)
    const pending = await r.inboxStore.listPending(USER)
    expect(pending).toHaveLength(1)
    expect(pending[0]!.kind).toBe('approval')
    // The inbox title reuses the steward's zh summary (describe → summarizeStewardAction).
    expect(pending[0]!.prompt).toContain('小助手')

    // Approve → the held turn runs the REAL create through HostMeAgentService.
    await resolve(parked.taskId, true)
    expect(await hasAgent(HELPER_ID)).toBe(true)
    expect(r.identity.hasResourceGrant('agent', HELPER_ID, userPrincipal(USER), 'owner')).toBe(true)
    expect(r.lifecycle.started.map((a) => a.id)).toContain(HELPER_ID)
    expect(r.hub.taskResult(parked.taskId)?.kind).toBe('ok')
  })

  // ② delete — parks at NEVER, blind to the sweep, with a /me item; nothing removed.
  it('② deleting an agent via the butler parks at NEVER with a /me item — nothing removed yet', async () => {
    // Seed a real owned agent the member will ask the butler to delete.
    await r.meAgents.create(USER, { id: 'helper', label: '小助手', provider: 'mock', system: 's', capabilities: ['chat'] })
    expect(await hasAgent(HELPER_ID)).toBe(true)

    const b = butlerFor('butler:u1', USER)
    r.hub.register(b)

    const parked = await dispatchTo('butler:u1', USER, `帮我把 ${HELPER_ID} 这个助手删了。`)
    expect(parked.kind).toBe('suspended')
    if (parked.kind !== 'suspended') throw new Error('expected a park')
    const taskId = parked.taskId

    // Still there — the gate held.
    expect(await hasAgent(HELPER_ID)).toBe(true)

    // A /me approval item names WHAT action and ON WHAT (the steward zh summary).
    const pending = await r.inboxStore.listPending(USER)
    expect(pending).toHaveLength(1)
    expect(pending[0]!.itemId).toBe(taskId)
    expect(pending[0]!.kind).toBe('approval')
    expect(pending[0]!.prompt).toContain(HELPER_ID)

    // Parked at never-resume → the timer sweep can never wake it; only a resolve can.
    const row = r.identity.getSuspendedTask(taskId)
    expect(row?.resumeAt).toBe(BUTLER_NEVER_RESUME_AT)
    expect(r.identity.listDueSuspendedTasks({ now: Date.now() }).some((d) => d.taskId === taskId)).toBe(false)
  })

  // ② approve → the second confirmation runs the REAL delete (Space + grant + spawn).
  it('② approving the parked delete really removes the agent', async () => {
    await r.meAgents.create(USER, { id: 'helper', label: '小助手', provider: 'mock', system: 's', capabilities: ['chat'] })
    const b = butlerFor('butler:u1', USER)
    r.hub.register(b)
    const parked = await dispatchTo('butler:u1', USER, `帮我把 ${HELPER_ID} 删了。`)
    if (parked.kind !== 'suspended') throw new Error('expected a park')

    await resolve(parked.taskId, true)

    expect(await hasAgent(HELPER_ID)).toBe(false)
    expect(r.identity.hasResourceGrant('agent', HELPER_ID, userPrincipal(USER), 'viewer')).toBe(false)
    expect(r.lifecycle.removed).toContain(HELPER_ID)
    expect(r.hub.taskResult(parked.taskId)?.kind).toBe('ok')
    expect(r.identity.getSuspendedTask(parked.taskId)).toBeNull()
    expect(await r.inboxStore.listPending(USER)).toHaveLength(0)
  })

  // ② reject → fail-closed: the agent survives the declined second confirmation.
  it('② rejecting the parked delete leaves the agent intact (fail-closed)', async () => {
    await r.meAgents.create(USER, { id: 'helper', label: '小助手', provider: 'mock', system: 's', capabilities: ['chat'] })
    const b = butlerFor('butler:u1', USER)
    r.hub.register(b)
    const parked = await dispatchTo('butler:u1', USER, `帮我把 ${HELPER_ID} 删了。`)
    if (parked.kind !== 'suspended') throw new Error('expected a park')

    await resolve(parked.taskId, false)

    expect(await hasAgent(HELPER_ID)).toBe(true)
    expect(r.identity.hasResourceGrant('agent', HELPER_ID, userPrincipal(USER), 'owner')).toBe(true)
    expect(r.lifecycle.removed).not.toContain(HELPER_ID)
    expect(r.hub.taskResult(parked.taskId)?.kind).toBe('ok')
  })
})
