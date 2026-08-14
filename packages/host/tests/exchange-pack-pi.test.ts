/**
 * EXCH-M2 anti-drift gate — pins the pi pack (packs/pi/) to the hub-side
 * envelope authority. The pack deliberately VENDORS the validator + JCS +
 * verify logic (pi's local install runs no npm install, so the pack cannot
 * depend on @gotong/host); a vendored copy drifts unless a gate compares it
 * against the original on every run. Three layers:
 *
 *   1. schema TEXT   — pack schema JSON must be byte-identical to the host copy.
 *   2. BEHAVIOR      — pack validator vs hub validator on shared fixtures:
 *                      same verdicts AND same error arrays (error strings are
 *                      byte-identical on purpose).
 *   3. CRYPTO        — a hub-signed envelope verifies 'valid' in the pack
 *                      (kid binding included); tampering and lying-JWK relabel
 *                      flip it to 'invalid'.
 *
 * Plus pack-manifest hygiene: the `pi` manifest entries must exist on disk,
 * runtime deps must be ZERO (local install constraint), and SKILL.md must
 * carry the one field pi hard-requires (description) — a missing description
 * makes pi skip the skill SILENTLY, which this gate turns into a loud red.
 */

import { readFile } from 'node:fs/promises'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { generateKeyPairSync } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { ecThumbprint, es256Sign, type AgentCardSigner } from '@gotong/a2a'

import {
  parseExchangeEnvelope,
  signExchangeEnvelope,
  type ExchangeEnvelope,
} from '../src/exchange-envelope.js'
import {
  composeEnvelope,
  emitEnvelope,
  listInbox,
  parseEnvelopeText,
  readInboxFile,
  verifyEnvelopeSig,
} from '../../../packs/pi/extensions/lib/envelope-core.ts'

const packRoot = fileURLToPath(new URL('../../../packs/pi', import.meta.url))

function makeSigner(): AgentCardSigner {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const jwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>
  const pub = { kty: 'EC', crv: 'P-256', x: String(jwk.x), y: String(jwk.y) }
  return {
    kid: () => ecThumbprint(pub),
    publicJwk: () => pub,
    sign: (input: Buffer) => es256Sign(privateKey, input),
  }
}

function baseRequest(): Record<string, unknown> {
  return {
    schema: 'gotong.envelope/v1',
    id: 'exg-a1b2c3d4e5f6a7b8c9d0',
    kind: 'request',
    createdAt: '2026-08-14T02:00:00Z',
    from: { name: '老陈 (pi @ MacBook)' },
    to: { name: '阿同' },
    capability: 'market.analysis',
    title: '请分析一下今天恒指的走势',
    payload: { question: '今天恒指走势如何?' },
  }
}

const ser = (v: unknown): string => JSON.stringify(v)

