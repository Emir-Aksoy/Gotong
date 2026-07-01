/**
 * butler-run-workflow-e2e — Stream-1 S1-M1. The resident butler's BENIGN
 * "run my workflow" toolset, from the security gate up to a real dispatch.
 *
 * A member talking to their butler in IM ("帮我跑今天的每日反思") should be able
 * to kick off ONE of THEIR OWN published, member-facing workflows — scoped to
 * themselves — exactly as if they had clicked "run" in the `/me` web surface.
 *
 * Two layers, matching the two risks:
 *
 *   PART A — the security GATE, exhaustively, with a fake catalog + a capturing
 *   hub. The tool re-implements `/me`'s `evaluateMeSurface`: runnable ONLY when a
 *   workflow is `published` (Phase 15) AND `surface.me.enabled` (Phase 14) AND the
 *   role is allowed; the scope key is FORCE-SET to the caller's own userId and
 *   dropped from the copyable inputs. These are deterministic and cover every
 *   branch (draft / not-member-facing / role-restricted / wrong-id / spoofed
 *   scope / undeclared field).
 *
 *   PART B — the load-bearing seam the fakes can't: a REAL `WorkflowController`
 *   (the host's actual workflow surface) feeding a REAL `PersonalButlerAgent`'s
 *   benign tool, dispatched through a REAL `Hub`. It proves the whole S1-M1 story
 *   — a member TALKS to the butler, the butler runs `run_my_workflow` INLINE (no
 *   park — it's benign), and the run reaches the runner with `case_id` forced to
 *   the caller across every recorded task, the spoofed value nowhere.
 *
 * The LLM is a deterministic provider (no API key); the butler's loop, the benign
 * toolset, per-user memory, and the real dispatch are the real code.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Hub, HumanParticipant, Space, type Logger } from '@aipehub/core'
import { PersonalButlerAgent } from '@aipehub/personal-butler'
import type { LlmProvider, LlmRequest, LlmStreamChunk } from '@aipehub/llm'
import type { MemoryHandle } from '@aipehub/services-sdk'

import {
  buildButlerWorkflowsToolset,
  type ButlerDispatchHub,
  type ButlerWorkflowSummary,
  type ButlerWorkflowSurface,
} from '../src/personal-butler-workflows.js'
import { openButlerMemory } from '../src/personal-butler-memory.js'
import { WorkflowController } from '../src/workflow-controller.js'

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

// ── PART A helpers: a fake catalog + a capturing hub ────────────────────────

type DispatchInput = Parameters<ButlerDispatchHub['dispatch']>[0]

class CapturingHub implements ButlerDispatchHub {
  readonly calls: DispatchInput[] = []
  async dispatch(input: DispatchInput): Promise<unknown> {
    this.calls.push(input)
    return { kind: 'ok' }
  }
}

function surfaceOf(...summaries: ButlerWorkflowSummary[]): ButlerWorkflowSurface {
  return { list: async () => summaries }
}

async function callText(
  toolset: ReturnType<typeof buildButlerWorkflowsToolset>,
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean }> {
  const res = await toolset.callTool(name, args)
  const first = res.content[0] as { text?: string } | undefined
  return { text: first?.text ?? '', isError: res.isError === true }
}

// A published, member-facing daily flow: scope `case_id`, one visible field.
const DAILY: ButlerWorkflowSummary = {
  id: 'daily',
  name: '每日反思',
  triggerCapability: 'daily-reflection',
  state: 'published',
  surfaceMe: {
    enabled: true,
    label: '每日反思',
    inputSchema: [{ id: 'highlights' }, { id: 'case_id' }],
    userScopeField: 'case_id',
  },
}
// Draft (Phase 15): saved but not member-facing yet.
const DRAFT: ButlerWorkflowSummary = {
  id: 'draft-wf',
  triggerCapability: 'draft-cap',
  state: 'draft',
  surfaceMe: { enabled: true, label: '草稿' },
}
// Published but surface.me is off — an internal/admin workflow.
const NOT_ME: ButlerWorkflowSummary = {
  id: 'internal',
  triggerCapability: 'internal-cap',
  state: 'published',
  surfaceMe: { enabled: false },
}
// Published + member-facing but owner-only.
const OWNER_ONLY: ButlerWorkflowSummary = {
  id: 'owner-only',
  triggerCapability: 'owner-cap',
  state: 'published',
  surfaceMe: { enabled: true, label: '仅 owner', allowedRoles: ['owner'] },
}

describe('S1-M1 — butler run-my-workflow gate (fake catalog + capturing hub)', () => {
  it('list_my_workflows shows only runnable workflows for the default member role', async () => {
    const hub = new CapturingHub()
    const t = buildButlerWorkflowsToolset({
      userId: USER,
      workflows: surfaceOf(DAILY, DRAFT, NOT_ME, OWNER_ONLY),
      hub,
      logger: silentLogger,
    })
    const { text } = await callText(t, 'list_my_workflows', {})
    expect(text).toContain('每日反思')
    expect(text).toContain('daily')
    // The draft / non-member-facing / owner-only ones are hidden.
    expect(text).not.toContain('草稿')
    expect(text).not.toContain('internal')
    expect(text).not.toContain('owner-only')
    // Its ONE visible input field (the scope key is dropped from the form).
    expect(text).toContain('highlights')
    expect(text).not.toContain('case_id')
  })

  it('run_my_workflow forces the scope key to the caller, drops spoof + undeclared fields', async () => {
    const hub = new CapturingHub()
    const t = buildButlerWorkflowsToolset({ userId: USER, workflows: surfaceOf(DAILY), hub })
    const { isError } = await callText(t, 'run_my_workflow', {
      workflowId: 'daily',
      inputs: { highlights: '上线了 S1-M1', case_id: 'someone-else', sneaky: 'x' },
    })
    expect(isError).toBe(false)
    expect(hub.calls).toHaveLength(1)
    const call = hub.calls[0]!
    // Dispatched to the workflow's trigger capability, attributed to the member.
    expect(call.strategy).toEqual({ kind: 'capability', capabilities: ['daily-reflection'] })
    expect(call.from).toBe(USER)
    expect(call.origin).toEqual({ orgId: 'local', userId: USER })
    // The one security invariant: scope forced to the caller, spoof ignored.
    expect(call.payload.case_id).toBe(USER)
    // Declared field survives; undeclared field (and the spoofed scope) dropped.
    expect(call.payload.highlights).toBe('上线了 S1-M1')
    expect(call.payload.sneaky).toBeUndefined()
    expect(Object.keys(call.payload).sort()).toEqual(['case_id', 'highlights'])
  })

  it('run_my_workflow refuses a draft workflow and does NOT dispatch', async () => {
    const hub = new CapturingHub()
    const t = buildButlerWorkflowsToolset({ userId: USER, workflows: surfaceOf(DRAFT), hub })
    const { isError } = await callText(t, 'run_my_workflow', { workflowId: 'draft-wf' })
    expect(isError).toBe(true)
    expect(hub.calls).toHaveLength(0)
  })

  it('run_my_workflow refuses a non-member-facing workflow and does NOT dispatch', async () => {
    const hub = new CapturingHub()
    const t = buildButlerWorkflowsToolset({ userId: USER, workflows: surfaceOf(NOT_ME), hub })
    const { isError } = await callText(t, 'run_my_workflow', { workflowId: 'internal' })
    expect(isError).toBe(true)
    expect(hub.calls).toHaveLength(0)
  })

  it('run_my_workflow refuses an owner-only workflow for the default member role', async () => {
    const hub = new CapturingHub()
    const t = buildButlerWorkflowsToolset({ userId: USER, workflows: surfaceOf(OWNER_ONLY), hub })
    const { isError } = await callText(t, 'run_my_workflow', { workflowId: 'owner-only' })
    expect(isError).toBe(true)
    expect(hub.calls).toHaveLength(0)
  })

  it('run_my_workflow refuses an unknown id and a missing id, without dispatching', async () => {
    const hub = new CapturingHub()
    const t = buildButlerWorkflowsToolset({ userId: USER, workflows: surfaceOf(DAILY), hub })
    expect((await callText(t, 'run_my_workflow', { workflowId: 'nope' })).isError).toBe(true)
    expect((await callText(t, 'run_my_workflow', {})).isError).toBe(true)
    expect(hub.calls).toHaveLength(0)
  })
})

// ── PART B: real WorkflowController + real butler + real Hub ─────────────────

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')
const TEMPLATE = join(repoRoot, 'templates', 'workflows', 'daily-reflection-flow.yaml')

// A deterministic provider: on the member's opening message it calls
// `run_my_workflow` with the shipped flow's id + a SPOOFED case_id (to prove the
// tool forces it to the caller). On the tool_result it closes out.
class ButlerRunProvider implements LlmProvider {
  readonly name = 'butler-run-workflow-e2e'
  async *stream(req: LlmRequest): AsyncIterable<LlmStreamChunk> {
    const last = req.messages[req.messages.length - 1]
    const content = last?.content
    if (Array.isArray(content) && content.some((b) => (b as { type?: string }).type === 'tool_result')) {
      yield { type: 'text', text: '好的,已经帮你开始跑了。' }
      yield { type: 'end', stopReason: 'end_turn' }
      return
    }
    yield {
      type: 'tool_use',
      toolUse: {
        type: 'tool_use',
        id: 'run-1',
        name: 'run_my_workflow',
        input: {
          workflowId: 'daily-reflection-flow',
          inputs: { highlights: '上线了 S1-M1', case_id: 'someone-else' },
        },
      },
    }
    yield { type: 'end', stopReason: 'tool_use' }
  }
}

interface Rig {
  root: string
  hub: Hub
  controller: WorkflowController
  memRoot: string
}

async function boot(): Promise<Rig> {
  const root = await mkdtemp(join(tmpdir(), 'aipe-butler-run-wf-'))
  const { space } = await Space.init(root, { name: 'butler-run-wf' })
  const hub = new Hub({ space })
  await hub.start()
  // Downstream target so the runner has somewhere to dispatch `reflect-on-day`
  // (a human participant just parks the sub-task pending — no error noise).
  hub.register(new HumanParticipant({ id: 'reflect-stub', capabilities: ['reflect-on-day'] }))
  // The REAL host workflow surface; import publishes daily-reflection-flow (rev1).
  const controller = new WorkflowController({
    hub,
    definitionsDir: join(root, 'workflows', 'definitions'),
    spaceRoot: root,
  })
  await controller.importFromText(await readFile(TEMPLATE, 'utf8'))
  return { root, hub, controller, memRoot: join(root, 'mem') }
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('S1-M1 — butler run-my-workflow acceptance (real WorkflowController seam)', () => {
  let r: Rig
  beforeEach(async () => {
    r = await boot()
  })
  afterEach(async () => {
    await r.hub.stop().catch(() => {})
    await rm(r.root, { recursive: true, force: true })
  })

  function memFor(userId: string): MemoryHandle {
    return openButlerMemory({ rootDir: r.memRoot, userId, logger: silentLogger })
  }

  function butlerFor(id: string, userId: string): PersonalButlerAgent {
    return new PersonalButlerAgent({
      id,
      provider: new ButlerRunProvider(),
      memory: memFor(userId),
      system: '你是用户的私人管家。',
      benign: [
        buildButlerWorkflowsToolset({
          userId,
          workflows: r.controller,
          hub: r.hub,
          logger: silentLogger,
        }),
      ],
      maxToolRounds: 4,
    })
  }

  it('a member telling the butler to run their daily flow dispatches it scoped to them (no park, no spoof)', async () => {
    const b = butlerFor('butler:u1', USER)
    r.hub.register(b)

    const res = await r.hub.dispatch({
      from: `user:${USER}`,
      strategy: { kind: 'explicit', to: 'butler:u1' },
      payload: '帮我跑今天的每日反思。',
      origin: { orgId: 'local', userId: USER },
    })

    // Benign tool → runs INLINE → the butler turn completes ok (never parks).
    expect(res.kind).toBe('ok')

    // Fire-and-forget: wait for the runner to record the trigger task.
    await waitFor(() =>
      r.hub.tasks().some((t) => {
        const p = t.task.payload as Record<string, unknown> | undefined
        return p !== undefined && typeof p === 'object' && 'case_id' in p
      }),
    )

    // Across every recorded task, case_id is the member's own id and the spoofed
    // value never appears; the declared field survives.
    const payloads = r.hub
      .tasks()
      .map((t) => t.task.payload)
      .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object' && !Array.isArray(p))
    const scoped = payloads.filter((p) => 'case_id' in p)
    expect(scoped.length).toBeGreaterThan(0)
    expect(scoped.every((p) => p.case_id === USER)).toBe(true)
    expect(payloads.every((p) => p.case_id !== 'someone-else')).toBe(true)
    expect(payloads.some((p) => p.highlights === '上线了 S1-M1')).toBe(true)
  })
})
