import { createHash } from 'node:crypto'
import { jcsCanonicalize } from '@gotong/a2a'
export { jcsCanonicalize } from '@gotong/a2a'

export type AcceptanceCheck =
  | { id: string; op: 'human'; description: string }
  | { id: string; op: 'exists'; path: string }
  | { id: string; op: 'equals'; path: string; expected: unknown }
  | { id: string; op: 'contains'; path: string; expected: string }
export interface CheckResult { id: string; status: 'passed' | 'failed' | 'untested' }
export interface DeliveryEvidence {
  schema: 'gotong.evidence/v1'
  requestDigest: string
  payloadDigest: string
  checks: AcceptanceCheck[]
  results: CheckResult[]
  provenance: { taskId: string; by: string }
}
export interface DeliveryVerification {
  consistent: boolean
  requestMatch: 'matched' | 'mismatch' | 'not_provided'
  /** Requires the original request, successful execution, and every check passing. */
  accepted: boolean
  passed: number
  failed: number
  untested: number
}
export class DeliveryEvidenceError extends Error {
  readonly code = 'invalid_delivery_evidence'
  constructor(message: string) { super(message); this.name = 'DeliveryEvidenceError' }
}

function fail(message: string): never { throw new DeliveryEvidenceError(message) }
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const own = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key)
const digest = (value: unknown): string => createHash('sha256').update(jcsCanonicalize(value)).digest('hex')
const HASH = /^[a-f0-9]{64}$/
function keys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some(k => !allowed.includes(k))) fail('unknown evidence/check field')
}
function label(value: unknown, max = 200): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max &&
    !/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(value)
}

function parseProvenance(value: unknown): DeliveryEvidence['provenance'] {
  if (!object(value)) fail('evidence requires task provenance')
  keys(value, ['taskId', 'by'])
  if (!label(value.taskId) || !label(value.by)) fail('invalid task provenance')
  return { taskId: value.taskId, by: value.by }
}

/** Received checks are data, never commands, paths on disk, URLs, or regexes. */
export function parseAcceptance(value: unknown): AcceptanceCheck[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) fail('acceptance requires 1..32 checks')
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 16 * 1024) fail('acceptance exceeds 16384 bytes')
  const ids = new Set<string>()
  for (const c of value) {
    if (!object(c) || !label(c.id, 64) || ids.has(c.id)) fail('invalid or duplicate check id')
    ids.add(c.id)
    if (c.op === 'human') {
      keys(c, ['id', 'op', 'description'])
      if (!label(c.description, 500)) fail('human check requires a description')
      continue
    }
    if (c.op !== 'exists' && c.op !== 'equals' && c.op !== 'contains') fail('unknown check operation')
    keys(c, c.op === 'exists' ? ['id', 'op', 'path'] : ['id', 'op', 'path', 'expected'])
    if (typeof c.path !== 'string' || c.path.length > 500 ||
        (c.path !== '' && !c.path.startsWith('/')) || /~(?![01])/u.test(c.path)) fail('invalid JSON pointer')
    if (c.op !== 'exists' && (!own(c, 'expected') || c.expected === undefined)) fail('check requires a defined expected value')
    if (c.op === 'contains' && (typeof c.expected !== 'string' || c.expected.length === 0)) fail('contains requires non-empty expected text')
  }
  // Return a detached JSON copy so callers cannot change the stored checks.
  return JSON.parse(jcsCanonicalize(value)) as AcceptanceCheck[]
}

function select(value: unknown, pointer: string): { found: boolean; value?: unknown } {
  let current = value
  if (current === undefined) return { found: false }
  for (const part of pointer === '' ? [] : pointer.slice(1).split('/')) {
    const key = part.replace(/~1/g, '/').replace(/~0/g, '~')
    // Array length is an own JavaScript property, but is not a JSON member.
    if (Array.isArray(current) && !/^(0|[1-9][0-9]*)$/.test(key)) return { found: false }
    if (current === null || typeof current !== 'object' || !own(current, key)) return { found: false }
    current = (current as Record<string, unknown>)[key]
  }
  return { found: true, value: current }
}

export function evaluateAcceptance(checks: readonly AcceptanceCheck[], output: unknown): CheckResult[] {
  return checks.map(c => {
    if (c.op === 'human') return { id: c.id, status: 'untested' }
    const selected = select(output, c.path)
    const passed = selected.found && (c.op === 'exists' ||
      (c.op === 'contains' ? typeof selected.value === 'string' && selected.value.includes(c.expected)
        : jcsCanonicalize(selected.value) === jcsCanonicalize(c.expected)))
    return { id: c.id, status: passed ? 'passed' : 'failed' }
  })
}

export function buildDeliveryEvidence(
  request: unknown,
  payload: Record<string, unknown>,
  provenance: DeliveryEvidence['provenance'],
): DeliveryEvidence {
  if (!object(request)) fail('request must be an object')
  const checks = parseAcceptance(request.acceptance)
  return {
    schema: 'gotong.evidence/v1', requestDigest: digest(request), payloadDigest: digest(payload),
    checks, results: evaluateAcceptance(checks, payload.output), provenance: parseProvenance(provenance),
  }
}

export function parseDeliveryEvidence(value: unknown): DeliveryEvidence {
  if (!object(value)) fail('evidence must be an object')
  keys(value, ['schema', 'requestDigest', 'payloadDigest', 'checks', 'results', 'provenance'])
  if (value.schema !== 'gotong.evidence/v1' || typeof value.requestDigest !== 'string' || !HASH.test(value.requestDigest) ||
      typeof value.payloadDigest !== 'string' || !HASH.test(value.payloadDigest)) fail('invalid evidence schema or digest')
  const checks = parseAcceptance(value.checks)
  if (!Array.isArray(value.results) || value.results.length !== checks.length) fail('evidence requires one result per check')
  for (const [i, r] of value.results.entries()) {
    if (!object(r)) fail('invalid check result')
    keys(r, ['id', 'status'])
    if (r.id !== checks[i]!.id || !['passed', 'failed', 'untested'].includes(String(r.status))) fail('invalid check result')
  }
  parseProvenance(value.provenance)
  return JSON.parse(jcsCanonicalize(value)) as DeliveryEvidence
}

/** Self-consistency is separate from matching the receiver's original request. */
export function verifyDeliveryEvidence(
  value: unknown, payload: Record<string, unknown>, originalRequest?: unknown,
): DeliveryVerification {
  const e = parseDeliveryEvidence(value)
  const recomputed = evaluateAcceptance(e.checks, payload.output)
  const consistent = e.payloadDigest === digest(payload) && jcsCanonicalize(recomputed) === jcsCanonicalize(e.results)
  const requestMatch = originalRequest === undefined ? 'not_provided' :
    object(originalRequest) && own(originalRequest, 'acceptance') && e.requestDigest === digest(originalRequest) &&
    jcsCanonicalize(e.checks) === jcsCanonicalize(originalRequest.acceptance) ? 'matched' : 'mismatch'
  const passed = recomputed.filter(r => r.status === 'passed').length
  const failed = recomputed.filter(r => r.status === 'failed').length
  const untested = recomputed.filter(r => r.status === 'untested').length
  return { consistent, requestMatch, accepted: consistent && requestMatch === 'matched' && payload.ok === true &&
    failed === 0 && untested === 0, passed, failed, untested }
}
