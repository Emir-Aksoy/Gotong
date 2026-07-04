/**
 * A-M1 — the member-facing steward and the operator-console steward (SW-M9) are
 * two instances of `createHubStewardService` on ONE hub. They coexist ONLY
 * because each registers under a DISJOINT id set: the privilege boundary is the
 * registered participant identity (+ the host surface that built it), NEVER a
 * payload flag a member could forge.
 *
 * This gate pins the two properties A-M1 must guarantee before A-M2..A-M7 build
 * the operator executor on top:
 *   1. both agents AND both approval brokers register under disjoint ids/caps;
 *   2. each `plan` routes to its OWN agent — a distinct mock reply per instance
 *      means a cross-talk bug (capability dispatch crossing) would surface as the
 *      wrong reply.
 *
 * Light fakes for the executor deps (this test never executes a write — that's
 * the A-M2/A-M7 e2e's job). A real Hub (InMemoryStorage) + real MockLlmProvider
 * so dispatch + the agent's parse pipeline run for real.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Hub, InMemoryStorage, createLogger } from '@gotong/core'
import { MockLlmProvider } from '@gotong/llm'
import { FileInboxStore } from '@gotong/inbox'

import {
  createHubStewardService,
  DEFAULT_STEWARD_IDS,
  OPERATOR_STEWARD_IDS,
  type HubStewardSurface,
  type StewardAgentDirectory,
  type StewardWorkflowDirectory,
  type StewardWorkflowEditor,
} from '../src/hub-steward-service.js'

// --- light executor fakes (no writes happen in A-M1) ------------------------

const fakeAgents: StewardAgentDirectory = {
  async listOwned() {
    return []
  },
  async availableProviders() {
    return ['mock']
  },
  async create() {
    throw new Error('A-M1 never executes a create')
  },
  async update() {
    throw new Error('A-M1 never executes an update')
  },
  async remove() {
    return true
  },
}
const fakeWorkflows: StewardWorkflowDirectory = {
  async listForUser() {
    return []
  },
}
const fakeEditor: StewardWorkflowEditor = {
  async edit() {
    throw new Error('A-M1 never executes a workflow edit')
  },
}

/** A valid steward proposal JSON whose `reply` tags WHICH instance produced it. */
function taggedProposal(tag: string): string {
  return ['好的', '', '```json', JSON.stringify({ reply: tag, actions: [] }), '```'].join('\n')
}

describe('A-M1 — member + operator steward instances coexist disjointly', () => {
  let tmp: string
  let hub: Hub
  let inbox: FileInboxStore
  let member: HubStewardSurface
  let operator: HubStewardSurface

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'gotong-steward-ids-'))
    hub = new Hub({ storage: new InMemoryStorage() })
    await hub.start()
    inbox = new FileInboxStore(tmp)
    inbox.ensureDirs()

    const common = {
      hub,
      config: { provider: 'mock' as const },
      agents: fakeAgents,
      workflows: fakeWorkflows,
      workflowEditor: fakeEditor,
      inbox, // wired so BOTH approval brokers register too
      logger: createLogger('test-steward-ids'),
    }
    const m = createHubStewardService({
      ...common,
      provider: new MockLlmProvider({ reply: () => taggedProposal('MEMBER') }),
    })
    const o = createHubStewardService({
      ...common,
      ids: OPERATOR_STEWARD_IDS,
      provider: new MockLlmProvider({ reply: () => taggedProposal('OPERATOR') }),
    })
    if (!m || !o) throw new Error('expected both steward surfaces to register')
    member = m
    operator = o
  })

  afterEach(async () => {
    await hub.stop()
    await rm(tmp, { recursive: true, force: true })
  })

  it('registers both agents + both brokers under disjoint ids/caps', () => {
    const registered = new Set(hub.participants().map((p) => p.id))
    expect(registered.has(DEFAULT_STEWARD_IDS.agentId)).toBe(true)
    expect(registered.has(OPERATOR_STEWARD_IDS.agentId)).toBe(true)
    expect(registered.has(DEFAULT_STEWARD_IDS.brokerId)).toBe(true)
    expect(registered.has(OPERATOR_STEWARD_IDS.brokerId)).toBe(true)

    // Each agent answers ONLY its own capability.
    expect(hub.participant(DEFAULT_STEWARD_IDS.agentId)?.capabilities).toEqual([
      DEFAULT_STEWARD_IDS.capability,
    ])
    expect(hub.participant(OPERATOR_STEWARD_IDS.agentId)?.capabilities).toEqual([
      OPERATOR_STEWARD_IDS.capability,
    ])
    expect(hub.participant(DEFAULT_STEWARD_IDS.brokerId)?.capabilities).toEqual([
      DEFAULT_STEWARD_IDS.brokerCapability,
    ])
    expect(hub.participant(OPERATOR_STEWARD_IDS.brokerId)?.capabilities).toEqual([
      OPERATOR_STEWARD_IDS.brokerCapability,
    ])

    // The two id sets share NOTHING — else capability dispatch could cross.
    const memberVals = new Set(Object.values(DEFAULT_STEWARD_IDS))
    for (const v of Object.values(OPERATOR_STEWARD_IDS)) {
      expect(memberVals.has(v)).toBe(false)
    }
  })

  it('routes each plan to its OWN agent (no cross-talk)', async () => {
    const m = await member.plan({ userId: 'u1', instruction: '你好' })
    expect(m.reply).toBe('MEMBER')
    const o = await operator.plan({ userId: 'u1', instruction: '你好' })
    expect(o.reply).toBe('OPERATOR')
  })
})
