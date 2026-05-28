/**
 * Phase 13 M3 — POST /api/admin/workflows/assist route tests.
 *
 * The host injects a `WorkflowAssistSurface` (duck-typed) that wraps a
 * registered `WorkflowAssistantAgent`. These tests stub that surface so
 * the web package's tests stay decoupled from the workflow-assistant /
 * llm packages — the host-side wiring is exercised by host tests.
 *
 * Coverage:
 *   - 503 when host did not wire ctx.workflowAssist (disabled / no key)
 *   - 401 when unauthenticated
 *   - 400 on missing / empty description
 *   - 200 happy path forwards { description, contextHints, by:admin.id }
 *     and echoes the surface's output verbatim under `{ ok: true, ... }`
 *   - 500 when surface throws (no_participant / dispatch failure)
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Hub, Space } from '@aipehub/core'

import {
  serveWeb,
  type WebServerHandle,
  type WorkflowAssistSurface,
} from '../src/server.js'

interface BootResult {
  tmp: string
  hub: Hub
  space: Space
  server: WebServerHandle
  baseUrl: string
  adminToken: string
  adminId: string
  assistCalls: Array<Parameters<WorkflowAssistSurface['assist']>[0]>
  /** What the stub returns on success; tests overwrite per case. */
  assistResponse: Awaited<ReturnType<WorkflowAssistSurface['assist']>>
  /** When set, the stub throws this instead of returning. */
  assistThrows: Error | null
}

async function boot(opts: { withAssist: boolean } = { withAssist: true }): Promise<BootResult> {
  const tmp = await mkdtemp(join(tmpdir(), 'aipehub-web-wfassist-'))
  const init = await Space.init(tmp, { name: 'wfassist-test' })
  const space = init.space
  const hub = new Hub({ space })
  await hub.start()
  const { admin, token: adminToken } = await space.createAdmin('TestAdmin')

  const assistCalls: BootResult['assistCalls'] = []
  const out: BootResult = {
    tmp, hub, space,
    server: undefined as unknown as WebServerHandle,
    baseUrl: '',
    adminToken,
    adminId: admin.id,
    assistCalls,
    assistResponse: {
      yaml: 'schema: aipehub.workflow/v1\nworkflow:\n  id: stub\n  trigger:\n    capability: chat\n  steps:\n    - id: a\n      dispatch:\n        strategy: { kind: capability, capabilities: [chat] }\n',
      explanation: 'A stubbed two-line workflow.',
      raw: '```yaml\n...\n```',
      draftStatus: 'valid',
      by: 'mock-provider',
      stopReason: 'end_turn',
    },
    assistThrows: null,
  }

  const stub: WorkflowAssistSurface = {
    async assist(input) {
      assistCalls.push(input)
      if (out.assistThrows) throw out.assistThrows
      return out.assistResponse
    },
  }

  out.server = await serveWeb(hub, {
    host: '127.0.0.1',
    port: 0,
    ...(opts.withAssist ? { workflowAssist: stub } : {}),
  })
  out.baseUrl = out.server.url
  return out
}

async function teardown(b: BootResult): Promise<void> {
  await b.server.close()
  await b.hub.stop()
  await rm(b.tmp, { recursive: true, force: true })
}

