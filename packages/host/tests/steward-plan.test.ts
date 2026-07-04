/**
 * SW-M3 — `HostStewardService.plan()` over a real Hub.
 *
 * `plan` is the propose half of the steward: build a read-only snapshot of what
 * the member owns → dispatch to the `HubStewardAgent` → classify each proposed
 * action server-side → return a `ClassifiedProposal`. This test wires the real
 * service (real Hub + registered agent) to a scripted `MockLlmProvider` and
 * asserts the three things `plan` is responsible for:
 *
 *   1. the owned-resource snapshot actually reaches the LLM (real ids, the
 *      cross-hub flag, the steward-pickable provider filter);
 *   2. each returned action carries the HOST-computed tier — and the two hard
 *      constraints land: `delete_agent` → dangerous, a cross-hub `edit_workflow`
 *      → cross_hub (the classifier, not the client, decides);
 *   3. a chat-only reply (no JSON) comes back as `{ reply, actions: [] }`, and a
 *      dispatch failure surfaces as a throw.
 *
 * The provider is injected (the `provider` test seam) so we can script the exact
 * proposal — classification + parse correctness already have unit coverage in
 * `@gotong/hub-steward`; this test is about the host wiring around them.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Hub, Space, createLogger } from '@gotong/core'
import { MockLlmProvider, type LlmMessage, type LlmRequest } from '@gotong/llm'

import {
  createHubStewardService,
  summarizeStewardAction,
  type HubStewardSurface,
  type StewardAgentDirectory,
  type StewardWorkflowDirectory,
} from '../src/hub-steward-service.js'

const USER = 'u1'

/** One owned agent + a provider list whose `openai-compatible` must be filtered.
 * The write verbs (create/update/remove) are part of the widened directory but
 * unused by `plan`, so they throw if a plan test ever reaches them. */
function fakeAgentDir(): StewardAgentDirectory {
  return {
    async listOwned(userId) {
      return [
        {
          id: `me.${userId}.summarizer`,
          label: '邮件总结助手',
          capabilities: ['summarize'],
          provider: 'anthropic',
        },
      ]
    },
    async availableProviders() {
      // `openai-compatible` is operator infra (needs a baseURL), not a
      // steward-pickable provider — the service must drop it from the snapshot.
      return ['anthropic', 'mock', 'openai-compatible']
    },
    async create() {
      throw new Error('create not exercised by plan tests')
    },
    async update() {
      throw new Error('update not exercised by plan tests')
    },
    async remove() {
      throw new Error('remove not exercised by plan tests')
    },
  }
}

/** One purely-local workflow + one cross-hub workflow (drives the tier split). */
function fakeWorkflowDir(): StewardWorkflowDirectory {
  return {
    async listForUser() {
      return [
        { id: 'local-wf', name: '本地工作流', crossHub: false },
        { id: 'xhub-wf', name: '跨 hub 工作流', crossHub: true },
      ]
    },
  }
}

function userText(req: LlmRequest): string {
  return req.messages
    .filter((m: LlmMessage) => m.role === 'user')
    .map((m) => (typeof m.content === 'string' ? m.content : ''))
    .join('\n')
}

interface Bench {
  root: string
  hub: Hub
  surface: HubStewardSurface
  lastReq(): LlmRequest | undefined
}

async function boot(): Promise<Bench> {
  const root = await mkdtemp(join(tmpdir(), 'gotong-steward-plan-'))
  const { space } = await Space.init(root, { name: 'steward-plan-test' })
  const hub = new Hub({ space })
  await hub.start()

  let captured: LlmRequest | undefined
  const provider = new MockLlmProvider({
    // Several chunks so the per-call streaming sink has something to deliver.
    textChunkCount: 4,
    reply: (req) => {
      captured = req
      // A chat-only path: no JSON → the steward "just chatted".
      if (userText(req).includes('CHATONLY')) return '我不太确定你想改什么,能再说具体点吗?'
      // Otherwise a fixed five-action proposal spanning every tier outcome.
      return JSON.stringify({
        reply: '好的,我准备了这些动作让你确认。',
        actions: [
          {
            kind: 'create_agent',
            handle: 'mailer',
            label: '邮件助手',
            provider: 'anthropic',
            system: '你负责把邮件总结成要点。',
            capabilities: ['summarize'],
          },
          { kind: 'delete_agent', agentId: `me.${USER}.summarizer` },
          { kind: 'edit_workflow', workflowId: 'local-wf', instruction: '语气更礼貌些' },
          { kind: 'edit_workflow', workflowId: 'xhub-wf', instruction: '只改本地那一步' },
          { kind: 'inspect', answer: '你现在有 1 个助手。' },
        ],
      })
    },
  })

  const surface = createHubStewardService({
    hub,
    config: { provider: 'mock' },
    agents: fakeAgentDir(),
    workflows: fakeWorkflowDir(),
    // The editor is unused by plan; a throwing stub satisfies the required dep.
    workflowEditor: {
      async edit() {
        throw new Error('workflowEditor.edit not exercised by plan tests')
      },
    },
    logger: createLogger('test-steward'),
    provider, // test seam — bypass env/key, use the scripted mock
  })
  if (!surface) throw new Error('createHubStewardService returned null (expected a surface)')

  return { root, hub, surface, lastReq: () => captured }
}

