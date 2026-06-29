/**
 * `@aipehub/personal-memory` — the memory engine for the resident butler.
 *
 * Public surface:
 *   - `renderFrozenBlock`        pure, byte-stable memory → markdown renderer
 *   - `MemorySession`            once-per-session frozen-block memoizer
 *   - `MemoryToolset`            remember / recall / forget as LLM tools
 *   - `MemoryRetriever`          swappable `recall` backend (vector / chroma-mcp)
 *   - `MemoryAugmentedAgent`     LlmAgent + frozen-block injection + tools + capture
 *   - `buildTurnCapture` (+ helpers)  turn-end → episodic capture (M2)
 *   - `MemoryReviewParticipant`  heartbeat-driven review loop (M2)
 *   - `consolidate` (+ `consolidateReviewer`)  episodic→semantic profile distillation (M3)
 *   - `PersonalMemoryError`      typed error
 *
 * See `docs/zh/PERSONAL-BUTLER-DESIGN.md` (milestones M1–M3).
 */

export {
  renderFrozenBlock,
  renderClusteredFrozenBlock,
  type RenderFrozenBlockOptions,
  type RenderClusteredFrozenBlockOptions,
} from './frozen-block.js'
export { MemorySession, type MemorySessionOptions } from './session.js'
export { MemoryToolset, type MemoryToolsetOptions } from './toolset.js'
export { handleRetriever, type MemoryRetriever } from './retriever.js'
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
  composeReviewers,
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
  distillWithinCap,
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
export {
  DEFAULT_TIERS,
  META_TIER,
  META_LEVEL,
  tierOf,
  levelOf,
  isDigest,
  isClusterProfile,
  isKnownTier,
  normalizeTier,
  routeFallback,
  type TierSpec,
  type TierConfig,
  type MemoryLevel,
} from './tiers.js'
export {
  consolidateTiered,
  promoteCluster,
  tieredReviewer,
  DEFAULT_DIGEST_HARD_CAP,
  DEFAULT_PROMOTE_AFTER_DIGESTS,
  DEFAULT_PROMOTE_MIN_IMPORTANCE,
  type ConsolidateTieredOptions,
  type ConsolidateTieredResult,
  type TieredDigest,
  type PromoteClusterOptions,
  type PromoteClusterResult,
  type TieredReviewerOptions,
} from './consolidate-tiered.js'
export {
  clampImportance,
  importanceOf,
  compareByImportanceThenRecency,
  DEFAULT_IMPORTANCE,
  MIN_IMPORTANCE,
  MAX_IMPORTANCE,
  PIN_IMPORTANCE,
  META_IMPORTANCE,
  type Importance,
} from './importance.js'
export {
  enforceBudget,
  budgetReviewer,
  BUDGET_SCAN_LIMIT,
  DEFAULT_PROTECT_RECENT_EPISODIC,
  type EnforceBudgetOptions,
  type EnforceBudgetResult,
  type MemoryUsageMeasure,
} from './budget.js'
export {
  reconcile,
  reconcileReviewer,
  DEFAULT_RECONCILE_SYSTEM,
  DEFAULT_RECONCILE_TRIGGER_ENTRIES,
  RECONCILE_RECALL_WINDOW,
  type ReconcileOp,
  type ReconcileOptions,
  type ReconcileResult,
} from './reconcile.js'
export {
  extractDurableFacts,
  saveBeforeCompact,
  DEFAULT_COMPACTION_SYSTEM,
  DEFAULT_COMPACTION_MAX_CHARS,
  DEFAULT_COMPACTION_MIN_MESSAGES,
  META_COMPACTED,
  type DurableFact,
  type CompactionMessage,
  type ExtractDurableFactsOptions,
  type SaveBeforeCompactOptions,
  type SaveBeforeCompactResult,
} from './compaction.js'
export { relevanceScore, extractTerms } from './relevance.js'
export { PersonalMemoryError, type PersonalMemoryErrorCode } from './errors.js'
