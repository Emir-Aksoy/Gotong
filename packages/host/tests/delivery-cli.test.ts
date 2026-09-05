import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { buildResultEnvelope, parseExchangeEnvelope } from '../src/exchange-envelope.js'

const cli = fileURLToPath(new URL('../../../scripts/verify-delivery.mjs', import.meta.url))
describe('delivery verification command', () => {
  it('reverifies a real file pair and fails on missing, wrong, tampered or untested evidence', () => {
    const parsed = parseExchangeEnvelope(JSON.stringify({
      schema: 'gotong.envelope/v1', id: 'exg-cli-request0001', kind: 'request',
      createdAt: '2026-09-04T00:00:00Z', from: { name: 'User' }, title: 'A task', payload: { question: 'Answer' },
      acceptance: [{ id: 'answer', op: 'equals', path: '/text', expected: '42' }],
    }))
    if (!parsed.ok) throw new Error('Invalid fixture')
    const request = parsed.envelope
    const result = buildResultEnvelope({ request, ok: true, output: { text: '42', note: 'PRIVATE_RESULT_BODY' }, fromName: 'Agent', provenance: { taskId: 't1', by: 'atong' } })
    const tmp = mkdtempSync(join(tmpdir(), 'gotong-evidence-cli-'))
    const rp = join(tmp, 'request.json'), op = join(tmp, 'result.json')
    writeFileSync(rp, JSON.stringify(request))
    const run = (value: unknown, original = rp) => {
      writeFileSync(op, JSON.stringify(value))
      return spawnSync(process.execPath, [cli, op, original], { encoding: 'utf8' })
    }
    const ok = run(result)
    expect(ok.status, ok.stderr).toBe(0)
    expect(JSON.parse(ok.stdout)).toMatchObject({ signature: { state: 'unsigned' }, evidence: { accepted: true } })
    expect(ok.stdout).not.toContain('PRIVATE_RESULT_BODY')
    expect(run({ ...result, payload: { ok: true, output: { text: '43' } } }).status).toBe(1)
    expect(run({ ...result, replyTo: 'exg-wrong000000001' }).status).toBe(1)
    expect(run({ ...result, evidence: undefined }).status).toBe(1)
    expect(run(result, join(tmp, 'missing.json')).status).toBe(1)
    const humanRequest = { ...request, acceptance: [{ id: 'human', op: 'human' as const, description: 'Review' }] }
    writeFileSync(rp, JSON.stringify(humanRequest))
    expect(run(buildResultEnvelope({ request: humanRequest, ok: true, output: '42', fromName: 'Agent', provenance: { taskId: 't1', by: 'atong' } })).status).toBe(1)
  })
})
