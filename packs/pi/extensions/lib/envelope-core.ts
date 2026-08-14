/**
 * gotong.envelope/v1 — self-contained core for the pi host-agent pack.
 *
 * This file is a DELIBERATE vendored copy of the hub-side validator semantics
 * (packages/host/src/exchange-envelope.ts) plus the JCS / thumbprint helpers
 * (packages/a2a/src/card-signature.ts). It cannot import them: `pi install
 * <local-path>` never runs npm install, so this pack must carry zero
 * third-party runtime dependencies — node:* built-ins only. Two anti-drift
 * gates in the main repo keep the copy honest:
 *
 *   1. schema text:  packs/pi/schema/gotong.envelope.v1.schema.json must be
 *      byte-identical to packages/host/src/gotong.envelope.v1.schema.json.
 *   2. behavior:     packages/host/tests/exchange-pack-pi.test.ts imports THIS
 *      file and asserts verdict + error-text agreement with the hub validator
 *      on shared fixtures (error strings here are byte-identical on purpose).
 *
 * Posture (unchanged from the hub side): fail-closed — unknown keys reject,
 * hostile control/bidi characters in display fields reject, size caps reject
 * BEFORE JSON.parse. Errors are COLLECTED (≤ 20) so the model can self-correct
 * in one round. A signature proves integrity + key binding, NEVER sender
 * identity — the human relay (the person forwarding the file over IM) is the
 * sender-identity channel. Unsigned envelopes are fully legal.
 */

import { createHash, createPublicKey, randomBytes, verify as cryptoVerify } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

// ─── Wire shapes ─────────────────────────────────────────────────────────────

export const ENVELOPE_SCHEMA_V1 = 'gotong.envelope/v1'

export interface EnvelopeFrom {
  name: string
  hub?: string
  kid?: string
}

export interface EnvelopeSig {
  alg: 'ES256'
  kid: string
  jwk: { kty: 'EC'; crv: 'P-256'; x: string; y: string }
  signature: string
}

export interface ExchangeEnvelope {
  schema: typeof ENVELOPE_SCHEMA_V1
  id: string
  kind: 'request' | 'result'
  replyTo?: string
  createdAt: string
  from: EnvelopeFrom
  to?: { name: string }
  capability?: string
  title: string
  payload: Record<string, unknown>
  sig?: EnvelopeSig
}

// ─── Constants (must mirror the hub validator; the repo gate pins them) ──────

export const ENVELOPE_ID_RE = /^exg-[a-z0-9][a-z0-9-]{7,59}$/
export const ENVELOPE_CAPABILITY_RE = /^[a-z][a-z0-9._-]{1,63}$/
export const ENVELOPE_KID_RE = /^[A-Za-z0-9_-]{43}$/
export const ENVELOPE_SIGNATURE_RE = /^[A-Za-z0-9_-]{86}$/
export const ENVELOPE_CREATED_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/

export const ENVELOPE_MAX_FILE_BYTES = 256 * 1024
export const ENVELOPE_MAX_PAYLOAD_BYTES = 200 * 1024
export const ENVELOPE_MAX_TITLE_CHARS = 200
export const ENVELOPE_MAX_NAME_CHARS = 120
export const ENVELOPE_MAX_HUB_CHARS = 200
export const EXCHANGE_MAX_ERRORS = 20

/** Directory convention (docs/zh/EXCHANGE-ENVELOPE.md §四): the agent writes
 * outgoing envelopes here; the human picks them up and forwards over IM. */
export const OUT_DIR = 'gotong-out'
/** The human drops received envelope files here; the agent parses on demand.
 * No watcher, no daemon — parse when asked (不要求电脑常开). */
export const IN_DIR = 'gotong-in'

const TOP_KEYS = new Set(['schema', 'id', 'kind', 'replyTo', 'createdAt', 'from', 'to', 'capability', 'title', 'payload', 'sig'])
const FROM_KEYS = new Set(['name', 'hub', 'kid'])
const TO_KEYS = new Set(['name'])
const SIG_KEYS = new Set(['alg', 'kid', 'jwk', 'signature'])
const JWK_KEYS = new Set(['kty', 'crv', 'x', 'y'])
const RESULT_PAYLOAD_KEYS = new Set(['ok', 'output', 'error'])

// ─── Small helpers ───────────────────────────────────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

/** Character-level on purpose (no `\uXXXX` regex literal — Edit-tool raw-byte
 * rot precedent in the main repo). Display fields are single-line, so
 * newline/tab count as hostile here too. */
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
export function clipText(s: string, max: number): string {
  if (s.length <= max) return s
  let out = s.slice(0, max)
  const last = out.charCodeAt(out.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1)
  return out
}

// ─── Parse + validate (fail-closed, collected errors) ────────────────────────

export type EnvelopeParseResult =
  | { ok: true; envelope: ExchangeEnvelope; bytes: number }
  | { ok: false; errors: string[] }

