/**
 * DAG-M5 — end-to-end acceptance for the read-only workflow flow chart (graph).
 *
 * The web unit test (packages/web/tests/workflow-graph-route.test.ts) covers the
 * route plumbing against a STUBBED `graphOf`. This test closes the one seam those
 * stubs can't: a REAL `WorkflowController` (the host's actual `WorkflowSurface`)
 * projecting a REAL imported YAML through the REAL versioning resolver, served over
 * real HTTP with admin auth — exactly the production wiring
 * (`serveWeb({ workflows: controller })`).
 *
 * It boots a real Hub + Space + IdentityStore + serveWeb, imports a shipped
 * template with the richest shape we ship (`issue-triage-flow`: a parallel
 * fan-out + `$ref` data deps + trigger reads), and asserts the graph the admin
 * "view flow chart" button fetches matches that structure. It is the durable
 * proof that the chart's nodes/edges are the workflow's real DAG — not a mock.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Hub, HumanParticipant, Space } from '@gotong/core'
import { serveWeb, type WebServerHandle } from '@gotong/web'
import { openIdentityStore, type IdentityStore } from '@gotong/identity'

import { WorkflowController } from '../src/workflow-controller.js'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')
const TEMPLATE = join(repoRoot, 'templates', 'workflows', 'issue-triage-flow.yaml')

interface GraphNode {
  id: string
  kind: string
  label: string
  destination?: { kind: string; capabilities: string[]; to?: string }
  when?: string
  readsTrigger?: boolean
  branchNodeIds?: string[]
  parentId?: string
  crossHub?: unknown
}
interface GraphEdge {
  from: string
  to: string
  kind: 'sequence' | 'data'
}
interface GraphView {
  workflowId: string
  nodes: GraphNode[]
  edges: GraphEdge[]
}

interface Rig {
  root: string
  hub: Hub
  identity: IdentityStore
  web: WebServerHandle
  adminCookie: string
}

async function boot(): Promise<Rig> {
  const root = await mkdtemp(join(tmpdir(), 'gotong-wf-graph-e2e-'))
  const { space } = await Space.init(root, { name: 'wf-graph-e2e' })
  const hub = new Hub({ space })
  await hub.start()

  // Stub participants satisfying the template's dispatch capabilities — keeps the
  // import's runtime-aware structure check quiet. They never run here (we only
  // project the graph), and being LOCAL they can never be stamped cross-hub.
  for (const cap of [
    'issue-classify',
    'issue-severity',
    'issue-dedupe',
    'issue-label',
    'issue-assign',
  ]) {
    hub.register(new HumanParticipant({ id: `${cap}-stub`, capabilities: [cap] }))
  }

  // The REAL host workflow surface, with the shipped template imported (Model-B
  // import → publishes rev1, registering a runner + a resolvable revision).
  const controller = new WorkflowController({
    hub,
    definitionsDir: join(root, 'workflows', 'definitions'),
    spaceRoot: root,
  })
  await controller.importFromText(await readFile(TEMPLATE, 'utf8'))

  const identity = openIdentityStore({ dbPath: join(root, 'identity.sqlite') })
  identity.bootstrap({ ownerEmail: 'owner@local', ownerDisplayName: 'Owner' })
  // An admin user — requireAdmin (which the graph route is gated by) is satisfied
  // by role='admin'. Seeing the SHAPE of a workflow is an operator read.
  identity.createUser({
    email: 'admin@e2e.test',
    displayName: 'Admin',
    password: 'admin-strong-password',
    role: 'admin',
  })
  const adminCookie = `gotong_identity=${
    identity.authenticatePassword({ email: 'admin@e2e.test', password: 'admin-strong-password' }).token
  }`

  const web = await serveWeb(hub, {
    host: '127.0.0.1',
    port: 0,
    identity,
    workflows: controller, // <-- the production wiring under test
  })

  return { root, hub, identity, web, adminCookie }
}

async function teardown(r: Rig): Promise<void> {
  await r.web.close()
  await r.hub.stop()
  r.identity.close()
  await rm(r.root, { recursive: true, force: true })
}

const hasSeq = (e: GraphEdge[], from: string, to: string): boolean =>
  e.some((x) => x.kind === 'sequence' && x.from === from && x.to === to)
const hasData = (e: GraphEdge[], from: string, to: string): boolean =>
  e.some((x) => x.kind === 'data' && x.from === from && x.to === to)

describe('DAG-M5 — read-only workflow graph, real WorkflowController over HTTP', () => {
  let r: Rig
  beforeEach(async () => { r = await boot() })
  afterEach(async () => { await teardown(r) })

  it('GET /api/admin/workflows/:id/graph projects the real imported DAG', async () => {
    const res = await fetch(`${r.web.url}/api/admin/workflows/issue-triage-flow/graph`, {
      headers: { cookie: r.adminCookie },
    })
    expect(res.status).toBe(200)
    const { graph } = (await res.json()) as { graph: GraphView }

    expect(graph.workflowId).toBe('issue-triage-flow')
    const byId = new Map(graph.nodes.map((n) => [n.id, n]))

    // Termini: the trigger node carries the dispatch capability that starts it;
    // the output node closes the backbone.
    expect(byId.get('__trigger__')).toMatchObject({ kind: 'trigger', label: 'triage-issue' })
    expect(byId.get('__output__')).toMatchObject({ kind: 'output' })

    // The simple steps.
    expect(byId.get('step:classify')).toMatchObject({ kind: 'step', label: 'classify' })
    expect(byId.get('step:assign')).toMatchObject({ kind: 'step', label: 'assign' })

    // The parallel container + its three branches (declaration order preserved).
    const analyze = byId.get('step:analyze')!
    expect(analyze.kind).toBe('parallel')
    expect(analyze.branchNodeIds).toEqual([
      'branch:analyze/severity',
      'branch:analyze/dedupe',
      'branch:analyze/labels',
    ])
    for (const b of ['severity', 'dedupe', 'labels']) {
      expect(byId.get(`branch:analyze/${b}`)).toMatchObject({
        kind: 'branch',
        label: b,
        parentId: 'step:analyze',
      })
    }
    // Branch destinations are capability dispatches (flattened DispatchStrategy).
    expect(byId.get('branch:analyze/severity')!.destination).toMatchObject({
      kind: 'capability',
      capabilities: ['issue-severity'],
    })

    // Sequence backbone: trigger → classify → analyze(container) → assign → output,
    // with the container fanning a sequence edge into each branch.
    expect(hasSeq(graph.edges, '__trigger__', 'step:classify')).toBe(true)
    expect(hasSeq(graph.edges, 'step:classify', 'step:analyze')).toBe(true)
    expect(hasSeq(graph.edges, 'step:analyze', 'branch:analyze/severity')).toBe(true)
    expect(hasSeq(graph.edges, 'step:analyze', 'branch:analyze/dedupe')).toBe(true)
    expect(hasSeq(graph.edges, 'step:analyze', 'branch:analyze/labels')).toBe(true)
    expect(hasSeq(graph.edges, 'step:analyze', 'step:assign')).toBe(true)
    expect(hasSeq(graph.edges, 'step:assign', '__output__')).toBe(true)

    // Data dependencies: every branch reads `$classify.output`; assign + output
    // read both `classify` and `analyze`.
    expect(hasData(graph.edges, 'step:classify', 'branch:analyze/severity')).toBe(true)
    expect(hasData(graph.edges, 'step:classify', 'branch:analyze/dedupe')).toBe(true)
    expect(hasData(graph.edges, 'step:classify', 'branch:analyze/labels')).toBe(true)
    expect(hasData(graph.edges, 'step:classify', 'step:assign')).toBe(true)
    expect(hasData(graph.edges, 'step:analyze', 'step:assign')).toBe(true)
    expect(hasData(graph.edges, 'step:classify', '__output__')).toBe(true)

    // Trigger-read flag (a node badge, not an edge): classify reads $trigger.*.
    expect(byId.get('step:classify')!.readsTrigger).toBe(true)

    // Single-hub host: nothing is stamped cross-hub (the host's federation view
    // is empty, so the projection's `crossHub` stays undefined).
    expect(graph.nodes.every((n) => n.crossHub === undefined)).toBe(true)
  })

  it('404s for an unknown workflow id', async () => {
    const res = await fetch(`${r.web.url}/api/admin/workflows/no-such-flow/graph`, {
      headers: { cookie: r.adminCookie },
    })
    expect(res.status).toBe(404)
  })

  it('requires admin auth (401 without a session)', async () => {
    const res = await fetch(`${r.web.url}/api/admin/workflows/issue-triage-flow/graph`)
    expect(res.status).toBe(401)
  })
})