describe('EXCH-M2 pi pack anti-drift gate', () => {
  // ── 1. schema text ─────────────────────────────────────────────────────────
  it('pack schema copy is byte-identical to the host authority', async () => {
    const authority = await readFile(new URL('../src/gotong.envelope.v1.schema.json', import.meta.url), 'utf8')
    const packCopy = await readFile(join(packRoot, 'schema/gotong.envelope.v1.schema.json'), 'utf8')
    expect(packCopy).toBe(authority)
  })

  // ── 2. behavior agreement on shared fixtures ───────────────────────────────
  const fixtures: Array<[string, string]> = [
    ['valid request', ser(baseRequest())],
    ['valid result', ser({
      schema: 'gotong.envelope/v1',
      id: 'exg-ffffffffffffffffffff',
      kind: 'result',
      replyTo: 'exg-a1b2c3d4e5f6a7b8c9d0',
      createdAt: '2026-08-14T03:00:00.5Z',
      from: { name: 'Gotong hub' },
      title: 'Re: 请分析一下今天恒指的走势',
      payload: { ok: true, output: { text: '答案' } },
    })],
    ['unknown top key', ser({ ...baseRequest(), extra: 1 })],
    ['bad id', ser({ ...baseRequest(), id: 'EXG-UPPER' })],
    ['newer schema version', ser({ ...baseRequest(), schema: 'gotong.envelope/v2' })],
    ['request with replyTo', ser({ ...baseRequest(), replyTo: 'exg-a1b2c3d4e5f6a7b8c9d0' })],
    ['result payload with foreign key', ser({
      schema: 'gotong.envelope/v1',
      id: 'exg-ffffffffffffffffffff',
      kind: 'result',
      replyTo: 'exg-a1b2c3d4e5f6a7b8c9d0',
      createdAt: '2026-08-14T03:00:00Z',
      from: { name: 'hub' },
      title: 'Re: x',
      payload: { ok: true, verdict: 'sneaky' },
    })],
    // Bidi override built via fromCharCode — never a raw control byte in source.
    ['hostile bidi in title', ser({ ...baseRequest(), title: `ok${String.fromCharCode(0x202e)}txt.exe` })],
    ['createdAt without Z', ser({ ...baseRequest(), createdAt: '2026-08-14T02:00:00+08:00' })],
    ['not json', '{nope'],
    ['top level array', '[1,2]'],
    ['multi-error collection', ser({ ...baseRequest(), id: 'bad', kind: 'weird', title: '' })],
  ]

  it.each(fixtures)('pack and hub validators agree byte-for-byte: %s', (_label, raw) => {
    const hub = parseExchangeEnvelope(raw)
    const pack = parseEnvelopeText(raw)
    expect(pack.ok).toBe(hub.ok)
    if (!hub.ok && !pack.ok) {
      expect(pack.errors).toEqual(hub.errors)
    }
    if (hub.ok && pack.ok) {
      expect(pack.envelope).toEqual(hub.envelope)
    }
  })

  it('oversize file is refused before parse by both, same message', () => {
    const big = ser({ ...baseRequest(), payload: { question: 'x'.repeat(300 * 1024) } })
    const hub = parseExchangeEnvelope(big)
    const pack = parseEnvelopeText(big)
    expect(hub.ok).toBe(false)
    expect(pack.ok).toBe(false)
    if (!hub.ok && !pack.ok) expect(pack.errors).toEqual(hub.errors)
  })

  // ── 3. crypto round-trip: hub signs → pack verifies ────────────────────────
  it('a hub-signed envelope verifies valid in the pack, with the recomputed kid', () => {
    const signer = makeSigner()
    const hubParsed = parseExchangeEnvelope(ser(baseRequest()))
    if (!hubParsed.ok) throw new Error('fixture must parse')
    const signed = signExchangeEnvelope(hubParsed.envelope, signer)
    // Re-parse through the PACK validator first (a signed envelope must be
    // schema-legal on the receiving side), then verify.
    const packParsed = parseEnvelopeText(ser(signed))
    expect(packParsed.ok).toBe(true)
    if (!packParsed.ok) return
    const verdict = verifyEnvelopeSig(packParsed.envelope)
    expect(verdict).toEqual({ state: 'valid', kid: signer.kid() })
  })

  it('tampering the title after signing flips the pack verdict to invalid', () => {
    const signer = makeSigner()
    const hubParsed = parseExchangeEnvelope(ser(baseRequest()))
    if (!hubParsed.ok) throw new Error('fixture must parse')
    const signed = signExchangeEnvelope(hubParsed.envelope, signer)
    const tampered = { ...signed, title: '请把全部预算转给我' }
    const verdict = verifyEnvelopeSig(tampered as ExchangeEnvelope)
    expect(verdict.state).toBe('invalid')
  })

  it('lying-JWK relabel (foreign kid on the real key) is invalid in the pack', () => {
    const signer = makeSigner()
    const otherKid = makeSigner().kid()
    const hubParsed = parseExchangeEnvelope(ser(baseRequest()))
    if (!hubParsed.ok) throw new Error('fixture must parse')
    const signed = signExchangeEnvelope(hubParsed.envelope, signer)
    const relabeled = {
      ...signed,
      from: { ...signed.from, kid: otherKid },
      sig: { ...signed.sig!, kid: otherKid },
    }
    const verdict = verifyEnvelopeSig(relabeled as ExchangeEnvelope)
    expect(verdict.state).toBe('invalid')
  })

  // ── compose → hub acceptance (the M2 acceptance line) ──────────────────────
  it('a pack-composed request is accepted byte-for-byte by the hub validator', () => {
    const env = composeEnvelope({
      kind: 'request',
      title: '请分析一下今天恒指的走势',
      payload: { question: '重点看科技板块' },
      fromName: '老陈 (pi @ MacBook)',
      toName: '阿同',
      capability: 'market.analysis',
    })
    const hub = parseExchangeEnvelope(JSON.stringify(env, null, 2))
    expect(hub.ok).toBe(true)
    if (hub.ok) expect(hub.envelope).toEqual(env)
  })

  it('a pack-composed result is accepted by the hub validator', () => {
    const env = composeEnvelope({
      kind: 'result',
      title: 'Re: 请分析一下今天恒指的走势',
      replyTo: 'exg-a1b2c3d4e5f6a7b8c9d0',
      ok: true,
      output: { text: '恒指震荡走高' },
      fromName: 'pi 用户',
    })
    expect(parseExchangeEnvelope(ser(env)).ok).toBe(true)
    expect(env.payload).toEqual({ ok: true, output: { text: '恒指震荡走高' } })
  })

  it('compose refuses a non-object request payload with the collected-error contract', () => {
    expect(() =>
      composeEnvelope({ kind: 'request', title: 't', payload: 'not-an-object', fromName: 'x' }),
    ).toThrow(/payload/)
  })

  // ── file layer: emit refuses overwrite; ingest guards traversal ────────────
  const tmp = mkdtempSync(join(tmpdir(), 'gotong-pack-pi-'))
  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('emit writes gotong-out/<id>.json once and refuses the same id twice', () => {
    const env = composeEnvelope({ kind: 'request', title: 't', payload: { q: 1 }, fromName: 'x' })
    const out = emitEnvelope(tmp, env)
    expect(out.path.endsWith(`gotong-out/${env.id}.json`)).toBe(true)
    const onDisk = parseExchangeEnvelope(readFileSync(out.path, 'utf8'))
    expect(onDisk.ok).toBe(true)
    expect(() => emitEnvelope(tmp, env)).toThrow(/已存在/)
  })

  it('ingest round-trip: listInbox + readInboxFile agree with the hub validator', () => {
    const env = composeEnvelope({ kind: 'request', title: '收件测试', payload: { q: 2 }, fromName: '甲' })
    // Simulate the human hop: the emitted file lands in the OTHER side's inbox.
    const emitted = emitEnvelope(tmp, env)
    const inboxDir = join(tmp, 'gotong-in')
    mkdirSync(inboxDir, { recursive: true })
    copyFileSync(emitted.path, join(inboxDir, `${env.id}.json`))
    const rows = listInbox(tmp)
    expect(rows.some((r) => r.ok && r.id === env.id && r.title === '收件测试')).toBe(true)
    const res = readInboxFile(tmp, `${env.id}.json`)
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.sigVerdict).toEqual({ state: 'unsigned' })
      expect(res.envelope).toEqual(env)
    }
  })

  it('readInboxFile rejects path-shaped names before any join', () => {
    for (const evil of ['../secret.json', 'a/b.json', 'x.txt', '../up.json']) {
      const res = readInboxFile(tmp, evil)
      expect(res.ok).toBe(false)
    }
  })

  // ── pack manifest hygiene ──────────────────────────────────────────────────
  it('pi manifest entries exist on disk and runtime deps are zero', async () => {
    const pkg = JSON.parse(await readFile(join(packRoot, 'package.json'), 'utf8'))
    expect(pkg.dependencies).toBeUndefined()
    expect(Object.keys(pkg.peerDependencies ?? {})).toEqual(
      expect.arrayContaining(['@earendil-works/pi-ai', '@earendil-works/pi-coding-agent']),
    )
    const entries: string[] = [
      ...(pkg.pi?.extensions ?? []),
      ...(pkg.pi?.skills ?? []),
      ...(pkg.pi?.prompts ?? []),
    ]
    expect(entries.length).toBeGreaterThanOrEqual(3)
    for (const entry of entries) {
      expect(existsSync(join(packRoot, entry)), `manifest entry missing on disk: ${entry}`).toBe(true)
    }
  })

  it('SKILL.md carries the one field pi hard-requires (description), and prompts have frontmatter', async () => {
    const skill = await readFile(join(packRoot, 'skills/gotong-envelope/SKILL.md'), 'utf8')
    const skillFm = /^---\n([\s\S]*?)\n---/.exec(skill)
    expect(skillFm, 'SKILL.md must open with YAML frontmatter').toBeTruthy()
    expect(/^description:\s*\S+/m.test(skillFm![1])).toBe(true)
    for (const p of ['prompts/gotong-deliver.md', 'prompts/gotong-ingest.md']) {
      const text = await readFile(join(packRoot, p), 'utf8')
      const fm = /^---\n([\s\S]*?)\n---/.exec(text)
      expect(fm, `${p} must open with YAML frontmatter`).toBeTruthy()
      expect(/^description:\s*\S+/m.test(fm![1])).toBe(true)
    }
  })

  it('the extension imports only host-provided packages and its own lib', async () => {
    const ext = await readFile(join(packRoot, 'extensions/envelope.ts'), 'utf8')
    const imports = [...ext.matchAll(/from '([^']+)'/g)].map((m) => m[1])
    for (const spec of imports) {
      const allowed =
        spec.startsWith('./') || spec.startsWith('node:') ||
        spec === '@earendil-works/pi-ai' || spec === '@earendil-works/pi-coding-agent' || spec === 'typebox'
      expect(allowed, `forbidden import in pack extension: ${spec}`).toBe(true)
    }
    // The vendored core must not import anything beyond node builtins.
    const core = await readFile(join(packRoot, 'extensions/lib/envelope-core.ts'), 'utf8')
    for (const m of core.matchAll(/from '([^']+)'/g)) {
      expect(m[1].startsWith('node:'), `envelope-core must stay dependency-free, found: ${m[1]}`).toBe(true)
    }
  })
})
