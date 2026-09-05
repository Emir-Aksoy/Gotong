/**
 * EXCH-M1 — `gotong.envelope/v1` pure core (parse / sign / verify / result
 * assembly). Load-bearing claims:
 *
 *  - fail-closed validation: unknown keys, unknown newer schema versions,
 *    hostile control/bidi chars in display fields, and oversize input are all
 *    REJECTED (size before JSON.parse); errors are collected, capped at
 *    EXCHANGE_MAX_ERRORS with an honest truncation note;
 *  - the result-payload three-key shape { ok, output?, error? } is structure,
 *    not free data;
 *  - sign → serialize → parse → verify round-trips byte-exactly, and the
 *    verifier's kid is RECOMPUTED from sig.jwk (lying-JWK defense) — a
 *    swapped key or a re-signed envelope under someone else's from.kid is
 *    'invalid', never 'valid';
 *  - buildResultEnvelope output is valid by construction, and fitResultPayload
 *    never flips the ok verdict while fitting under the byte cap;
 *  - the TS constants are PINNED to gotong.envelope.v1.schema.json (the
 *    cross-pack truth source) so the hand validator and the schema text
 *    cannot drift apart.
 */
import { readFile } from 'node:fs/promises'
import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { ecThumbprint, es256Sign, type AgentCardSigner } from '@gotong/a2a'
import { DeliveryEvidenceError, verifyDeliveryEvidence } from '../src/delivery-evidence.js'

import {
  ENVELOPE_CAPABILITY_RE,
  ENVELOPE_CREATED_AT_RE,
  ENVELOPE_ID_RE,
  ENVELOPE_KID_RE,
  ENVELOPE_MAX_FILE_BYTES,
  ENVELOPE_MAX_HUB_CHARS,
  ENVELOPE_MAX_NAME_CHARS,
  ENVELOPE_MAX_PAYLOAD_BYTES,
  ENVELOPE_MAX_TITLE_CHARS,
  ENVELOPE_SCHEMA_V1,
  ENVELOPE_SIGNATURE_RE,
  EXCHANGE_MAX_ERRORS,
  buildResultEnvelope,
  envelopeSigningBytes,
  fitResultPayload,
  generateExchangeId,
  parseExchangeEnvelope,
  signExchangeEnvelope,
  verifyExchangeEnvelope,
  type ExchangeEnvelope,
} from '../src/exchange-envelope.js'

const REQ_ID = 'exg-7f3a9c2e5b1d4a8f0c6e'

/** Doc §3.4-shaped request (pi user → hub). */
function baseRequest(): Record<string, unknown> {
  return {
    schema: ENVELOPE_SCHEMA_V1,
    id: REQ_ID,
    kind: 'request',
    createdAt: '2026-08-14T02:00:00Z',
    from: { name: '老陈 (pi @ MacBook)' },
    to: { name: '阿同' },
    capability: 'market.analysis',
    title: '请分析一下今天恒指的走势',
    payload: { question: '恒指今天怎么看?' },
  }
}

/** Doc §3.4-shaped result (hub → back through the human). */
function baseResult(): Record<string, unknown> {
  return {
    schema: ENVELOPE_SCHEMA_V1,
    id: 'exg-result0000000001a',
    kind: 'result',
    replyTo: REQ_ID,
    createdAt: '2026-08-14T03:00:00Z',
    from: { name: 'Gotong hub' },
    title: 'Re: 请分析一下今天恒指的走势',
    payload: { ok: true, output: { text: '分析如下……' } },
  }
}

const ser = (v: unknown): string => JSON.stringify(v)

function makeSigner(): AgentCardSigner {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const jwk = publicKey.export({ format: 'jwk' }) as Record<string, string>
  const pub = { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }
  const kid = ecThumbprint(pub)
  return {
    kid: () => kid,
    publicJwk: () => ({ ...pub }),
    sign: (input: Buffer) => es256Sign(privateKey, input),
  }
}

function parseOk(raw: string): ExchangeEnvelope {
  const r = parseExchangeEnvelope(raw)
  if (!r.ok) throw new Error(`expected valid envelope, got: ${r.errors.join(' | ')}`)
  return r.envelope
}

