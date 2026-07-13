/**
 * butler-embedder.test.ts — the M-EMB1 opt-in real embedder (host side).
 * Proves the production embedder speaks the OpenAI `/v1/embeddings` wire, aligns
 * vectors to input order, is fail-soft (throws on any anomaly so `fusedRetriever`
 * degrades to keyword), and that env parsing is opt-in + discloses off-box use.
 */
import { describe, expect, it } from 'vitest'

import { httpEmbedder, butlerEmbedderFromEnv, isLocalEmbedderUrl } from '../src/butler-embedder.js'

type Row = { index: number; embedding: number[] }
function mockFetch(
  rows: Row[] | undefined,
  opts?: { ok?: boolean; status?: number },
): { impl: typeof fetch; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return {
      ok: opts?.ok ?? true,
      status: opts?.status ?? 200,
      json: async () => ({ data: rows }),
    } as Response
  }) as unknown as typeof fetch
  return { impl, calls }
}

describe('httpEmbedder — OpenAI /v1/embeddings wire', () => {
  it('POSTs to <base>/embeddings with model + input and returns vectors', async () => {
    const { impl, calls } = mockFetch([
      { index: 0, embedding: [1, 0] },
      { index: 1, embedding: [0, 1] },
    ])
    const embed = httpEmbedder({ baseUrl: 'http://localhost:11434/v1', model: 'nomic-embed-text', fetchImpl: impl })
    const out = await embed(['q', 'a'])
    expect(out).toEqual([
      [1, 0],
      [0, 1],
    ])
    expect(calls[0]!.url).toBe('http://localhost:11434/v1/embeddings')
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ model: 'nomic-embed-text', input: ['q', 'a'] })
  })

  it('trims a trailing slash on the base URL (no double slash)', async () => {
    const { impl, calls } = mockFetch([{ index: 0, embedding: [1] }])
    const embed = httpEmbedder({ baseUrl: 'https://api.openai.com/v1/', model: 'text-embedding-3-small', fetchImpl: impl })
    await embed(['x'])
    expect(calls[0]!.url).toBe('https://api.openai.com/v1/embeddings')
  })

  it('aligns vectors to INPUT order by sorting on the response index', async () => {
    // Response rows scrambled — must come back in input order.
    const { impl } = mockFetch([
      { index: 2, embedding: [3] },
      { index: 0, embedding: [0] },
      { index: 1, embedding: [1] },
    ])
    const embed = httpEmbedder({ baseUrl: 'http://localhost:1234/v1', model: 'm', fetchImpl: impl })
    expect(await embed(['a', 'b', 'c'])).toEqual([[0], [1], [3]])
  })

  it('sends a Bearer key only when configured', async () => {
    const withKey = mockFetch([{ index: 0, embedding: [1] }])
    await httpEmbedder({ baseUrl: 'https://api.openai.com/v1', model: 'm', apiKey: 'sk-x', fetchImpl: withKey.impl })(['q'])
    expect((withKey.calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer sk-x')

    const noKey = mockFetch([{ index: 0, embedding: [1] }])
    await httpEmbedder({ baseUrl: 'http://localhost:11434/v1', model: 'm', fetchImpl: noKey.impl })(['q'])
    expect((noKey.calls[0]!.init.headers as Record<string, string>).authorization).toBeUndefined()
  })

  it('short-circuits on empty input (no fetch)', async () => {
    const { impl, calls } = mockFetch([])
    expect(await httpEmbedder({ baseUrl: 'http://localhost/v1', model: 'm', fetchImpl: impl })([])).toEqual([])
    expect(calls).toHaveLength(0)
  })

  it('fail-soft: throws on non-ok HTTP', async () => {
    const { impl } = mockFetch(undefined, { ok: false, status: 503 })
    await expect(httpEmbedder({ baseUrl: 'http://localhost/v1', model: 'm', fetchImpl: impl })(['q'])).rejects.toThrow(/503/)
  })

  it('fail-soft: throws when the vector count mismatches the input count', async () => {
    const { impl } = mockFetch([{ index: 0, embedding: [1] }]) // 1 vector for 2 inputs
    await expect(httpEmbedder({ baseUrl: 'http://localhost/v1', model: 'm', fetchImpl: impl })(['q', 'a'])).rejects.toThrow(/expected 2/)
  })
})

describe('butlerEmbedderFromEnv — opt-in + off-box disclosure', () => {
  it('returns undefined when unconfigured (⇒ factory keeps local default)', () => {
    expect(butlerEmbedderFromEnv({} as NodeJS.ProcessEnv)).toBeUndefined()
    // URL without MODEL is incomplete → still undefined (byte-identical path).
    expect(butlerEmbedderFromEnv({ GOTONG_BUTLER_EMBEDDER_URL: 'http://localhost/v1' } as NodeJS.ProcessEnv)).toBeUndefined()
  })

  it('a LOCAL endpoint does not leave the box', () => {
    const got = butlerEmbedderFromEnv({
      GOTONG_BUTLER_EMBEDDER_URL: 'http://localhost:11434/v1',
      GOTONG_BUTLER_EMBEDDER_MODEL: 'nomic-embed-text',
    } as NodeJS.ProcessEnv)
    expect(got).toBeDefined()
    expect(got!.dataLeavesBox).toBe(false)
    expect(got!.disclosure).toContain('不离盒')
    expect(typeof got!.embed).toBe('function')
  })

  it('a REMOTE endpoint flags dataLeavesBox + discloses off-box use', () => {
    const got = butlerEmbedderFromEnv({
      GOTONG_BUTLER_EMBEDDER_URL: 'https://api.openai.com/v1',
      GOTONG_BUTLER_EMBEDDER_MODEL: 'text-embedding-3-small',
      GOTONG_BUTLER_EMBEDDER_KEY: 'sk-x',
    } as NodeJS.ProcessEnv)
    expect(got!.dataLeavesBox).toBe(true)
    expect(got!.disclosure).toContain('远程')
    expect(got!.disclosure).toContain('api.openai.com')
  })

  it('isLocalEmbedderUrl classifies loopback hosts', () => {
    expect(isLocalEmbedderUrl('http://localhost:11434/v1')).toBe(true)
    expect(isLocalEmbedderUrl('http://127.0.0.1/v1')).toBe(true)
    expect(isLocalEmbedderUrl('https://api.jina.ai/v1')).toBe(false)
    expect(isLocalEmbedderUrl('not-a-url')).toBe(false)
  })
})
