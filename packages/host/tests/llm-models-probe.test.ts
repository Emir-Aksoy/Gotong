/**
 * llm-models-probe — CARE-M4 的只读活体校验单元面。
 *
 * 钉三件事:① 每个 provider 家族打对端点/头(anthropic 自有头 scheme,
 * 其余 OpenAI-compatible `/models` + Bearer,baseURL 去尾斜杠);② 失败
 * 形状是 classifyLlmError 直接能吃的 {status,message}(→ CARE-M1 翻译表
 * 一张表管到底,这里绝不长第二张);③ key 永不回显——响应体哪怕原文含
 * key 也要被打码。全程 fake fetch,零网络。
 */

import { describe, expect, it } from 'vitest'

import { classifyLlmError } from '@gotong/llm'

import { probeLlmModels } from '../src/llm-models-probe.js'

function fakeFetch(
  handler: (url: string, init: { headers?: Record<string, string> }) => Response,
): { impl: typeof fetch; calls: { url: string; headers: Record<string, string> }[] } {
  const calls: { url: string; headers: Record<string, string> }[] = []
  const impl = (async (input: unknown, init?: { headers?: Record<string, string> }) => {
    const url = String(input)
    calls.push({ url, headers: init?.headers ?? {} })
    return handler(url, init ?? {})
  }) as unknown as typeof fetch
  return { impl, calls }
}

describe('CARE-M4 — llm-models-probe(只读 GET,零生成)', () => {
  it('anthropic:GET /v1/models,x-api-key + anthropic-version 头,数出模型数', async () => {
    const { impl, calls } = fakeFetch(
      () => new Response(JSON.stringify({ data: [{ id: 'a' }, { id: 'b' }] }), { status: 200 }),
    )
    const res = await probeLlmModels(
      { provider: 'anthropic', apiKey: 'sk-ant-x' },
      { fetchImpl: impl, now: () => 0 },
    )
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.modelCount).toBe(2)
    expect(calls[0]!.url).toBe('https://api.anthropic.com/v1/models?limit=100')
    expect(calls[0]!.headers['x-api-key']).toBe('sk-ant-x')
    expect(calls[0]!.headers['anthropic-version']).toBe('2023-06-01')
  })

  it('openai-compatible:baseURL 去尾斜杠 + Bearer 头', async () => {
    const { impl, calls } = fakeFetch(
      () => new Response(JSON.stringify({ data: [] }), { status: 200 }),
    )
    const res = await probeLlmModels(
      { provider: 'openai-compatible', apiKey: 'sk-x', baseURL: 'https://api.deepseek.com/v1/' },
      { fetchImpl: impl },
    )
    expect(res.ok).toBe(true)
    expect(calls[0]!.url).toBe('https://api.deepseek.com/v1/models')
    expect(calls[0]!.headers['Authorization']).toBe('Bearer sk-x')
  })

  it('401 → {status,message},CARE-M1 分类为 auth,响应体里的 key 被打码', async () => {
    const key = 'sk-secret-123456'
    const { impl } = fakeFetch(
      () => new Response(`Invalid API key ${key} rejected`, { status: 401 }),
    )
    const res = await probeLlmModels({ provider: 'openai', apiKey: key }, { fetchImpl: impl })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      const err = res.error as { status: number; message: string }
      expect(err.status).toBe(401)
      expect(err.message).not.toContain(key)
      expect(err.message).toContain('***')
      expect(classifyLlmError(res.error)).toBe('auth')
    }
  })

  it('402 → 分类为 quota(翻译表会说「余额不够」而不是「稍后再试」)', async () => {
    const { impl } = fakeFetch(() => new Response('Insufficient Balance', { status: 402 }))
    const res = await probeLlmModels({ provider: 'openai-compatible', apiKey: 'k-123456', baseURL: 'https://x.example/v1' }, { fetchImpl: impl })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(classifyLlmError(res.error)).toBe('quota')
  })

  it('传输层 throw 原样透传(code 保留)→ 分类为 network', async () => {
    const boom = Object.assign(new Error('fetch failed'), { code: 'ECONNREFUSED' })
    const impl = (async () => {
      throw boom
    }) as unknown as typeof fetch
    const res = await probeLlmModels({ provider: 'openai', apiKey: 'k-123456' }, { fetchImpl: impl })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(classifyLlmError(res.error)).toBe('network')
  })

  it('空 key 不打网络,直接 401 形状(分类 auth)', async () => {
    let called = 0
    const impl = (async () => {
      called++
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch
    const res = await probeLlmModels({ provider: 'anthropic', apiKey: '   ' }, { fetchImpl: impl })
    expect(res.ok).toBe(false)
    expect(called).toBe(0)
    if (!res.ok) expect(classifyLlmError(res.error)).toBe('auth')
  })

  it('2xx 但响应体不是 JSON:仍算通(连通+认证已证),只是数不出数量', async () => {
    const { impl } = fakeFetch(() => new Response('<html>ok</html>', { status: 200 }))
    const res = await probeLlmModels({ provider: 'openai', apiKey: 'k-123456' }, { fetchImpl: impl })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.modelCount).toBeUndefined()
  })
})
