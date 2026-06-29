/**
 * `@aipehub/personal-memory` — the memory engine for the resident butler.
 *
 * Public surface:
 *   - `renderFrozenBlock`        pure, byte-stable memory → markdown renderer
 *   - `MemorySession`            once-per-session frozen-block memoizer
 *   - `MemoryToolset`            remember / recall / forget as LLM tools
 *   - `MemoryAugmentedAgent`     LlmAgent + frozen-block injection + tools + capture
 *   - `buildTurnCapture` (+ helpers)  turn-end → episodic capture (M2)
 *   - `MemoryReviewParticipant`  heartbeat-driven review loop (M2)
 *   - `consolidate` (+ `consolidateReviewer`)  episodic→semantic profile distillation (M3)
 *   - `PersonalMemoryError`      typed error
 *
 * See `docs/zh/PERSONAL-BUTLER-DESIGN.md` (milestones M1–M3).
 */

export { renderFrozenBlock, type RenderFrozenBlockOptions } from './frozen-block.js'
export { MemorySession, type MemorySessionOptions } from './session.js'
export { MemoryToolset, type MemoryToolsetOptions } from './toolset.js'
export {
  MemoryAugmentedAgent,
  type MemoryAugmentedAgentOptions,
} from './agent.js'
export {
  buildTurnCapture,
  extractUserText,
  extractReplyText,
  isHeartbeatPayload,
  DEFAULT_CAPTURE_MAX_CHARS,
  type TurnCaptureInput,
} from './capture.js'
export {
  MemoryReviewParticipant,
  HEARTBEAT_OK,
  MEMORY_REVIEW_ID,
  DEFAULT_REVIEW_MIN_EPISODIC,
  DEFAULT_REVIEW_RECALL_K,
  type MemoryReviewParticipantOptions,
  type MemoryReviewer,
  type ReviewPolicy,
  type ReviewContext,
  type ReviewOutcome,
} from './review.js'
export {
  consolidate,
  shouldConsolidate,
  consolidateReviewer,
  DEFAULT_CONSOLIDATE_SYSTEM,
  DEFAULT_CONSOLIDATE_TRIGGER_ENTRIES,
  DEFAULT_CONSOLIDATE_TRIGGER_BYTES,
  DEFAULT_CONSOLIDATE_KEEP_RECENT,
  DEFAULT_PROFILE_HARD_CAP,
  META_PROFILE,
  type MemorySummarizer,
  type ConsolidateOptions,
  type ConsolidateResult,
} from './consolidate.js'
export { PersonalMemoryError, type PersonalMemoryErrorCode } from './errors.js'
