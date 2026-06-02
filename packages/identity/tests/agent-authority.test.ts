/**
 * v5 Stream 0-M2 — agent-as-owner authority boundary.
 *
 * Pure policy gate: a closed set of high-risk actions an agent principal may
 * not do alone (decision #2). Non-agent principals are unrestricted; agents
 * get `requires_human` exactly on the sensitive verbs.
 */

import { describe, expect, it } from 'vitest'

import {
  AGENT_HUMAN_CONFIRM_ACTIONS,
  isHumanConfirmAction,
  describeHumanConfirmAction,
  authorizeAgentAction,
  type AgentHumanConfirmAction,
} from '../src/agent-authority.js'
import { agentPrincipal, userPrincipal, hubPrincipal, peerPrincipal } from '../src/principal.js'

describe('AGENT_HUMAN_CONFIRM_ACTIONS', () => {
  it('is the closed high-risk set from decision #2', () => {
    expect([...AGENT_HUMAN_CONFIRM_ACTIONS]).toEqual([
      'modify_owner_grant',
      'delete_audit',
      'change_security',
    ])
  })

  it('isHumanConfirmAction guards membership', () => {
    expect(isHumanConfirmAction('delete_audit')).toBe(true)
    expect(isHumanConfirmAction('modify_owner_grant')).toBe(true)
    expect(isHumanConfirmAction('run_workflow')).toBe(false)
    expect(isHumanConfirmAction('')).toBe(false)
  })

  it('every action has a non-empty human-readable reason', () => {
    for (const a of AGENT_HUMAN_CONFIRM_ACTIONS) {
      expect(describeHumanConfirmAction(a as AgentHumanConfirmAction).length).toBeGreaterThan(0)
    }
  })
})

describe('authorizeAgentAction — non-agent principals are unrestricted', () => {
  it('a human user may do even the sensitive actions alone (they ARE the confirmation)', () => {
    expect(authorizeAgentAction(userPrincipal('u1'), 'delete_audit')).toEqual({ kind: 'allow' })
    expect(authorizeAgentAction(userPrincipal('u1'), 'modify_owner_grant')).toEqual({ kind: 'allow' })
  })

  it('the hub itself and peers are allowed (own RBAC / federation policy governs them)', () => {
    expect(authorizeAgentAction(hubPrincipal(), 'change_security')).toEqual({ kind: 'allow' })
    expect(authorizeAgentAction(peerPrincipal('hub-b'), 'delete_audit')).toEqual({ kind: 'allow' })
  })
})

describe('authorizeAgentAction — agent principals are gated', () => {
  it('allows ordinary actions (manage own resources / spend / send)', () => {
    expect(authorizeAgentAction(agentPrincipal('writer'), 'run_workflow')).toEqual({ kind: 'allow' })
    expect(authorizeAgentAction(agentPrincipal('writer'), 'send_message')).toEqual({ kind: 'allow' })
    expect(authorizeAgentAction(agentPrincipal('writer'), 'spend_budget')).toEqual({ kind: 'allow' })
  })

  it('requires a human for each high-risk action, carrying the action + reason', () => {
    for (const action of AGENT_HUMAN_CONFIRM_ACTIONS) {
      const d = authorizeAgentAction(agentPrincipal('writer'), action)
      expect(d.kind).toBe('requires_human')
      if (d.kind === 'requires_human') {
        expect(d.action).toBe(action)
        expect(d.reason).toBe(describeHumanConfirmAction(action))
        expect(d.reason).toMatch(/human owner must confirm/)
      }
    }
  })

  it('the gate is closed-by-enumeration: a new unknown action is allowed, not blocked', () => {
    // A future sensitive action must be ADDED to the list explicitly; the gate
    // never blocks an unknown verb (closed human-gated set, not open allowlist).
    expect(authorizeAgentAction(agentPrincipal('writer'), 'some_future_action')).toEqual({ kind: 'allow' })
  })
})