function parseErrs(raw: string): string[] {
  const r = parseExchangeEnvelope(raw)
  if (r.ok) throw new Error('expected validation failure, got ok')
  return r.errors
}

describe('parseExchangeEnvelope', () => {
  it('rejects lone surrogates in payload values and keys at the envelope boundary', () => {
    for (const payload of [{ value: '\ud800' }, { '\udc00': 'value' }]) {
      expect(parseErrs(ser({ ...baseRequest(), payload })).join(' ')).toContain('surrogate')
    }
  })

  it.each(['1e309', '-1e309'])('rejects JSON numeric overflow (%s) before dispatch or verification', (number) => {
    for (const envelope of [baseRequest(), baseResult()]) {
      const raw = ser(envelope).replace('"payload":{', `"payload":{"overflow":${number},`)
      expect(parseErrs(raw).join(' ')).toContain('non-finite')
    }
  })

  it('accepts the doc §3.4 request shape and echoes every field', () => {
    const env = parseOk(ser(baseRequest()))
    expect(env.id).toBe(REQ_ID)
    expect(env.kind).toBe('request')
    expect(env.capability).toBe('market.analysis')
    expect(env.from.name).toBe('老陈 (pi @ MacBook)')
    expect(env.to?.name).toBe('阿同')
    expect(env.payload).toEqual({ question: '恒指今天怎么看?' })
    expect(env.sig).toBeUndefined()
  })

  it('accepts the doc §3.4 result shape (replyTo + three-key payload)', () => {
    const env = parseOk(ser(baseResult()))
    expect(env.kind).toBe('result')
    expect(env.replyTo).toBe(REQ_ID)
    expect(env.payload.ok).toBe(true)
  })

  it('tolerates a UTF-8 BOM', () => {
    const env = parseOk('﻿' + ser(baseRequest()))
    expect(env.id).toBe(REQ_ID)
  })

  it('rejects an unknown NEWER schema version with a single honest error, never guessing', () => {
    const req = { ...baseRequest(), schema: 'gotong.envelope/v2' }
    const errors = parseErrs(ser(req))
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain("unknown version 'gotong.envelope/v2'")
    expect(errors[0]).toContain('will not guess')
  })

  it('rejects unknown keys at every level (fail-closed)', () => {
    const req = baseRequest()
    req.extra = 1
    ;(req.from as Record<string, unknown>).email = 'x@y.z'
    ;(req.to as Record<string, unknown>).address = 'nope'
    const errors = parseErrs(ser(req))
    expect(errors.some((e) => e.startsWith('extra:'))).toBe(true)
    expect(errors.some((e) => e.startsWith('from.email:'))).toBe(true)
    expect(errors.some((e) => e.startsWith('to.address:'))).toBe(true)
  })

  it('rejects a payload smuggling a prototype chain (prototype-pinned object check)', () => {
    // JSON.parse never produces these, but the validator is also called on
    // in-process objects via own-bytes checks — keep the pin honest.
    const raw = ser(baseRequest()).replace('"payload":{', '"payload":{"__proto__":{"polluted":1},')
    // JSON.parse keeps __proto__ as a plain own key — the envelope must
    // still parse and the key must land as data, not prototype.
    const r = parseExchangeEnvelope(raw)
    if (r.ok) {
      expect(Object.getPrototypeOf(r.envelope.payload)).toBe(Object.prototype)
      expect((r.envelope.payload as Record<string, unknown>).polluted).toBeUndefined()
    }
  })

  it('enforces kind rules: request must not carry replyTo, result must', () => {
    const req = { ...baseRequest(), replyTo: REQ_ID }
    expect(parseErrs(ser(req)).some((e) => e.includes('only a result carries replyTo'))).toBe(true)
    const res = baseResult()
    delete res.replyTo
    expect(parseErrs(ser(res)).some((e) => e.startsWith('replyTo:'))).toBe(true)
  })

  it('enforces the result payload three-key shape', () => {
    const res = baseResult()
    res.payload = { ok: 'yes', extra: 1 }
    const errors = parseErrs(ser(res))
    expect(errors.some((e) => e.includes('payload.ok'))).toBe(true)
    expect(errors.some((e) => e.includes('payload.extra'))).toBe(true)
    const res2 = baseResult()
    res2.payload = { ok: false, error: 42 }
    expect(parseErrs(ser(res2)).some((e) => e.includes('payload.error'))).toBe(true)
  })

  it('rejects hostile control / bidi-override characters in display fields', () => {
    for (const [mutate, path] of [
      [(r: Record<string, unknown>) => (r.title = 'evil' + String.fromCharCode(0x202e) + 'live'), 'title'],
      [(r: Record<string, unknown>) => ((r.from as Record<string, unknown>).name = 'a\nb'), 'from.name'],
      [(r: Record<string, unknown>) => ((r.to as Record<string, unknown>).name = 'a' + String.fromCharCode(0) + 'b'), 'to.name'],
      [(r: Record<string, unknown>) => ((r.from as Record<string, unknown>).hub = 'h' + String.fromCharCode(0x2066)), 'from.hub'],
    ] as Array<[(r: Record<string, unknown>) => void, string]>) {
      const req = baseRequest()
      mutate(req)
      expect(parseErrs(ser(req)).some((e) => e.startsWith(path))).toBe(true)
    }
  })

  it('rejects bad ids (uppercase, short, traversal shapes) — the regex is the traversal guard', () => {
    for (const bad of ['exg-UPPER00000000', 'exg-short', 'exg-../../etc/passwd', 'exg-a.b.c.d.e.f.g.h', 'no-prefix-000000000']) {
      const req = { ...baseRequest(), id: bad }
      expect(parseErrs(ser(req)).some((e) => e.startsWith('id:'))).toBe(true)
    }
  })

  it('rejects non-UTC and impossible createdAt values', () => {
    for (const bad of ['2026-08-14T02:00:00+08:00', '2026-08-14 02:00:00Z', '2026-13-45T02:00:00Z']) {
      const req = { ...baseRequest(), createdAt: bad }
      expect(parseErrs(ser(req)).some((e) => e.startsWith('createdAt:'))).toBe(true)
    }
  })

  it('rejects oversize input BEFORE JSON.parse (whole-file cap)', () => {
    const big = '{"schema":"' + 'x'.repeat(ENVELOPE_MAX_FILE_BYTES) + '"}'
    const errors = parseErrs(big)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('byte limit')
  })

  it('rejects an oversize payload (serialized bytes cap)', () => {
    const req = baseRequest()
    req.payload = { blob: 'x'.repeat(ENVELOPE_MAX_PAYLOAD_BYTES) }
    expect(parseErrs(ser(req)).some((e) => e.startsWith('payload:') && e.includes('byte limit'))).toBe(true)
  })

  it('caps collected errors at EXCHANGE_MAX_ERRORS with a truncation note', () => {
    const req = baseRequest()
    for (let i = 0; i < EXCHANGE_MAX_ERRORS + 10; i++) req[`junk${i}`] = i
    const errors = parseErrs(ser(req))
    expect(errors).toHaveLength(EXCHANGE_MAX_ERRORS + 1)
    expect(errors[errors.length - 1]).toContain('more errors omitted')
  })

  it('requires from.kid when sig is present, and sig.kid === from.kid structurally', () => {
    const signer = makeSigner()
    const signed = signExchangeEnvelope(parseOk(ser(baseRequest())), signer)
    // Drop from.kid: structural reject.
    const noKid = { ...signed, from: { name: signed.from.name } }
    expect(parseErrs(ser(noKid)).some((e) => e.includes('from.kid: required when sig is present'))).toBe(true)
    // Mismatched from.kid: structural reject.
    const otherKid = makeSigner().kid()
    const mismatch = { ...signed, from: { ...signed.from, kid: otherKid } }
    expect(parseErrs(ser(mismatch)).some((e) => e.includes('sig.kid: must equal from.kid'))).toBe(true)
  })
})

