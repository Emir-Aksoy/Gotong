/**
 * `scrubSecrets` — redact secret-looking substrings from free text WITHOUT
 * needing the literal secret on hand.
 *
 * Why this exists (ease-of-use ❶-M2): a workflow run's failure reason is shown
 * to the member who started it on `/me` (recent runs). That reason wraps the
 * provider's own error string, and a provider error CAN echo the request it
 * rejected — an `Authorization: Bearer <key>` header, or an `api_key=<key>`
 * body. A member must never read another participant's key off a shared run
 * row, so the host scrubs the reason before it crosses the wire.
 *
 * Unlike `scrubKey` (llm-key-test.ts), which removes one KNOWN literal key, the
 * key here is not available at run-summary projection time — so this is
 * pattern-based. The realistic leak vector is the request echo, so the
 * high-precision rules below target exactly that: a `Bearer` token, a
 * vendor-prefixed key (`sk-…`, `xoxb-…`), or a labelled `key/token/secret =
 * value`. A final low-precision rule redacts any bare 40+ char token-shaped run
 * (real keys hit it; short ids / UUIDs don't).
 *
 * The error's human-meaningful WORDS — the HTTP status code, "invalid api key",
 * "quota", "rate limit" — are short English phrases, so none of these rules
 * touch them. That's deliberate: the frontend's `describeError()` classifier
 * keys off exactly those words, and it must keep classifying the scrubbed text.
 */

/** Default cap on the returned length (mirrors `scrubKey`'s 300-char clamp). */
const DEFAULT_MAX_LEN = 300

export function scrubSecrets(text: string | undefined, maxLen = DEFAULT_MAX_LEN): string {
  if (!text) return ''
  let out = String(text)
  // 1) `Bearer <token>` — the Authorization-header echo, scheme kept for context.
  out = out.replace(/\b(Bearer)\s+[A-Za-z0-9._~+/-]{8,}=*/gi, '$1 ***')
  // 2) Vendor-prefixed keys: sk-…, xoxb-…, xapp-…, ghp_…, etc. Prefix + a long
  //    token tail. Keep the prefix so the reader still sees WHICH kind of key.
  out = out.replace(
    /\b((?:sk|xoxb|xapp|xoxp|xoxa|ghp|gho|ghs|pk|rk|aip)[-_])[A-Za-z0-9._-]{12,}/gi,
    '$1***',
  )
  // 3) Labelled secret: `api_key: "<value>"`, `token=<value>`, `secret <value>`,
  //    `authorization: <value>`. Separator class covers `:`, `=`, quotes, space.
  out = out.replace(
    /\b(api[_-]?key|token|secret|authorization|password|passwd)\b(["':=\s]{1,4})[A-Za-z0-9._~+/-]{8,}=*/gi,
    '$1$2***',
  )
  // 4) Last resort: any bare 40+ char token-shaped run. Real API keys land here;
  //    short ids, step/workflow ids and 36-char UUIDs do not. Runs already
  //    redacted by rules 1-3 contain `*` (outside this class) so they're skipped.
  out = out.replace(/[A-Za-z0-9_-]{40,}/g, '***')
  // Redact on the FULL string first (a key near a naive cut could survive as a
  // sub-40 fragment), THEN clamp length.
  return out.slice(0, maxLen)
}
