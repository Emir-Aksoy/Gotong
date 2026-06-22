// LLM key "test connection" service (ease-of-use ①).
//
// The lowest-capability user's most common first-run failure is a key that
// silently doesn't work: pasted into the wrong provider, a typo, an empty
// balance, or a baseURL that points nowhere. They only find out much later,
// when an agent they built returns nothing. This service closes that loop:
// it sends ONE minimal request with the user's own key and turns whatever
// happens into a friendly verdict the UI can show immediately.
//
// Design rules (why, not what):
//   - Construct the SAME provider classes the rest of the host uses
//     (mirror of workflow-assist-agent.ts) so a "pass" here means the real
//     call path will also work — no separate, divergent probe.
//   - Use `provider.stream()` directly and stop after the first chunk. The
//     provider contract says stream() throws synchronously on transport /
//     auth errors (the exact thing we want to catch); `complete()` would
//     swallow those into a text reply with stopReason:'error'.
//   - NEVER log or echo the key. The returned `message` is scrubbed of the
//     key substring as a belt-and-suspenders guard on top of the fact that
//     vendor SDK errors don't embed the key.
//   - Return a stable machine `code`; the web/UI maps it to localized
//     human words. Keeps this module i18n-free and web zero-LLM-dep.

import { AnthropicProvider } from '@aipehub/llm-anthropic'
import { OpenAIProvider } from '@aipehub/llm-openai'
import type { LlmProvider } from '@aipehub/llm'

/** Stable, UI-mappable outcome codes. `ok:true` carries none of these. */
export type LlmKeyTestCode =
  | 'invalid_key' //        401/403 — key wrong / revoked / not for this provider
  | 'insufficient_quota' // 402, or 429 whose body mentions balance/quota
  | 'rate_limited' //       429 without a quota signal — too many requests now
  | 'not_found' //          404 — model id wrong, or baseURL points at nothing
  | 'bad_request' //        400/422 — request shape rejected (rare for a ping)
  | 'network' //            DNS / connection refused / socket — can't reach host
  | 'timeout' //            our own abort fired before any chunk arrived
  | 'upstream' //           5xx — provider is sick; not the user's fault
  | 'unknown' //            anything we couldn't classify

export interface LlmKeyTestInput {
  /** 'anthropic' | 'openai' | 'openai-compatible' | 'deepseek' (alias). */
  provider: string
  apiKey: string
  /** Required for openai-compatible endpoints (DeepSeek/Qwen/Ollama/…). */
  baseURL?: string
  /** Optional explicit model id. When absent we pick a cheap per-provider default. */
  model?: string
}

export interface LlmKeyTestResult {
  ok: boolean
  /** The model id we actually tested against (resolved default included). */
  model: string
  /** Round-trip time to first chunk (or to failure), milliseconds. */
  latencyMs: number
  code?: LlmKeyTestCode
  /** Short, key-scrubbed diagnostic. UI prefers `code`; this aids debugging. */
  message?: string
}