describe('POST /api/admin/workflows/assist', () => {
  let b: BootResult
  afterEach(async () => { await teardown(b) })

  it('503 when host did not wire ctx.workflowAssist', async () => {
    b = await boot({ withAssist: false })
    const r = await fetch(`${b.baseUrl}/api/admin/workflows/assist`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${b.adminToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ description: 'anything' }),
    })
    expect(r.status).toBe(503)
    const j = await r.json()
    expect(j.error).toMatch(/assistant not enabled/i)
  })

  it('401 when unauthenticated', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}/api/admin/workflows/assist`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description: 'anything' }),
    })
    expect(r.status).toBe(401)
  })

  it('400 on missing description', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}/api/admin/workflows/assist`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${b.adminToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    })
    expect(r.status).toBe(400)
    const j = await r.json()
    expect(j.error).toMatch(/description/i)
  })

  it('400 on empty / whitespace-only description', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}/api/admin/workflows/assist`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${b.adminToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ description: '   \n  ' }),
    })
    expect(r.status).toBe(400)
  })

  it('200 happy path — forwards inputs + echoes surface output', async () => {
    b = await boot()
    const hints = {
      agents: [{ id: 'writer', capabilities: ['draft'] }],
      existingWorkflowIds: ['x-1'],
    }
    const r = await fetch(`${b.baseUrl}/api/admin/workflows/assist`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${b.adminToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        description: 'crawl 3 news sources, summarize, post',
        contextHints: hints,
      }),
    })
    expect(r.status).toBe(200)
    const j = await r.json()
    expect(j.ok).toBe(true)
    // Echoes the stub's response fields verbatim.
    expect(j.yaml).toContain('schema: aipehub.workflow/v1')
    expect(j.draftStatus).toBe('valid')
    expect(j.explanation).toMatch(/stubbed two-line/)
    expect(j.by).toBe('mock-provider')

    // Stub received the description, hints, and the admin's id as `by`.
    expect(b.assistCalls.length).toBe(1)
    const call = b.assistCalls[0]!
    expect(call.description).toBe('crawl 3 news sources, summarize, post')
    expect(call.contextHints).toEqual(hints)
    expect(call.by).toBe(b.adminId)
  })

  it('200 forwards `invalid` draftStatus + validationError verbatim', async () => {
    b = await boot()
    b.assistResponse = {
      yaml: 'schema: aipehub.workflow/v1\nworkflow: { id: x }',
      explanation: 'Tried.',
      raw: '...',
      draftStatus: 'invalid',
      validationError: "workflow.steps is required (non-empty array)",
    }
    const r = await fetch(`${b.baseUrl}/api/admin/workflows/assist`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${b.adminToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ description: 'broken' }),
    })
    expect(r.status).toBe(200)
    const j = await r.json()
    expect(j.draftStatus).toBe('invalid')
    expect(j.validationError).toMatch(/steps is required/)
  })

  it('200 forwards `no_yaml` cleanly', async () => {
    b = await boot()
    b.assistResponse = {
      yaml: '',
      explanation: "Sorry, I can't help with that.",
      raw: "Sorry, I can't help with that.",
      draftStatus: 'no_yaml',
    }
    const r = await fetch(`${b.baseUrl}/api/admin/workflows/assist`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${b.adminToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ description: 'invent something' }),
    })
    expect(r.status).toBe(200)
    const j = await r.json()
    expect(j.draftStatus).toBe('no_yaml')
    expect(j.yaml).toBe('')
    expect(j.validationError).toBeUndefined()
  })

  it('500 when the surface throws (e.g. no_participant)', async () => {
    b = await boot()
    b.assistThrows = new Error(
      'workflow:assist dispatch failed — no participant for capability workflow:assist',
    )
    const r = await fetch(`${b.baseUrl}/api/admin/workflows/assist`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${b.adminToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ description: 'anything' }),
    })
    expect(r.status).toBe(500)
    const j = await r.json()
    expect(j.error).toMatch(/no participant/i)
  })

  it('omits contextHints when caller did not send any', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}/api/admin/workflows/assist`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${b.adminToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ description: 'no hints' }),
    })
    expect(r.status).toBe(200)
    expect(b.assistCalls.length).toBe(1)
    expect(b.assistCalls[0]!.contextHints).toBeUndefined()
  })

  // ── Phase 13 M4 ────────────────────────────────────────────────

  it('200 forwards deepCheck.ok=true verbatim from the surface', async () => {
    b = await boot()
    b.assistResponse = {
      ...b.assistResponse,
      deepCheck: { ok: true, violations: [] },
    }
    const r = await fetch(`${b.baseUrl}/api/admin/workflows/assist`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${b.adminToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        description: 'with deep check',
        contextHints: { agents: [{ id: 'a', capabilities: ['c'] }] },
      }),
    })
    expect(r.status).toBe(200)
    const j = await r.json()
    expect(j.deepCheck).toEqual({ ok: true, violations: [] })
  })

  it('200 forwards deepCheck.ok=false with violations verbatim', async () => {
    b = await boot()
    b.assistResponse = {
      ...b.assistResponse,
      deepCheck: {
        ok: false,
        violations: [
          {
            kind: 'unknown_capability',
            message: 'no agent satisfies cap "summarize"',
            path: 'workflow.steps[1].dispatch.strategy.capabilities',
          },
          {
            kind: 'id_collision',
            message: "workflow.id 'news-digest' already exists",
            path: 'workflow.id',
          },
        ],
      },
    }
    const r = await fetch(`${b.baseUrl}/api/admin/workflows/assist`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${b.adminToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        description: 'collides',
        contextHints: {
          agents: [{ id: 'a', capabilities: ['c'] }],
          existingWorkflowIds: ['news-digest'],
        },
      }),
    })
    expect(r.status).toBe(200)
    const j = await r.json()
    expect(j.draftStatus).toBe('valid')
    expect(j.deepCheck.ok).toBe(false)
    expect(j.deepCheck.violations).toHaveLength(2)
    expect(j.deepCheck.violations[0].kind).toBe('unknown_capability')
    expect(j.deepCheck.violations[1].kind).toBe('id_collision')
  })

  it('omits deepCheck when surface does not include it', async () => {
    b = await boot()
    // Default assistResponse has no deepCheck — i.e. the host's surface
    // didn't run the check (no contextHints, or yaml was invalid).
    const r = await fetch(`${b.baseUrl}/api/admin/workflows/assist`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${b.adminToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ description: 'no hints' }),
    })
    expect(r.status).toBe(200)
    const j = await r.json()
    expect(j.deepCheck).toBeUndefined()
  })
})