/**
 * Parse + validate one envelope file's text. Never throws. Error strings are
 * byte-identical to the hub validator so the repo's behavior gate can compare
 * whole error arrays, not just verdicts.
 */
export function parseEnvelopeText(raw: string): EnvelopeParseResult {
  const bytes = Buffer.byteLength(raw, 'utf8')
  if (bytes > ENVELOPE_MAX_FILE_BYTES) {
    return { ok: false, errors: [`file: ${bytes} bytes exceeds the ${ENVELOPE_MAX_FILE_BYTES} byte limit`] }
  }
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

// ─── JCS (RFC 8785) + RFC 7638 thumbprint + verify ───────────────────────────

function deepCanonicalize(value: unknown): unknown {
  if (value === null) return null
  const t = typeof value
  if (t === 'number') {
    if (!Number.isFinite(value as number)) {
      throw new Error('envelope JCS: non-finite number cannot be canonicalized')
    }
    return value
  }
  if (t === 'string' || t === 'boolean') return value
  if (Array.isArray(value)) return value.map(deepCanonicalize)
  if (t === 'object') {
    const obj = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(obj).sort()) {
      const v = obj[key]
      if (v === undefined) continue
      out[key] = deepCanonicalize(v)
    }
    return out
  }
  throw new Error(`envelope JCS: unsupported value of type ${t}`)
}

/** RFC 8785 canonical JSON string (envelope shape only). */
export function jcsCanonicalize(value: unknown): string {
  return JSON.stringify(deepCanonicalize(value))
}

/** RFC 7638 thumbprint of an EC public JWK (required members, lexical order). */
export function ecThumbprint(jwk: { crv: string; kty: string; x: string; y: string }): string {
  const canonical = `{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}","y":"${jwk.y}"}`
  return createHash('sha256').update(canonical, 'utf8').digest('base64url')
}

/** The signed bytes: JCS canonical UTF-8 of the envelope WITHOUT its `sig`. */
export function envelopeSigningBytes(env: ExchangeEnvelope): Buffer {
  const { sig: _drop, ...rest } = env
  return Buffer.from(jcsCanonicalize(rest), 'utf8')
}

export type EnvelopeSigVerdict =
  | { state: 'valid'; kid: string }
  | { state: 'invalid'; reason: string }
  | { state: 'unsigned' }

/**
 * Best-effort, self-contained verification — never throws. 'valid' proves
 * integrity + binding to the RECOMPUTED kid (lying-JWK defense); it says
 * NOTHING about who the sender is — that stays with the human relay.
 */
