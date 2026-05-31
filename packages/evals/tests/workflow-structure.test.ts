/**
 * Unit tests for `checkWorkflowStructure` (Phase 13 M4 deep checker).
 *
 * Pure function — every test builds a synthetic WorkflowDefinition, runs
 * the checker, and asserts on `ok` + violation kinds. No fs, no LLM.
 *
 * We don't go through `parseWorkflow` here — the test inputs are typed
 * literals so we can construct edge cases (forward refs, broadcast with
 * trigger cap, etc.) without hitting the schema validator. The route /
 * assistant integration tests cover the parse → check pipeline.
 */

import { describe, expect, it } from 'vitest'

import {
  WORKFLOW_SCHEMA_V1,
  type WorkflowDefinition,
} from '@aipehub/workflow'

import {
  checkWorkflowStructure,
  type WorkflowInventory,
  type WorkflowStructureViolation,
} from '../src/checkers/workflow-structure.js'

function kinds(vs: WorkflowStructureViolation[]): string[] {
  return vs.map((v) => v.kind)
}

function wf(over: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    schema: WORKFLOW_SCHEMA_V1,
    id: over.id ?? 'test-workflow',
    trigger: over.trigger ?? { capability: 'test:start' },
    steps: over.steps ?? [
      {
        id: 'step1',
        dispatch: {
          strategy: { kind: 'capability', capabilities: ['chat'] },
          payload: { msg: 'hello' },
        },
      },
    ],
    onFailure: over.onFailure ?? 'halt',
    ...(over.name !== undefined ? { name: over.name } : {}),
    ...(over.description !== undefined ? { description: over.description } : {}),
    ...(over.output !== undefined ? { output: over.output } : {}),
  }
}

const NO_INVENTORY: WorkflowInventory = {}
const FULL_INVENTORY: WorkflowInventory = {
  agents: [
    { id: 'chat-agent', capabilities: ['chat'] },
    { id: 'writer', capabilities: ['draft', 'rewrite'] },
    { id: 'reviewer', capabilities: ['review'] },
  ],
  existingWorkflowIds: ['existing-1', 'existing-2'],
}

// ───────────────────────────────────────────────────────────────────
// Happy path
// ───────────────────────────────────────────────────────────────────

describe('checkWorkflowStructure — happy path', () => {
  it('passes a minimal valid workflow with no inventory', () => {
    const r = checkWorkflowStructure(wf(), NO_INVENTORY)
    expect(r.ok).toBe(true)
    expect(r.violations).toEqual([])
  })

  it('passes a single-step capability dispatch when inventory satisfies it', () => {
    const r = checkWorkflowStructure(wf(), FULL_INVENTORY)
    expect(r.ok).toBe(true)
  })

  it('passes an explicit dispatch when the target agent exists', () => {
    const r = checkWorkflowStructure(
      wf({
        steps: [
          {
            id: 's1',
            dispatch: {
              strategy: { kind: 'explicit', to: 'writer' },
              payload: { msg: 'draft this' },
            },
          },
        ],
      }),
      FULL_INVENTORY,
    )
    expect(r.ok).toBe(true)
  })

  it('passes refs that point at strictly earlier steps', () => {
    const r = checkWorkflowStructure(
      wf({
        steps: [
          {
            id: 'a',
            dispatch: {
              strategy: { kind: 'capability', capabilities: ['draft'] },
              payload: { msg: '$trigger.payload.topic' },
            },
          },
          {
            id: 'b',
            dispatch: {
              strategy: { kind: 'capability', capabilities: ['review'] },
              payload: { draft: '$a.output' },
            },
          },
        ],
      }),
      FULL_INVENTORY,
    )
    expect(r.ok).toBe(true)
  })
})

// ───────────────────────────────────────────────────────────────────
// id_collision
// ───────────────────────────────────────────────────────────────────