describe('SW-M3 — hub steward plan()', () => {
  let b: Bench
  beforeEach(async () => {
    b = await boot()
  })
  afterEach(async () => {
    await b.hub.stop()
    await rm(b.root, { recursive: true, force: true })
  })

  it('classifies each proposed action server-side (delete=dangerous, cross-hub edit=cross_hub)', async () => {
    const proposal = await b.surface.plan({
      userId: USER,
      instruction: '帮我建个邮件助手,删掉旧的总结助手,再改两个工作流',
    })

    expect(proposal.reply).toBe('好的,我准备了这些动作让你确认。')

    // The host — not the client — assigns the tier. The two hard constraints
    // live here: delete_agent → dangerous, the cross-hub workflow → cross_hub.
    const tiers = proposal.actions.map((a) => `${a.action.kind}:${a.tier}`)
    expect(tiers).toEqual([
      'create_agent:safe',
      'delete_agent:dangerous',
      'edit_workflow:safe', // local-wf — purely local
      'edit_workflow:cross_hub', // xhub-wf — leaves the hub
      'inspect:safe',
    ])

    // Every action carries a member-readable summary (matches the pure helper).
    for (const a of proposal.actions) {
      expect(a.summary.length).toBeGreaterThan(0)
      expect(a.summary).toBe(summarizeStewardAction(a.action))
    }
  })

  it('injects the owned-resource snapshot into the LLM request (real ids, cross-hub flag, filtered providers)', async () => {
    await b.surface.plan({ userId: USER, instruction: '看看我现在有什么' })

    const req = b.lastReq()
    expect(req).toBeDefined()
    const msg = userText(req!)

    // Real owned-agent id (not a hallucinated one).
    expect(msg).toContain(`me.${USER}.summarizer`)
    // Both workflows, with the cross-hub one flagged for the model.
    expect(msg).toContain('local-wf')
    expect(msg).toContain('xhub-wf')
    expect(msg).toMatch(/xhub-wf[^\n]*\[CROSS-HUB/)
    expect(msg).not.toMatch(/local-wf[^\n]*\[CROSS-HUB/)
    // Providers narrowed to the steward-pickable set — `openai-compatible` dropped.
    expect(msg).toContain('Providers you can use: anthropic, mock')
    expect(msg).not.toContain('openai-compatible')
  })

  it('returns an empty action list when the steward just chats (no JSON)', async () => {
    const proposal = await b.surface.plan({ userId: USER, instruction: 'CHATONLY' })
    expect(proposal.reply).toContain('能再说具体点')
    expect(proposal.actions).toEqual([])
  })

  it('streams chunks to a per-call sink without breaking the plan', async () => {
    const chunks: string[] = []
    const proposal = await b.surface.plan({
      userId: USER,
      instruction: '建个助手',
      onChunk: (c) => chunks.push(c),
    })
    // The proposal still resolves normally...
    expect(proposal.actions[0]?.action.kind).toBe('create_agent')
    // ...and the sink saw the streamed reply (concatenation reproduces the JSON,
    // so the steward's `reply` field is in there).
    expect(chunks.length).toBeGreaterThan(0)
    expect(chunks.join('')).toContain('我准备了这些动作')
  })

  it('throws when the dispatch fails (e.g. an empty instruction the agent rejects)', async () => {
    // The agent's buildRequest rejects a blank instruction → the dispatch
    // resolves `failed` → plan surfaces it as a throw for the web layer to map.
    await expect(b.surface.plan({ userId: USER, instruction: '   ' })).rejects.toThrow(
      /hub:steward dispatch failed/,
    )
  })
})
