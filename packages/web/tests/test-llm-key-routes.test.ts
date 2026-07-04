/**
 * ①TC-M1 — "test connection" routes (ease-of-use ①).
 *
 * Two entry points share one duck-typed `llmKeyTest` surface:
 *   - POST /api/setup/test-llm-key  — loopback-only, pre-auth (first-run wizard)
 *   - POST /api/admin/test-llm-key  — admin Bearer (the agent-create form)
 *
 * Driven through a real serveWeb with a STUB surface. The probe itself is
 * covered in host/tests/llm-key-test.test.ts; here we pin gating (loopback /
 * admin / 503-when-absent), body validation, and that the verdict is echoed
 * back to the caller VERBATIM (the UI maps `code` → localized words, so the
 * route must not reshape it).
 *
 * The test's own fetch binds to 127.0.0.1, so it IS loopback — the same
 * property the owner-password / owner-llm-key happy paths rely on.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Hub, Space } from '@gotong/core'

import {
  serveWeb,
  type LlmKeyTestSurface,
  type LlmKeyTestResult,
  type WebServerHandle,
} from '../src/server.js'

interface Boot {
  tmp: string
  hub: Hub
  server: WebServerHandle
  baseUrl: string
  adminToken: string
  calls: Array<{ provider: string; apiKey: string; baseURL?: string; model?: string }>
  reply: LlmKeyTestResult
}

async function boot(opts: { wired?: boolean } = {}): Promise<Boot> {
  const wired = opts.wired ?? true
  const tmp = await mkdtemp(join(tmpdir(), 'gotong-web-test-llm-key-'))
  const init = await Space.init(tmp, { name: 'test-llm-key-route-test' })
  const hub = new Hub({ space: init.space })
  await hub.start()
  const { token: adminToken } = await init.space.createAdmin('TestAdmin')

  const out: Boot = {
    tmp,
    hub,
    server: undefined as unknown as WebServerHandle,
    baseUrl: '',
    adminToken,
    calls: [],
    // Default canned verdict; individual tests can mutate out.reply first.
    reply: { ok: true, model: 'claude-haiku-4-5-20251001', latencyMs: 42 },
  }

  const surface: LlmKeyTestSurface = {
    async testLlmKey(input) {
      out.calls.push({ ...input })
      return out.reply
    },
  }

  out.server = await serveWeb(hub, {
    host: '127.0.0.1',
    port: 0,
    ...(wired ? { llmKeyTest: surface } : {}),
  })
  out.baseUrl = out.server.url
  return out
}

let current: Boot | null = null
afterEach(async () => {
  if (current) {
    await current.server.close()
    await current.hub.stop()
    await rm(current.tmp, { recursive: true, force: true })
    current = null
  }
})

const setupPost = (b: Boot, body: unknown) =>
  fetch(`${b.baseUrl}/api/setup/test-llm-key`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

const adminPost = (b: Boot, body: unknown, withAuth = true) =>
  fetch(`${b.baseUrl}/api/admin/test-llm-key`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(withAuth ? { authorization: `Bearer ${b.adminToken}` } : {}),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

describe('POST /api/setup/test-llm-key (loopback, pre-auth)', () => {
  it('echoes an ok verdict verbatim + forwards the typed key/baseURL/model', async () => {
    const b = (current = await boot())
    b.reply = { ok: true, model: 'deepseek-chat', latencyMs: 311 }
    const r = await setupPost(b, {
      provider: 'openai-compatible',
      apiKey: 'sk-typed-here',
      baseURL: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
    })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ ok: true, model: 'deepseek-chat', latencyMs: 311 })
    expect(b.calls).toEqual([
      { provider: 'openai-compatible', apiKey: 'sk-typed-here', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
    ])
  })

  it('echoes a failure verdict (code) verbatim — never reshapes to a 4xx/5xx', async () => {
    const b = (current = await boot())
    b.reply = { ok: false, model: 'gpt-4o-mini', latencyMs: 88, code: 'invalid_key', message: 'unauthorized' }
    const r = await setupPost(b, { provider: 'openai', apiKey: 'sk-bad' })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ ok: false, model: 'gpt-4o-mini', latencyMs: 88, code: 'invalid_key', message: 'unauthorized' })
  })

  it('surface absent → 503', async () => {
    const b = (current = await boot({ wired: false }))
    const r = await setupPost(b, { provider: 'anthropic', apiKey: 'sk-x' })
    expect(r.status).toBe(503)
    expect(b.calls.length).toBe(0)
  })

  it('garbage body → 400', async () => {
    const b = (current = await boot())
    const r = await setupPost(b, '{not json')
    expect(r.status).toBe(400)
    expect(b.calls.length).toBe(0)
  })

  it('missing provider → 400', async () => {
    const b = (current = await boot())
    const r = await setupPost(b, { apiKey: 'sk-x' })
    expect(r.status).toBe(400)
    expect((await r.json()).error).toMatch(/provider is required/)
  })

  it('blank apiKey → 400', async () => {
    const b = (current = await boot())
    const r = await setupPost(b, { provider: 'anthropic', apiKey: '   ' })
    expect(r.status).toBe(400)
    expect((await r.json()).error).toMatch(/apiKey is required/)
  })
})

describe('POST /api/admin/test-llm-key (admin Bearer)', () => {
  it('no auth → 401, surface never called', async () => {
    const b = (current = await boot())
    const r = await adminPost(b, { provider: 'anthropic', apiKey: 'sk-x' }, false)
    expect(r.status).toBe(401)
    expect(b.calls.length).toBe(0)
  })

  it('admin + surface → 200 echoes verdict verbatim + forwards inputs', async () => {
    const b = (current = await boot())
    b.reply = { ok: false, model: 'gpt-4o-mini', latencyMs: 5, code: 'insufficient_quota' }
    const r = await adminPost(b, { provider: 'openai', apiKey: 'sk-form-key', model: 'gpt-4o-mini' })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ ok: false, model: 'gpt-4o-mini', latencyMs: 5, code: 'insufficient_quota' })
    expect(b.calls).toEqual([{ provider: 'openai', apiKey: 'sk-form-key', baseURL: undefined, model: 'gpt-4o-mini' }])
  })

  it('admin but surface absent → 503', async () => {
    const b = (current = await boot({ wired: false }))
    const r = await adminPost(b, { provider: 'anthropic', apiKey: 'sk-x' })
    expect(r.status).toBe(503)
    expect(b.calls.length).toBe(0)
  })

  it('admin + garbage body → 400', async () => {
    const b = (current = await boot())
    const r = await adminPost(b, '{not json')
    expect(r.status).toBe(400)
  })

  it('admin + missing provider → 400', async () => {
    const b = (current = await boot())
    const r = await adminPost(b, { apiKey: 'sk-x' })
    expect(r.status).toBe(400)
  })

  it('admin + blank apiKey → 400', async () => {
    const b = (current = await boot())
    const r = await adminPost(b, { provider: 'anthropic', apiKey: '  ' })
    expect(r.status).toBe(400)
  })
})
