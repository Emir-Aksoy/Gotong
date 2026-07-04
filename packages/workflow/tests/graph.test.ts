import { describe, expect, it } from 'vitest'

import {
  WORKFLOW_SCHEMA_V1,
  OUTPUT_NODE_ID,
  TRIGGER_NODE_ID,
  parseWorkflow,
  projectWorkflowGraph,
} from '../src/index.js'
import type { WorkflowDefinition, WorkflowGraphEdge } from '../src/index.js'

/**
 * Unit tests for the read-only DAG projection. `projectWorkflowGraph` is a pure
 * lens over an already-structured `WorkflowDefinition`, so the tests assert the
 * exact node/edge sets a frontend would draw — and that the projection NEVER
 * mutates the input or invents cross-hub annotations (that's the host's job).
 */

/** Minimal hand-built definition; spread to override per case. */
function def(partial: Partial<WorkflowDefinition>): WorkflowDefinition {
  return {
    schema: WORKFLOW_SCHEMA_V1,
    id: 'wf-test',
    trigger: { capability: 'start.flow' },
    steps: [],
    ...partial,
  }
}

const cap = (capability: string) => ({
  strategy: { kind: 'capability' as const, capabilities: [capability] },
  payload: {},
})

/** Find an edge by endpoints (kind-agnostic unless `kind` is given). */
function hasEdge(
  edges: WorkflowGraphEdge[],
  from: string,
  to: string,
  kind?: WorkflowGraphEdge['kind'],
): boolean {
  return edges.some(
    (e) => e.from === from && e.to === to && (kind === undefined || e.kind === kind),
  )
}

describe('projectWorkflowGraph — backbone', () => {
  it('threads trigger → steps → output with sequence edges', () => {
    const g = projectWorkflowGraph(
      def({
        steps: [
          { id: 'a', dispatch: cap('do.a') },
          { id: 'b', dispatch: cap('do.b') },
        ],
      }),
    )

    // One trigger + two steps + one output.
    expect(g.nodes.map((n) => n.id)).toEqual([
      TRIGGER_NODE_ID,
      'step:a',
      'step:b',
      OUTPUT_NODE_ID,
    ])
    expect(g.workflowId).toBe('wf-test')

    // The backbone is a single chain.
    expect(hasEdge(g.edges, TRIGGER_NODE_ID, 'step:a', 'sequence')).toBe(true)
    expect(hasEdge(g.edges, 'step:a', 'step:b', 'sequence')).toBe(true)
    expect(hasEdge(g.edges, 'step:b', OUTPUT_NODE_ID, 'sequence')).toBe(true)
  })

  it('labels the trigger with its capability and the steps with their ids', () => {
    const g = projectWorkflowGraph(
      def({
        trigger: { capability: 'intake.request' },
        steps: [{ id: 'review', description: 'review it', dispatch: cap('do.review') }],
      }),
    )
    const trigger = g.nodes.find((n) => n.id === TRIGGER_NODE_ID)!
    expect(trigger.kind).toBe('trigger')
    expect(trigger.label).toBe('intake.request')

    const step = g.nodes.find((n) => n.id === 'step:review')!
    expect(step.kind).toBe('step')
    expect(step.label).toBe('review')
    expect(step.description).toBe('review it')
    expect(step.destination).toEqual({ kind: 'capability', capabilities: ['do.review'] })
  })

  it('handles a zero-step workflow (trigger straight to output)', () => {
    const g = projectWorkflowGraph(def({ steps: [] }))
    expect(g.nodes.map((n) => n.id)).toEqual([TRIGGER_NODE_ID, OUTPUT_NODE_ID])
    expect(hasEdge(g.edges, TRIGGER_NODE_ID, OUTPUT_NODE_ID, 'sequence')).toBe(true)
  })
})

describe('projectWorkflowGraph — destinations', () => {
  it('flattens explicit / capability / broadcast strategies', () => {
    const g = projectWorkflowGraph(
      def({
        steps: [
          { id: 'x', dispatch: { strategy: { kind: 'explicit', to: 'agent-7' }, payload: {} } },
          { id: 'y', dispatch: { strategy: { kind: 'capability', capabilities: ['c.1', 'c.2'] }, payload: {} } },
          { id: 'z', dispatch: { strategy: { kind: 'broadcast' }, payload: {} } },
        ],
      }),
    )
    expect(g.nodes.find((n) => n.id === 'step:x')!.destination).toEqual({
      kind: 'explicit',
      capabilities: [],
      to: 'agent-7',
    })
    expect(g.nodes.find((n) => n.id === 'step:y')!.destination).toEqual({
      kind: 'capability',
      capabilities: ['c.1', 'c.2'],
    })
    expect(g.nodes.find((n) => n.id === 'step:z')!.destination).toEqual({
      kind: 'broadcast',
      capabilities: [],
    })
  })
})

