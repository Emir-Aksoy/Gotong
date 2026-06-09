/**
 * WFEDIT-M1 — unit tests for the pure cross-hub boundary lock. No Hub, no LLM,
 * no versioning: it's a function over (original def, edited def, local caps,
 * peer entries). We exercise the decision logic directly.
 *
 * Contract under test:
 *   - a local-only edit (no egress)                    → ok (trigger preserved)
 *   - changing the trigger capability                  → trigger_changed
 *   - editing a LOCAL step in a cross-hub workflow     → ok (egress preserved)
 *   - repointing an egress step to another peer cap    → egress_retargeted
 *   - deleting an egress step / making it local        → egress_removed
 *   - adding a brand-new egress step                   → egress_added
 *   - changing an egress node's data classes           → egress_dataclass_changed
 *   - reordering data classes (canonical)              → NOT a violation
 *   - a parallel-branch egress is addressed by composite id
 */

import { describe, expect, it } from 'vitest'

import { WORKFLOW_SCHEMA_V1, type Step, type WorkflowDefinition } from '@aipehub/workflow'

import {
  enforceEditBoundary,
  workflowBoundary,
  type PeerCapEntry,
} from '../src/workflow-edit-guard.js'

function wf(steps: Step[], trigger = 'run-flow'): WorkflowDefinition {
  return { schema: WORKFLOW_SCHEMA_V1, id: 'flow', trigger: { capability: trigger }, steps }
}

function capStep(id: string, capability: string, dataClasses?: string[]): Step {
  return {
    kind: 'simple',
    id,
    dispatch: {
      strategy: { kind: 'capability', capabilities: [capability] },
      payload: {},
      ...(dataClasses ? { dataClasses } : {}),
    },
  }
}

/** A local step whose payload we can vary to simulate "editing my own part". */
function localStep(id: string, capability: string, payload: unknown): Step {
  return {
    kind: 'simple',
    id,
    dispatch: { strategy: { kind: 'capability', capabilities: [capability] }, payload },
  }
}

const LOCAL = new Set(['wf.draft'])
const PEER: PeerCapEntry = {
  peer: 'supplier-hub',
  label: '供货商 Hub',
  capabilities: ['supplier.confirm-order'],
}
/** A peer that serves two off-hub caps — lets us test a true retarget (cap→cap). */
const PEER2: PeerCapEntry = {
  peer: 'supplier-hub',
  label: '供货商 Hub',
  capabilities: ['supplier.confirm-order', 'supplier.express'],
}

describe('workflowBoundary', () => {
  it('reports trigger + egress (with data classes) for a cross-hub workflow', () => {
    const def = wf([
      capStep('draft', 'wf.draft'),
      capStep('place', 'supplier.confirm-order', ['public']),
    ])
    expect(workflowBoundary(def, LOCAL, [PEER])).toEqual({
      trigger: 'run-flow',
      egress: [{ stepId: 'place', capability: 'supplier.confirm-order', dataClasses: ['public'] }],
    })
  })

  it('has empty egress for a purely-local workflow', () => {
    const def = wf([capStep('draft', 'wf.draft')])
    expect(workflowBoundary(def, LOCAL, [PEER])).toEqual({ trigger: 'run-flow', egress: [] })
  })
})

describe('enforceEditBoundary — local edits are allowed', () => {
  it('allows editing a LOCAL step payload in a cross-hub workflow', () => {
    const before = wf([
      localStep('draft', 'wf.draft', { note: 'old' }),
      capStep('place', 'supplier.confirm-order', ['public']),
    ])
    const after = wf([
      localStep('draft', 'wf.draft', { note: 'NEW longer instruction from the member' }),
      capStep('place', 'supplier.confirm-order', ['public']),
    ])
    expect(enforceEditBoundary(before, after, LOCAL, [PEER])).toEqual({ ok: true })
  })

  it('allows a purely-local workflow edit (only the trigger is locked)', () => {
    const before = wf([localStep('draft', 'wf.draft', { a: 1 })])
    const after = wf([localStep('draft', 'wf.draft', { a: 2 }), localStep('extra', 'wf.draft', {})])
    expect(enforceEditBoundary(before, after, LOCAL, [PEER])).toEqual({ ok: true })
  })

  it('treats reordered data classes as unchanged (canonical)', () => {
    const before = wf([capStep('place', 'supplier.confirm-order', ['pii', 'public'])])
    const after = wf([capStep('place', 'supplier.confirm-order', ['public', 'pii'])])
    expect(enforceEditBoundary(before, after, new Set(), [PEER])).toEqual({ ok: true })
  })
})

