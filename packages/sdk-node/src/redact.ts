/**
 * Sensitive-string redaction helpers used by the sdk-node Session
 * whenever it builds an Error message from data the Hub controls
 * (notably REJECT.message — see AUDIT-v3.3.md finding H11).
 *
 * The threat model: a misconfigured Hub OR upstream proxy can put the
 * client's own credentials back into an error string (e.g. "apiKey
 * 'sk-...' not recognised"). The sdk-node Session then wraps that
 * string into `new Error(...)`, which downstream apps typically log
 * to Sentry / structured logs / stderr. From there an admin token
 * can leak to whoever has read access to those sinks.
 *
 * Mitigation: every string that crosses the Session->user boundary
 * goes through `redactSecrets()`. It scans for the three concrete
 * patterns we know are credential-shaped today:
 *
 *   1. `sk-...`      — OpenAI / Anthropic / DeepSeek style API keys.
 *      Used by virtually every LLM provider. Required prefix means we
 *      don't fight false positives on prose containing `-` characters.
 *
 *   2. `Bearer ...`  — HTTP `Authorization` header literal. A leaky
 *      proxy can echo this back wholesale. Bounded at "until
 *      whitespace or quoting", same approach the MCP server's
 *      `redactToken` takes.
 *
 *   3. `gotong-...`    — Gotong-issued admin / agent tokens. Same
 *      family of risk as `sk-` but in our own namespace.
 *
 * Anything that DOESN'T match — random opaque IDs, session IDs, IP
 * addresses — passes through unchanged. We deliberately stop short
 * of "redact any 30+ char base64-looking blob" because that hits
 * legitimate context (request IDs, log correlation tokens) and
 * makes error messages useless. The trade is: prefer "missed the
 * leak but kept the diagnostic" over "fully redacted but bricked
 * debugging". Tighten when a new leak vector shows up — never the
 * reverse.
 */

/** Replacement marker used by every redaction site. */
const REDACTED = '<redacted>'

const PATTERNS: ReadonlyArray<RegExp> = [
  // 1. sk-... API keys. The trailing class is permissive (keys can
  // contain `_` / `-` in modern providers). Bounded at first
  // whitespace/quote so we don't eat surrounding prose.
  /sk-[A-Za-z0-9_-]+/g,
  // 2. HTTP Authorization Bearer. Same shape MCP server's
  // redactToken matches — single-source-of-truth a future refactor
  // could consolidate, but for now duplication keeps package
  // boundaries clean.
  /Bearer\s+[^\s'"`{}]+/gi,
  // 3. gotong-... tokens (our own namespace).
  /gotong-[A-Za-z0-9_-]+/g,
]

/**
 * Replace any credential-shaped substring with `<redacted>`. Returns
 * the input unchanged if no pattern matches. Idempotent — running on
 * an already-redacted string is a no-op.
 *
 * Returns the input as-is for non-string values; callers that
 * already narrow at the type level get the strong typing, but
 * defence-in-depth keeps runtime surprises out (e.g. a future caller
 * passing `err.message` where `err` isn't actually an Error).
 */
export function redactSecrets(input: unknown): string {
  if (typeof input !== 'string') return String(input ?? '')
  let out = input
  for (const re of PATTERNS) {
    out = out.replace(re, REDACTED)
  }
  return out
}
