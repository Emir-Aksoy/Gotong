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

export { resolveRefs, lookupRef } from './resolver.js'
export type { ResolutionContext } from './resolver.js'

export { RunStore } from './run-store.js'

export { WorkflowRunner, workflowParticipantId } from './runner.js'
export type { WorkflowRunnerOptions, HubLike } from './runner.js'

// Phase 13 M1 — AI-assisted workflow authoring moved out to its own
// package, `@aipehub/workflow-assistant`, so this runner stays free of
// any LLM runtime dependency. Import from there if you want the agent:
//
//   import { WorkflowAssistantAgent } from '@aipehub/workflow-assistant'
