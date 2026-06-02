export { Hub, newId } from './hub.js'
export type { HubConfig, TaskStatus, TaskView } from './hub.js'
export { readMaxDispatchDepth } from './hub.js'

export {
  Space,
  SpaceUnsafeError,
  DEFAULT_CONFIG,
  SPACE_FILE_VERSION,
} from './space.js'
export type {
  SpaceMeta,
  SpaceConfig,
  SpaceUnsafeCode,
  AdminRecord,
  AgentRecord,
  ManagedAgentSpec,
  ManagedAgentLifecycle,
  McpServerSpec,
  McpStdioServerSpec,
  McpHttpServerSpec,
  McpSseServerSpec,
  HubMcpServerRecord,
  ServiceUseSpec,
  WorkerRecord,
  SessionRecord,
  PersistedPendingApp,
  // Phase 10 M4 — DispatchToolset allow-list declared on the agent spec
  DispatchAllowList,
  // v5 Stream D — per-agent proactive heartbeat spec
  HeartbeatSpec,
} from './space.js'

export type {
  ServicesAdminSurface,
  ServicePluginDescriptor,
  ServiceOwnerRef,
  ServiceTarget,
  ServiceSnapshotView,
  ServicePreviewBlob,
  ServiceTrashRef,
} from './services-admin.js'

export type {
  GrowthReportsAdminSurface,
  GrowthReportSummary,
} from './growth-reports-admin.js'

export {
  encryptSecret,
  decryptSecret,
  loadOrCreateMasterKey,
  emptySecretsFile,
  SECRETS_FILE_VERSION,
} from './secrets.js'
export type { EncryptedSecret, SecretsFile } from './secrets.js'

export { MessageBus } from './bus.js'
export type { Deliverer } from './bus.js'

export { Registry } from './registry.js'

export { DefaultScheduler } from './scheduler.js'
export type {
  Scheduler,
  TaskInvoker,
  CancelNotifier,
  ReputationLookup,
  CrossHubExplicitResolver,
  CrossHubDispatcher,
  // Phase 11 M2 — suspend persistence callback shape
  SuspendNotifier,
} from './scheduler.js'

export {
  PriorityQueueScheduler,
  type PriorityQueueSchedulerOptions,
} from './priority-scheduler.js'

export { Transcript } from './transcript.js'

export { createLogger } from './logger.js'
export type { Logger, LogLevel, LoggerOptions } from './logger.js'

export { InMemoryStorage, FileStorage, SqliteStorage } from './storage/index.js'
export type { Storage, SqliteStorageOptions } from './storage/index.js'

export { AgentParticipant } from './participants/agent.js'
export type { AgentOptions } from './participants/agent.js'

// Phase 11 M1 — Suspend/Resume control-flow primitive. Throw the
// error from `onTask`/`onResume` to park the task; the scheduler
// (Phase 11 M2/M3) re-dispatches via `Participant.onResume`.
export { SuspendTaskError, isSuspendTaskError } from './suspend.js'

export { HumanParticipant } from './participants/human.js'
export type { HumanOptions } from './participants/human.js'

export { HubAsParticipant } from './participants/hub-adapter.js'
export type { HubAsParticipantOptions } from './participants/hub-adapter.js'

export { createInprocHubLinkPair } from './hub-link.js'
export type {
  HubLink,
  HubLinkDirection,
  HubLinkStatus,
} from './hub-link.js'

export { RemoteHubViaLink } from './participants/remote-hub.js'
export type {
  RemoteHubViaLinkOptions,
  OriginResolver,
} from './participants/remote-hub.js'

export { installPeerLink } from './peer-link-install.js'
export type {
  InstallPeerLinkOptions,
  InstalledPeerLink,
  PeerLinkAcl,
} from './peer-link-install.js'

export {
  FeedbackLedger,
  FileFeedbackStorage,
  MemoryFeedbackStorage,
  statusOf,
} from './feedback/index.js'
export type {
  FeedbackEntry,
  FeedbackEntryDraft,
  FeedbackScope,
  FeedbackStatus,
  FeedbackStorage,
  FeedbackQuery,
  LedgerLine,
  // Audit #155 — exposed so consumers (web) can extend instead of
  // re-defining a parallel shape that's prone to drift.
  PeerReputation,
  ReputationStoreOptions,
} from './feedback/index.js'

export type {
  // ids
  ParticipantId,
  ChannelId,
  TaskId,
  MessageId,
  ParticipantKind,
  // messages
  Message,
  // tasks
  Task,
  TaskResult,
  TaskOrigin,
  DispatchStrategy,
  // Phase 10 M2 — dispatch ancestry record
  AncestryNode,
  // participants
  Participant,
  // transcript / events
  TranscriptEntry,
  HubEvent,
  // admission gating (v1.1)
  PendingApplication,
  AdmissionDecision,
  // evaluation (v1.1)
  Evaluation,
  // contribution / leaderboard (v2.1)
  ContributionRow,
  Leaderboard,
} from './types.js'