describe('id_collision', () => {
  it('flags when workflow.id clashes with an existing id', () => {
    const r = checkWorkflowStructure(wf({ id: 'existing-1' }), FULL_INVENTORY)
    expect(r.ok).toBe(false)
    expect(kinds(r.violations)).toContain('id_collision')
    const v = r.violations.find((x) => x.kind === 'id_collision')!
    expect(v.path).toBe('workflow.id')
    expect(v.message).toMatch(/existing-1/)
  })

  it('does not flag when existingWorkflowIds is empty / omitted', () => {
    const r = checkWorkflowStructure(wf({ id: 'whatever' }), {})
    expect(kinds(r.violations)).not.toContain('id_collision')
  })
})

// ───────────────────────────────────────────────────────────────────
// unknown_agent
// ───────────────────────────────────────────────────────────────────

describe('unknown_agent', () => {
  it('flags explicit dispatch to a non-existent agent', () => {
    const r = checkWorkflowStructure(
      wf({
        steps: [
          {
            id: 's1',
            dispatch: {
              strategy: { kind: 'explicit', to: 'ghost-agent' },
              payload: {},
            },
          },
        ],
      }),
      FULL_INVENTORY,
    )
    expect(r.ok).toBe(false)
    expect(kinds(r.violations)).toEqual(['unknown_agent'])
    expect(r.violations[0]!.path).toBe('workflow.steps[0].dispatch.strategy.to')
    expect(r.violations[0]!.message).toMatch(/ghost-agent/)
  })

  it('skips agent check when inventory.agents is omitted (portable mode)', () => {
    const r = checkWorkflowStructure(
      wf({
        steps: [
          {
            id: 's1',
            dispatch: {
              strategy: { kind: 'explicit', to: 'ghost-agent' },
              payload: {},
            },
          },
        ],
      }),
      NO_INVENTORY,
    )
    expect(r.ok).toBe(true)
  })

  it('flags unknown agent inside a parallel branch', () => {
    const r = checkWorkflowStructure(
      wf({
        steps: [
          {
            id: 'fan',
            parallel: true,
            branches: [
              {
                id: 'b1',
                dispatch: { strategy: { kind: 'explicit', to: 'writer' }, payload: {} },
              },
              {
                id: 'b2',
                dispatch: { strategy: { kind: 'explicit', to: 'no-such-bot' }, payload: {} },
              },
            ],
          },
        ],
      }),
      FULL_INVENTORY,
    )
    expect(r.ok).toBe(false)
    expect(kinds(r.violations)).toEqual(['unknown_agent'])
    expect(r.violations[0]!.path).toBe(
      'workflow.steps[0].branches[1].dispatch.strategy.to',
    )
  })
})

// ───────────────────────────────────────────────────────────────────
// unknown_capability
// ───────────────────────────────────────────────────────────────────

describe('unknown_capability', () => {
  it('flags capability dispatch when no agent satisfies any of the caps', () => {
    const r = checkWorkflowStructure(
      wf({
        steps: [
          {
            id: 's1',
            dispatch: {
              strategy: { kind: 'capability', capabilities: ['summarize', 'translate'] },
              payload: {},
            },
          },
        ],
      }),
      FULL_INVENTORY,
    )
    expect(r.ok).toBe(false)
    expect(kinds(r.violations)).toEqual(['unknown_capability'])
  })

  it('flags when no single agent satisfies every listed cap', () => {
    // Runtime dispatch uses Registry.byCapabilities(), where one participant
    // must cover every requested capability. Split / partial matches fail.
    const r = checkWorkflowStructure(
      wf({
        steps: [
          {
            id: 's1',
            dispatch: {
              strategy: { kind: 'capability', capabilities: ['nonexistent', 'chat'] },
              payload: {},
            },
          },
        ],
      }),
      FULL_INVENTORY,
    )
    expect(r.ok).toBe(false)
    expect(kinds(r.violations)).toEqual(['unknown_capability'])
  })

  it('passes when one agent satisfies every listed cap', () => {
    const r = checkWorkflowStructure(
      wf({
        steps: [
          {
            id: 's1',
            dispatch: {
              strategy: { kind: 'capability', capabilities: ['draft', 'rewrite'] },
              payload: {},
            },
          },
        ],
      }),
      FULL_INVENTORY,
    )
    expect(r.ok).toBe(true)
  })

  it('skips cap check when inventory.agents is omitted', () => {
    const r = checkWorkflowStructure(
      wf({
        steps: [
          {
            id: 's1',
            dispatch: {
              strategy: { kind: 'capability', capabilities: ['never-existed'] },
              payload: {},
            },
          },
        ],
      }),
      NO_INVENTORY,
    )
    expect(r.ok).toBe(true)
  })

  it('flags an empty-inventory broadcast that targets unsatisfiable caps', () => {
    const r = checkWorkflowStructure(
      wf({
        steps: [
          {
            id: 's1',
            dispatch: {
              strategy: { kind: 'broadcast', capabilities: ['nope-1', 'nope-2'] },
              payload: {},
            },
          },
        ],
      }),
      FULL_INVENTORY,
    )
    expect(r.ok).toBe(false)
    expect(kinds(r.violations)).toEqual(['unknown_capability'])
  })

  it('does not flag a bare broadcast (no capability filter)', () => {
    const r = checkWorkflowStructure(
      wf({
        steps: [
          {
            id: 's1',
            dispatch: {
              strategy: { kind: 'broadcast' },
              payload: {},
            },
          },
        ],
      }),
      FULL_INVENTORY,
    )
    expect(r.ok).toBe(true)
  })
})

