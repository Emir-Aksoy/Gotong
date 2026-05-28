/**
 * Public API for `@aipehub/workflow-assistant`.
 *
 * Phase 13 M1 — AI-assisted workflow authoring. Wraps an LlmAgent that
 * turns a natural-language description into a draft
 * `aipehub.workflow/v1` YAML, self-validates it via `parseWorkflow`,
 * and reports a `draftStatus` verdict ('valid' | 'no_yaml' | 'invalid').
 *
 * Lives in a separate package from `@aipehub/workflow` so the runner
 * itself doesn't acquire a runtime dependency on `@aipehub/llm` —
 * non-AI workflow consumers (host bootstrap, sidecars, evals) keep
 * a lean dep graph.
 */

export {
  WorkflowAssistantAgent,
  buildSystemPrompt,
  renderUserMessage,
  extractYamlAndExplanation,
  verdictForYaml,
  WORKFLOW_ASSISTANT_CAPABILITY,
  WORKFLOW_ASSISTANT_DEFAULT_ID,
} from './assistant.js'

export type {
  WorkflowAssistantPayload,
  WorkflowAssistantOutput,
  WorkflowAssistantOptions,
  WorkflowDraftStatus,
  WorkflowExample,
} from './assistant.js'