export function verifyEnvelopeSig(env: ExchangeEnvelope): EnvelopeSigVerdict {
  const sig = env.sig
  if (sig === undefined) return { state: 'unsigned' }
  try {
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

// ─── Compose (tool-side assembly; always re-validated before write) ──────────

/** Fresh exchange id: `exg-` + 20 lowercase hex chars (80 bits). */
export function generateExchangeId(): string {
  return `exg-${randomBytes(10).toString('hex')}`
}

export interface ComposeRequestOpts {
  kind: 'request'
  title: string
  payload: unknown
  fromName: string
  toName?: string
  capability?: string
}

export interface ComposeResultOpts {
  kind: 'result'
  title: string
  replyTo: string
  ok: boolean
  output?: unknown
  error?: string
  fromName: string
  toName?: string
}

export type ComposeOpts = ComposeRequestOpts | ComposeResultOpts

/**
 * Assemble an envelope from tool parameters, then run it through the FULL
 * validator before returning — defense in depth: even the pack's own assembly
 * must pass the same gate a foreign file would (结构性校验,不靠 prompt 祈祷).
 * Throws with the collected error list on any failure so the model can
 * self-correct in one round.
 */
export function composeEnvelope(opts: ComposeOpts, now?: Date): ExchangeEnvelope {
  const base = {
    schema: ENVELOPE_SCHEMA_V1,
    id: generateExchangeId(),
    createdAt: (now ?? new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    from: { name: clipText(opts.fromName, ENVELOPE_MAX_NAME_CHARS) },
    ...(opts.toName !== undefined && opts.toName !== '' ? { to: { name: clipText(opts.toName, ENVELOPE_MAX_NAME_CHARS) } } : {}),
    title: clipText(opts.title, ENVELOPE_MAX_TITLE_CHARS),
  }
  let draft: Record<string, unknown>
  if (opts.kind === 'request') {
    if (!isPlainObject(opts.payload)) {
      throw new Error('payload: 必须是一个 JSON 对象(例如 {"question": "..."})')
    }
    draft = {
      ...base,
      kind: 'request',
      ...(opts.capability !== undefined && opts.capability !== '' ? { capability: opts.capability } : {}),
      payload: opts.payload,
    }
  } else {
    const payload: Record<string, unknown> = { ok: opts.ok }
    if (opts.output !== undefined) payload.output = opts.output
    if (opts.error !== undefined) payload.error = clipText(opts.error, 2000)
    draft = { ...base, kind: 'result', replyTo: opts.replyTo, payload }
  }
  const parsed = parseEnvelopeText(JSON.stringify(draft))
  if (!parsed.ok) {
    throw new Error(`信封校验未通过,请修正后重试:\n- ${parsed.errors.join('\n- ')}`)
  }
  return parsed.envelope
}

// ─── File layer: gotong-out/ (emit) + gotong-in/ (ingest) ────────────────────

export interface EmitResult {
  id: string
  path: string
  bytes: number
}

/**
 * Write a validated envelope to `<baseDir>/gotong-out/<id>.json`. The 'wx'
 * flag refuses to overwrite an existing file — the id is the idempotency key,
 * so a name collision is an error, never a silent replacement.
 */
export function emitEnvelope(baseDir: string, env: ExchangeEnvelope): EmitResult {
  const dir = join(baseDir, OUT_DIR)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${env.id}.json`)
  const text = JSON.stringify(env, null, 2) + '\n'
  try {
    writeFileSync(path, text, { encoding: 'utf8', flag: 'wx' })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`gotong-out/${env.id}.json 已存在 — id 即幂等键,不覆盖既有文件`)
    }
    throw err
  }
  return { id: env.id, path, bytes: Buffer.byteLength(text, 'utf8') }
}

export interface InboxRow {
  file: string
  ok: boolean
  id?: string
  kind?: string
  title?: string
  fromName?: string
  note?: string
}

/** List `<baseDir>/gotong-in/*.json` with a light per-file summary. A broken
 * file is a row with ok:false, never a thrown error — the inbox listing must
 * survive one bad download. */
export function listInbox(baseDir: string): InboxRow[] {
  const dir = join(baseDir, IN_DIR)
  let names: string[]
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.json')).sort()
  } catch {
    return []
  }
  const rows: InboxRow[] = []
  for (const file of names) {
    try {
      const stat = statSync(join(dir, file))
      if (!stat.isFile()) continue
      if (stat.size > ENVELOPE_MAX_FILE_BYTES) {
        rows.push({ file, ok: false, note: `${stat.size} bytes exceeds the ${ENVELOPE_MAX_FILE_BYTES} byte limit` })
        continue
      }
      const parsed = parseEnvelopeText(readFileSync(join(dir, file), 'utf8'))
      if (!parsed.ok) {
        rows.push({ file, ok: false, note: parsed.errors[0] })
        continue
      }
      const env = parsed.envelope
      rows.push({
        file,
        ok: true,
        id: env.id,
        kind: env.kind,
        title: env.title,
        fromName: env.from.name,
        ...(file !== `${env.id}.json` ? { note: `文件名与信封 id 不一致(以内容里的 id 为准)` } : {}),
      })
    } catch (err) {
      rows.push({ file, ok: false, note: err instanceof Error ? err.message : String(err) })
    }
  }
  return rows
}

export interface IngestOk {
  ok: true
  envelope: ExchangeEnvelope
  bytes: number
  sigVerdict: EnvelopeSigVerdict
  /** Set when the on-disk filename disagrees with the envelope id. */
  nameMismatch?: string
}

export type IngestResult = IngestOk | { ok: false; errors: string[] }

/**
 * Read + fully validate + best-effort verify one file from gotong-in/.
 * `name` must be a bare `*.json` filename — path separators and dot-dot are
 * rejected before any path join (the guard IS the traversal defense).
 */
export function readInboxFile(baseDir: string, name: string): IngestResult {
  if (name !== basename(name) || name.includes('..') || !name.endsWith('.json') || name.length > 255) {
    return { ok: false, errors: [`file: 只接受 gotong-in/ 里的裸文件名(*.json),不接受路径`] }
  }
  const path = join(baseDir, IN_DIR, name)
  let stat
  try {
    stat = statSync(path)
  } catch {
    return { ok: false, errors: [`file: gotong-in/${name} 不存在`] }
  }
  if (!stat.isFile()) return { ok: false, errors: [`file: gotong-in/${name} 不是普通文件`] }
  if (stat.size > ENVELOPE_MAX_FILE_BYTES) {
    return { ok: false, errors: [`file: ${stat.size} bytes exceeds the ${ENVELOPE_MAX_FILE_BYTES} byte limit`] }
  }
  const parsed = parseEnvelopeText(readFileSync(path, 'utf8'))
  if (!parsed.ok) return parsed
  const env = parsed.envelope
  return {
    ok: true,
    envelope: env,
    bytes: parsed.bytes,
    sigVerdict: verifyEnvelopeSig(env),
    ...(name !== `${env.id}.json` ? { nameMismatch: name } : {}),
  }
}