describe('enforceEditBoundary — boundary changes are rejected', () => {
  it('rejects a trigger capability change', () => {
    const before = wf([capStep('draft', 'wf.draft')], 'run-flow')
    const after = wf([capStep('draft', 'wf.draft')], 'run-other')
    const r = enforceEditBoundary(before, after, LOCAL, [PEER])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.violations.map((v) => v.kind)).toEqual(['trigger_changed'])
  })

  it('rejects repointing an egress step to a different peer cap (retarget)', () => {
    const before = wf([capStep('place', 'supplier.confirm-order')])
    const after = wf([capStep('place', 'supplier.express')])
    const r = enforceEditBoundary(before, after, new Set(), [PEER2])
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.violations).toHaveLength(1)
      expect(r.violations[0]?.kind).toBe('egress_retargeted')
      expect(r.violations[0]?.stepId).toBe('place')
    }
  })

  it('rejects deleting an egress step', () => {
    const before = wf([capStep('draft', 'wf.draft'), capStep('place', 'supplier.confirm-order')])
    const after = wf([capStep('draft', 'wf.draft')])
    const r = enforceEditBoundary(before, after, LOCAL, [PEER])
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.violations[0]?.kind).toBe('egress_removed')
      expect(r.violations[0]?.stepId).toBe('place')
    }
  })

  it('rejects adding a brand-new egress step', () => {
    const before = wf([capStep('draft', 'wf.draft')])
    const after = wf([capStep('draft', 'wf.draft'), capStep('sneak', 'supplier.confirm-order')])
    const r = enforceEditBoundary(before, after, LOCAL, [PEER])
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.violations[0]?.kind).toBe('egress_added')
      expect(r.violations[0]?.stepId).toBe('sneak')
    }
  })

  it('rejects changing an egress node data classes', () => {
    const before = wf([capStep('place', 'supplier.confirm-order', ['public'])])
    const after = wf([capStep('place', 'supplier.confirm-order', ['pii'])])
    const r = enforceEditBoundary(before, after, new Set(), [PEER])
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.violations[0]?.kind).toBe('egress_dataclass_changed')
      expect(r.violations[0]?.stepId).toBe('place')
    }
  })

  it('rejects a retarget on a parallel branch (composite step id)', () => {
    const branchStep = (cap: string): Step => ({
      kind: 'parallel',
      id: 'fan',
      branches: [
        { id: 'local', dispatch: { strategy: { kind: 'capability', capabilities: ['wf.draft'] }, payload: {} } },
        { id: 'remote', dispatch: { strategy: { kind: 'capability', capabilities: [cap] }, payload: {} } },
      ],
    })
    const before = wf([branchStep('supplier.confirm-order')])
    const after = wf([branchStep('supplier.express')])
    const r = enforceEditBoundary(before, after, LOCAL, [PEER2])
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.violations[0]?.kind).toBe('egress_retargeted')
      expect(r.violations[0]?.stepId).toBe('fan/remote')
    }
  })

  it('reports multiple boundary violations at once', () => {
    const before = wf([capStep('place', 'supplier.confirm-order', ['public'])], 'run-flow')
    // trigger changed AND egress removed (place is gone, replaced by a local step)
    const after = wf([capStep('draft', 'wf.draft')], 'run-other')
    const r = enforceEditBoundary(before, after, LOCAL, [PEER])
    expect(r.ok).toBe(false)
    if (!r.ok) {
      const kinds = r.violations.map((v) => v.kind).sort()
      expect(kinds).toEqual(['egress_removed', 'trigger_changed'])
    }
  })
})
