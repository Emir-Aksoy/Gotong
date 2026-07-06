/**
 * CARE-M1 — classifyLlmError 的表驱动回归。
 *
 * fixture 按真实 SDK 的错误形状造:Anthropic SDK(err.status +
 * err.error.error.type)、OpenAI SDK(err.status + err.error.code +
 * 类名即 name)、undici fetch(TypeError 'fetch failed' + cause.code)、
 * Node net(code 直挂)。分类器是启发式,这张表就是它的行为契约——
 * 任何一行变红都意味着某类用户会拿到错误的大白话。
 */

import { describe, expect, it } from 'vitest'

import { classifyLlmError, llmErrorSummary, type LlmErrorKind } from '../src/index.js'

function sdkError(shape: Record<string, unknown>): Error {
  const err = new Error(String(shape.message ?? 'boom'))
  return Object.assign(err, shape)
}

/** 类名会被 constructor.name 读到——模拟 SDK 的具名错误类。 */
function namedError(name: string, shape: Record<string, unknown> = {}): Error {
  const err = sdkError(shape)
  err.name = name
  return err
}

const TABLE: Array<{ what: string; err: unknown; kind: LlmErrorKind }> = [
  // ---- auth --------------------------------------------------------------
  {
    what: 'Anthropic 401(authentication_error 响应体)',
    err: namedError('AuthenticationError', {
      status: 401,
      error: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } },
    }),
    kind: 'auth',
  },
  {
    what: 'OpenAI 401 Incorrect API key',
    err: namedError('AuthenticationError', {
      status: 401,
      error: { message: 'Incorrect API key provided', type: 'invalid_request_error', code: 'invalid_api_key' },
    }),
    kind: 'auth',
  },
  {
    what: '403 PermissionDenied(key 有效但无权)并入 auth',
    err: namedError('PermissionDeniedError', { status: 403 }),
    kind: 'auth',
  },
  // ---- quota(必须先于 rate_limited / auth 判)---------------------------
  {
    what: 'OpenAI 把额度耗尽装在 429 里(insufficient_quota)',
    err: namedError('RateLimitError', {
      status: 429,
      error: { message: 'You exceeded your current quota, please check your plan and billing details.', code: 'insufficient_quota' },
    }),
    kind: 'quota',
  },
  {
    what: 'DeepSeek 402 Insufficient Balance',
    err: sdkError({ status: 402, message: '402 Insufficient Balance' }),
    kind: 'quota',
  },
  {
    what: 'Anthropic 400 credit balance is too low',
    err: sdkError({
      status: 400,
      message: 'Your credit balance is too low to access the Anthropic API.',
    }),
    kind: 'quota',
  },
  // ---- rate_limited --------------------------------------------------------
  {
    what: '429 RateLimitError(真限流,无 quota 字样)',
    err: namedError('RateLimitError', { status: 429, message: '429 Too Many Requests' }),
    kind: 'rate_limited',
  },
  {
    what: 'Anthropic 529 overloaded_error',
    err: sdkError({
      status: 529,
      message: 'Overloaded',
      error: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
    }),
    kind: 'rate_limited',
  },
  // ---- model_not_found -----------------------------------------------------
  {
    what: 'OpenAI 404 code=model_not_found',
    err: namedError('NotFoundError', {
      status: 404,
      error: { message: "The model 'gpt-99' does not exist", code: 'model_not_found' },
    }),
    kind: 'model_not_found',
  },
  {
    what: "Ollama 404 model 'x' not found",
    err: sdkError({ status: 404, message: "model 'llama9:latest' not found, try pulling it first" }),
    kind: 'model_not_found',
  },
  // ---- network ---------------------------------------------------------------
  {
    what: 'undici fetch failed + cause ECONNREFUSED(本地端点没起)',
    err: Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), { code: 'ECONNREFUSED' }),
    }),
    kind: 'network',
  },
  { what: 'socket hang up', err: sdkError({ message: 'socket hang up', code: 'ECONNRESET' }), kind: 'network' },
  { what: 'DNS 解析失败 ENOTFOUND', err: sdkError({ message: 'getaddrinfo ENOTFOUND api.example.com', code: 'ENOTFOUND' }), kind: 'network' },
  {
    what: '500 InternalServerError(服务端病了,话术同网络不通)',
    err: namedError('InternalServerError', { status: 500, message: '500 Internal Server Error' }),
    kind: 'network',
  },
  // ---- timeout(先于 network 判)------------------------------------------
  {
    what: 'SDK APIConnectionTimeoutError(名字同时像 connection,超时优先)',
    err: namedError('APIConnectionTimeoutError', { message: 'Request timed out.' }),
    kind: 'timeout',
  },
  { what: 'Node ETIMEDOUT', err: sdkError({ message: 'connect ETIMEDOUT 1.2.3.4:443', code: 'ETIMEDOUT' }), kind: 'timeout' },
  { what: 'undici headers timeout', err: sdkError({ message: 'Headers Timeout Error', code: 'UND_ERR_HEADERS_TIMEOUT' }), kind: 'timeout' },
  // ---- unknown(诚实兜底)--------------------------------------------------
  { what: '平平无奇的 Error', err: new Error('something exploded in a novel way'), kind: 'unknown' },
  { what: 'null', err: null, kind: 'unknown' },
  { what: '字符串 throw', err: 'oops', kind: 'unknown' },
  {
    what: '裸 404 无 model 字样(可能是 base URL 配错)不装懂',
    err: sdkError({ status: 404, message: '404 page not found' }),
    kind: 'unknown',
  },
]

describe('classifyLlmError', () => {
  for (const { what, err, kind } of TABLE) {
    it(`${what} → ${kind}`, () => {
      expect(classifyLlmError(err)).toBe(kind)
    })
  }

  it('全部 7 种 kind 都被表覆盖(表本身不许缩水)', () => {
    const covered = new Set(TABLE.map((row) => row.kind))
    for (const kind of ['auth', 'quota', 'rate_limited', 'network', 'model_not_found', 'timeout', 'unknown']) {
      expect(covered.has(kind as LlmErrorKind), `kind ${kind} 没有 fixture`).toBe(true)
    }
  })
})

describe('llmErrorSummary', () => {
  it('Error 带 status:Name (http N): message', () => {
    const s = llmErrorSummary(sdkError({ status: 401, message: 'invalid x-api-key' }))
    expect(s).toContain('http 401')
    expect(s).toContain('invalid x-api-key')
  })

  it('非 Error 值不炸:null / 字符串 / 裸对象', () => {
    expect(llmErrorSummary(null)).toBe('null')
    expect(llmErrorSummary('oops')).toBe('oops')
    expect(llmErrorSummary({ weird: true })).toContain('weird')
  })

  it('超长原文截断到上限', () => {
    const s = llmErrorSummary(new Error('x'.repeat(1000)))
    expect(s.length).toBeLessThanOrEqual(310)
    expect(s.endsWith('…')).toBe(true)
  })
})
