/**
 * Public API for `@aipehub/workflow`.
 */

export {
  WORKFLOW_SCHEMA_V1,
  WorkflowSchemaError,
  WorkflowRefError,
} from './types.js'
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
  StepRecord,
} from './types.js'

export { parseWorkflow } from './schema.js'

export { resolveRefs, lookupRef } from './resolver.js'
export type { ResolutionContext } from './resolver.js'

export { RunStore } from './run-store.js'

export { WorkflowRunner, workflowParticipantId } from './runner.js'
export type { WorkflowRunnerOptions, HubLike } from './runner.js'
