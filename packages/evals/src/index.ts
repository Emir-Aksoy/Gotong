/**
 * `@aipehub/evals` — lightweight, LLM-free structural checkers for
 * workflow + agent prompt outputs.
 *
 * # What this package is
 *
 * A collection of pure functions that take an LLM-shaped text blob
 * (already produced — we don't call any LLM here) and answer questions
 * like "does it conform to the three-segment output contract?" or
 * "does it have the required sections?". Pair with golden inputs +
 * vitest to catch prompt regressions in CI without burning API tokens.
 *
 * # What this package is NOT
 *
 * - Not an LLM judge — we don't ask another model "is this output good?"
 * - Not a runtime layer — checkers run in tests / CI / scripts, not in
 *   the hot path of a workflow.
 * - Not a benchmark suite for accuracy — we measure *structural*
 *   compliance, not factual quality. Quality lives in HITL approve
 *   steps and in production telemetry, not here.
 *
 * # Why structural-only
 *
 * Anthropic "Building Effective Agents" recommends starting with
 * deterministic guardrails before reaching for AI-graded evals.
 * Structural checks are zero-cost, fully deterministic, and catch the
 * vast majority of prompt regressions (missing sections, wrong markers,
 * skipped TL;DR). When/if we need semantic eval, that's a separate
 * package — keeping this one focused.
 */

export * from './checkers/three-segment.js'
export * from './checkers/structure.js'
export * from './checkers/workflow-structure.js'
