/**
 * EXCH-M1 — `gotong.envelope/v1` pure core: parse/validate, sign/verify, and
 * result assembly for the standard exchange envelope (docs/zh/EXCHANGE-ENVELOPE.md §3).
 *
 * ZERO I/O by design — no fs / net / env reads — so every rule is unit-testable
 * byte-for-byte. The file-first archive + dispatch live in me-exchange-service.ts.
 * The JSON Schema copy beside this file (gotong.envelope.v1.schema.json) is the
 * cross-pack truth source; a test pins the constants here to that file so the
 * hand-written validator and the schema text cannot drift apart.
 *
 * Validator posture (panel-schema mirror): fail-closed — unknown keys reject,
 * hostile control/bidi characters in display fields reject (spoofing raw
 * material), size caps reject BEFORE parse (a 300MB file must not reach
 * JSON.parse). Errors are COLLECTED (≤ EXCHANGE_MAX_ERRORS) so a host-agent
 * pack's model can self-correct in one round instead of whack-a-mole.
 *
 * Signature (advisory, 发现≠信任): ES256 over the JCS (RFC 8785) UTF-8 bytes of
 * the envelope WITHOUT its `sig` key. `sig.jwk` carries the public key so any
 * receiver can verify OFFLINE; the kid is RECOMPUTED from that jwk (RFC 7638)
 * and must equal both `sig.kid` and `from.kid` — the lying-JWK defense
 * (STD-M2b-1): never trust a label, only the fingerprint of the key that
 * actually verified. A valid signature proves integrity + key binding, never
 * sender identity — that stays with the human relay (or a future kid PIN).
 * Envelopes with no `sig` are fully legal (the human hop has human eyes).
 */

import { createPublicKey, randomBytes, verify as cryptoVerify } from 'node:crypto'
import { ecThumbprint, jcsCanonicalize, type AgentCardSigner } from '@gotong/a2a'

// ─── Wire shapes ─────────────────────────────────────────────────────────────

export const ENVELOPE_SCHEMA_V1 = 'gotong.envelope/v1'

export interface EnvelopeFrom {
  name: string
  hub?: string
  kid?: string
}

export interface EnvelopeTo {
  name: string
}

export interface EnvelopeJwk {
  kty: 'EC'
  crv: 'P-256'
  x: string
  y: string
}

export interface EnvelopeSig {
  alg: 'ES256'
  kid: string
  jwk: EnvelopeJwk
  signature: string
}

export interface ExchangeEnvelope {
  schema: typeof ENVELOPE_SCHEMA_V1
  id: string
  kind: 'request' | 'result'
  replyTo?: string
  createdAt: string
  from: EnvelopeFrom
  to?: EnvelopeTo
  capability?: string
  title: string
  payload: Record<string, unknown>
  sig?: EnvelopeSig
}

// ─── Constants (pinned to gotong.envelope.v1.schema.json by a test) ──────────

/** Exchange id — the idempotency key; the filename MUST be `<id>.json`. The
 * charset is deliberately filename-safe (lowercase alnum + dash, no dots, no
 * separators), so a validated id can be used as a path segment with no further
 * escaping — the regex IS the traversal guard. */
export const ENVELOPE_ID_RE = /^exg-[a-z0-9][a-z0-9-]{7,59}$/
/** Capability name — same grammar the hub dispatch layer uses. */
export const ENVELOPE_CAPABILITY_RE = /^[a-z][a-z0-9._-]{1,63}$/
/** RFC 7638 thumbprint / P-256 coordinate: exactly 43 base64url chars. */
export const ENVELOPE_KID_RE = /^[A-Za-z0-9_-]{43}$/
/** ES256 ieee-p1363 signature: 64 raw bytes = exactly 86 base64url chars. */
export const ENVELOPE_SIGNATURE_RE = /^[A-Za-z0-9_-]{86}$/
/** ISO-8601 UTC with mandatory Z — display-honest, never a timing judgment. */
export const ENVELOPE_CREATED_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/

/** Whole file ceiling — IM file-forwarding friendly, and a DoS floor: bigger
 * input is refused before JSON.parse ever runs. */
export const ENVELOPE_MAX_FILE_BYTES = 256 * 1024
/** Serialized payload ceiling (compact JSON bytes). */
export const ENVELOPE_MAX_PAYLOAD_BYTES = 200 * 1024
export const ENVELOPE_MAX_TITLE_CHARS = 200
export const ENVELOPE_MAX_NAME_CHARS = 120
export const ENVELOPE_MAX_HUB_CHARS = 200
/** Collected-error ceiling — one round of feedback, not a firehose. */
export const EXCHANGE_MAX_ERRORS = 20

