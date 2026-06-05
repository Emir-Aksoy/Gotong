import { describe, it, expect } from 'vitest'

import {
  ACP_NEVER_RESUME_AT,
  ACP_CHECKPOINT_STATE_V,
  dangerousToolGate,
  pickOptionId,
  readPermissionDecision,
  acpParkState,
  readAcpCheckpointState,
  toolContext,
  type AcpToolContext,
  type AcpPermissionOption,
} from '../src/acp-checkpoint.js'

const ctx = (over: Partial<AcpToolContext>): AcpToolContext => ({
  taskId: 't1' as AcpToolContext['taskId'],
  kind: undefined,
  title: undefined,
  rawInput: undefined,
  ...over,
})

describe('dangerousToolGate', () => {
  it('allows a benign tool inline (no match)', () => {
    const gate = dangerousToolGate()
    expect(gate(ctx({ kind: 'edit', title: 'update README.md' }))).toEqual({ allow: true })
  })

  it('escalates a destructive tool by default', () => {
    const gate = dangerousToolGate()
    const v = gate(ctx({ kind: 'execute', title: 'rm -rf build' }))
    expect(v).toMatchObject({ escalate: true })
  })

  it('matches on rawInput too', () => {
    const gate = dangerousToolGate()
    const v = gate(ctx({ kind: 'execute', title: 'run', rawInput: { cmd: 'git push --force' } }))
    expect(v).toMatchObject({ escalate: true })
  })

  it('onMatch:"deny" refuses inline instead of escalating', () => {
    const gate = dangerousToolGate(undefined, { onMatch: 'deny' })
    expect(gate(ctx({ title: 'sudo reboot' }))).toMatchObject({ deny: true })
  })

  it('honours custom patterns', () => {
    const gate = dangerousToolGate([/\bsecret\b/i])
    expect(gate(ctx({ title: 'read the secret file' }))).toMatchObject({ escalate: true })
    expect(gate(ctx({ title: 'rm -rf build' }))).toEqual({ allow: true }) // not in the custom set
  })
})

describe('pickOptionId', () => {
  const opts: AcpPermissionOption[] = [
    { optionId: 'a1', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'a2', name: 'Always allow', kind: 'allow_always' },
    { optionId: 'r1', name: 'Reject', kind: 'reject_once' },
  ]

  it('prefers the once variant by kind', () => {
    expect(pickOptionId(opts, 'allow')).toBe('a1')
    expect(pickOptionId(opts, 'reject')).toBe('r1')
  })

  it('falls back to the always variant when no once', () => {
    expect(pickOptionId([{ optionId: 'x', name: 'Always', kind: 'allow_always' }], 'allow')).toBe('x')
  })

  it('falls back to a name/id text match for unknown kinds', () => {
    const weird: AcpPermissionOption[] = [
      { optionId: 'yes', name: 'Approve it', kind: 'proceed' },
      { optionId: 'no', name: 'Deny it', kind: 'stop' },
    ]
    expect(pickOptionId(weird, 'allow')).toBe('yes')
    expect(pickOptionId(weird, 'reject')).toBe('no')
  })

  it('returns undefined when nothing matches', () => {
    expect(pickOptionId([{ optionId: 'm', name: 'Maybe', kind: 'dunno' }], 'reject')).toBeUndefined()
  })
})

describe('readPermissionDecision', () => {
  it('reads the persisted-state shape (decision)', () => {
    expect(readPermissionDecision({ decision: { approved: true } })).toEqual({ approved: true })
  })

  it('reads the inbox shape (answer) with a note', () => {
    expect(readPermissionDecision({ answer: { approved: false, note: 'too risky' } })).toEqual({
      approved: false,
      note: 'too risky',
    })
  })

  it('returns null for garbage / missing approved', () => {
    expect(readPermissionDecision(null)).toBeNull()
    expect(readPermissionDecision({})).toBeNull()
    expect(readPermissionDecision({ decision: { foo: 1 } })).toBeNull()
    expect(readPermissionDecision({ answer: 'yes' })).toBeNull()
  })
})

describe('checkpoint state round-trip', () => {
  it('builds and reads back the park state', () => {
    const s = acpParkState({
      permissionToken: 'acp-perm-3',
      reason: 'matched destructive pattern /rm/',
      tool: { kind: 'execute', title: 'rm -rf build' },
    })
    expect(s.v).toBe(ACP_CHECKPOINT_STATE_V)
    expect(s.kind).toBe('permission')
    const read = readAcpCheckpointState(s)
    expect(read?.permissionToken).toBe('acp-perm-3')
    expect(read?.tool.title).toBe('rm -rf build')
  })

  it('tolerates the host-merged shape (fields at top level alongside a decision)', () => {
    const merged = {
      ...acpParkState({ permissionToken: 'tok', reason: 'r', tool: { kind: 'x', title: 'y' } }),
      decision: { approved: true },
    }
    expect(readAcpCheckpointState(merged)?.permissionToken).toBe('tok')
  })

  it('tolerates a nested {state} shape and rejects missing token', () => {
    const nested = { state: acpParkState({ permissionToken: 'tok', reason: 'r', tool: { kind: undefined, title: undefined } }) }
    expect(readAcpCheckpointState(nested)?.permissionToken).toBe('tok')
    expect(readAcpCheckpointState({ v: 1, kind: 'permission' })).toBeNull()
    expect(readAcpCheckpointState(null)).toBeNull()
  })
})

describe('toolContext + constants', () => {
  it('maps a tool call into the gate context', () => {
    const c = toolContext('task-9' as AcpToolContext['taskId'], {
      title: 'edit file',
      kind: 'edit',
      rawInput: { path: 'a.ts' },
    })
    expect(c).toEqual({ taskId: 'task-9', title: 'edit file', kind: 'edit', rawInput: { path: 'a.ts' } })
  })

  it('NEVER_RESUME_AT sits beyond any real clock', () => {
    expect(ACP_NEVER_RESUME_AT).toBeGreaterThan(Date.now() + 1000 * 60 * 60 * 24 * 365 * 100)
  })
})