describe('sign / verify', () => {
  it('signs nested __proto__ data and rejects tampering with it', () => {
    const env = parseOk(ser({ ...baseResult(), payload: { ok: true, output: JSON.parse('{"__proto__":{"value":"original"}}') } }))
    const signed = parseOk(ser(signExchangeEnvelope(env, makeSigner())))
    expect(verifyExchangeEnvelope(signed).state).toBe('valid')
    ;(signed.payload.output as { __proto__: { value: string } }).__proto__.value = 'tampered'
    expect(verifyExchangeEnvelope(signed).state).toBe('invalid')
  })

  it('sign → serialize → parse → verify round-trips, kid recomputed from the jwk', () => {
    const signer = makeSigner()
    const signed = signExchangeEnvelope(parseOk(ser(baseRequest())), signer)
    expect(signed.from.kid).toBe(signer.kid())
    const reparsed = parseOk(ser(signed))
    // Byte-exact: the signing bytes of the reparsed envelope equal the original's.
    expect(envelopeSigningBytes(reparsed).equals(envelopeSigningBytes(signed))).toBe(true)
    const verdict = verifyExchangeEnvelope(reparsed)
    expect(verdict).toEqual({ state: 'valid', kid: signer.kid() })
  })

  it('reports unsigned for an envelope without sig', () => {
    expect(verifyExchangeEnvelope(parseOk(ser(baseRequest())))).toEqual({ state: 'unsigned' })
  })

  it('detects tampering with any signed field', () => {
    const signed = signExchangeEnvelope(parseOk(ser(baseRequest())), makeSigner())
    const tampered = parseOk(ser({ ...signed, title: '改过的标题' }))
    const verdict = verifyExchangeEnvelope(tampered)
    expect(verdict.state).toBe('invalid')
    if (verdict.state === 'invalid') expect(verdict.reason).toContain('does not verify')
  })

  it('lying-JWK defense: a swapped public key is invalid because the kid is recomputed', () => {
    const victim = makeSigner()
    const attacker = makeSigner()
    const signed = signExchangeEnvelope(parseOk(ser(baseRequest())), victim)
    // Attacker keeps the victim's kid label but swaps in their own key.
    const attackerJwk = attacker.publicJwk() as Record<string, string>
    const swapped: ExchangeEnvelope = {
      ...signed,
      sig: { ...signed.sig!, jwk: { kty: 'EC', crv: 'P-256', x: attackerJwk.x, y: attackerJwk.y } },
    }
    const verdict = verifyExchangeEnvelope(swapped)
    expect(verdict.state).toBe('invalid')
    if (verdict.state === 'invalid') expect(verdict.reason).toContain('sig.kid does not match')
  })

  it('a full re-sign under the attacker key moves from.kid with it — valid, but a DIFFERENT kid', () => {
    // This is exactly why 'valid' never means sender identity: the verdict
    // binds bytes to the recomputed kid, and the kid changed.
    const victim = makeSigner()
    const attacker = makeSigner()
    const original = signExchangeEnvelope(parseOk(ser(baseRequest())), victim)
    const resigned = signExchangeEnvelope({ ...original, title: '被换过的内容' }, attacker)
    const verdict = verifyExchangeEnvelope(parseOk(ser(resigned)))
    expect(verdict).toEqual({ state: 'valid', kid: attacker.kid() })
    expect(attacker.kid()).not.toBe(victim.kid())
  })
})

