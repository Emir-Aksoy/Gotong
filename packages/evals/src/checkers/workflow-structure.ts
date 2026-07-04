/**
 * Workflow structure checker (Phase 13 M4).
 *
 * Takes a parsed `WorkflowDefinition` plus an optional inventory of what's
 * actually live on the hub (agent ids + their capabilities, existing
 * workflow ids), and surfaces structural problems that the bare
 * `parseWorkflow` schema check can't see — because they require knowing
 * about runtime context.
 *
 * Typical caller: the WorkflowAssistantAgent's HTTP route. After
 * `parseWorkflow` accepts the YAML, this checker walks the definition
 * against the live hub state and reports things like:
 *
 *   - `unknown_agent`        — explicit dispatch targets an agent id
 *                              that doesn't exist on this hub
 *   - `unknown_capability`   — capability dispatch (or broadcast) lists
 *                              caps that no registered agent satisfies
 *   - `bad_ref`              — `$stepId.output.…` points to a step id
 *                              that isn't defined anywhere
 *   - `forward_ref`          — ref points to a step that runs LATER
 *                              (would always fail at runtime)
 *   - `self_trigger_cycle`   — a step dispatches to `workflow.trigger.
 *                              capability`, so triggering the workflow
 *                              would re-enter itself
 *   - `id_collision`         — `workflow.id` clashes with an existing
 *                              workflow on this hub (import would fail)
 *
 * Same shape as the other checkers in this package: pure function,
 * `{ ok, violations[] }` result, no IO, no throw. Callers either pass
 * `ok` into a test assertion or render the violations list to a user.
 *
 * Scope deliberately limited:
 *   - We do NOT chase cross-workflow cycles (would require having every
 *     other workflow's full definition; out of scope for M4).
 *   - We do NOT type-check `$ref` *fields* — the resolver does that at
 *     runtime against actual produced values, and a generated workflow
 *     hasn't run yet.
 *   - We do NOT call `parseWorkflow` ourselves — caller passes an
 *     already-parsed `WorkflowDefinition`. Pairing with `parseWorkflow`
 *     is the caller's responsibility (the assistant route does both).
 */

import type {
  Branch,
  DispatchSpec,
  ParallelStep,
  SimpleStep,
  Step,
  WorkflowDefinition,
} from '@gotong/workflow'

// Re-imported here (rather than from workflow) because workflow keeps it
// internal. Mirror of `REF_RE` in `packages/workflow/src/resolver.ts` —
// `$<ident><dot-path>` where the head char is alnum/underscore and the
// rest may include `_-.:`.
const REF_RE = /\$[a-zA-Z0-9_][a-zA-Z0-9_.:-]*/g

// ───────────────────────────────────────────────────────────────────
// Public types
// ───────────────────────────────────────────────────────────────────

/**
 * What we know about the host this workflow is targeting. All fields
 * optional — callers pass what they have, and checks that need missing
 * data are silently skipped (no false positives).
 */
export interface WorkflowInventory {
  /**
   * Agents currently registered on the hub. Used to validate explicit
   * dispatch targets (`strategy.to`) and to verify at least one agent
   * satisfies each capability-based dispatch.
   *
   * When omitted (or empty), `unknown_agent` / `unknown_capability`
   * checks are skipped — the workflow is treated as portable across
   * hubs, structural-only.
   */
  agents?: ReadonlyArray<{
    id: string
    capabilities: ReadonlyArray<string>
  }>

  /**
   * Existing workflow ids on this hub. Used to detect `id_collision` —
   * importing a workflow with a duplicate id either overwrites or
   * fails depending on the host, so callers want to know up front.
   */
  existingWorkflowIds?: ReadonlyArray<string>
}

export type WorkflowStructureViolationKind =
  | 'unknown_agent'
  | 'unknown_capability'
  | 'bad_ref'
  | 'forward_ref'
  | 'self_trigger_cycle'
  | 'id_collision'

export interface WorkflowStructureViolation {
  kind: WorkflowStructureViolationKind
  /** Human-readable explanation safe to surface in admin UI verbatim. */
  message: string
  /**
   * JSON-pointer-ish path inside the workflow object — e.g.
   * `workflow.steps[2].dispatch.strategy.to` — so the UI can highlight
   * the offending field. Best-effort; not machine-parsed.
   */
  path: string
}