// ───────────────────────────────────────────────────────────────────
// self_trigger_cycle
// ───────────────────────────────────────────────────────────────────

describe('self_trigger_cycle', () => {
  it('flags a step whose capability dispatch includes the workflow trigger', () => {
    const r = checkWorkflowStructure(
      wf({
        trigger: { capability: 'looper:start' },
        steps: [
          {
            id: 's1',
            dispatch: {
              strategy: { kind: 'capability', capabilities: ['looper:start'] },
              payload: {},
            },
          },
        ],
      }),
      NO_INVENTORY,
    )
    expect(r.ok).toBe(false)
    expect(kinds(r.violations)).toContain('self_trigger_cycle')
    expect(r.violations[0]!.path).toBe(
      'workflow.steps[0].dispatch.strategy.capabilities',
    )
  })

  it('flags a broadcast that includes the trigger capability', () => {
    const r = checkWorkflowStructure(
      wf({
        trigger: { capability: 'fan-out' },
        steps: [
          {
            id: 's1',
            dispatch: {
              strategy: { kind: 'broadcast', capabilities: ['fan-out', 'chat'] },
              payload: {},
            },
          },
        ],
      }),
      FULL_INVENTORY,
    )
    expect(kinds(r.violations)).toContain('self_trigger_cycle')
  })

  it('does not flag an explicit dispatch (target unknown at check time)', () => {
    const r = checkWorkflowStructure(
      wf({
        trigger: { capability: 'looper:start' },
        steps: [
          {
            id: 's1',
            dispatch: {
              strategy: { kind: 'explicit', to: 'writer' },
              payload: {},
            },
          },
        ],
      }),
      FULL_INVENTORY,
    )
    expect(r.ok).toBe(true)
  })
})

// ───────────────────────────────────────────────────────────────────
// bad_ref / forward_ref
// ───────────────────────────────────────────────────────────────────

