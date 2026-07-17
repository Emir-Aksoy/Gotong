/**
 * LSA-M6 — `gotong model` interactive selector. Everything runs against a
 * scripted ModelIo + a routed fake fetch: no network, no key, no host. The
 * load-bearing assertions:
 *
 *   - full-field echo: the PUT body carries fallbacks / maintenanceModel /
 *     heartbeat / system … verbatim from the export (PUT is a whole-spec
 *     replace — dropping any of them would silently destroy config);
 *   - apiKeyEnv exclusivity: a new key (or endpoint switch) DROPS the env
 *     binding; keep-current keeps it;
 *   - the key never appears in anything written to the terminal;
 *   - inline-mcpServers agents are refused BEFORE any write;
 *   - probe failure + 放弃 leaves the hub untouched (no PUT).
 */

import { describe, expect, it } from 'vitest'

import {
  buildPutBody,
  hasInlineMcpServers,
  listRemoteModels,
  model,
  parseModelArgs,
  type ModelIo,
} from '../src/commands/model.js'

// ── fakes ───────────────────────────────────────────────────────────────────

function fakeIo(lines: string[], secrets: string[] = []) {
  const writes: string[] = []
  const io: ModelIo = {
    read: async () => (lines.length > 0 ? lines.shift()! : null),
    readSecret: async () => (secrets.length > 0 ? secrets.shift()! : null),
    write: (c) => {
      writes.push(c)
    },
    close: () => {},
  }
  return { io, writes }
}

interface Call {
  url: string
  method: string
  headers: Record<string, string>
  body?: Record<string, unknown>
}

type Handler = (call: Call) => { status?: number; json?: unknown } | undefined

function fakeFetch(handler: Handler) {
  const calls: Call[] = []
  const impl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = String(v)
    }
    const call: Call = {
      url,
      method: init?.method ?? 'GET',
      headers,
      ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) as Record<string, unknown> } : {}),
    }
    calls.push(call)
    const rep = handler(call) ?? { status: 404, json: {} }
    const status = rep.status ?? 200
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => rep.json ?? {},
    } as Response
  }) as typeof fetch
  return { impl, calls }
}

/** A realistic exported spec with every echo-sensitive field present. */
function exportedAtong(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'atong',
    capabilities: ['chat'],
    kind: 'llm',
    provider: 'openai-compatible',
    system: '你是阿同',
    baseURL: 'https://old.example/v1',
    model: 'old-model',
    displayName: '阿同',
    fallbacks: [{ provider: 'openai-compatible', baseURL: 'https://mimo.example/v1', model: 'm2' }],
    maintenanceModel: 'cheap-1',
    heartbeat: { enabled: true, intervalMs: 60_000 },
    ...extra,
  }
}

const BASE_FLAGS = ['--url', 'http://hub:3000', '--token', 'tok-admin', '--agent', 'atong']

function hubHandler(opts: {
  exported?: Record<string, unknown>
  probe?: { status?: number; json?: unknown }
  models?: unknown
  agents?: unknown[]
}): Handler {
  return (call) => {
    if (call.url === 'http://hub:3000/api/admin/agents' && call.method === 'GET') {
      return {
        json: {
          agents: opts.agents ?? [
            { id: 'atong', displayName: '阿同', managed: { kind: 'llm' }, online: true },
          ],
        },
      }
    }
    if (call.url === 'http://hub:3000/api/admin/agents/atong/export') {
      return { json: { schema: 'gotong.agent/v1', agent: opts.exported ?? exportedAtong() } }
    }
    if (call.url === 'http://hub:3000/api/admin/test-llm-key' && call.method === 'POST') {
      return opts.probe ?? { json: { ok: true, model: 'probed', latencyMs: 88 } }
    }
    if (call.url === 'http://hub:3000/api/admin/agents/atong' && call.method === 'PUT') {
      return { json: { ok: true } }
    }
    if (call.url.endsWith('/models')) {
      return { json: opts.models ?? { data: [{ id: 'llama-3.3-70b' }, { id: 'qwen-32b' }] } }
    }
    return undefined
  }
}

// ── parseModelArgs ──────────────────────────────────────────────────────────