export interface WorkflowStructureCheckResult {
  ok: boolean
  violations: WorkflowStructureViolation[]
}

// ───────────────────────────────────────────────────────────────────
// Checker
// ───────────────────────────────────────────────────────────────────

/**
 * Deep-check a parsed workflow against an optional hub inventory.
 *
 * Always returns; never throws. `ok` is true iff `violations` is empty.
 * Caller picks rendering strategy:
 *   - Tests: `expect(result.ok).toBe(true)` and dump violations on fail.
 *   - UI: render the violations list with `path` highlighting.
 *   - SDK: return as-is to the caller; let them decide.
 */
export function checkWorkflowStructure(
  workflow: WorkflowDefinition,
  inventory?: WorkflowInventory,
): WorkflowStructureCheckResult {
  const violations: WorkflowStructureViolation[] = []

  const inv = inventory ?? {}
  const agents = inv.agents ?? []
  const agentIds = new Set((inv.agents ?? []).map((a) => a.id))
  const haveInventory = agents.length > 0

  // 1. id collision
  if (inv.existingWorkflowIds && inv.existingWorkflowIds.includes(workflow.id)) {
    violations.push({
      kind: 'id_collision',
      message: `workflow.id '${workflow.id}' already exists on this hub (import would collide)`,
      path: 'workflow.id',
    })
  }

  // 2-N. walk steps in declaration order so forward-ref detection works.
  const earlierStepIds = new Set<string>()
  const allStepIds = new Set(workflow.steps.map((s) => s.id))

  for (let i = 0; i < workflow.steps.length; i++) {
    const step = workflow.steps[i]!
    const path = `workflow.steps[${i}]`
    if (isParallelStep(step)) {
      checkParallelStep(step, path, {
        violations,
        agentIds,
        agents,
        haveInventory,
        earlierStepIds,
        allStepIds,
        triggerCap: workflow.trigger.capability,
      })
    } else {
      checkSimpleStep(step, path, {
        violations,
        agentIds,
        agents,
        haveInventory,
        earlierStepIds,
        allStepIds,
        triggerCap: workflow.trigger.capability,
      })
    }
    earlierStepIds.add(step.id)
  }

  // Workflow-level `output` may also contain $-refs — by this point every
  // step is "earlier", so forward-ref isn't a concern; just check bad_ref.
  if (workflow.output !== undefined) {
    checkRefsInTree(workflow.output, 'workflow.output', {
      violations,
      earlierStepIds: allStepIds, // all steps complete before output
      allStepIds,
    })
  }

  return { ok: violations.length === 0, violations }
}

// ───────────────────────────────────────────────────────────────────
// Internals
// ───────────────────────────────────────────────────────────────────

interface StepCtx {
  violations: WorkflowStructureViolation[]
  agentIds: Set<string>
  agents: ReadonlyArray<{ id: string; capabilities: readonly string[] }>
  haveInventory: boolean
  earlierStepIds: Set<string>
  allStepIds: Set<string>
  triggerCap: string
}

interface RefCtx {
  violations: WorkflowStructureViolation[]
  earlierStepIds: Set<string>
  allStepIds: Set<string>
}

function isParallelStep(s: Step): s is ParallelStep {
  return s.kind === 'parallel'
}

function checkSimpleStep(step: SimpleStep, path: string, ctx: StepCtx): void {
  checkDispatch(step.dispatch, `${path}.dispatch`, ctx)
  // Refs inside the step's resolved payload point at earlier steps only.
  checkRefsInTree(step.dispatch.payload, `${path}.dispatch.payload`, {
    violations: ctx.violations,
    earlierStepIds: ctx.earlierStepIds,
    allStepIds: ctx.allStepIds,
  })
}

function checkParallelStep(step: ParallelStep, path: string, ctx: StepCtx): void {
  for (let i = 0; i < step.branches.length; i++) {
    const b: Branch = step.branches[i]!
    const bp = `${path}.branches[${i}]`
    checkDispatch(b.dispatch, `${bp}.dispatch`, ctx)
    checkRefsInTree(b.dispatch.payload, `${bp}.dispatch.payload`, {
      violations: ctx.violations,
      earlierStepIds: ctx.earlierStepIds,
      allStepIds: ctx.allStepIds,
    })
  }
}

