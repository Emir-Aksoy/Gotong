/**
 * Public API for `@gotong/workflow-assistant`.
 *
 * Phase 13 M1 — AI-assisted workflow authoring. Wraps an LlmAgent that
 * turns a natural-language description into a draft
 * `gotong.workflow/v1` YAML, self-validates it via `parseWorkflow`,
 * and reports a `draftStatus` verdict ('valid' | 'no_yaml' | 'invalid').
 *
 * Lives in a separate package from `@gotong/workflow` so the runner
 * itself doesn't acquire a runtime dependency on `@gotong/llm` —
 * non-AI workflow consumers (host bootstrap, sidecars, evals) keep
 * a lean dep graph.
 */

export {
  WorkflowAssistantAgent,
  buildSystemPrompt,
  renderUserMessage,
  renderExplainMessage,
  detailInstruction,
  extractYamlAndExplanation,
  verdictForYaml,
  verdictForYamlWithDeepCheck,
  inventoryFromContextHints,
  WORKFLOW_ASSISTANT_CAPABILITY,
  WORKFLOW_ASSISTANT_DEFAULT_ID,
} from './assistant.js'

export type {
  WorkflowAssistantPayload,
  WorkflowAssistantOutput,
  WorkflowAssistantOptions,
  WorkflowAssistMode,
  WorkflowDetailLevel,
  WorkflowDraftStatus,
  WorkflowExample,
  YamlVerdict,
} from './assistant.js'

// Architect evolution — re-export the DAG graph shape so callers that
// consume `output.graph` can type it without a separate `@gotong/workflow`
// import. (web duck-types its own copy; host already depends on workflow.)
export type {
  WorkflowGraphView,
  WorkflowGraphNode,
  WorkflowGraphEdge,
} from '@gotong/workflow'

// Phase 13 follow-up — few-shot example loader. Bundled templates ship
// inside the package's `templates/` dir; callers can also supply their
// own directory of YAMLs.
export {
  loadBundledExamples,
  loadExamplesFromDir,
} from './examples-loader.js'

// Phase 13 M4 — re-export the deep-check shapes so callers don't need
// a separate `@gotong/evals` import just to type the deepCheck field.
export type {
  WorkflowInventory,
  WorkflowStructureCheckResult,
  WorkflowStructureViolation,
  WorkflowStructureViolationKind,
} from '@gotong/evals/checkers/workflow-structure'