const TOP_KEYS = new Set(['schema', 'id', 'kind', 'replyTo', 'createdAt', 'from', 'to', 'capability', 'title', 'payload', 'sig'])
const FROM_KEYS = new Set(['name', 'hub', 'kid'])
const TO_KEYS = new Set(['name'])
const SIG_KEYS = new Set(['alg', 'kid', 'jwk', 'signature'])
const JWK_KEYS = new Set(['kty', 'crv', 'x', 'y'])
const RESULT_PAYLOAD_KEYS = new Set(['ok', 'output', 'error'])

// ─── Small helpers ───────────────────────────────────────────────────────────

/** Plain-object check that pins the prototype (SDUI Codex precedent): a
 * constructed object smuggling a prototype chain is rejected, not walked. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

/**
 * Display fields travel verbatim into the import-confirm page (and into other
 * hosts' UIs). Control chars and bidi overrides are the raw material of
 * content spoofing — reject, don't strip. Character-level on purpose (no
 * regex literal): a `\uXXXX` class once rotted into raw bytes via the Edit
 * tool; per-char code checks cannot (me-panel-surface precedent). Display
 * fields are single-line, so newline/tab are hostile here too.
 */
function hostileDisplayText(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) return true
    if (code >= 0x202a && code <= 0x202e) return true
    if (code >= 0x2066 && code <= 0x2069) return true
  }
  return false
}

/** Clip to `max` UTF-16 code units without splitting a surrogate pair. */
function clipText(s: string, max: number): string {
  if (s.length <= max) return s
  let out = s.slice(0, max)
  const last = out.charCodeAt(out.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1)
  return out
}

// ─── Parse + validate (fail-closed, collected errors) ────────────────────────

export interface EnvelopeParseOk {
  ok: true
  envelope: ExchangeEnvelope
  /** UTF-8 byte length of the raw input (what the 256KB cap measured). */
  bytes: number
}
export interface EnvelopeParseErr {
  ok: false
  errors: string[]
}
export type EnvelopeParseResult = EnvelopeParseOk | EnvelopeParseErr

/**
 * Parse + validate one envelope file's text. Never throws. On failure the
 * errors array is the machine-readable feedback a pack's model self-corrects
 * against — each entry is `<path>: <rule>`.
 */
