import { describe, expect, it } from 'vitest'

import { classifyStewardAction, type StewardClassifyContext } from '../src/classify.js'
import type { StewardAction } from '../src/types.js'

const STEWARD_ID = 'me.u1.steward'

/** A ctx where `wf-cross` is the only cross-hub workflow. */
function ctx(crossHub: string[] = []): StewardClassifyContext {
  return { crossHubWorkflowIds: new Set(crossHub), stewardId: STEWARD_ID }
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