export interface LlmKeyTestOptions {
  /** Injectable clock (tests). */
  now?: () => number
  /** Injectable provider builder (tests) — bypass real SDK construction. */
  buildProvider?: (input: LlmKeyTestInput) => LlmProvider
  /** Abort budget. Generous enough for a cold provider, short enough to not hang a wizard. */
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 15_000

type NormalizedProvider = 'anthropic' | 'openai' | 'openai-compatible'

function normalizeProvider(p: string): NormalizedProvider {
  const v = (p || '').trim().toLowerCase()
  if (v === 'anthropic') return 'anthropic'
  if (v === 'openai') return 'openai'
  // deepseek / qwen / ollama / zhipu / openai-compatible all share the
  // OpenAI-compatible wire format; the only thing that differs is baseURL.
  return 'openai-compatible'
}

/**
 * Cheap, broadly-available default model per provider for a connection probe.
 * A real key has access to these, and they bill near-nothing for a 1-token
 * reply. For openai-compatible we sniff the baseURL for DeepSeek; otherwise
 * we fall back to a common small id and let a 404 honestly report "model not
 * found" if the endpoint disagrees.
 */
function defaultModelFor(provider: NormalizedProvider, baseURL?: string): string {
  switch (provider) {
    case 'anthropic':
      return 'claude-haiku-4-5-20251001'
    case 'openai':
      return 'gpt-4o-mini'
    default:
      if (baseURL && /deepseek/i.test(baseURL)) return 'deepseek-chat'
      return 'gpt-4o-mini'
  }
}

function buildProvider(input: LlmKeyTestInput): LlmProvider {
  const provider = normalizeProvider(input.provider)
  if (provider === 'anthropic') {
    // maxInlineBytes is irrelevant for a plain-text ping — let it default.
    return new AnthropicProvider({ apiKey: input.apiKey })
  }
  return new OpenAIProvider({
    apiKey: input.apiKey,
    ...(input.baseURL ? { baseURL: input.baseURL } : {}),
  })
}

function scrubKey(msg: string, apiKey: string): string {
  let out = (msg || '').slice(0, 300)
  const key = (apiKey || '').trim()
  // Only redact when the key is long enough that a substring match is
  // meaningful (avoids nuking short common tokens).
  if (key.length >= 6 && out.includes(key)) {
    out = out.split(key).join('***')
  }
  return out
}

function classifyKeyError(
  err: unknown,
  apiKey: string,
): { code: LlmKeyTestCode; message: string } {
  const e = (err && typeof err === 'object' ? err : {}) as {
    name?: unknown
    message?: unknown
    code?: unknown
    status?: unknown
    cause?: { name?: unknown; code?: unknown; message?: unknown }
  }
  const name = typeof e.name === 'string' ? e.name : ''
  const status = typeof e.status === 'number' ? e.status : 0
  const rawCode =
    (typeof e.code === 'string' ? e.code : '') ||
    (typeof e.cause?.code === 'string' ? e.cause.code : '')
  const rawMsg = typeof e.message === 'string' ? e.message : String(err ?? '')
  const message = scrubKey(rawMsg, apiKey)

  // Our own abort budget firing, or any deliberate cancel.
  if (
    name === 'AbortError' ||
    e.cause?.name === 'AbortError' ||
    rawCode === 'ABORT_ERR'
  ) {
    return { code: 'timeout', message }
  }

  // Network layer — never reached the provider's HTTP stack. A wrong baseURL
  // (typo, http vs https, no such host) lands here, which is exactly the
  // "provider 选错 / 地址填错" signal we want to surface distinctly from a
  // bad key.
  const netCodes = [
    'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ETIMEDOUT',
    'EPIPE', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT',
  ]
  if (
    netCodes.includes(rawCode) ||
    /fetch failed|socket hang up|getaddrinfo|ENOTFOUND|ECONNREFUSED|other side closed/i.test(rawMsg)
  ) {
    return { code: 'network', message }
  }

  // HTTP status from the vendor SDK error (`.status`).
  if (status === 401 || status === 403) return { code: 'invalid_key', message }
  if (status === 402) return { code: 'insufficient_quota', message }
  if (status === 429) {
    // 429 is overloaded: pure rate-limit OR exhausted balance (DeepSeek,
    // OpenAI free tier, …). Disambiguate on the body when it tells us.
    if (/quota|insufficient|balance|credit|exceeded your current|billing/i.test(rawMsg)) {
      return { code: 'insufficient_quota', message }
    }
    return { code: 'rate_limited', message }
  }
  if (status === 404) return { code: 'not_found', message }
  if (status === 400 || status === 422) return { code: 'bad_request', message }
  if (status >= 500 && status <= 599) return { code: 'upstream', message }

  return { code: 'unknown', message }
}

/**
 * Probe a provider+key with one minimal streamed request. Resolves to a
 * verdict; never throws (all errors are classified into the result).
 */
export async function testLlmKey(
  input: LlmKeyTestInput,
  opts: LlmKeyTestOptions = {},
): Promise<LlmKeyTestResult> {
  const now = opts.now ?? (() => Date.now())
  const make = opts.buildProvider ?? buildProvider
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS

  const apiKey = (input.apiKey || '').trim()
  if (apiKey.length === 0) {
    return { ok: false, model: '', latencyMs: 0, code: 'invalid_key', message: 'apiKey is empty' }
  }

  const provider = make({ ...input, apiKey })
  const model =
    (input.model && input.model.trim()) ||
    defaultModelFor(normalizeProvider(input.provider), input.baseURL)

  const started = now()
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    // The first chunk proves: network reached + key accepted + model exists.
    // That's the whole verdict — drain nothing more (we capped output at 1).
    for await (const _chunk of provider.stream(
      { model, maxTokens: 1, messages: [{ role: 'user', content: 'ping' }] },
      ctrl.signal,
    )) {
      void _chunk
      break
    }
    return { ok: true, model, latencyMs: now() - started }
  } catch (err) {
    const { code, message } = classifyKeyError(err, apiKey)
    return { ok: false, model, latencyMs: now() - started, code, message }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Duck-typed surface handed to `serveWeb({ llmKeyTest })`. Web mirrors this
 * shape structurally so it stays free of any host/llm runtime dependency.
 */
export interface LlmKeyTestSurface {
  testLlmKey(input: LlmKeyTestInput): Promise<LlmKeyTestResult>
}

/** Build the surface the web layer consumes. Always available — no config. */
export function createLlmKeyTestSurface(): LlmKeyTestSurface {
  return { testLlmKey: (input) => testLlmKey(input) }
}