describe('projectWorkflowGraph — when predicates', () => {
  it('rides the predicate on the node, not an edge', () => {
    const g = projectWorkflowGraph(
      def({
        steps: [
          { id: 'a', dispatch: cap('do.a') },
          { id: 'b', when: '$a.output.ok == true', dispatch: cap('do.b') },
        ],
      }),
    )
    const a = g.nodes.find((n) => n.id === 'step:a')!
    const b = g.nodes.find((n) => n.id === 'step:b')!
    expect(a.when).toBeUndefined()
    expect(b.when).toBe('$a.output.ok == true')
  })
})

describe('projectWorkflowGraph — data ($ref) edges', () => {
  it('draws a data edge from a referenced earlier step', () => {
    const g = projectWorkflowGraph(
      def({
        steps: [
          { id: 'draft', dispatch: cap('do.draft') },
          {
            id: 'review',
            dispatch: {
              strategy: { kind: 'capability', capabilities: ['do.review'] },
              payload: { text: '$draft.output' },
            },
          },
        ],
      }),
    )
    expect(hasEdge(g.edges, 'step:draft', 'step:review', 'data')).toBe(true)
    // The backbone edge is still there too (distinct kind).
    expect(hasEdge(g.edges, 'step:draft', 'step:review', 'sequence')).toBe(true)
  })

  it('flags trigger reads on the node instead of drawing an edge', () => {
    const g = projectWorkflowGraph(
      def({
        steps: [
          {
            id: 'a',
            dispatch: {
              strategy: { kind: 'capability', capabilities: ['do.a'] },
              payload: { name: '$trigger.payload.name' },
            },
          },
        ],
      }),
    )
    const a = g.nodes.find((n) => n.id === 'step:a')!
    expect(a.readsTrigger).toBe(true)
    // No data edge FROM the trigger node (would clutter — nearly every step reads it).
    expect(g.edges.some((e) => e.from === TRIGGER_NODE_ID && e.kind === 'data')).toBe(false)
  })

  it('ignores $ref-looking strings that are not real step ids', () => {
    const g = projectWorkflowGraph(
      def({
        steps: [
          {
            id: 'pay',
            dispatch: {
              strategy: { kind: 'capability', capabilities: ['do.pay'] },
              // `$5.00` matches the ref regex head `5` — but there is no step `5`.
              payload: { note: 'price is $5.00', other: '$nonexistent.output' },
            },
          },
        ],
      }),
    )
    expect(g.edges.filter((e) => e.kind === 'data')).toEqual([])
  })

  it('draws data edges from the explicit output', () => {
    const g = projectWorkflowGraph(
      def({
        steps: [
          { id: 'a', dispatch: cap('do.a') },
          { id: 'b', dispatch: cap('do.b') },
        ],
        output: { result: '$a.output', extra: '$b.output.x' },
      }),
    )
    expect(hasEdge(g.edges, 'step:a', OUTPUT_NODE_ID, 'data')).toBe(true)
    expect(hasEdge(g.edges, 'step:b', OUTPUT_NODE_ID, 'data')).toBe(true)
  })
})