function checkDispatch(d: DispatchSpec, path: string, ctx: StepCtx): void {
  const s = d.strategy
  if (s.kind === 'explicit') {
    // Self-cycle check via explicit: we can't tell what cap the target
    // listens on without inventory — skip cycle check, only validate id.
    if (ctx.haveInventory && !ctx.agentIds.has(s.to)) {
      ctx.violations.push({
        kind: 'unknown_agent',
        message: `explicit dispatch targets agent '${s.to}', which is not registered on this hub`,
        path: `${path}.strategy.to`,
      })
    }
    return
  }
  if (s.kind === 'capability') {
    // self-cycle: workflow runner registers itself as a participant for
    // the trigger capability. Any step that dispatches back to it
    // re-enters the same workflow — infinite loop at worst, dispatch
    // depth gate at best.
    if (s.capabilities.includes(ctx.triggerCap)) {
      ctx.violations.push({
        kind: 'self_trigger_cycle',
        message: `step dispatches to its own workflow's trigger capability '${ctx.triggerCap}' — would re-trigger the workflow`,
        path: `${path}.strategy.capabilities`,
      })
    }
    if (ctx.haveInventory) {
      if (!hasAgentWithAllCapabilities(ctx.agents, s.capabilities)) {
        ctx.violations.push({
          kind: 'unknown_capability',
          message: `no single agent on this hub satisfies all capabilities: ${s.capabilities.join(', ')}`,
          path: `${path}.strategy.capabilities`,
        })
      }
    }
    return
  }
  // broadcast — capabilities optional; only flag self-cycle when listed.
  if (s.kind === 'broadcast') {
    const caps = s.capabilities ?? []
    if (caps.includes(ctx.triggerCap)) {
      ctx.violations.push({
        kind: 'self_trigger_cycle',
        message: `broadcast includes workflow's own trigger capability '${ctx.triggerCap}' — would re-trigger the workflow`,
        path: `${path}.strategy.capabilities`,
      })
    }
    if (ctx.haveInventory && caps.length > 0) {
      if (!hasAgentWithAllCapabilities(ctx.agents, caps)) {
        ctx.violations.push({
          kind: 'unknown_capability',
          message: `no single agent on this hub satisfies all broadcast capabilities: ${caps.join(', ')}`,
          path: `${path}.strategy.capabilities`,
        })
      }
    }
  }
}

function hasAgentWithAllCapabilities(
  agents: ReadonlyArray<{ capabilities: readonly string[] }>,
  capabilities: readonly string[],
): boolean {
  return agents.some((agent) => capabilities.every((cap) => agent.capabilities.includes(cap)))
}

/**
 * Walk a payload (or output) tree looking for `$ref` strings, then check
 * each ref's *head* against the set of known step ids. Forward refs
 * (head ∈ allStepIds but ∉ earlierStepIds) are flagged separately from
 * unknown refs (head ∉ allStepIds at all).
 *
 * `$trigger.payload[.…]` and `$trigger.from` are always valid here —
 * the resolver checks payload field existence at runtime against real
 * values, and we don't have those at design time.
 */
function checkRefsInTree(value: unknown, path: string, ctx: RefCtx): void {
  if (value === null || value === undefined) return
  if (typeof value === 'string') {
    const matches = value.match(REF_RE)
    if (!matches) return
    for (const ref of matches) {
      checkOneRef(ref, path, ctx)
    }
    return
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      checkRefsInTree(value[i], `${path}[${i}]`, ctx)
    }
    return
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      checkRefsInTree(v, `${path}.${k}`, ctx)
    }
  }
}

function checkOneRef(ref: string, path: string, ctx: RefCtx): void {
  // Strip leading "$" then split on ".".
  const parts = ref.slice(1).split('.')
  const head = parts[0]
  if (!head) return
  // $trigger.* — runtime-validated; nothing to say here.
  if (head === 'trigger') return
  // Step head: $<stepId>.output or $<stepId>.<branchId>.output
  if (ctx.allStepIds.has(head)) {
    if (!ctx.earlierStepIds.has(head)) {
      ctx.violations.push({
        kind: 'forward_ref',
        message: `ref '${ref}' points to step '${head}' which runs at or after the current step`,
        path,
      })
    }
    return
  }
  ctx.violations.push({
    kind: 'bad_ref',
    message: `ref '${ref}' points to unknown step '${head}' (and is not '$trigger…')`,
    path,
  })
}
