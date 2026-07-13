/**
 * butler-embedder.ts — an opt-in REAL semantic embedder for the butler's fusion
 * recall (M-EMB1). The recall retriever's `fusion.embed` seam (MU-M4's designed
 * but never-wired entry) takes a text→vector function; the DEFAULT is the
 * dependency-free local bigram embedder — a lexical signal that cannot bridge a
 * true synonym (「饮料」↛「珍珠奶茶」, "electric vehicle"↛"Tesla"). This module
 * supplies a real semantic embedder over the OpenAI-compatible `/v1/embeddings`
 * wire, ONE implementation covering both a LOCAL endpoint (Ollama / LM Studio /
 * vLLM — no key, no data leaves the box) and a HOSTED API (OpenAI / Jina /
 * DeepInfra — key + off-box disclosure).
 *
 * Boundaries (the memory track's four, held here):
 *  - hot-path zero LLM: an embedder is NOT a reasoning-path model call — it's a
 *    vector lookup the PURE retriever consumes to rank. No model decides routing.
 *  - opt-in, unset = byte-identical: no env config ⇒ `butlerEmbedderFromEnv`
 *    returns undefined ⇒ the factory keeps `fusion: {}` (local default) ⇒ recall
 *    is byte-for-byte today's.
 *  - data-leaves-box opt-in: a REMOTE base URL sends memory text off-box for
 *    embedding; `dataLeavesBox` + the boot `disclosure` name the host so the
 *    operator sees it (the env-config analogue of the connector panel badge).
 *  - fail-soft: any HTTP / timeout / shape error THROWS, and `fusedRetriever`
 *    catches it to collapse the semantic arm to pure keyword ranking. A
 *    misconfigured embedder degrades recall QUALITY, it never breaks recall.
 *
 * Zero new dependency: native `fetch`, the same choice the LLM providers made.
 */

import type { Embedder } from '@gotong/personal-memory'

export interface HttpEmbedderConfig {
  /** OpenAI-compatible base, e.g. `http://localhost:11434/v1` or `https://api.openai.com/v1`. */
  baseUrl: string
  /** Embeddings model, e.g. `nomic-embed-text` or `text-embedding-3-small`. */
  model: string
  /** Bearer key for hosted APIs; omit for keyless local endpoints. */
  apiKey?: string
  /** Per-batch timeout (ms). Default 10_000. On timeout the embedder throws (fail-soft). */
  timeoutMs?: number
  /** Injectable for tests (defaults to global `fetch`). */
  fetchImpl?: typeof fetch
}

const DEFAULT_TIMEOUT_MS = 10_000

/**
 * Build an {@link Embedder} over the OpenAI `/v1/embeddings` wire. It batches ONE
 * request per `retrieve` call (`[query, ...candidates]`) and returns vectors
 * ALIGNED to input order (sorted by the response `index`, which OpenAI does not
 * strictly promise ordered).
 */
export function httpEmbedder(config: HttpEmbedderConfig): Embedder {
  const url = `${config.baseUrl.replace(/\/+$/, '')}/embeddings`
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const doFetch = config.fetchImpl ?? fetch
  return async (texts) => {
    if (texts.length === 0) return []
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeoutMs)
    try {
      const res = await doFetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
        },
        body: JSON.stringify({ model: config.model, input: [...texts] }),
        signal: ac.signal,
      })
      if (!res.ok) throw new Error(`embeddings HTTP ${res.status}`)
      const json = (await res.json()) as {
        data?: Array<{ index?: number; embedding?: number[] }>
      }
      const rows = json.data
      if (!Array.isArray(rows) || rows.length !== texts.length) {
        throw new Error(`embeddings shape: expected ${texts.length} vectors, got ${rows?.length ?? 0}`)
      }
      // Sort by `index` to guarantee input alignment, then project the vectors.
      return [...rows]
        .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
        .map((r) => {
          if (!Array.isArray(r.embedding)) throw new Error('embeddings shape: row missing embedding')
          return r.embedding
        })
    } finally {
      clearTimeout(timer)
    }
  }
}

/** True when the URL targets the local machine (⇒ no data leaves the box). */
export function isLocalEmbedderUrl(u: string): boolean {
  try {
    const h = new URL(u).hostname.toLowerCase()
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0'
  } catch {
    return false
  }
}

export interface ButlerEmbedder {
  /** The text→vector function to inject as the recall fusion's semantic arm. */
  embed: Embedder
  /** Human-readable boot disclosure — names the endpoint + whether data leaves the box. */
  disclosure: string
  /** True when memory text is sent to a REMOTE host (the `dataLeavesBox` analogue). */
  dataLeavesBox: boolean
}

/**
 * Construct the opt-in butler embedder from env. Returns `undefined` when
 * unconfigured (⇒ the factory keeps the local default, byte-identical). Requires
 * BOTH `GOTONG_BUTLER_EMBEDDER_URL` and `_MODEL`; `_KEY` is optional (hosted
 * APIs need it, local endpoints don't). Pure (no logging / no side effects) so
 * the caller decides how to surface the disclosure.
 */
export function butlerEmbedderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ButlerEmbedder | undefined {
  const baseUrl = (env.GOTONG_BUTLER_EMBEDDER_URL ?? '').trim()
  const model = (env.GOTONG_BUTLER_EMBEDDER_MODEL ?? '').trim()
  if (!baseUrl || !model) return undefined
  const apiKey = (env.GOTONG_BUTLER_EMBEDDER_KEY ?? '').trim() || undefined
  const local = isLocalEmbedderUrl(baseUrl)
  let host = baseUrl
  try {
    host = new URL(baseUrl).host
  } catch {
    /* keep the raw string for the disclosure */
  }
  const disclosure = local
    ? `阿同召回 embedder: ${model} @ ${host}（本地端点 — 记忆文本不离盒）`
    : `阿同召回 embedder: ${model} @ ${host}（远程 — 记忆文本会发往该主机做向量化）`
  return { embed: httpEmbedder({ baseUrl, model, apiKey }), disclosure, dataLeavesBox: !local }
}
