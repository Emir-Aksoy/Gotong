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
  BUTLER_MAX_TOOL_ROUNDS,
  type PersonalButlerAgentOptions,
  type ButlerLongRunDriver,
} from './agent.js'

export {
  buildButlerClockProbe,
  renderClockCard,
  type ButlerClockProbeOptions,
} from './butler-clock.js'

export {
  openTaskNotebook,
  createTaskNotebookToolset,
  composeContextProbes,
  readTaskNotesSnapshot,
  triageStalledTaskNotes,
  formatTaskNudgeMessage,
  TASK_NOTEBOOK_LIMITS,
  TASK_NUDGE_DEFAULTS,
  type TriageStalledInput,
  type TaskNudgeTriage,
  type TaskNotebook,
  type TaskNote,
  type TaskNoteStep,
  type OpenTaskNotebookOptions,
  type OpenTaskNoteInput,
  type UpdateTaskNoteInput,
  type ButlerContextProbe,
  type TaskNotebookLogger,
} from './task-notebook.js'

export {
  openKnowledgeLibrary,
  createKnowledgeLibraryToolset,
  validateKnowledgePath,
  KNOWLEDGE_LIBRARY_LIMITS,
  KNOWLEDGE_ARCHIVE_DIR,
  KNOWLEDGE_INDEX_FILE,
  type KnowledgeLibrary,
  type KnowledgeFileInfo,
  type KnowledgeListing,
  type OpenKnowledgeLibraryOptions,
  type KnowledgeLibraryLimits,
} from './knowledge-library.js'

export {
  ButlerSessionWindow,
  SESSION_IDLE_MS,
  SESSION_MAX_TURNS,
  SESSION_TURN_MAX_CHARS,
  SESSION_RECALL_HINT,
  buildButlerSessionHintProbe,
  type SessionRole,
  type SessionMessage,
  type ButlerSessionWindowOptions,
  type SessionWindowLogger,
} from './session-window.js'

export {
  knowledgeLibrarianReviewer,
  parseLibrarianPlan,
  isPromoted,
  META_PROMOTED_TO,
  LIBRARIAN_RECALL_WINDOW,
  DEFAULT_LIBRARIAN_TRIGGER_FACTS,
  DEFAULT_LIBRARIAN_MAX_BATCH,
  DEFAULT_LIBRARIAN_SYSTEM,
  type KnowledgeLibrarianOptions,
  type KnowledgeShelver,
  type LibrarianPlan,
  type LibrarianPromotion,
} from './knowledge-librarian.js'

export {
  classifyHandsAction,
  classifyHandsToolCall,
  handsGovernedClassifier,
  parseHandsToolCall,
  resolveWorkspacePath,
  inferNeedsNet,
  nodeHandsFsProbe,
  HANDS_LIMITS,
  HANDS_TOOL_NAMES,
  HANDS_FORBIDDEN_COMMANDS,
  HANDS_NET_COMMANDS,
  type HandsTier,
  type HandsToolName,
  type HandsAction,
  type HandsFileAction,
  type HandsFileKind,
  type HandsRunAction,
  type HandsPolicyCode,
  type HandsPolicyDecision,
  type HandsPolicyContext,
  type HandsFsProbe,
} from './hands-policy.js'

export {
  validatePanelConfig,
  PANEL_SCHEMA_VERSION,
  PANEL_COMPONENT_TYPES,
  PANEL_RESERVED_TYPES,
  PANEL_FIXED_SOURCES,
  PANEL_SOURCE_PREFIXES,
  PANEL_FIXED_ACTIONS,
  PANEL_ACTION_PREFIXES,
  PANEL_COMPONENT_CONTRACTS,
  PANEL_LIMITS,
  PANEL_ID_RE,
  PANEL_TAB_IDS,
  PANEL_RESERVED_TABS,
  PANEL_SCALES,
  DEFAULT_PANEL,
  panelContract,
  panelContractVerdict,
  PANEL_BASELINE_CLIENT_SCHEMA_VERSION,
  type PanelContract,
  type PanelContractVerdict,
  type PanelConfig,
  type PanelSection,
  type PanelComponent,
  type PanelComponentType,
  type PanelTabId,
  type PanelScale,
  type PanelValidationResult,
} from './panel-schema.js'

export {
  openLongRunDossierStore,
  cleanLongRunText,
  escapeXmlText,
  clipLongRunText,
  recordSegmentUsage,
  checkLongRunBudget,
  decideSegmentVerdict,
  precheckLongRunWake,
  countSettledChildren,
  markChildResultsSeen,
  renderRelayPrompt,
  renderWindDownPrompt,
  longRunRelayState,
  readLongRunRelayState,
  readLongRunSegmentMarker,
  readLongRunChildMarker,
  LONGRUN_DOSSIER_V,
  LONGRUN_LIMITS,
  LONGRUN_TOOL_NAMES,
  LONGRUN_TASK_ID_RE,
  LONGRUN_RELAY_STATE_V,
  LONGRUN_SEGMENT_PAYLOAD_KEY,
  LONGRUN_CHILD_PAYLOAD_KEY,
  type LongRunDossier,
  type LongRunStatus,
  type LongRunPlanItem,
  type LongRunChildRow,
  type LongRunBudget,
  type LongRunJournalEntry,
  type LongRunDossierStore,
  type LongRunLoadResult,
  type LongRunSummary,
  type LongRunBudgetVerdict,
  type SegmentVerdict,
  type LongRunWakePrecheck,
  type OpenLongRunStoreOptions,
  type CreateLongRunInput,
  type LongRunLoggerDuck,
} from './longrun-dossier.js'

export {
  openObsidianProjector,
  renderTasksProjection,
  renderMemoryTierProjection,
  planMemoryProjections,
  buildKnowledgeLinkTable,
  linkifyKnowledgePaths,
  isSafeTierId,
  oneLine,
  TASKS_PROJECTION_FILE,
  MEMORY_PROJECTION_DIR,
  OBSIDIAN_PROJECTION_LIMITS,
  type ObsidianProjector,
  type OpenObsidianProjectorOptions,
  type MemoryProjectionPlan,
} from './obsidian-projection.js'
