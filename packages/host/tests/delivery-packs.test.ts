import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import { ecThumbprint, es256Sign } from '@gotong/a2a'
import { parseExchangeEnvelope, buildResultEnvelope, signExchangeEnvelope } from '../src/exchange-envelope.js'
import { parseEnvelopeText as piParse, verifyEnvelopeSig as piSig } from '../../../packs/pi/extensions/lib/envelope-core.js'
import { parseEnvelopeText as dshParse, verifyEnvelopeSig as dshSig } from '../../../packs/dsh/skills/gotong-envelope/scripts/envelope.mjs'
import { verifyDeliveryEvidence as piVerify } from '../../../packs/pi/extensions/lib/delivery-evidence.mjs'
import { verifyDeliveryEvidence as dshVerify } from '../../../packs/dsh/skills/gotong-envelope/scripts/delivery-evidence.mjs'

const request = {
  schema: 'gotong.envelope/v1', id: 'exg-evidence00000001', kind: 'request',
  createdAt: '2026-09-04T00:00:00Z', from: { name: 'tester' }, title: 'answer', payload: { question: 'answer' },
  acceptance: [{ id: 'text', op: 'equals', path: '/text', expected: '42' }],
}
const script = fileURLToPath(new URL('../../../packs/workbuddy/skills/gotong-envelope/scripts/validate.py', import.meta.url))
function pythonParse(raw: string) {
  const r = spawnSync('python3', ['-c', 'import runpy,sys,json; m=runpy.run_path(sys.argv[1]); print(json.dumps(m["parse_envelope_text"](sys.stdin.read())))', script], { input: raw, encoding: 'utf8' })
  expect(r.status, r.stderr).toBe(0)
  return JSON.parse(r.stdout)
}
describe('delivery evidence pack interoperability', () => {
  it('public pack tools expose evidence failures and unsupported verification', async () => {
    const parsed = parseExchangeEnvelope(JSON.stringify(request))
    if (!parsed.ok) throw new Error('Invalid fixture')
    const result = buildResultEnvelope({ request: parsed.envelope, ok: true, output: { text: 'WRONG' }, fromName: 'hub', provenance: { taskId: 't1', by: 'atong' } })
    const tmp = mkdtempSync(join(tmpdir(), 'gotong-pack-evidence-'))
    mkdirSync(join(tmp, 'gotong-in'))
    const file = `${result.id}.json`
    writeFileSync(join(tmp, 'gotong-in', file), JSON.stringify(result))
    const dsh = fileURLToPath(new URL('../../../packs/dsh/skills/gotong-envelope/scripts/envelope.mjs', import.meta.url))
    const read = spawnSync(process.execPath, [dsh, 'ingest', file], { cwd: tmp, encoding: 'utf8' })
    expect(read.status, read.stderr).toBe(0)
    expect(read.stdout).toContain('"failed":1')
    expect(read.stdout).toContain('"accepted":false')
    expect(read.stdout).toContain('not_provided')
    const python = spawnSync('python3', [script, 'ingest', file], { cwd: tmp, encoding: 'utf8' })
    expect(python.status, python.stderr).toBe(0)
    expect(python.stdout).toContain('not_checked')
    // Exercise pi's registered callback; only its SDK schema/registration helpers
    // are substituted, not the pack reader, verifier or output rendering.
    const { build } = createRequire(new URL('../../web/package.json', import.meta.url))('esbuild')
    const bundle = await build({
      entryPoints: [fileURLToPath(new URL('../../../packs/pi/extensions/envelope.ts', import.meta.url))],
      bundle: true, platform: 'node', format: 'esm', write: false,
      plugins: [{ name: 'pi-registration-fixture', setup(b: any) {
        b.onResolve({ filter: /^@earendil-works\// }, (a: any) => ({ path: a.path, namespace: 'pi-fixture' }))
        b.onLoad({ filter: /.*/, namespace: 'pi-fixture' }, () => ({ contents: 'export const Type = new Proxy({}, { get: () => (...args) => ({ args }) }); export const defineTool = x => x;' }))
      } }],
    })
    const extension = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].contents).toString('base64'))
    const registered: any[] = []
    extension.default({ registerTool: (tool: any) => registered.push(tool) })
    const view = await registered.find(tool => tool.name === 'gotong_ingest').execute('', { file }, undefined, undefined, { cwd: tmp })
    expect(view.content[0].text).toContain('"failed":1')
    expect(view.details.evidence).toMatchObject({ failed: 1, accepted: false, requestMatch: 'not_provided' })
    result.payload.output = { text: '42' }
    writeFileSync(join(tmp, 'gotong-in', file), JSON.stringify(result))
    expect(spawnSync(process.execPath, [dsh, 'ingest', file], { cwd: tmp, encoding: 'utf8' }).stdout).toContain('"consistent":false')
  })
  it('rejects noncanonical JSON input in every reader before dispatch', () => {
    for (const bad of ['1e309', '"\\ud800"']) {
      const raw = JSON.stringify(request).replace('"question":"answer"', `"question":${bad}`)
      for (const parse of [parseExchangeEnvelope, piParse, dshParse, pythonParse]) expect(parse(raw).ok).toBe(false)
    }
  })
  it('Node packs preserve signed prototype fields and lexical integer-key ordering', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    const jwk = publicKey.export({ format: 'jwk' })
    const pub = { kty: 'EC' as const, crv: 'P-256' as const, x: jwk.x!, y: jwk.y! }
    const parsed = parseExchangeEnvelope(JSON.stringify({ ...request, payload: JSON.parse('{"__proto__":{"value":"original"},"2":2,"10":10}') }))
    if (!parsed.ok) throw new Error('Invalid fixture')
    const signed = signExchangeEnvelope(parsed.envelope, { kid: () => ecThumbprint(pub), publicJwk: () => pub, sign: (bytes) => es256Sign(privateKey, bytes) })
    for (const verify of [piSig, dshSig]) {
      expect(verify(signed).state).toBe('valid')
      const changed = JSON.parse(JSON.stringify(signed))
      changed.payload.__proto__.value = 'changed'
      expect(verify(changed).state).toBe('invalid')
    }
  })
  it('all three standalone packs accept evidenced results and reject forged check structure', () => {
    const parsed = parseExchangeEnvelope(JSON.stringify(request))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const result = buildResultEnvelope({ request: parsed.envelope, ok: true, output: { text: '42' }, fromName: 'hub', provenance: { taskId: 't1', by: 'atong' } })
    for (const parse of [piParse, dshParse, pythonParse]) {
      expect(parse(JSON.stringify(request)).ok).toBe(true)
      expect(parse(JSON.stringify(result)).ok).toBe(true)
      expect(parse(JSON.stringify({ ...request, acceptance: [{ ...request.acceptance[0], passed: true }] })).ok).toBe(false)
      expect(parse(JSON.stringify({ ...result, evidence: { ...result.evidence, results: [] } })).ok).toBe(false)
    }
    for (const verify of [piVerify, dshVerify]) {
      expect(verify(result.evidence, result.payload, request).accepted).toBe(true)
      expect(verify(result.evidence, { ok: true, output: { text: '43' } }, request).accepted).toBe(false)
    }
  })
})