describe('parseModelArgs', () => {
  it('parses the full flag set and strips trailing slashes off --url', () => {
    expect(parseModelArgs(['--url', 'http://h:3000///', '--token', 't', '--agent', 'a'])).toEqual({
      url: 'http://h:3000',
      token: 't',
      agent: 'a',
    })
  })

  it('defaults --url to localhost:3000', () => {
    expect(parseModelArgs(['--token', 't'])).toEqual({ url: 'http://127.0.0.1:3000', token: 't' })
  })

  it('usage errors and help', () => {
    expect(parseModelArgs([])).toMatch(/--token/)
    expect(parseModelArgs(['--token', 't', '--nope'])).toMatch(/不认识的旗标/)
    expect(parseModelArgs(['--token'])).toMatch(/--token 需要一个值/)
    expect(parseModelArgs(['--url', '--token'])).toMatch(/--url 需要一个值/)
    expect(parseModelArgs(['--help'])).toBe('help')
  })
})

// ── pure halves ─────────────────────────────────────────────────────────────

describe('buildPutBody', () => {
  it('echoes every untouched field, applies the selection, drops kind', () => {
    const { body, droppedApiKeyEnv } = buildPutBody(exportedAtong(), {
      provider: 'openai-compatible',
      baseURL: 'https://api.groq.com/openai/v1',
      providerLabel: 'Groq',
      model: 'llama-3.3-70b',
      apiKey: 'sk-new',
    })
    expect(body.kind).toBeUndefined()
    expect(body).toMatchObject({
      id: 'atong',
      capabilities: ['chat'],
      system: '你是阿同',
      provider: 'openai-compatible',
      baseURL: 'https://api.groq.com/openai/v1',
      providerLabel: 'Groq',
      model: 'llama-3.3-70b',
      apiKey: 'sk-new',
      maintenanceModel: 'cheap-1',
      heartbeat: { enabled: true, intervalMs: 60_000 },
    })
    expect(body.fallbacks).toEqual(exportedAtong().fallbacks)
    expect(droppedApiKeyEnv).toBeUndefined()
  })

  it('switching to a native provider sheds compat-only fields', () => {
    const { body } = buildPutBody(exportedAtong({ providerLabel: 'OldLabel' }), {
      provider: 'anthropic',
      model: 'claude-x',
      apiKey: 'sk-a',
    })
    expect(body.provider).toBe('anthropic')
    expect(body.baseURL).toBeUndefined()
    expect(body.providerLabel).toBeUndefined()
  })

  it('apiKeyEnv: dropped on new key, dropped on endpoint switch, kept otherwise', () => {
    const withEnv = () => exportedAtong({ apiKeyEnv: 'LONGCAT_API_KEY' })
    // new key, same endpoint → the pasted key must win → drop
    const a = buildPutBody(withEnv(), {
      provider: 'openai-compatible',
      baseURL: 'https://old.example/v1',
      model: 'old-model',
      apiKey: 'sk-new',
    })
    expect(a.body.apiKeyEnv).toBeUndefined()
    expect(a.droppedApiKeyEnv).toBe('LONGCAT_API_KEY')
    // endpoint switch, no new key → old wallet vs new endpoint would lie → drop
    const b = buildPutBody(withEnv(), {
      provider: 'openai-compatible',
      baseURL: 'https://other.example/v1',
      model: 'm',
    })
    expect(b.body.apiKeyEnv).toBeUndefined()
    expect(b.droppedApiKeyEnv).toBe('LONGCAT_API_KEY')
    // keep-current (model-only change) → binding stays
    const c = buildPutBody(withEnv(), {
      provider: 'openai-compatible',
      baseURL: 'https://old.example/v1',
      model: 'newer-model',
    })
    expect(c.body.apiKeyEnv).toBe('LONGCAT_API_KEY')
    expect(c.droppedApiKeyEnv).toBeUndefined()
  })

  it('model undefined = leave unset (deletes a previous model)', () => {
    const { body } = buildPutBody(exportedAtong(), {
      provider: 'openai-compatible',
      baseURL: 'https://old.example/v1',
    })
    expect(body.model).toBeUndefined()
    expect(body.apiKey).toBeUndefined()
  })
})

describe('hasInlineMcpServers', () => {
  it('detects inline specs, ignores registry names', () => {
    expect(hasInlineMcpServers({ mcpServers: [{ name: 'x', command: 'y' }] })).toBe(true)
    expect(hasInlineMcpServers({ useMcpServers: ['tavily'] })).toBe(false)
    expect(hasInlineMcpServers({})).toBe(false)
    expect(hasInlineMcpServers({ mcpServers: [] })).toBe(false)
  })
})

