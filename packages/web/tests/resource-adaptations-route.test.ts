/**
 * RES-M4 — GET /api/admin/resources/adaptations (the always-on entrance).
 *
 * The RES-M2 propose engine runs over EVERY managed LLM agent on the hub (not
 * just freshly-imported ones), so the admin can see, any time, "which agents
 * can't run and how to adapt them to this machine". This route is strictly
 * read-only — it only proposes; enacting still goes through the human-approved
 * POST .../adapt (covered by resource-adapt-route.test.ts).
 *
 * These tests pin the route plumbing against a REAL Space + Hub + serveWeb with
 * a duck-typed adaptation surface (the host's real propose logic is unit-tested
 * in host/tests/resource-adaptation.test.ts; here we prove the route gates,
 * hands the surface exactly the managed-LLM agents as {id, provider}, and
 * verbatim-echoes the proposals it returns):
 *
 *   - wired surface → 200, echoes proposals, surface saw every managed agent
 *   - no surface wired → 503 (advisory feature absent, never errors the panel)
 *   - no admin token → 401 (read is admin-gated like the rest of /api/admin)
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Hub, Space } from '@gotong/core'

import {
  serveWeb,
  type ResAdaptationProposal,
  type ResourceAdaptationSurface,
  type WebServerHandle,
} from '../src/server.js'

interface Boot {
  tmp: string
  hub: Hub
  space: Space
  server: WebServerHandle
  baseUrl: string
  token: string
  /** Captures the last `propose` input so a test can assert what the route sent. */
  lastInput: { agents: readonly { id: string; provider: string }[] } | null
}

/** A duck-typed surface that records its input and canned-echoes one applicable
 *  switch_provider proposal per agent — enough to assert the route→surface wire. */
function fakeSurface(sink: { value: Boot['lastInput'] }): ResourceAdaptationSurface {
  return {
    async propose(input) {
      sink.value = { agents: input.agents }
      return input.agents.map<ResAdaptationProposal>((a) => ({
        kind: 'switch_provider',
        id: `adapt:switch_provider:${a.id}:anthropic`,
        title: `switch ${a.id} → anthropic`,
        detail: 'd',
        applicable: true,
        agentId: a.id,
        fromProvider: a.provider,
        toProvider: 'anthropic',
      }))
    },
  }
}

async function boot(opts: { withSurface: boolean }): Promise<Boot> {
  const tmp = await mkdtemp(join(tmpdir(), 'gotong-res-adapts-'))
  const init = await Space.init(tmp, { name: 'res-adapts-test' })
  const space = init.space
  const hub = new Hub({ space })
  await hub.start()
  const { token } = await space.createAdmin('TestAdmin')
  const sink: { value: Boot['lastInput'] } = { value: null }
  const server = await serveWeb(hub, {
    host: '127.0.0.1',
    port: 0,
    ...(opts.withSurface ? { resourceAdaptation: fakeSurface(sink) } : {}),
  })
  return {
    tmp, hub, space, server, baseUrl: server.url, token,
    get lastInput() { return sink.value },
  } as Boot
}

async function teardown(b: Boot): Promise<void> {
  await b.server.close()
  await b.hub.stop()
  await rm(b.tmp, { recursive: true, force: true })
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}`, 'content-type': 'application/json' })

async function createAgent(b: Boot, body: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${b.baseUrl}/api/admin/agents`, {
    method: 'POST',
    headers: auth(b.token),
    body: JSON.stringify(body),
  })
  if (res.status !== 200) throw new Error(`create failed ${res.status}: ${await res.text()}`)
}

const list = (b: Boot, token?: string) =>
  fetch(`${b.baseUrl}/api/admin/resources/adaptations`, {
    headers: token === undefined ? {} : { Authorization: `Bearer ${token}` },
  })

describe('RES-M4 adaptations route', () => {
  it('wired surface → 200, echoes proposals, surface saw every managed agent', async () => {
    const b = await boot({ withSurface: true })
    try {
      await createAgent(b, { id: 'mentor', provider: 'anthropic', system: 's', capabilities: ['chat'] })
      await createAgent(b, {
        id: 'writer', provider: 'openai-compatible', baseURL: 'http://x.test/v1',
        apiKey: 'k', system: 's', capabilities: ['chat'],
      })
      const res = await list(b, b.token)
      expect(res.status).toBe(200)
      const body = await res.json()
      // One proposal per agent, echoed verbatim from the surface.
      const byAgent = new Map<string, ResAdaptationProposal>(
        (body.proposals as ResAdaptationProposal[]).map((p) => [p.agentId!, p]),
      )
      expect(byAgent.get('mentor')?.toProvider).toBe('anthropic')
      expect(byAgent.get('writer')?.fromProvider).toBe('openai-compatible')
      // The route handed the surface exactly the managed-LLM agents as {id, provider}.
      const seen = new Map((b.lastInput?.agents || []).map((a) => [a.id, a.provider]))
      expect(seen.get('mentor')).toBe('anthropic')
      expect(seen.get('writer')).toBe('openai-compatible')
    } finally {
      await teardown(b)
    }
  })

  it('no surface wired → 503 (advisory feature absent)', async () => {
    const b = await boot({ withSurface: false })
    try {
      const res = await list(b, b.token)
      expect(res.status).toBe(503)
    } finally {
      await teardown(b)
    }
  })

  it('no admin token → 401', async () => {
    const b = await boot({ withSurface: true })
    try {
      const res = await list(b) // no Authorization header
      expect(res.status).toBe(401)
    } finally {
      await teardown(b)
    }
  })
})
