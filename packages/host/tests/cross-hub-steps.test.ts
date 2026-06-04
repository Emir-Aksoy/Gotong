/**
 * Stream G day-2 — unit tests for the pure cross-hub-step detector
 * (`crossHubStepsOf`). It needs no Hub and no versioning: it's a function over
 * a definition + the local capability set + the connected-peer capability
 * entries, so we exercise the decision logic directly.
 *
 * The contract under test:
 *   - a step asking for a capability ONLY a peer serves      → flagged
 *   - a step asking for a capability ONLY local serves       → not flagged
 *   - a capability BOTH local AND a peer serve               → not flagged
 *     (routes locally; flagging it would be a false "goes cross-hub" alarm)
 *   - explicit / unfiltered-broadcast dispatch               → never flagged
 *   - parallel branches addressed `${stepId}/${branchId}`
 *   - two peers advertising the same cap                     → first wins
 */

import { describe, expect, it } from 'vitest'

import { WORKFLOW_SCHEMA_V1, type WorkflowDefinition, type Step } from '@aipehub/workflow'

import { crossHubStepsOf } from '../src/workflow-controller.js'

/** Build a minimal valid definition with the given steps. */
function def(steps: Step[]): WorkflowDefinition {
  return {
    schema: WORKFLOW_SCHEMA_V1,
    id: 'flow',
    trigger: { capability: 'run-flow' },
    steps,
  }
}

/** A simple capability-dispatch step. */
function capStep(id: string, capability: string): Step {
  return {
    id,
    dispatch: { strategy: { kind: 'capability', capabilities: [capability] }, payload: {} },
  }
}

const PEER = { peer: 'supplier-hub', label: '供货商 Hub', capabilities: ['supplier.confirm-order'] }

describe('crossHubStepsOf', () => {
  it('flags a step whose cap only a peer serves (with peer + label)', () => {
    const flagged = crossHubStepsOf(
      def([capStep('place', 'supplier.confirm-order')]),
      new Set(['teashop.draft-order']),
      [PEER],
    )
    expect(flagged).toEqual([
      {
        stepId: 'place',
        capability: 'supplier.confirm-order',
        peer: 'supplier-hub',
        peerLabel: '供货商 Hub',
      },
    ])
  })

  it('does not flag a step whose cap a local participant serves', () => {
    const flagged = crossHubStepsOf(
      def([capStep('draft', 'teashop.draft-order')]),
      new Set(['teashop.draft-order']),
      [PEER],
    )
    expect(flagged).toEqual([])
  })

  it('does not flag a cap that BOTH local and a peer serve (routes locally)', () => {
    // local also serves supplier.confirm-order → capability dispatch is
    // satisfied locally, so it is NOT a cross-hub hop.
    const flagged = crossHubStepsOf(
      def([capStep('place', 'supplier.confirm-order')]),
      new Set(['supplier.confirm-order']),
      [PEER],
    )
    expect(flagged).toEqual([])
  })

  it('ignores explicit dispatch (un-allowlistable → never cross-hub)', () => {
    const explicit: Step = {
      id: 'direct',
      dispatch: { strategy: { kind: 'explicit', to: 'supplier-hub' }, payload: {} },
    }
    const flagged = crossHubStepsOf(def([explicit]), new Set(), [PEER])
    expect(flagged).toEqual([])
  })

  it('addresses parallel branches as `${stepId}/${branchId}`', () => {
    const fan: Step = {
      id: 'fanout',
      parallel: true,
      branches: [
        {
          id: 'local',
          dispatch: { strategy: { kind: 'capability', capabilities: ['teashop.draft-order'] }, payload: {} },
        },
        {
          id: 'remote',
          dispatch: { strategy: { kind: 'capability', capabilities: ['supplier.confirm-order'] }, payload: {} },
        },
      ],
    }
    const flagged = crossHubStepsOf(def([fan]), new Set(['teashop.draft-order']), [PEER])
    expect(flagged).toEqual([
      {
        stepId: 'fanout/remote',
        capability: 'supplier.confirm-order',
        peer: 'supplier-hub',
        peerLabel: '供货商 Hub',
      },
    ])
  })

  it('attributes a shared cap to the FIRST peer that advertises it', () => {
    const flagged = crossHubStepsOf(
      def([capStep('place', 'shared.cap')]),
      new Set(),
      [
        { peer: 'hub-a', label: 'A', capabilities: ['shared.cap'] },
        { peer: 'hub-b', label: 'B', capabilities: ['shared.cap'] },
      ],
    )
    expect(flagged).toHaveLength(1)
    expect(flagged[0]?.peer).toBe('hub-a')
  })

  it('returns [] when there are no peer entries', () => {
    expect(crossHubStepsOf(def([capStep('place', 'supplier.confirm-order')]), new Set(), [])).toEqual([])
  })

  it('carries a null peer label through', () => {
    const flagged = crossHubStepsOf(def([capStep('place', 'x.cap')]), new Set(), [
      { peer: 'p', label: null, capabilities: ['x.cap'] },
    ])
    expect(flagged[0]?.peerLabel).toBeNull()
  })
})