export function parseExchangeEnvelope(raw: string): EnvelopeParseResult {
  const bytes = Buffer.byteLength(raw, 'utf8')
  if (bytes > ENVELOPE_MAX_FILE_BYTES) {
    return { ok: false, errors: [`file: ${bytes} bytes exceeds the ${ENVELOPE_MAX_FILE_BYTES} byte limit`] }
  }
  // Tolerate a UTF-8 BOM (Windows editors / IM download paths add one);
  // JSON.parse would otherwise reject the whole file on an invisible char.
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return { ok: false, errors: [`file: not valid JSON (${err instanceof Error ? err.message : String(err)})`] }
  }
  if (!isPlainObject(parsed)) {
    return { ok: false, errors: ['file: top level must be a JSON object'] }
  }

  const errors: string[] = []
  let truncated = false
  const fail = (msg: string): void => {
    if (errors.length >= EXCHANGE_MAX_ERRORS) {
      truncated = true
      return
    }
    errors.push(msg)
  }

  // schema — the version-negotiation anchor. A reader NEVER guesses a newer
  // schema (SHELL-M3 posture): honest whole-file rejection beats a half-
  // understood envelope.
  const schema = parsed.schema
  if (schema !== ENVELOPE_SCHEMA_V1) {
    if (typeof schema === 'string' && schema.startsWith('gotong.envelope/')) {
      return { ok: false, errors: [`schema: unknown version '${schema}' — this reader only understands ${ENVELOPE_SCHEMA_V1} and will not guess a newer schema`] }
    }
    fail(`schema: must be the string '${ENVELOPE_SCHEMA_V1}'`)
  }

  for (const key of Object.keys(parsed)) {
    if (!TOP_KEYS.has(key)) fail(`${key}: unknown key (fail-closed: v1 rejects keys it does not understand)`)
  }

  const id = parsed.id
  if (typeof id !== 'string' || !ENVELOPE_ID_RE.test(id)) {
    fail(`id: must match ${String(ENVELOPE_ID_RE)}`)
  }

  const kind = parsed.kind
  if (kind !== 'request' && kind !== 'result') {
    fail(`kind: must be 'request' or 'result'`)
  }

  const replyTo = parsed.replyTo
  if (kind === 'result') {
    if (typeof replyTo !== 'string' || !ENVELOPE_ID_RE.test(replyTo)) {
      fail(`replyTo: required on a result and must match ${String(ENVELOPE_ID_RE)}`)
    }
  } else if (replyTo !== undefined) {
    fail('replyTo: only a result carries replyTo')
  }

  const createdAt = parsed.createdAt
  if (typeof createdAt !== 'string' || !ENVELOPE_CREATED_AT_RE.test(createdAt) || Number.isNaN(Date.parse(createdAt))) {
    fail(`createdAt: must be ISO-8601 UTC ending in Z (e.g. 2026-08-14T02:00:00Z)`)
  }

  const from = parsed.from
  if (!isPlainObject(from)) {
    fail('from: required object { name, hub?, kid? }')
  } else {
    for (const key of Object.keys(from)) {
      if (!FROM_KEYS.has(key)) fail(`from.${key}: unknown key`)
    }
    const name = from.name
    if (typeof name !== 'string' || name.length < 1 || name.length > ENVELOPE_MAX_NAME_CHARS) {
      fail(`from.name: required string of 1..${ENVELOPE_MAX_NAME_CHARS} chars`)
    } else if (hostileDisplayText(name)) {
      fail('from.name: control or bidi-override characters are not allowed')
    }
    const hub = from.hub
    if (hub !== undefined) {
      if (typeof hub !== 'string' || hub.length < 1 || hub.length > ENVELOPE_MAX_HUB_CHARS) {
        fail(`from.hub: must be a string of 1..${ENVELOPE_MAX_HUB_CHARS} chars when present`)
      } else if (hostileDisplayText(hub)) {
        fail('from.hub: control or bidi-override characters are not allowed')
      }
    }
    const kid = from.kid
    if (kid !== undefined && (typeof kid !== 'string' || !ENVELOPE_KID_RE.test(kid))) {
      fail('from.kid: must be a 43-char base64url RFC 7638 thumbprint when present')
    }
  }

  const to = parsed.to
  if (to !== undefined) {
    if (!isPlainObject(to)) {
      fail('to: must be an object { name } when present')
    } else {
      for (const key of Object.keys(to)) {
        if (!TO_KEYS.has(key)) fail(`to.${key}: unknown key`)
      }
      const name = to.name
      if (typeof name !== 'string' || name.length < 1 || name.length > ENVELOPE_MAX_NAME_CHARS) {
        fail(`to.name: required string of 1..${ENVELOPE_MAX_NAME_CHARS} chars`)
      } else if (hostileDisplayText(name)) {
        fail('to.name: control or bidi-override characters are not allowed')
      }
    }
  }

  const capability = parsed.capability
  if (capability !== undefined && (typeof capability !== 'string' || !ENVELOPE_CAPABILITY_RE.test(capability))) {
    fail(`capability: must match ${String(ENVELOPE_CAPABILITY_RE)} when present`)
  }

  const title = parsed.title
  if (typeof title !== 'string' || title.length < 1 || title.length > ENVELOPE_MAX_TITLE_CHARS) {
    fail(`title: required string of 1..${ENVELOPE_MAX_TITLE_CHARS} chars`)
  } else if (hostileDisplayText(title)) {
    fail('title: control or bidi-override characters are not allowed')
  }

  const payload = parsed.payload
  if (!isPlainObject(payload)) {
    fail('payload: required JSON object')
  } else {
    const payloadBytes = Buffer.byteLength(JSON.stringify(payload), 'utf8')
    if (payloadBytes > ENVELOPE_MAX_PAYLOAD_BYTES) {
      fail(`payload: ${payloadBytes} serialized bytes exceeds the ${ENVELOPE_MAX_PAYLOAD_BYTES} byte limit`)
    }
    if (kind === 'result') {
      // A result payload's three-key shape IS structure, not free data:
      // downstream packs branch on `ok` and render `output`/`error`.
      for (const key of Object.keys(payload)) {
        if (!RESULT_PAYLOAD_KEYS.has(key)) fail(`payload.${key}: a result payload only carries { ok, output?, error? }`)
      }
      if (typeof payload.ok !== 'boolean') fail('payload.ok: required boolean on a result')
      if (payload.error !== undefined && typeof payload.error !== 'string') fail('payload.error: must be a string when present')
    }
  }

  const sig = parsed.sig
  if (sig !== undefined) {
    if (!isPlainObject(sig)) {
      fail('sig: must be an object { alg, kid, jwk, signature } when present')
    } else {
      for (const key of Object.keys(sig)) {
        if (!SIG_KEYS.has(key)) fail(`sig.${key}: unknown key`)
      }
      if (sig.alg !== 'ES256') fail(`sig.alg: must be 'ES256'`)
      if (typeof sig.kid !== 'string' || !ENVELOPE_KID_RE.test(sig.kid)) {
        fail('sig.kid: must be a 43-char base64url RFC 7638 thumbprint')
      }
      const jwk = sig.jwk
      if (!isPlainObject(jwk)) {
        fail('sig.jwk: required object { kty:EC, crv:P-256, x, y } — a signature without its public key is unverifiable by everyone')
      } else {
        for (const key of Object.keys(jwk)) {
          if (!JWK_KEYS.has(key)) fail(`sig.jwk.${key}: unknown key`)
        }
        if (jwk.kty !== 'EC') fail(`sig.jwk.kty: must be 'EC'`)
        if (jwk.crv !== 'P-256') fail(`sig.jwk.crv: must be 'P-256'`)
        if (typeof jwk.x !== 'string' || !ENVELOPE_KID_RE.test(jwk.x)) fail('sig.jwk.x: must be a 43-char base64url P-256 coordinate')
        if (typeof jwk.y !== 'string' || !ENVELOPE_KID_RE.test(jwk.y)) fail('sig.jwk.y: must be a 43-char base64url P-256 coordinate')
      }
      if (typeof sig.signature !== 'string' || !ENVELOPE_SIGNATURE_RE.test(sig.signature)) {
        fail('sig.signature: must be 86 base64url chars (ES256 ieee-p1363, 64 raw bytes)')
      }
      // Structural kid consistency; the cryptographic half (thumbprint
      // recomputed from the jwk) lives in verifyExchangeEnvelope.
      const fromKid = isPlainObject(from) ? from.kid : undefined
      if (fromKid === undefined) {
        fail('from.kid: required when sig is present')
      } else if (typeof sig.kid === 'string' && ENVELOPE_KID_RE.test(sig.kid) && sig.kid !== fromKid) {
        fail('sig.kid: must equal from.kid')
      }
    }
  }

  if (truncated) errors.push(`(more errors omitted — showing the first ${EXCHANGE_MAX_ERRORS})`)
  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, envelope: parsed as unknown as ExchangeEnvelope, bytes }
}