describe('projectWorkflowGraph — parallel steps', () => {
  it('emits a container node + one node per branch, fanned by sequence edges', () => {
    const g = projectWorkflowGraph(
      def({
        steps: [
          {
            kind: 'parallel',
            id: 'fan',
            branches: [
              { id: 'left', dispatch: cap('do.left') },
              { id: 'right', when: '$trigger.payload.go == true', dispatch: cap('do.right') },
            ],
          },
        ],
      }),
    )

    const container = g.nodes.find((n) => n.id === 'step:fan')!
    expect(container.kind).toBe('parallel')
    expect(container.branchNodeIds).toEqual(['branch:fan/left', 'branch:fan/right'])

    // Container renders before its branches (array order).
    const ids = g.nodes.map((n) => n.id)
    expect(ids.indexOf('step:fan')).toBeLessThan(ids.indexOf('branch:fan/left'))

    const left = g.nodes.find((n) => n.id === 'branch:fan/left')!
    expect(left.kind).toBe('branch')
    expect(left.parentId).toBe('step:fan')
    expect(left.destination).toEqual({ kind: 'capability', capabilities: ['do.left'] })

    const right = g.nodes.find((n) => n.id === 'branch:fan/right')!
    expect(right.when).toBe('$trigger.payload.go == true')

    // Backbone enters the container; the container fans out to each branch.
    expect(hasEdge(g.edges, TRIGGER_NODE_ID, 'step:fan', 'sequence')).toBe(true)
    expect(hasEdge(g.edges, 'step:fan', 'branch:fan/left', 'sequence')).toBe(true)
    expect(hasEdge(g.edges, 'step:fan', 'branch:fan/right', 'sequence')).toBe(true)
    // The backbone continues from the container to the output.
    expect(hasEdge(g.edges, 'step:fan', OUTPUT_NODE_ID, 'sequence')).toBe(true)
  })

  it('draws a data edge into a branch that reads an earlier step', () => {
    const g = projectWorkflowGraph(
      def({
        steps: [
          { id: 'seed', dispatch: cap('do.seed') },
          {
            kind: 'parallel',
            id: 'fan',
            branches: [
              {
                id: 'b1',
                dispatch: {
                  strategy: { kind: 'capability', capabilities: ['do.b1'] },
                  payload: { from: '$seed.output' },
                },
              },
            ],
          },
        ],
      }),
    )
    expect(hasEdge(g.edges, 'step:seed', 'branch:fan/b1', 'data')).toBe(true)
  })
})

describe('projectWorkflowGraph — node-level data classes', () => {
  it('carries dispatch.dataClasses onto the node', () => {
    const g = projectWorkflowGraph(
      def({
        steps: [
          {
            id: 'a',
            dispatch: {
              strategy: { kind: 'capability', capabilities: ['do.a'] },
              payload: {},
              dataClasses: ['pii', 'public'],
            },
          },
        ],
      }),
    )
    expect(g.nodes.find((n) => n.id === 'step:a')!.dataClasses).toEqual(['pii', 'public'])
  })
})

describe('projectWorkflowGraph — purity + cross-hub left for host', () => {
  it('never sets crossHub (host stamps it) and never mutates the input', () => {
    const input = def({
      steps: [{ id: 'a', dispatch: cap('do.a') }],
    })
    const snapshot = JSON.stringify(input)
    const g = projectWorkflowGraph(input)
    expect(g.nodes.every((n) => n.crossHub === undefined)).toBe(true)
    // Input untouched.
    expect(JSON.stringify(input)).toBe(snapshot)
  })
})

describe('projectWorkflowGraph — on a real parsed YAML', () => {
  it('projects a parseWorkflow output (parser-stamped kind, parallel, refs)', () => {
    const yaml = `
schema: gotong.workflow/v1
workflow:
  id: real-flow
  name: Real Flow
  trigger:
    capability: intake.start
  steps:
    - id: classify
      dispatch:
        strategy: { kind: capability, capabilities: [do.classify] }
        payload:
          text: $trigger.payload.body
    - id: handle
      parallel: true
      branches:
        - id: urgent
          when: $classify.output.priority == "high"
          dispatch:
            strategy: { kind: capability, capabilities: [do.urgent] }
            payload:
              ref: $classify.output
        - id: normal
          dispatch:
            strategy: { kind: capability, capabilities: [do.normal] }
            payload: {}
  output:
    done: $handle.urgent.output
`
    const parsed = parseWorkflow(yaml)
    const g = projectWorkflowGraph(parsed)

    // Parser stamps kind:'simple' on classify and kind:'parallel' on handle —
    // the projection must branch on that correctly.
    expect(g.nodes.find((n) => n.id === 'step:classify')!.kind).toBe('step')
    expect(g.nodes.find((n) => n.id === 'step:handle')!.kind).toBe('parallel')
    expect(g.nodes.find((n) => n.id === 'branch:handle/urgent')!.kind).toBe('branch')

    // classify reads the trigger payload (flag, not edge).
    expect(g.nodes.find((n) => n.id === 'step:classify')!.readsTrigger).toBe(true)
    // The urgent branch reads classify's output (data edge into the branch).
    expect(hasEdge(g.edges, 'step:classify', 'branch:handle/urgent', 'data')).toBe(true)
    // The when predicate rides the branch node.
    expect(g.nodes.find((n) => n.id === 'branch:handle/urgent')!.when).toBe(
      '$classify.output.priority == "high"',
    )
    // The output references handle's urgent branch — its data edge is keyed to
    // the parallel STEP (ref head is the step id, not the branch).
    expect(hasEdge(g.edges, 'step:handle', OUTPUT_NODE_ID, 'data')).toBe(true)
  })
})
