/**
 * `@gotong/personal-butler` — a resident butler agent (OpenClaw / Hermes style).
 *
 * Builds on `@gotong/personal-memory` (frozen-block memory + turn capture) and
 * adds a bounded, governance-gated tool-loop: benign tools run inline, sensitive
 * ones park for a human (`SuspendTaskError` → `/me` inbox) before any side
 * effect. The framework still never decides — it routes, suspends, and resumes;
 * a person clears every dangerous action.
 *
 * Leaf package: no host / identity dependency. The classifier (real tiering) and
 * executor (real side effects) are INJECTED by the host, same discipline as the
 * `MemorySummarizer` in `@gotong/personal-memory`.
 */

export { ButlerError, type ButlerErrorCode } from './errors.js'

export {
  BUTLER_NEVER_RESUME_AT,
  BUTLER_GATE_STATE_V,
  butlerGateState,
  readButlerGateState,
  readButlerDecision,
  type ButlerApprovalContext,
  type ButlerGateState,
  type ButlerDecision,
} from './checkpoint.js'

export {
  GovernedActionToolset,
  type GovernedActionToolsetOptions,
  type GovernedToolSpec,
  type GovernedVerdict,
  type GovernedClassifier,
  type GovernedExecutor,
  type GovernedExecResult,
} from './governed-toolset.js'

export {
  PersonalButlerAgent,
  type PersonalButlerAgentOptions,
} from './agent.js'

export {
  openTaskNotebook,
  createTaskNotebookToolset,
  composeContextProbes,
  TASK_NOTEBOOK_LIMITS,
  type TaskNotebook,
  type TaskNote,
  type TaskNoteStep,
  type OpenTaskNotebookOptions,
  type OpenTaskNoteInput,
  type UpdateTaskNoteInput,
  type ButlerContextProbe,
  type TaskNotebookLogger,
} from './task-notebook.js'
