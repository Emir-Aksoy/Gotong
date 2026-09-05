import { describe, expect, it } from 'vitest'
import { DeliveryEvidenceError, evaluateAcceptance, parseAcceptance, buildDeliveryEvidence, verifyDeliveryEvidence } from '../src/delivery-evidence.js'

const checks = [
  { id: 'answer', path: '/text', op: 'equals', expected: '42' },
  { id: 'review', op: 'human', description: 'Review the conclusion' },
]
const request = { id: 'request-1', payload: { question: 'answer' }, acceptance: checks }
const payload = { ok: true, output: { text: '42' } }

describe('delivery evidence', () => {
  it('rejects an undefined equals expectation before the detached copy can drop it', () => {
    expect(() => parseAcceptance([{ id: 'a', op: 'equals', path: '', expected: undefined }]))
      .toThrow(DeliveryEvidenceError)
    expect(parseAcceptance([{ id: 'a', op: 'equals', path: '', expected: null }]))
      .toEqual([{ id: 'a', op: 'equals', path: '', expected: null }])
  })

  it('preserves __proto__ in equality checks instead of weakening the expected value', () => {
    const expected = JSON.parse('{"__proto__":{"approved":true}}')
    const c = parseAcceptance([{ id: 'exact', op: 'equals', path: '', expected }])
    expect(JSON.stringify(c[0])).toContain('"__proto__"')
    expect(evaluateAcceptance(c, {})).toEqual([{ id: 'exact', status: 'failed' }])
    expect(evaluateAcceptance(c, expected)).toEqual([{ id: 'exact', status: 'passed' }])
  })

  it('binds prototype-named fields in both the delivered payload and original request', () => {
    const original = { ...request, payload: JSON.parse('{"__proto__":{"instruction":"original"}}'), acceptance: [checks[0]] }
    const delivered = { ...payload, output: { ...payload.output, data: JSON.parse('{"__proto__":{"value":"original"}}') } }
    const evidence = buildDeliveryEvidence(original, delivered, { taskId: 't1', by: 'atong' })
    expect(verifyDeliveryEvidence(evidence, delivered, original).accepted).toBe(true)
    const changedPayload = JSON.parse(JSON.stringify(delivered))
    changedPayload.output.data.__proto__.value = 'changed'
    expect(verifyDeliveryEvidence(evidence, changedPayload, original).consistent).toBe(false)
    const changedRequest = JSON.parse(JSON.stringify(original))
    changedRequest.payload.__proto__.instruction = 'changed'
    expect(verifyDeliveryEvidence(evidence, delivered, changedRequest).requestMatch).toBe('mismatch')
  })

  it('rejects invalid task provenance when building evidence', () => {
    for (const provenance of [undefined, { taskId: '', by: 'atong' }, { taskId: 't1', by: '' }]) {
      expect(() => buildDeliveryEvidence(request, payload, provenance as never)).toThrow(DeliveryEvidenceError)
    }
  })

  it('computes pass, fail and untested from actual output, never a supplied verdict', () => {
    expect(evaluateAcceptance(parseAcceptance(checks), payload.output)).toEqual([
      { id: 'answer', status: 'passed' }, { id: 'review', status: 'untested' },
    ])
    expect(evaluateAcceptance(parseAcceptance(checks), { text: 'wrong' })[0]?.status).toBe('failed')
    expect(() => parseAcceptance([{ ...checks[0], status: 'passed' }])).toThrow()
  })
  it('distinguishes missing, null and inherited fields and decodes JSON pointers', () => {
    const c = parseAcceptance([
      { id: 'null', path: '/null', op: 'equals', expected: null },
      { id: 'missing', path: '/missing', op: 'equals', expected: null },
      { id: 'proto', path: '/toString', op: 'exists' },
      { id: 'escaped', path: '/a~1b/~0', op: 'equals', expected: 3 },
    ])
    expect(evaluateAcceptance(c, { null: null, 'a/b': { '~': 3 } }).map(x => x.status))
      .toEqual(['passed', 'failed', 'failed', 'passed'])
  })
  it('selects only JSON array indices, never JavaScript length or padded indices', () => {
    const c = parseAcceptance(['0', '01', 'length', '-'].map(path => ({ id: path, op: 'exists', path: '/' + path })))
    expect(evaluateAcceptance(c, ['a', 'b']).map(r => r.status)).toEqual(['passed', 'failed', 'failed', 'failed'])
    expect(evaluateAcceptance(parseAcceptance([{ id: 'length', op: 'equals', path: '/length', expected: 2 }]), { length: 2 })[0]?.status).toBe('passed')
  })
  it('rejects duplicate ids, malformed pointers, unknown operations and oversized suites', () => {
    for (const c of [
      [checks[0], checks[0]], [{ id: 'x', path: '/~2', op: 'exists' }],
      [{ id: 'x', path: '', op: 'exec', command: 'touch /tmp/no' }],
      Array.from({ length: 33 }, (_, i) => ({ id: String(i), path: '', op: 'exists' })),
    ]) expect(() => parseAcceptance(c)).toThrow()
  })
  it('binds exact delivered bytes, task provenance and the original request', () => {
    const evidence = buildDeliveryEvidence(request, payload, { taskId: 't1', by: 'atong' })
    expect(verifyDeliveryEvidence(evidence, payload, request)).toMatchObject({ consistent: true, requestMatch: 'matched', passed: 1, untested: 1 })
    expect(verifyDeliveryEvidence(evidence, payload)).toMatchObject({ consistent: true, requestMatch: 'not_provided' })
    expect(verifyDeliveryEvidence(evidence, { ...payload, output: { text: '43' } }, request).consistent).toBe(false)
    expect(verifyDeliveryEvidence(evidence, payload, { ...request, payload: { question: 'other' } }).requestMatch).toBe('mismatch')
  })
  it('recomputes claimed results and refuses a tampered pass even with a matching payload', () => {
    const evidence = buildDeliveryEvidence(request, { ...payload, output: { text: 'wrong' } }, { taskId: 't1', by: 'atong' })
    evidence.results[0]!.status = 'passed'
    expect(verifyDeliveryEvidence(evidence, { ...payload, output: { text: 'wrong' } }, request).consistent).toBe(false)
  })
  it('does not call a failed execution accepted because its output happens to match', () => {
    const automaticRequest = { ...request, acceptance: [checks[0]] }
    for (const ok of [true, false]) {
      const result = { ...payload, ok }
      const e = buildDeliveryEvidence(automaticRequest, result, { taskId: 't1', by: 'atong' })
      expect(verifyDeliveryEvidence(e, result, automaticRequest)).toEqual({
        consistent: true, requestMatch: 'matched', accepted: ok, passed: 1, failed: 0, untested: 0,
      })
    }
  })
})
