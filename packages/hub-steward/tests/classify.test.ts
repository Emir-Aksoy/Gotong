import { describe, expect, it } from 'vitest'

import {
  authorityVerbFor,
  classifyStewardAction,
  type StewardClassifyContext,
} from '../src/classify.js'
import type { StewardAction } from '../src/types.js'

const STEWARD_ID = 'me.u1.steward'

/**
 * A ctx where `wf-cross` is the only cross-hub workflow. `operator` defaults to
 * `false` (the member steward) — the four sensitive writes are `forbidden`
 * there; pass `true` for the operator console (they become `dangerous`).
 */
function ctx(crossHub: string[] = [], operator = false): StewardClassifyContext {
  return { crossHubWorkflowIds: new Set(crossHub), stewardId: STEWARD_ID, operator }
}

const AGENT_FIELDS = {
  handle: 'emailer',
  label: 'Email summarizer',
  provider: 'anthropic' as const,
  system: 'You summarize emails.',
  capabilities: ['summarize'],
}

describe('classifyStewardAction — the tier table', () => {
  it('inspect (read-only answer) is safe', () => {
    expect(classifyStewardAction({ kind: 'inspect', answer: 'You own 2 agents.' }, ctx())).toBe('safe')
  })

  it('create_agent is safe (one confirmation)', () => {
    expect(classifyStewardAction({ kind: 'create_agent', ...AGENT_FIELDS }, ctx())).toBe('safe')
  })

  it('edit_agent is safe (one confirmation)', () => {
    const action: StewardAction = { kind: 'edit_agent', agentId: 'me.u1.emailer', changes: { label: 'New' } }
    expect(classifyStewardAction(action, ctx())).toBe('safe')
  })

  it('delete_agent is dangerous (★ second confirmation)', () => {
    expect(classifyStewardAction({ kind: 'delete_agent', agentId: 'me.u1.emailer' }, ctx())).toBe('dangerous')
  })

  it('edit_workflow on a PURELY-LOCAL workflow is safe', () => {
    const action: StewardAction = { kind: 'edit_workflow', workflowId: 'wf-local', instruction: 'be nicer' }
    expect(classifyStewardAction(action, ctx(['wf-cross']))).toBe('safe')
  })

  it('edit_workflow on a CROSS-HUB workflow is cross_hub (★ second confirmation)', () => {
    const action: StewardAction = { kind: 'edit_workflow', workflowId: 'wf-cross', instruction: 'be nicer' }
    expect(classifyStewardAction(action, ctx(['wf-cross']))).toBe('cross_hub')
  })

  it('refuse (out-of-scope / sensitive) is forbidden', () => {
    expect(classifyStewardAction({ kind: 'refuse', reason: 'I cannot change peer trust.' }, ctx())).toBe('forbidden')
  })
})

describe('classifyStewardAction — conservatism guarantees', () => {
  it('a cross-hub edit stays cross_hub regardless of how many local workflows exist', () => {
    const action: StewardAction = { kind: 'edit_workflow', workflowId: 'wf-cross', instruction: 'x' }
    expect(classifyStewardAction(action, ctx(['wf-a', 'wf-b', 'wf-cross', 'wf-c']))).toBe('cross_hub')
  })

  it('an unknown workflow id is treated as local (set miss → safe), the editor lock is the real backstop', () => {
    // Defensive: classifier only escalates a workflow KNOWN to be cross-hub. If the
    // host snapshot misses one, `MeWorkflowEditService.edit()` still byte-locks the
    // 出入口 (boundary_locked), so a mis-tier never lets an egress change through.
    const action: StewardAction = { kind: 'edit_workflow', workflowId: 'wf-unknown', instruction: 'x' }
    expect(classifyStewardAction(action, ctx(['wf-cross']))).toBe('safe')
  })
})

// ── B-M2: the four SENSITIVE writes (credentials / peer / security) ──────────
// A member steward never does these (forbidden); the operator console routes
// every one through the approval inbox (dangerous — stricter than delete_agent,
// enforced in B-M4). The `operator` flag is the ONLY thing that flips it, and it
// is a host-side construction flag, never a member-forgeable payload field.

const SENSITIVE: ReadonlyArray<{ label: string; action: StewardAction }> = [
  {
    label: 'set_credential_ref',
    action: { kind: 'set_credential_ref', provider: 'anthropic', envVarName: 'ANTHROPIC_API_KEY' },
  },
  { label: 'revoke_credential', action: { kind: 'revoke_credential', credentialId: 'cred_1' } },
  {
    label: 'set_peer_policy',
    action: { kind: 'set_peer_policy', peerId: 'peer_1', allowedDataClasses: ['public'] },
  },
  {
    label: 'set_security_quota',
    action: { kind: 'set_security_quota', scope: 'hub', metric: 'llm_tokens', period: 'day', limit: 1000 },
  },
]

describe('classifyStewardAction — sensitive writes are operator-only (B-M2)', () => {
  for (const { label, action } of SENSITIVE) {
    it(`${label} is forbidden for a MEMBER steward`, () => {
      expect(classifyStewardAction(action, ctx([], false))).toBe('forbidden')
    })
    it(`${label} is dangerous (★ always inbox) for an OPERATOR steward`, () => {
      expect(classifyStewardAction(action, ctx([], true))).toBe('dangerous')
    })
  }

  it('a cross-hub workflow set does not change sensitive tiering', () => {
    // The sensitive tier depends ONLY on `operator`, never on the workflow set.
    const action = SENSITIVE[0]!.action
    expect(classifyStewardAction(action, ctx(['wf-cross'], false))).toBe('forbidden')
    expect(classifyStewardAction(action, ctx(['wf-cross'], true))).toBe('dangerous')
  })
})

describe('authorityVerbFor — the human-confirm backstop (B-M2)', () => {
  for (const { label, action } of SENSITIVE) {
    it(`${label} maps to the change_security verb`, () => {
      expect(authorityVerbFor(action)).toBe('change_security')
    })
  }

  it('every non-sensitive kind maps to no verb (null)', () => {
    const benign: StewardAction[] = [
      { kind: 'inspect', answer: 'x' },
      { kind: 'create_agent', ...AGENT_FIELDS },
      { kind: 'edit_agent', agentId: 'me.u1.emailer', changes: {} },
      { kind: 'delete_agent', agentId: 'me.u1.emailer' },
      { kind: 'edit_workflow', workflowId: 'wf', instruction: 'x' },
      { kind: 'refuse', reason: 'x' },
    ]
    for (const action of benign) expect(authorityVerbFor(action)).toBeNull()
  })
})