describe('listRemoteModels', () => {
  it('openai-compatible joins /models onto a trailing-slash base and sends Bearer', async () => {
    const { impl, calls } = fakeFetch(() => ({
      json: { data: [{ id: 'gemini-2.5-flash' }] },
    }))
    const ids = await listRemoteModels(
      'openai-compatible',
      'https://generativelanguage.googleapis.com/v1beta/openai/',
      'sk-g',
      impl,
    )
    expect(ids).toEqual(['gemini-2.5-flash'])
    expect(calls[0]!.url).toBe('https://generativelanguage.googleapis.com/v1beta/openai/models')
    expect(calls[0]!.headers.authorization).toBe('Bearer sk-g')
  })

  it('anthropic uses x-api-key + anthropic-version', async () => {
    const { impl, calls } = fakeFetch(() => ({ json: { data: [{ id: 'claude-x' }] } }))
    const ids = await listRemoteModels('anthropic', undefined, 'sk-a', impl)
    expect(ids).toEqual(['claude-x'])
    expect(calls[0]!.url).toBe('https://api.anthropic.com/v1/models')
    expect(calls[0]!.headers['x-api-key']).toBe('sk-a')
    expect(calls[0]!.headers['anthropic-version']).toBe('2023-06-01')
    expect(calls[0]!.headers.authorization).toBeUndefined()
  })

  it('non-ok / bad shape / thrown fetch all collapse to null (manual-entry fallback)', async () => {
    const bad = fakeFetch(() => ({ status: 401, json: {} }))
    expect(await listRemoteModels('openai', undefined, 'k', bad.impl)).toBeNull()
    const shape = fakeFetch(() => ({ json: { whatever: 1 } }))
    expect(await listRemoteModels('openai', undefined, 'k', shape.impl)).toBeNull()
    const boom = (async () => {
      throw new Error('net down')
    }) as unknown as typeof fetch
    expect(await listRemoteModels('openai', undefined, 'k', boom)).toBeNull()
  })
})

// ── the interactive flow ────────────────────────────────────────────────────

