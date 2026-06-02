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

export { resolveRefs, lookupRef } from './resolver.js'
export type { ResolutionContext } from './resolver.js'

export { RunStore } from './run-store.js'
export type { ArchiveRunsOptions } from './run-store.js'

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

// Phase 13 M1 — AI-assisted workflow authoring moved out to its own
// package, `@aipehub/workflow-assistant`, so this runner stays free of
// any LLM runtime dependency. Import from there if you want the agent:
//
//   import { WorkflowAssistantAgent } from '@aipehub/workflow-assistant'
