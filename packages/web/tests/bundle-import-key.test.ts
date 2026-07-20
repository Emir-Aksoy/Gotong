/**
 * Regression: `POST /api/admin/bundles/import` must apply the pasted
 * `apiKey` to EVERY key-taking agent in the bundle — not just the
 * `openai-compatible` ones.
 *
 * The route used to gate on `a.managed.provider === 'openai-compatible'`.
 * That filter was copied verbatim during the route-extraction refactor
 * (c74d327), never a considered policy: the two sibling key-setting
 * paths in the same file (PUT /:id edit, inline create) have no such
 * check. The symptom was a silent one — import returned 200, the agent
 * landed on disk with no key, and the failure surfaced much later as a
 * 401 on first dispatch, far from the paste that caused it.
 *
 * Every shipped bundle happened to be `openai-compatible` (DeepSeek),
 * which is why nothing caught it. Anthropic/OpenAI bundles were broken.
 *
 * `mock` is the one provider with nothing to authenticate, so it stays
 * keyless — pinned here so a future "just set it on everything" edit
 * doesn't start writing junk secrets for mock agents.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Hub, Space } from '@gotong/core'

import { serveWeb, type WebServerHandle } from '../src/server.js'

interface Boot {
  tmp: string
  hub: Hub
  space: Space
  server: WebServerHandle
  baseUrl: string
  token: string
}

async function boot(): Promise<Boot> {
  const tmp = await mkdtemp(join(tmpdir(), 'gotong-bundle-key-'))
  const init = await Space.init(tmp, { name: 'bundle-key-test' })
  const space = init.space
  const hub = new Hub({ space })
  await hub.start()
  const { token } = await space.createAdmin('TestAdmin')
  const server = await serveWeb(hub, { host: '127.0.0.1', port: 0 })
  return { tmp, hub, space, server, baseUrl: server.url, token }
}

async function teardown(b: Boot): Promise<void> {
  await b.server.close()
  await b.hub.stop()
  await rm(b.tmp, { recursive: true, force: true })
}

/** One bundle, one agent per provider family — the whole closed set. */
const MIXED_BUNDLE = `schema: gotong.bundle/v1
bundle:
  name: mixed-providers
  team:
    name: mixed
    agents:
      - id: claude-one
        displayName: Claude One
        capabilities: [chat]
        provider: anthropic
        model: claude-sonnet-5
        system: you are a test agent
      - id: gpt-one
        displayName: GPT One
        capabilities: [chat]
        provider: openai
        model: gpt-5.6
        system: you are a test agent
      - id: compat-one
        displayName: Compat One
        capabilities: [chat]
        provider: openai-compatible
        model: deepseek-chat
        baseURL: https://api.deepseek.com/v1
        system: you are a test agent
      - id: mock-one
        displayName: Mock One
        capabilities: [chat]
        provider: mock
        system: you are a test agent
`

describe('bundles/import: the pasted apiKey reaches every key-taking provider', () => {
  let b: Boot
  beforeEach(async () => { b = await boot() })
  afterEach(async () => { await teardown(b) })

  it('applies one pasted key to anthropic + openai + openai-compatible, and skips mock', async () => {
    const res = await fetch(`${b.baseUrl}/api/admin/bundles/import`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${b.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ yaml: MIXED_BUNDLE, apiKey: 'sk-pasted-once' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.team.created.map((a: { id: string }) => a.id).sort())
      .toEqual(['claude-one', 'compat-one', 'gpt-one', 'mock-one'])

    // The load-bearing assertion: read the keys back off disk. Before the
    // fix, the first two were null.
    expect(await b.space.getAgentApiKey('claude-one')).toBe('sk-pasted-once')
    expect(await b.space.getAgentApiKey('gpt-one')).toBe('sk-pasted-once')
    expect(await b.space.getAgentApiKey('compat-one')).toBe('sk-pasted-once')
    expect(await b.space.getAgentApiKey('mock-one')).toBeNull()
  })

  it('no apiKey in the body → nothing is written for anyone', async () => {
    const res = await fetch(`${b.baseUrl}/api/admin/bundles/import`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${b.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ yaml: MIXED_BUNDLE }),
    })
    expect(res.status).toBe(200)
    for (const id of ['claude-one', 'gpt-one', 'compat-one', 'mock-one']) {
      expect(await b.space.getAgentApiKey(id)).toBeNull()
    }
  })
})