describe('gotong model (scripted end-to-end)', () => {
  it('happy path: catalog provider → key → live model list → probe → PUT with full echo', async () => {
    const { impl, calls } = fakeFetch(hubHandler({ exported: exportedAtong({ apiKeyEnv: 'OLD_ENV_KEY' }) }))
    const { io, writes } = fakeIo(
      [
        '2', // provider picker: 2 = Groq (catalog order: openrouter, groq, …)
        '1', // model list: pick llama-3.3-70b
      ],
      ['sk-test-123456'],
    )
    const code = await model(BASE_FLAGS, { io, fetchImpl: impl })
    expect(code).toBe(0)

    const put = calls.find((c) => c.method === 'PUT')!
    expect(put.url).toBe('http://hub:3000/api/admin/agents/atong')
    expect(put.headers.authorization).toBe('Bearer tok-admin')
    expect(put.body).toMatchObject({
      id: 'atong',
      provider: 'openai-compatible',
      baseURL: 'https://api.groq.com/openai/v1',
      providerLabel: 'Groq',
      model: 'llama-3.3-70b',
      apiKey: 'sk-test-123456',
      system: '你是阿同',
      maintenanceModel: 'cheap-1',
    })
    expect(put.body!.fallbacks).toEqual(exportedAtong().fallbacks)
    expect(put.body!.kind).toBeUndefined()
    // apiKeyEnv exclusivity: new key → binding dropped and said out loud
    expect(put.body!.apiKeyEnv).toBeUndefined()
    expect(writes.join('')).toContain('OLD_ENV_KEY')

    const probe = calls.find((c) => c.url.endsWith('/test-llm-key'))!
    expect(probe.body).toEqual({
      provider: 'openai-compatible',
      apiKey: 'sk-test-123456',
      baseURL: 'https://api.groq.com/openai/v1',
      model: 'llama-3.3-70b',
    })

    // the models listing hit Groq (not the hub) with the key as a header only
    const list = calls.find((c) => c.url === 'https://api.groq.com/openai/v1/models')!
    expect(list.headers.authorization).toBe('Bearer sk-test-123456')

    // the key never reaches the terminal
    expect(writes.join('')).not.toContain('sk-test-123456')
  })

  it('probe failure + 放弃 leaves the hub untouched (no PUT)', async () => {
    const { impl, calls } = fakeFetch(
      hubHandler({ probe: { json: { ok: false, code: 'invalid_key', message: 'bad key' } } }),
    )
    const { io, writes } = fakeIo(
      [
        '2', // Groq
        '1', // model pick
        '3', // probe-fail menu: 放弃
      ],
      ['sk-bad'],
    )
    const code = await model(BASE_FLAGS, { io, fetchImpl: impl })
    expect(code).toBe(1)
    expect(writes.join('')).toContain('invalid_key')
    expect(writes.join('')).toContain('已取消')
    expect(calls.some((c) => c.method === 'PUT')).toBe(false)
  })

  it('probe failure → 重新贴 key → second probe passes → saved with the NEW key', async () => {
    let probes = 0
    const { impl, calls } = fakeFetch((call) => {
      if (call.url.endsWith('/test-llm-key')) {
        probes += 1
        return probes === 1
          ? { json: { ok: false, code: 'invalid_key', message: 'nope' } }
          : { json: { ok: true, latencyMs: 5 } }
      }
      return hubHandler({})(call)
    })
    const { io } = fakeIo(['2', '1', '2'], ['sk-first', 'sk-second'])
    const code = await model(BASE_FLAGS, { io, fetchImpl: impl })
    expect(code).toBe(0)
    expect(probes).toBe(2)
    expect(calls.find((c) => c.method === 'PUT')!.body!.apiKey).toBe('sk-second')
  })

  it('keep-current (选 0): no key prompts, no probe, apiKeyEnv preserved, model-only PUT', async () => {
    const { impl, calls } = fakeFetch(
      fakeFetchRoute({ exported: exportedAtong({ apiKeyEnv: 'LONGCAT_API_KEY' }) }),
    )
    const { io } = fakeIo([
      '0', // 只换模型
      'newer-model', // manual model entry (no fresh key → no live listing)
    ])
    const code = await model(BASE_FLAGS, { io, fetchImpl: impl })
    expect(code).toBe(0)
    expect(calls.some((c) => c.url.endsWith('/test-llm-key'))).toBe(false)
    expect(calls.some((c) => c.url.endsWith('/models'))).toBe(false)
    const put = calls.find((c) => c.method === 'PUT')!
    expect(put.body).toMatchObject({
      provider: 'openai-compatible',
      baseURL: 'https://old.example/v1',
      model: 'newer-model',
      apiKeyEnv: 'LONGCAT_API_KEY',
    })
    expect(put.body!.apiKey).toBeUndefined()
  })

  it('same-endpoint empty key = keep stored key: no apiKey in PUT, probe skipped', async () => {
    // current spec already points at Groq; user re-picks Groq and just presses enter
    const { impl, calls } = fakeFetch(
      fakeFetchRoute({
        exported: exportedAtong({ baseURL: 'https://api.groq.com/openai/v1', model: 'llama-old' }),
      }),
    )
    const { io, writes } = fakeIo(
      [
        '2', // Groq again (same endpoint as current)
        'llama-new', // manual model entry (stored key never leaves the hub → no live listing)
      ],
      [''], // empty key entry = keep the stored one
    )
    const code = await model(BASE_FLAGS, { io, fetchImpl: impl })
    expect(code).toBe(0)
    expect(calls.some((c) => c.url.endsWith('/test-llm-key'))).toBe(false)
    const put = calls.find((c) => c.method === 'PUT')!
    expect(put.body!.apiKey).toBeUndefined()
    expect(put.body!.model).toBe('llama-new')
    expect(writes.join('')).toContain('跳过探针')
  })

  it('refuses an agent with INLINE mcpServers before any write', async () => {
    const { impl, calls } = fakeFetch(
      fakeFetchRoute({ exported: exportedAtong({ mcpServers: [{ name: 'x', command: 'y' }] }) }),
    )
    const { io, writes } = fakeIo([])
    const code = await model(BASE_FLAGS, { io, fetchImpl: impl })
    expect(code).toBe(1)
    expect(writes.join('')).toContain('内联 mcpServers')
    expect(calls.some((c) => c.method === 'PUT')).toBe(false)
  })

  it('bad token → 认证失败, exit 1', async () => {
    const { impl } = fakeFetch(() => ({ status: 401, json: {} }))
    const { io, writes } = fakeIo([])
    const code = await model(BASE_FLAGS, { io, fetchImpl: impl })
    expect(code).toBe(1)
    expect(writes.join('')).toContain('认证失败')
  })

  it('usage error exits 2; --help exits 0', async () => {
    expect(await model(['--token'])).toBe(2)
    expect(await model(['--help'])).toBe(0)
  })
})

/** hubHandler alias kept close to the tests that tweak only the export. */
function fakeFetchRoute(opts: Parameters<typeof hubHandler>[0]): Handler {
  return hubHandler(opts)
}