// ─── Sign / verify (advisory) ────────────────────────────────────────────────

/** The signed bytes: JCS (RFC 8785) canonical UTF-8 of the envelope WITHOUT
 * its `sig` key. Payloads come out of JSON.parse, so every number is finite
 * and JCS cannot throw on well-formed input. */
export function envelopeSigningBytes(env: ExchangeEnvelope): Buffer {
  const { sig: _drop, ...rest } = env
  return Buffer.from(jcsCanonicalize(rest), 'utf8')
}

/**
 * Return a signed copy: `from.kid` is stamped from the signer (it is part of
 * the signed bytes — stamp first, then sign), `sig` carries the public key so
 * any receiver can verify offline. The signer duck is `AgentCardSigner`
 * (STD-M1), so the hub's card-signing key signs exchange results too — one
 * hub, one kid.
 */
export function signExchangeEnvelope(env: ExchangeEnvelope, signer: AgentCardSigner): ExchangeEnvelope {
  const kid = signer.kid()
  const raw = signer.publicJwk()
  // Copy exactly the four schema-legal JWK members — publicJwk() may carry
  // extras (use/alg) that would fail the fail-closed jwk validation.
  const jwk: EnvelopeJwk = { kty: 'EC', crv: 'P-256', x: String(raw.x), y: String(raw.y) }
  const { sig: _drop, ...rest } = env
  const body: ExchangeEnvelope = { ...rest, from: { ...rest.from, kid } }
  const signature = signer.sign(envelopeSigningBytes(body)).toString('base64url')
  return { ...body, sig: { alg: 'ES256', kid, jwk, signature } }
}

export type EnvelopeSigVerdict =
  | { state: 'valid'; kid: string }
  | { state: 'invalid'; reason: string }
  | { state: 'unsigned' }

/**
 * Best-effort, self-contained verification — never throws. 'valid' proves the
 * envelope is byte-identical to what the holder of this key signed, and binds
 * it to the RECOMPUTED kid; it says NOTHING about who the sender is (a forger
 * can re-sign the whole envelope under their own key — from.kid moves with
 * it). Trust stays with the human relay; the verdict never replaces the
 * import confirmation.
 */