describe('refs', () => {
  it('flags a ref to a step that does not exist', () => {
    const r = checkWorkflowStructure(
      wf({
        steps: [
          {
            id: 's1',
            dispatch: {
              strategy: { kind: 'capability', capabilities: ['chat'] },
              payload: { upstream: '$ghost.output' },
            },
          },
        ],
      }),
      NO_INVENTORY,
    )
    expect(r.ok).toBe(false)
    expect(kinds(r.violations)).toContain('bad_ref')
    const v = r.violations.find((x) => x.kind === 'bad_ref')!
    expect(v.path).toBe('workflow.steps[0].dispatch.payload.upstream')
    expect(v.message).toMatch(/ghost/)
  })

  it('flags a ref that points to a later step (forward ref)', () => {
    const r = checkWorkflowStructure(
      wf({
        steps: [
          {
            id: 'first',
            dispatch: {
              strategy: { kind: 'capability', capabilities: ['chat'] },
              payload: { from_future: '$second.output' },
            },
          },
          {
            id: 'second',
            dispatch: {
              strategy: { kind: 'capability', capabilities: ['chat'] },
              payload: {},
            },
          },
        ],
      }),
      NO_INVENTORY,
    )
    expect(r.ok).toBe(false)
    expect(kinds(r.violations)).toContain('forward_ref')
  })

  it('accepts $trigger.payload.* refs without inventory', () => {
    const r = checkWorkflowStructure(
      wf({
        steps: [
          {
            id: 's1',
            dispatch: {
              strategy: { kind: 'capability', capabilities: ['chat'] },
              payload: { msg: '$trigger.payload.topic', who: '$trigger.from' },
            },
          },
        ],
      }),
      NO_INVENTORY,
    )
    expect(r.ok).toBe(true)
  })

  it('walks nested payload trees (object → array → string)', () => {
    const r = checkWorkflowStructure(
      wf({
        steps: [
          {
            id: 's1',
            dispatch: {
              strategy: { kind: 'capability', capabilities: ['chat'] },
              payload: {
                nested: {
                  arr: ['$trigger.payload.ok', '$ghost.output'],
                },
              },
            },
          },
        ],
      }),
      NO_INVENTORY,
    )
    expect(kinds(r.violations)).toEqual(['bad_ref'])
    expect(r.violations[0]!.path).toBe(
      'workflow.steps[0].dispatch.payload.nested.arr[1]',
    )
  })

  it('checks refs inside workflow.output too', () => {
    const r = checkWorkflowStructure(
      wf({
        steps: [
          {
            id: 's1',
            dispatch: {
              strategy: { kind: 'capability', capabilities: ['chat'] },
              payload: {},
            },
          },
        ],
        output: { final: '$nope.output' },
      }),
      NO_INVENTORY,
    )
    expect(kinds(r.violations)).toEqual(['bad_ref'])
    expect(r.violations[0]!.path).toBe('workflow.output.final')
  })

  it('handles inline templating refs ("hello $a.output.name")', () => {
    const r = checkWorkflowStructure(
      wf({
        steps: [
          {
            id: 'a',
            dispatch: {
              strategy: { kind: 'capability', capabilities: ['chat'] },
              payload: {},
            },
          },
          {
            id: 'b',
            dispatch: {
              strategy: { kind: 'capability', capabilities: ['chat'] },
              payload: { msg: 'Hi $a.output.name, you said $ghost.output yesterday' },
            },
          },
        ],
      }),
      NO_INVENTORY,
    )
    // $a.output.name resolves (a is earlier); $ghost.output is unknown.
    expect(kinds(r.violations)).toEqual(['bad_ref'])
    expect(r.violations[0]!.message).toMatch(/ghost/)
  })
})

// ───────────────────────────────────────────────────────────────────
// Aggregation
// ───────────────────────────────────────────────────────────────────

describe('aggregation', () => {
  it('reports multiple violations in one pass (no early return)', () => {
    const r = checkWorkflowStructure(
      wf({
        id: 'existing-1',                       // id_collision
        trigger: { capability: 'loop:start' },
        steps: [
          {
            id: 's1',
            dispatch: {
              strategy: { kind: 'capability', capabilities: ['loop:start'] }, // self_trigger_cycle
              payload: { x: '$ghost.output' },  // bad_ref
            },
          },
          {
            id: 's2',
            dispatch: {
              strategy: { kind: 'explicit', to: 'nobody' }, // unknown_agent
              payload: {},
            },
          },
        ],
      }),
      FULL_INVENTORY,
    )
    expect(r.ok).toBe(false)
    // 'loop:start' triggers BOTH self_trigger_cycle AND unknown_capability
    // (no agent satisfies it) — they're independent concerns and both apply.
    expect(kinds(r.violations).sort()).toEqual(
      [
        'bad_ref',
        'id_collision',
        'self_trigger_cycle',
        'unknown_agent',
        'unknown_capability',
      ].sort(),
    )
  })
})
