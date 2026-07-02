/**
 * butler-diagnose-e2e — Track A BE-M2. The diagnose→fix loop end to end, through
 * the REAL RES-M2 engine + a REAL HostMeAgentService, closing the seam the
 * isolated unit test can't: that the fix the butler NAMES actually lands on disk.
 *
 * The narrowed acceptance (the user's 守边界 decision) in one file:
 *
 *   ① A keyless owned agent (seeded template-import style, bypassing create()'s
 *      key gate) + an injected inventory where a NATIVE provider has a key →
 *      `diagnose_my_agents` (real `listOwned` + real `proposeAdaptations`) proposes
 *      a `switch_provider`→native as BUTLER-ENACTABLE and names `edit_agent`.
 *   ② Driving that `edit_agent` through the resident butler's REAL governed loop
 *      parks it → /me inbox → approve → the agent's provider REALLY changes on disk
 *      (batch "批准后真改").
 *   ③ Rejecting the park leaves the record byte-identical (fail-closed, "字节不变").
 *   ④ When the only keyed provider is openai-compatible (non-native), diagnosis is
 *      ADVISORY only — nothing is butler-enactable ("提议→只建议", the boundary).
 *
 * The LLM is a deterministic keyword provider; the butler loop, gating, park, and
 * two-step resume are the real code. Zero API key, zero clock.
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
} from '@aipehub/core'
import {
  MASTER_KEY_LEN_BYTES,
  openIdentityStore,
  userPrincipal,
  type IdentityStore,
} from '@aipehub/identity'
import { FileInboxStore } from '@aipehub/inbox'
import { PersonalButlerAgent } from '@aipehub/personal-butler'
import type { LlmMessage, LlmProvider, LlmRequest, LlmStreamChunk } from '@aipehub/llm'
import type { MemoryHandle } from '@aipehub/services-sdk'

import { buildButlerDiagnoseToolset } from '../src/personal-butler-diagnose.js'
import { buildButlerGovernedToolset } from '../src/personal-butler-governed.js'
import { butlerApprovalItemFor } from '../src/personal-butler-escalation.js'
import { openButlerMemory } from '../src/personal-butler-memory.js'
import { HostInboxService } from '../src/inbox-service.js'
import { HostMeAgentService } from '../src/me-agent-service.js'
import { createResourceAdaptationService } from '../src/resource-adaptation.js'
import type { ResourceInventory } from '../src/resource-inventory.js'

const USER = 'u1'
const IMPORTED = `me.${USER}.imported`

const silentLogger: Logger = {
  trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
  child() { return silentLogger },
}

const BUTLER_SYSTEM = '你是用户的私人管家。改动系统前先请示。'

function textOf(result: { content: { type: string; text?: string }[] }): string {
  return result.content.map((c) => c.text ?? '').join('')
}

// An inventory where anthropic (native) has a key and openai does not → a keyless
// openai agent gets a butler-ENACTABLE switch→anthropic proposal.
const INV_ANTHROPIC_KEYED: ResourceInventory = {
  llmKeys: [
    { provider: 'anthropic', envVar: 'ANTHROPIC_API_KEY', envSet: true, vaultConfigured: false },
    { provider: 'openai', envVar: 'OPENAI_API_KEY', envSet: false, vaultConfigured: false },
  ],
  localEndpoints: [],
  cliAgents: [],
  mcpServers: [],
  checkedAt: '2026-07-02T00:00:00.000Z',
}

// An inventory where the ONLY keyed provider is openai-compatible (vault-configured,
// non-native) → the switch is applicable:false → ADVISORY, nothing butler-enactable.
const INV_ONLY_MIMO: ResourceInventory = {
  llmKeys: [
    { provider: 'anthropic', envVar: 'ANTHROPIC_API_KEY', envSet: false, vaultConfigured: false },
    { provider: 'mimo', envSet: false, vaultConfigured: true },
    { provider: 'openai', envVar: 'OPENAI_API_KEY', envSet: false, vaultConfigured: false },
  ],
  localEndpoints: [],
  cliAgents: [],
  mcpServers: [],
  checkedAt: '2026-07-02T00:00:00.000Z',
}

// --- deterministic provider: scripts the edit_agent switch --------------------

function lastUserMessage(req: LlmRequest): LlmMessage | undefined {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    if (req.messages[i]!.role === 'user') return req.messages[i]
  }
  return undefined
}

class ButlerFixProvider implements LlmProvider {
  readonly name = 'butler-diagnose-e2e'

  async *stream(req: LlmRequest): AsyncIterable<LlmStreamChunk> {
    const content = lastUserMessage(req)?.content

    // continuation: a tool result came back → close out.
    if (Array.isArray(content) && content.some((b) => (b as { type?: string }).type === 'tool_result')) {
      const blob = JSON.stringify(content)
      yield { type: 'text', text: blob.includes('"isError":true') ? '好的,那我先不改。' : '已经按体检结果帮你改好了。' }
      yield { type: 'end', stopReason: 'end_turn' }
      return
    }

    const text = typeof content === 'string' ? content : ''
    // "把 <id> 换成 anthropic" → the governed edit_agent switch the diagnosis named.
    if (/换成|切到|改用|switch/i.test(text) && /anthropic/i.test(text)) {
      const agentId = (text.match(/me\.[\w.:-]+/) ?? [])[0]
      if (agentId) {
        yield {
          type: 'tool_use',
          toolUse: { type: 'tool_use', id: 'fix-1', name: 'edit_agent', input: { agentId, changes: { provider: 'anthropic' } } },
        }
        yield { type: 'end', stopReason: 'tool_use' }
        return
      }
    }

    yield { type: 'text', text: '好的。' }
    yield { type: 'end', stopReason: 'end_turn' }
  }
}

// A lifecycle that reports anthropic available, so the switch's key check passes.
class SwitchLifecycle implements ManagedAgentLifecycle {
  started: AgentRecord[] = []
  removed: ParticipantId[] = []
  async start(record: AgentRecord): Promise<void> { this.started.push(record) }
  async stop(): Promise<void> {}
  async availableProviders(): Promise<readonly string[]> { return ['mock', 'anthropic'] }
  async onAgentRemoved(id: ParticipantId): Promise<void> { this.removed.push(id) }
}

interface Rig {
  tmp: string
  memRoot: string
  hub: Hub
  identity: IdentityStore
  space: Space
  meAgents: HostMeAgentService
  lifecycle: SwitchLifecycle
  inboxStore: FileInboxStore
  inboxService: HostInboxService
  provider: ButlerFixProvider
}

async function boot(): Promise<Rig> {
  const tmp = await mkdtemp(join(tmpdir(), 'aipe-butler-diag-e2e-'))
  const { space } = await Space.init(tmp, { name: 'butler-diag-e2e' })
  const identity = openIdentityStore({
    dbPath: join(tmp, 'identity.sqlite'),
    masterKey: randomBytes(MASTER_KEY_LEN_BYTES),
  })
  const inboxStore = new FileInboxStore(tmp)
  inboxStore.ensureDirs()

  // Mirror main.ts: persist the park, then turn a butler governed park into a /me
  // approval item (the member approves their own butler).
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

  const lifecycle = new SwitchLifecycle()
  const meAgents = new HostMeAgentService({ space, hub, identity, lifecycle })
  const inboxService = new HostInboxService({ hub, store: inboxStore, identity })

  return { tmp, memRoot: join(tmp, 'mem'), hub, identity, space, meAgents, lifecycle, inboxStore, inboxService, provider: new ButlerFixProvider() }
}

describe('butler-diagnose-e2e — BE-M2 (real engine + real HostMeAgentService)', () => {
  let r: Rig
  beforeEach(async () => { r = await boot() })
  afterEach(async () => {
    await r.hub.stop().catch(() => {})
    r.identity.close()
    await rm(r.tmp, { recursive: true, force: true })
  })

  // Seed a keyless owned agent the way a TEMPLATE IMPORT does: upsert the record +
  // record owner grant DIRECTLY, bypassing create()'s key gate. This is the real
  // origin of a keyless agent — a template ships provider X, this hub has no X key.
  async function seedImported(provider: string): Promise<void> {
    await r.space.upsertAgent({
      id: IMPORTED,
      allowedCapabilities: ['chat'],
      managed: { kind: 'llm', provider, system: '模板带来的助手。' },
      displayName: '导入的助手',
    })
    r.identity.setResourceGrant({
      resourceKind: 'agent',
      resourceId: IMPORTED,
      principal: userPrincipal(USER),
      perm: 'owner',
      grantedBy: USER,
    })
  }

  function diagnoseToolset(inventory: ResourceInventory) {
    return buildButlerDiagnoseToolset({
      userId: USER,
      ownedAgents: r.meAgents,
      adaptation: createResourceAdaptationService({ inventory: async () => inventory }),
    })
  }

  function butlerFor(id: string): PersonalButlerAgent {
    return new PersonalButlerAgent({
      id,
      provider: r.provider,
      memory: openButlerMemory({ rootDir: r.memRoot, userId: USER, logger: silentLogger }) as MemoryHandle,
      system: BUTLER_SYSTEM,
      governed: buildButlerGovernedToolset({ userId: USER, agents: r.meAgents }),
      maxToolRounds: 6,
    })
  }

  async function providerOf(id: string): Promise<string | undefined> {
    const rec = (await r.space.agents()).find((a) => a.id === id)
    return rec?.managed?.provider
  }

  async function dispatchTo(butlerId: string, prompt: string) {
    return r.hub.dispatch({
      from: `user:${USER}`,
      strategy: { kind: 'explicit', to: butlerId },
      payload: prompt,
      origin: { orgId: 'local', userId: USER },
    })
  }

  // ① diagnose over the REAL engine names the enactable switch → edit_agent.
  it('① diagnoses a keyless agent and names edit_agent switch→native as enactable', async () => {
    await seedImported('openai') // keyless on this hub
    const out = textOf(await diagnoseToolset(INV_ANTHROPIC_KEYED).callTool('diagnose_my_agents', {}))
    expect(out).toContain('我能帮你改') // enactable head
    expect(out).toContain('edit_agent')
    expect(out).toContain('anthropic')
    expect(out).toContain(IMPORTED)
  })

  // ② the named fix, driven through the butler, parks → approve → provider REALLY changes.
  it('② the named edit_agent parks, and approval really switches the provider on disk', async () => {
    await seedImported('openai')
    expect(await providerOf(IMPORTED)).toBe('openai')

    const b = butlerFor('butler:u1')
    r.hub.register(b)
    const parked = await dispatchTo('butler:u1', `把 ${IMPORTED} 换成 anthropic。`)
    expect(parked.kind).toBe('suspended')
    if (parked.kind !== 'suspended') throw new Error('expected a park')

    // Not changed yet — the gate held before any write.
    expect(await providerOf(IMPORTED)).toBe('openai')
    const pending = await r.inboxStore.listPending(USER)
    expect(pending).toHaveLength(1)
    expect(pending[0]!.kind).toBe('approval')

    // Approve → the held turn runs the REAL edit_agent through HostMeAgentService.
    await r.inboxService.resolve({ itemId: parked.taskId, userId: USER, decision: { kind: 'approval', approved: true } })
    expect(await providerOf(IMPORTED)).toBe('anthropic') // 批准后真改
    expect(r.hub.taskResult(parked.taskId)?.kind).toBe('ok')
    expect(r.lifecycle.started.map((a) => a.id)).toContain(IMPORTED) // respawned with new config
  })

  // ③ rejecting the park leaves the record byte-identical (fail-closed).
  it('③ rejecting the parked switch leaves the provider unchanged (字节不变)', async () => {
    await seedImported('openai')
    const b = butlerFor('butler:u1')
    r.hub.register(b)
    const parked = await dispatchTo('butler:u1', `把 ${IMPORTED} 换成 anthropic。`)
    if (parked.kind !== 'suspended') throw new Error('expected a park')

    await r.inboxService.resolve({ itemId: parked.taskId, userId: USER, decision: { kind: 'approval', approved: false } })
    expect(await providerOf(IMPORTED)).toBe('openai') // untouched
    expect(await r.inboxStore.listPending(USER)).toHaveLength(0)
  })

  // ④ when only a non-native provider has a key, diagnosis is ADVISORY only.
  it('④ an openai-compatible-only inventory yields advisory diagnosis, nothing enactable', async () => {
    await seedImported('openai')
    const out = textOf(await diagnoseToolset(INV_ONLY_MIMO).callTool('diagnose_my_agents', {}))
    expect(out).toContain('都需要你或管理员手动处理')
    expect(out).not.toContain('我能帮你改')
  })
})