describe('result assembly', () => {
  it('checks the serialized output and returns detached deliverable JSON', () => {
    const date = new Date('2026-09-04T00:00:00Z')
    const request = parseOk(ser({ ...baseRequest(), acceptance: [
      { id: 'missing', path: '/text', op: 'exists' },
      { id: 'date', path: '/date', op: 'equals', expected: date.toISOString() },
      { id: 'array', path: '/items/0', op: 'equals', expected: null },
    ] }))
    const output = { text: undefined, date, items: [undefined] }
    const env = buildResultEnvelope({ request, ok: true, output, fromName: 'hub', provenance: { taskId: 't1', by: 'atong' } })
    expect(env.payload.output).toEqual({ date: date.toISOString(), items: [null] })
    expect(env.evidence?.results.map(r => r.status)).toEqual(['failed', 'passed', 'passed'])
    date.setUTCFullYear(2000)
    const wire = parseOk(ser(signExchangeEnvelope(env, makeSigner())))
    expect(verifyExchangeEnvelope(wire).state).toBe('valid')
    expect(verifyDeliveryEvidence(wire.evidence, wire.payload, request)).toMatchObject({ consistent: true, failed: 1, passed: 2 })
  })

  it('fits the JSON representation of toJSON output before computing evidence', () => {
    const request = parseOk(ser({ ...baseRequest(), acceptance: [{ id: 'end', path: '/text', op: 'contains', expected: 'THE_END' }] }))
    const output = { toJSON: () => ({ text: 'x'.repeat(ENVELOPE_MAX_PAYLOAD_BYTES) + 'THE_END' }) }
    const env = buildResultEnvelope({ request, ok: true, output, fromName: 'hub', provenance: { taskId: 't1', by: 'atong' } })
    expect((env.payload.output as { text: string }).text).toContain('[truncated')
    expect(env.evidence?.results).toEqual([{ id: 'end', status: 'failed' }])
    const wire = parseOk(ser(env))
    expect(verifyDeliveryEvidence(wire.evidence, wire.payload, request).consistent).toBe(true)
  })

  it('rejects acceptance without task provenance instead of silently dropping evidence', () => {
    const request = parseOk(ser({ ...baseRequest(), acceptance: [{ id: 'a', op: 'exists', path: '' }] }))
    expect(() => buildResultEnvelope({ request, ok: true, output: {}, fromName: 'hub' })).toThrow(DeliveryEvidenceError)
  })

  it('carries acceptance evidence computed over the fitted output and signs it', () => {
    const request = parseOk(ser({ ...baseRequest(), acceptance: [
      { id: 'ending', path: '/text', op: 'contains', expected: 'THE_END' },
    ] }))
    const env = buildResultEnvelope({
      request, ok: true, output: { text: 'x'.repeat(ENVELOPE_MAX_PAYLOAD_BYTES) + 'THE_END' },
      fromName: 'hub', provenance: { taskId: 't1', by: 'atong' },
    })
    expect(env.evidence?.results).toEqual([{ id: 'ending', status: 'failed' }])
    const signed = signExchangeEnvelope(env, makeSigner())
    expect(verifyExchangeEnvelope(parseOk(ser(signed))).state).toBe('valid')
    signed.evidence!.results[0]!.status = 'passed'
    expect(verifyExchangeEnvelope(signed).state).toBe('invalid')
  })

  it('rejects evidence on requests and acceptance on results', () => {
    expect(parseExchangeEnvelope(ser({ ...baseRequest(), evidence: {} })).ok).toBe(false)
    expect(parseExchangeEnvelope(ser({ ...baseResult(), acceptance: [{ id: 'a', op: 'human', description: 'Review' }] })).ok).toBe(false)
  })

  it('generateExchangeId matches the id grammar', () => {
    for (let i = 0; i < 20; i++) expect(generateExchangeId()).toMatch(ENVELOPE_ID_RE)
  })

  it('buildResultEnvelope is valid by construction (parse + re-verify own bytes)', () => {
    const env = buildResultEnvelope({
      request: { id: REQ_ID, title: '请分析一下今天恒指的走势' },
      ok: true,
      output: { text: '分析如下……' },
      fromName: 'Gotong hub',
      now: new Date('2026-08-14T03:00:00Z'),
    })
    const reparsed = parseOk(ser(env))
    expect(reparsed.kind).toBe('result')
    expect(reparsed.replyTo).toBe(REQ_ID)
    expect(reparsed.title).toBe('Re: 请分析一下今天恒指的走势')
    expect(reparsed.payload).toEqual({ ok: true, output: { text: '分析如下……' } })
  })

  it('clips a runaway title and error while keeping validity', () => {
    const env = buildResultEnvelope({
      request: { id: REQ_ID, title: 'T'.repeat(500) },
      ok: false,
      error: 'e'.repeat(5000),
      fromName: 'N'.repeat(500),
    })
    expect(env.title.length).toBe(ENVELOPE_MAX_TITLE_CHARS)
    expect(env.from.name.length).toBe(ENVELOPE_MAX_NAME_CHARS)
    expect((env.payload.error as string).length).toBe(2000)
    expect(parseExchangeEnvelope(ser(env)).ok).toBe(true)
  })

  it('fitResultPayload returns small payloads unchanged (same reference)', () => {
    const p = { ok: true, output: { text: 'small' } }
    expect(fitResultPayload(p)).toBe(p)
  })

  it('fitResultPayload clips oversize output.text with an explicit suffix, ok verdict unchanged', () => {
    const p = { ok: true, output: { text: '字'.repeat(ENVELOPE_MAX_PAYLOAD_BYTES) } }
    const fitted = fitResultPayload(p)
    expect(fitted.ok).toBe(true)
    const text = (fitted.output as { text: string }).text
    expect(text.endsWith('…[truncated to fit the envelope payload limit]')).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(fitted), 'utf8')).toBeLessThanOrEqual(ENVELOPE_MAX_PAYLOAD_BYTES)
  })

  it('fitResultPayload drops a non-text oversize output with an honest error note', () => {
    const p = { ok: true, output: { rows: Array.from({ length: 30000 }, (_, i) => `row-${i}-padding-padding`) } }
    const fitted = fitResultPayload(p)
    expect(fitted.ok).toBe(true)
    expect(fitted.output).toBeUndefined()
    expect(String(fitted.error)).toContain('output omitted')
    expect(Buffer.byteLength(JSON.stringify(fitted), 'utf8')).toBeLessThanOrEqual(ENVELOPE_MAX_PAYLOAD_BYTES)
  })
})

