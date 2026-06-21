/**
 * Read-only graph projection of a `WorkflowDefinition`.
 *
 * A workflow definition is ALREADY a fully-structured DAG (trigger → steps →
 * parallel branches → output, with `when` predicates and `$ref` data deps). This
 * module is a PURE function that flattens that structure into a `{ nodes, edges }`
 * view a frontend can draw — no layout, no styling, no runtime, no LLM. It does
 * NOT change the definition or how the runner executes it; it's a lens.
 *
 * Node kinds:
 *   - `trigger`  — the dispatch capability that starts the workflow (one, top).
 *   - `step`     — a simple step (one `hub.dispatch`).
 *   - `parallel` — a fan-out container; its branches are separate `branch` nodes.
 *   - `branch`   — one branch inside a parallel step.
 *   - `output`   — the workflow's return value (one, bottom).
 *
 * Edge kinds:
 *   - `sequence`    — execution backbone (trigger → step1 → … → output; a
 *                     parallel container fans `sequence` edges out to its branches).
 *   - `data`        — a `$ref` data dependency: an earlier step's node → the node
 *                     whose payload reads it. Trigger reads are a node flag
 *                     (`readsTrigger`) rather than an edge, to avoid clutter
 *                     (nearly every step reads the trigger payload).
 *
 * The `when` predicate and node-level `dataClasses` ride on the node; the
 * frontend renders them as badges / a dashed incoming edge. Cross-hub and
 * governance annotations are the HOST's concern (it has the federation view) —
 * the pure projection leaves `crossHub` undefined for the host to stamp.
 */

import type { DispatchStrategy } from '@aipehub/core'

import type { WorkflowDefinition } from './types.js'
import { collectRefHeads } from './resolver.js'

export type GraphNodeKind = 'trigger' | 'step' | 'parallel' | 'branch' | 'output'

/** Where a step/branch node dispatches — a flattened `DispatchStrategy`. */
export interface GraphNodeDestination {
  /** `'capability' | 'explicit' | 'broadcast'`. */
  kind: 'capability' | 'explicit' | 'broadcast'
  /** capability / broadcast: the capability list (broadcast may be empty = all). */
  capabilities: string[]
  /** explicit: the target participant id. */
  to?: string
}

/** Off-hub destination, stamped by the HOST (the pure projection never sets it). */
export interface GraphNodeCrossHub {
  /** Destination id (peer wrapper id or outbound A2A agent id). */
  peer: string
  peerLabel: string | null
  /** `'peer'` = mesh peer (may gate for approval); `'a2a'` = external (fires immediately). */
  kind: 'peer' | 'a2a'
}

export interface WorkflowGraphNode {
  /** Unique node id within the graph (prefixed so it can't collide with a step id). */
  id: string
  kind: GraphNodeKind
  /** Display label — step id / trigger capability / `输出`. */
  label: string
  description?: string
  /** `step` / `branch`: where it dispatches. */
  destination?: GraphNodeDestination
  /** `step` / `parallel` / `branch`: the `when` predicate text, if gated. */
  when?: string
  /** `step` / `branch`: node-level data classes (federation I/O tags). */
  dataClasses?: string[]
  /** `step` / `branch`: true if the dispatch payload reads `$trigger.*`. */
  readsTrigger?: boolean
  /** `parallel`: child branch node ids, in declaration order. */
  branchNodeIds?: string[]
  /** `branch`: the parent parallel node id. */
  parentId?: string
  /** Stamped by the host when this node's dispatch leaves the hub. */
  crossHub?: GraphNodeCrossHub
}

export type GraphEdgeKind = 'sequence' | 'data'

export interface WorkflowGraphEdge {
  from: string
  to: string
  kind: GraphEdgeKind
}

export interface WorkflowGraphView {
  workflowId: string
  nodes: WorkflowGraphNode[]
  edges: WorkflowGraphEdge[]
}

/** Stable, collision-proof node ids (a step id can be anything, so we prefix). */
export const TRIGGER_NODE_ID = '__trigger__'
export const OUTPUT_NODE_ID = '__output__'
const stepNodeId = (stepId: string): string => `step:${stepId}`
const branchNodeId = (stepId: string, branchId: string): string =>
  `branch:${stepId}/${branchId}`

/**
 * Project a workflow definition into a read-only `{ nodes, edges }` graph.
 * Pure: same definition in ⇒ same graph out; never mutates the input.
 */
