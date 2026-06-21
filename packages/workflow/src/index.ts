/**
 * Public API for `@aipehub/workflow`.
 */

export {
  WORKFLOW_SCHEMA_V1,
  WorkflowSchemaError,
  WorkflowRefError,
} from './types.js'

export {
  WorkflowPredicateError,
  parsePredicate,
  evaluatePredicate,
  CompiledPredicate,
} from './predicate.js'
export type {
  WorkflowDefinition,
  TriggerSpec,
  Step,
  StepKind,
  SimpleStep,
  ParallelStep,
  Branch,
  DispatchSpec,
  StepFailurePolicy,
  RunState,
  RunStatus,
  RunSummary,
  StepRecord,
} from './types.js'

export { parseWorkflow } from './schema.js'

// Phase 15 — workflow lifecycle + revision model.
export {
  transition,
  isLiveState,
  legalActions,
  WorkflowLifecycleError,
  WorkflowRevisionError,
} from './lifecycle.js'
export type {
  LifecycleState,
  LifecycleAction,
  RevisionOrigin,
  RevisionMeta,
  WorkflowRevision,
  TransitionLog,
  LifecycleRecord,
  TransitionInput,
} from './lifecycle.js'

export { resolveRefs, lookupRef, collectRefHeads } from './resolver.js'
export type { ResolutionContext } from './resolver.js'

// Read-only DAG projection of a workflow definition — a pure lens over the
// already-structured definition (no runtime, no LLM). Consumed by the host's
// `graphOf` (which stamps cross-hub annotations) and rendered by the admin UI.
export { projectWorkflowGraph, TRIGGER_NODE_ID, OUTPUT_NODE_ID } from './graph.js'
export type {
  WorkflowGraphView,
  WorkflowGraphNode,
  WorkflowGraphEdge,
  GraphNodeKind,
  GraphEdgeKind,
  GraphNodeDestination,
  GraphNodeCrossHub,
} from './graph.js'

export { RunStore } from './run-store.js'
export type { ArchiveRunsOptions, RunStatusCounts } from './run-store.js'

// Phase 15 — file-first revision + lifecycle stores (interface-gated so a
// SQLite backend can slot in later).
export { sanitiseFileBase } from './paths.js'
export { FileRevisionStore, hashDefinition } from './revision-store.js'
export type { RevisionStore } from './revision-store.js'
export { FileLifecycleStore } from './lifecycle-store.js'
export type { LifecycleStore } from './lifecycle-store.js'

export { WorkflowRunner, workflowParticipantId } from './runner.js'
export type {
  WorkflowRunnerOptions,
  HubLike,
  DefinitionResolver,
  ResolvedDefinition,
} from './runner.js'

// R7 — the step-execution seam. Provide a `StepExecutor` via
// `WorkflowRunnerOptions.stepExecutors` (plus a parser branch emitting its
// `kind`) to add a new control flow without touching the runner core.
export { SimpleStepExecutor, ParallelStepExecutor } from './step-executors.js'
export type { StepExecutor, StepExecContext } from './step-executors.js'

// Phase 13 M1 — AI-assisted workflow authoring moved out to its own
// package, `@aipehub/workflow-assistant`, so this runner stays free of
// any LLM runtime dependency. Import from there if you want the agent:
//
//   import { WorkflowAssistantAgent } from '@aipehub/workflow-assistant'