describe('schema.json pinning (cross-pack truth source)', () => {
  it('TS constants match gotong.envelope.v1.schema.json byte-for-byte', async () => {
    const raw = await readFile(new URL('../src/gotong.envelope.v1.schema.json', import.meta.url), 'utf8')
    const schema = JSON.parse(raw) as {
      description: string
      properties: Record<string, { pattern?: string; maxLength?: number; const?: string; properties?: Record<string, { pattern?: string; maxLength?: number; properties?: Record<string, { pattern?: string }> }> }>
    }
    expect(schema.properties.schema.const).toBe(ENVELOPE_SCHEMA_V1)
    expect(schema.properties.id.pattern).toBe(ENVELOPE_ID_RE.source)
    expect(schema.properties.replyTo.pattern).toBe(ENVELOPE_ID_RE.source)
    expect(schema.properties.capability.pattern).toBe(ENVELOPE_CAPABILITY_RE.source)
    expect(schema.properties.createdAt.pattern).toBe(ENVELOPE_CREATED_AT_RE.source)
    expect(schema.properties.title.maxLength).toBe(ENVELOPE_MAX_TITLE_CHARS)
    const from = schema.properties.from.properties!
    expect(from.name.maxLength).toBe(ENVELOPE_MAX_NAME_CHARS)
    expect(from.hub.maxLength).toBe(ENVELOPE_MAX_HUB_CHARS)
    expect(from.kid.pattern).toBe(ENVELOPE_KID_RE.source)
    const sig = schema.properties.sig.properties!
    expect(sig.kid.pattern).toBe(ENVELOPE_KID_RE.source)
    expect(sig.signature.pattern).toBe(ENVELOPE_SIGNATURE_RE.source)
    expect(sig.jwk.properties!.x.pattern).toBe(ENVELOPE_KID_RE.source)
    expect(sig.jwk.properties!.y.pattern).toBe(ENVELOPE_KID_RE.source)
    // Byte caps live in prose (not expressible in draft-07) — pin the numbers.
    expect(schema.description).toContain(String(ENVELOPE_MAX_FILE_BYTES))
    expect(schema.description).toContain(String(ENVELOPE_MAX_PAYLOAD_BYTES))
    // Top-level key set: the schema's properties ARE the validator's TOP_KEYS.
    expect(Object.keys(schema.properties).sort()).toEqual(
      ['schema', 'id', 'kind', 'replyTo', 'createdAt', 'from', 'to', 'capability', 'title', 'payload', 'acceptance', 'evidence', 'sig'].sort(),
    )
  })

  it("the schema's safe-text pattern agrees with hostileDisplayText behavior", async () => {
    const raw = await readFile(new URL('../src/gotong.envelope.v1.schema.json', import.meta.url), 'utf8')
    const schema = JSON.parse(raw) as { properties: { title: { pattern: string } } }
    // Compile the schema's own pattern — zero regex literals of our own.
    const safe = new RegExp(schema.properties.title.pattern, 'u')
    expect(safe.test('正常标题 with ASCII and 中文')).toBe(true)
    for (const code of [0x00, 0x0a, 0x1f, 0x7f, 0x202a, 0x202e, 0x2066, 0x2069]) {
      expect(safe.test('a' + String.fromCharCode(code) + 'b')).toBe(false)
    }
  })
})
