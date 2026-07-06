/**
 * CARE-M4 — read-only "这把 key 活着吗" probe: GET the provider's models list.
 *
 * Why a SECOND probe next to llm-key-test.ts: that one deliberately streams a
 * 1-token completion ("a pass means the real call path works") and is a MANUAL
 * admin button. The onboarding companion instead runs its check mid-chat,
 * possibly several times while a user fumbles a paste — so this probe must be
 * free by construction: a models-list GET generates nothing and bills no
 * tokens (RES 只读探测姿态). The trade-off is honest: it proves reachability +
 * auth, not that a specific model id completes; the strong probe stays one
 * click away in the admin panel.
 *
 * Failure contract: never throws. `ok:false` carries the RAW error shape
 * (`status`/`message`/`code`) exactly the way `classifyLlmError` reads it, so
 * the caller can hand it straight to the CARE-M1 failure translator instead of
 * inventing a second copy table here. The key never appears in any message —
 * body snippets are truncated and key-scrubbed (llm-key-test's rule).
 */

export interface LlmModelsProbeInput {
  /** 'anthropic' | 'openai' | 'openai-compatible' | vendor aliases (deepseek/…). */
  provider: string
  apiKey: string
  /** Required for openai-compatible endpoints; ignored for anthropic. */
  baseURL?: string
}

export type LlmModelsProbeResult =
  | { ok: true; modelCount: number | undefined; latencyMs: number }
  | { ok: false; error: unknown; latencyMs: number }

export interface LlmModelsProbeOptions {
  /** Injectable fetch (tests). Default: global fetch. */
  fetchImpl?: typeof fetch
  /** Abort budget — generous for a cold provider, short enough for a chat turn. */
  timeoutMs?: number
  /** Injectable clock (tests). */
  now?: () => number
}

const DEFAULT_TIMEOUT_MS = 10_000

function scrubKey(msg: string, apiKey: string): string {
  let out = (msg || '').slice(0, 300)
  const key = (apiKey || '').trim()
  if (key.length >= 6 && out.includes(key)) out = out.split(key).join('***')
  return out
}

/** Build the GET request for the provider family. Anthropic has its own header
 *  scheme; everything else speaks the OpenAI-compatible `/models` + Bearer. */
function buildModelsRequest(input: LlmModelsProbeInput): { url: string; headers: Record<string, string> } {
  const provider = (input.provider || '').trim().toLowerCase()
  if (provider === 'anthropic') {
    const base = (input.baseURL || 'https://api.anthropic.com').replace(/\/+$/, '')
    return {
      url: `${base}/v1/models?limit=100`,
      headers: { 'x-api-key': input.apiKey, 'anthropic-version': '2023-06-01' },
    }
  }
  // openai / deepseek / qwen / ollama / zhipu / openai-compatible: baseURL is
  // conventionally WITH the /v1 segment (same convention the OpenAI SDK and our
  // OpenAIProvider use), so appending `/models` lands on `<base>/models`.
  const base = (input.baseURL || 'https://api.openai.com/v1').replace(/\/+$/, '')
  return { url: `${base}/models`, headers: { Authorization: `Bearer ${input.apiKey}` } }
}

/**
 * Probe the models list with the given credentials. Resolves to a verdict;
 * never throws. A non-2xx becomes `{status, message}` (classifier-ready); a
 * transport throw is passed through raw (its `code`/`name` carry the story).
 */
export async function probeLlmModels(
  input: LlmModelsProbeInput,
  opts: LlmModelsProbeOptions = {},
): Promise<LlmModelsProbeResult> {
  const now = opts.now ?? (() => Date.now())
  const doFetch = opts.fetchImpl ?? fetch
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const apiKey = (input.apiKey || '').trim()
  const started = now()
  if (apiKey.length === 0) {
    return {
      ok: false,
      error: { status: 401, message: 'apiKey is empty' },
      latencyMs: 0,
    }
  }

  const { url, headers } = buildModelsRequest({ ...input, apiKey })
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await doFetch(url, { method: 'GET', headers, signal: ctrl.signal })
    const bodyText = await res.text().catch(() => '')
    if (!res.ok) {
      return {
        ok: false,
        error: { status: res.status, message: scrubKey(bodyText, apiKey) },
        latencyMs: now() - started,
      }
    }
    let modelCount: number | undefined
    try {
      const body = JSON.parse(bodyText) as { data?: unknown }
      if (Array.isArray(body.data)) modelCount = body.data.length
    } catch {
      // A 2xx with an unparseable body still proves reachability + auth —
      // count stays unknown rather than failing a healthy endpoint.
    }
    return { ok: true, modelCount, latencyMs: now() - started }
  } catch (err) {
    // Transport / abort — pass the raw shape through (classifier reads
    // name/code/cause); only the message text needs the key scrub.
    if (err && typeof err === 'object' && typeof (err as { message?: unknown }).message === 'string') {
      const e = err as { message: string }
      e.message = scrubKey(e.message, apiKey)
    }
    return { ok: false, error: err, latencyMs: now() - started }
  } finally {
    clearTimeout(timer)
  }
}
