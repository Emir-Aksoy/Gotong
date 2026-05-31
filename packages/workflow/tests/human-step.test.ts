import { describe, expect, it } from 'vitest'

import { parseWorkflow, WorkflowSchemaError } from '../src/index.js'

/**
 * `human:` step sugar (Phase 16 M6). A human-in-the-loop step desugars at
 * parse time into a plain dispatch to the `aipehub.human/v1` capability, so
 * the runner / resolver / deepCheck see a normal dispatch and need no changes.
 */

const HUMAN_CAP = 'aipehub.human/v1'

function firstDispatch(yaml: string): { strategy: unknown; payload: unknown } {
  const wf = parseWorkflow(yaml)
  const step = wf.steps[0]!
  if (!('dispatch' in step)) throw new Error('expected a simple (dispatch) step')
  return step.dispatch as { strategy: unknown; payload: unknown }
}

function wrap(stepBody: string): string {
  return `
schema: aipehub.workflow/v1
workflow:
  id: human-demo
  trigger: { capability: start }
  steps:
${stepBody}
`
}

describe('human: step sugar', () => {
  it('desugars an approval step into a dispatch to aipehub.human/v1', () => {
    const d = firstDispatch(
      wrap(`    - id: gate
      human:
        assignee: $trigger.payload.case_id
        kind: approval
        prompt: Approve the plan?`),
    )
    expect(d.strategy).toEqual({ kind: 'capability', capabilities: [HUMAN_CAP] })
    // assignee keeps the $ref verbatim — the resolver substitutes it at dispatch.
    expect(d.payload).toEqual({
      assignee: '$trigger.payload.case_id',
      kind: 'approval',
      prompt: 'Approve the plan?',
    })
  })

  it('carries title + options for a choice step', () => {
    const d = firstDispatch(
      wrap(`    - id: pick
      human:
        assignee: user-1
        kind: choice
        prompt: Pick one
        title: Decision
        options:
          - { value: a, label: Apple }
          - { value: b, label: Banana }`),
    )
    expect(d.payload).toEqual({
      assignee: 'user-1',
      kind: 'choice',
      prompt: 'Pick one',
      title: 'Decision',
      options: [
        { value: 'a', label: 'Apple' },
        { value: 'b', label: 'Banana' },
      ],
    })
  })

  it('carries editField for an edit step', () => {
    const d = firstDispatch(
      wrap(`    - id: tweak
      human:
        assignee: user-1
        kind: edit
        prompt: Revise the summary
        editField: { multiline: true, defaultValue: draft }`),
    )
    expect(d.payload).toMatchObject({
      kind: 'edit',
      editField: { multiline: true, defaultValue: 'draft' },
    })
  })

  it('a desugared human step still honours when / onFailure', () => {
    const wf = parseWorkflow(
      wrap(`    - id: gate
      when: $trigger.payload.needsApproval == true
      onFailure: { action: continue }
      human:
        assignee: user-1
        kind: approval
        prompt: ok?`),
    )
    const step = wf.steps[0]!
    expect(step.when).toBe('$trigger.payload.needsApproval == true')
    expect(step.onFailure).toEqual({ action: 'continue' })
  })

  it('rejects a missing assignee / bad kind / empty prompt at parse time', () => {
    expect(() =>
      parseWorkflow(wrap(`    - id: g
      human: { kind: approval, prompt: ok? }`)),
    ).toThrow(WorkflowSchemaError)
    expect(() =>
      parseWorkflow(wrap(`    - id: g
      human: { assignee: u, kind: nope, prompt: ok? }`)),
    ).toThrow(/kind must be/)
    expect(() =>
      parseWorkflow(wrap(`    - id: g
      human: { assignee: u, kind: edit, prompt: "" }`)),
    ).toThrow(/prompt is required/)
  })

  it('rejects a choice step with no options', () => {
    expect(() =>
      parseWorkflow(wrap(`    - id: g
      human: { assignee: u, kind: choice, prompt: pick }`)),
    ).toThrow(/options must be a non-empty array/)
  })

  it('rejects a step with both human and dispatch, or human and parallel', () => {
    expect(() =>
      parseWorkflow(wrap(`    - id: g
      human: { assignee: u, kind: approval, prompt: ok? }
      dispatch: { strategy: { kind: capability, capabilities: [x] }, payload: {} }`)),
    ).toThrow(/cannot have both 'human' and 'dispatch'/)
    expect(() =>
      parseWorkflow(wrap(`    - id: g
      parallel: true
      branches: [ { id: b, dispatch: { strategy: { kind: capability, capabilities: [x] }, payload: {} } } ]
      human: { assignee: u, kind: approval, prompt: ok? }`)),
    ).toThrow(/cannot be both 'human' and 'parallel'/)
  })
})
