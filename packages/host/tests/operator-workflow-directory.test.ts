/**
 * A-M4 — `operatorStewardWorkflowDirectory`: the operator console steward's
 * site-wide workflow snapshot. The defining difference from the member directory
 * is the DROPPED per-member grant filter — an operator sees EVERY workflow, not
 * just the ones it holds an editor grant on.
 *
 * Light fake for the controller's `listAll` read slice; no Hub / identity / RBAC.
 */

import { describe, expect, it } from 'vitest'

import {
  operatorStewardWorkflowDirectory,
  type OperatorWorkflowListSource,
} from '../src/operator-workflow-directory.js'

function source(
  rows: ReadonlyArray<{ id: string; name?: string; crossHubSteps?: ReadonlyArray<unknown> }>,
): OperatorWorkflowListSource {
  return { listAll: async () => rows }
}

describe('A-M4 — operatorStewardWorkflowDirectory (site-wide, no grant filter)', () => {
  it('lists EVERY workflow regardless of caller (no per-member grant filter)', async () => {
    // Three workflows nobody granted the caller — a MEMBER directory would return
    // []; the operator directory returns all three.
    const dir = operatorStewardWorkflowDirectory(
      source([
        { id: 'wf.a', name: '甲' },
        { id: 'wf.b' },
        { id: 'wf.c', name: '丙' },
      ]),
    )
    const got = await dir.listForUser('op-who-owns-nothing')
    expect(got.map((w) => w.id)).toEqual(['wf.a', 'wf.b', 'wf.c'])
  })

  it('flags cross-hub from crossHubSteps length (drives the cross_hub tier)', async () => {
    const dir = operatorStewardWorkflowDirectory(
      source([
        { id: 'local', crossHubSteps: [] }, // empty ⇒ local
        { id: 'federated', crossHubSteps: [{ stepId: 'place' }] }, // present ⇒ cross-hub
        { id: 'no-field' }, // absent ⇒ local
      ]),
    )
    const got = await dir.listForUser('op1')
    expect(got).toEqual([
      { id: 'local', crossHub: false },
      { id: 'federated', crossHub: true },
      { id: 'no-field', crossHub: false },
    ])
  })

  it('omits the name field entirely when a workflow has none', async () => {
    const dir = operatorStewardWorkflowDirectory(source([{ id: 'wf.x' }]))
    const got = await dir.listForUser('op1')
    expect(got[0]).toEqual({ id: 'wf.x', crossHub: false })
    expect('name' in got[0]!).toBe(false)
  })

  it('does not vary by userId (every operator sees the same site-wide list)', async () => {
    const dir = operatorStewardWorkflowDirectory(source([{ id: 'wf.a' }, { id: 'wf.b' }]))
    const a = await dir.listForUser('alice')
    const b = await dir.listForUser('bob')
    expect(a).toEqual(b)
  })
})