export function projectWorkflowGraph(def: WorkflowDefinition): WorkflowGraphView {
  const nodes: WorkflowGraphNode[] = []
  const edges: WorkflowGraphEdge[] = []

  // The set of real step ids — used to filter `$ref` heads down to genuine
  // step→step data edges (a head that isn't a step id is harmless noise).
  const stepIds = new Set(def.steps.map((s) => s.id))

  // 1. Trigger node (top of the backbone).
  nodes.push({
    id: TRIGGER_NODE_ID,
    kind: 'trigger',
    label: def.trigger.capability,
  })

  // 2. One node per top-level step, threaded by `sequence` edges. The previous
  //    backbone node starts at the trigger; a simple step advances it to itself,
  //    a parallel step advances it to the container (branches hang off it).
  let prevBackboneId = TRIGGER_NODE_ID
  for (const step of def.steps) {
    if (step.kind === 'parallel') {
      const containerId = stepNodeId(step.id)
      const branchIds: string[] = []
      for (const branch of step.branches) {
        const bId = branchNodeId(step.id, branch.id)
        branchIds.push(bId)
        const bNode: WorkflowGraphNode = {
          id: bId,
          kind: 'branch',
          label: branch.id,
          destination: flattenDestination(branch.dispatch.strategy),
          parentId: containerId,
        }
        if (branch.description) bNode.description = branch.description
        if (branch.when) bNode.when = branch.when
        applyDataDeps(bNode, branch.dispatch.payload, branch.dispatch.dataClasses, stepIds, edges, bId)
        nodes.push(bNode)
        // Fan-out: the container sequences into each branch.
        edges.push({ from: containerId, to: bId, kind: 'sequence' })
      }
      const node: WorkflowGraphNode = {
        id: containerId,
        kind: 'parallel',
        label: step.id,
        branchNodeIds: branchIds,
      }
      if (step.description) node.description = step.description
      if (step.when) node.when = step.when
      // Insert the container BEFORE its branches so a consumer that renders in
      // array order draws the box before its members.
      nodes.splice(nodes.length - step.branches.length, 0, node)
      edges.push({ from: prevBackboneId, to: containerId, kind: 'sequence' })
      prevBackboneId = containerId
    } else {
      const id = stepNodeId(step.id)
      const node: WorkflowGraphNode = {
        id,
        kind: 'step',
        label: step.id,
        destination: flattenDestination(step.dispatch.strategy),
      }
      if (step.description) node.description = step.description
      if (step.when) node.when = step.when
      applyDataDeps(node, step.dispatch.payload, step.dispatch.dataClasses, stepIds, edges, id)
      nodes.push(node)
      edges.push({ from: prevBackboneId, to: id, kind: 'sequence' })
      prevBackboneId = id
    }
  }

  // 3. Output node (bottom). Sequence from the last backbone node; data edges
  //    from any steps the explicit `output` reads.
  nodes.push({ id: OUTPUT_NODE_ID, kind: 'output', label: '__output__' })
  edges.push({ from: prevBackboneId, to: OUTPUT_NODE_ID, kind: 'sequence' })
  if (def.output !== undefined) {
    const { steps } = collectRefHeads(def.output)
    for (const src of steps) {
      if (stepIds.has(src)) {
        edges.push({ from: stepNodeId(src), to: OUTPUT_NODE_ID, kind: 'data' })
      }
    }
  }

  return { workflowId: def.id, nodes, edges }
}

/** Flatten a `DispatchStrategy` into the node's `destination` shape. */
function flattenDestination(strategy: DispatchStrategy): GraphNodeDestination {
  if (strategy.kind === 'explicit') {
    return { kind: 'explicit', capabilities: [], to: strategy.to }
  }
  if (strategy.kind === 'broadcast') {
    return { kind: 'broadcast', capabilities: strategy.capabilities ?? [] }
  }
  return { kind: 'capability', capabilities: strategy.capabilities }
}

/**
 * Stamp node-level data classes + trigger-read flag, and emit `data` edges for
 * every earlier step this node's payload references. Mutates `node` and pushes
 * onto `edges`.
 */
function applyDataDeps(
  node: WorkflowGraphNode,
  payload: unknown,
  dataClasses: string[] | undefined,
  stepIds: Set<string>,
  edges: WorkflowGraphEdge[],
  nodeId: string,
): void {
  if (dataClasses && dataClasses.length > 0) node.dataClasses = [...dataClasses]
  const { steps, usesTrigger } = collectRefHeads(payload)
  if (usesTrigger) node.readsTrigger = true
  for (const src of steps) {
    // Only draw an edge to a step that actually exists (filters `$5.00`-style
    // false matches + self/forward refs the deep-check flags separately).
    if (stepIds.has(src) && src !== node.label) {
      edges.push({ from: stepNodeId(src), to: nodeId, kind: 'data' })
    }
  }
}