export function verifyExchangeEnvelope(env: ExchangeEnvelope): EnvelopeSigVerdict {
  const sig = env.sig
  if (sig === undefined) return { state: 'unsigned' }
  try {
    // Lying-JWK defense: the kid we report is recomputed from the key that
    // actually verifies, never read off a label.
    const thumb = ecThumbprint({ kty: sig.jwk.kty, crv: sig.jwk.crv, x: sig.jwk.x, y: sig.jwk.y })
    if (thumb !== sig.kid) return { state: 'invalid', reason: 'sig.kid does not match the thumbprint of sig.jwk' }
    if (thumb !== env.from.kid) return { state: 'invalid', reason: 'from.kid does not match the thumbprint of sig.jwk' }
    let publicKey
    try {
      publicKey = createPublicKey({ key: sig.jwk as unknown as import('node:crypto').JsonWebKey, format: 'jwk' })
    } catch {
      return { state: 'invalid', reason: 'sig.jwk is not a usable P-256 public key' }
    }
    const okSig = cryptoVerify(
      'sha256',
      envelopeSigningBytes(env),
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(sig.signature, 'base64url'),
    )
    return okSig ? { state: 'valid', kid: thumb } : { state: 'invalid', reason: 'signature does not verify over the JCS bytes' }
  } catch (err) {
    return { state: 'invalid', reason: err instanceof Error ? err.message : String(err) }
  }
}

// ─── Result assembly ─────────────────────────────────────────────────────────

/** Fresh exchange id: `exg-` + 20 lowercase hex chars (80 bits). */
export function generateExchangeId(): string {
  return `exg-${randomBytes(10).toString('hex')}`
}

export interface BuildResultOpts {
  request: Pick<ExchangeEnvelope, 'id' | 'title'>
  ok: boolean
  output?: unknown
  error?: string
  /** Result `from.name`; the signing kid (added by signExchangeEnvelope) is
   * the cryptographic identity — this is the human-readable line. */
  fromName: string
  id?: string
  now?: Date
}

/**
 * Assemble an UNSIGNED result envelope that is valid by construction: title
 * clipped, payload fitted under the byte caps (a too-big output gets its
 * `.text` clipped when it has one, else is dropped with an honest error note —
 * never a silently truncated JSON body).
 */
export function buildResultEnvelope(opts: BuildResultOpts): ExchangeEnvelope {
  const payload: Record<string, unknown> = { ok: opts.ok }
  if (opts.output !== undefined) payload.output = opts.output
  if (opts.error !== undefined) payload.error = clipText(opts.error, 2000)
  return {
    schema: ENVELOPE_SCHEMA_V1,
    id: opts.id ?? generateExchangeId(),
    kind: 'result',
    replyTo: opts.request.id,
    createdAt: (opts.now ?? new Date()).toISOString(),
    from: { name: clipText(opts.fromName, ENVELOPE_MAX_NAME_CHARS) },
    title: clipText(`Re: ${opts.request.title}`, ENVELOPE_MAX_TITLE_CHARS),
    payload: fitResultPayload(payload),
  }
}

/**
 * Fit a result payload under ENVELOPE_MAX_PAYLOAD_BYTES. Exported for tests.
 * Strategy: (1) fits → unchanged; (2) output carries a `.text` string (the
 * dominant real shape — LLM prose) → binary-search the longest prefix that
 * fits, marked with an explicit truncation suffix; (3) anything else → drop
 * the output and say so in `error`. The `ok` verdict is NEVER changed by
 * fitting — a truncated success is still a success.
 */
export function fitResultPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const size = (p: Record<string, unknown>): number => Buffer.byteLength(JSON.stringify(p), 'utf8')
  if (size(payload) <= ENVELOPE_MAX_PAYLOAD_BYTES) return payload
  const output = payload.output
  const text = isPlainObject(output) && typeof output.text === 'string' ? output.text : null
  if (text !== null) {
    const suffix = '\n…[truncated to fit the envelope payload limit]'
    let lo = 0
    let hi = text.length
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2)
      const candidate = { ...payload, output: { ...(output as Record<string, unknown>), text: clipText(text, mid) + suffix } }
      if (size(candidate) <= ENVELOPE_MAX_PAYLOAD_BYTES) lo = mid
      else hi = mid - 1
    }
    if (lo > 0) {
      return { ...payload, output: { ...(output as Record<string, unknown>), text: clipText(text, lo) + suffix } }
    }
  }
  const dropped: Record<string, unknown> = { ...payload }
  const droppedBytes = size(payload)
  delete dropped.output
  const note = `output omitted: ${droppedBytes} bytes exceeds the ${ENVELOPE_MAX_PAYLOAD_BYTES} byte payload limit`
  dropped.error = typeof dropped.error === 'string' && dropped.error.length > 0 ? `${dropped.error}; ${note}` : note
  return dropped
}
