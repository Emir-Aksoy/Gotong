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
  FallbackCandidate,
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

export { Transcript } from './transcript.js'

export { createLogger } from './logger.js'
export type { Logger, LogLevel, LoggerOptions } from './logger.js'

export {
  InMemoryStorage,
  FileStorage,
  SqliteStorage,
  DEFAULT_MAX_SEGMENT_BYTES,
} from './storage/index.js'
export type { Storage, SqliteStorageOptions, ArchiveOptions } from './storage/index.js'

// Route B P0-M1 — tenant/namespace dimension. `DEFAULT_TENANT` resolves to
// the bare workspace root (zero behaviour change); `tenantRoot` isolates
// non-default tenants under `<root>/tenants/<id>/`.
export {
  DEFAULT_TENANT,
  TenantIdError,
  assertTenantId,
  normalizeNamespace,
  tenantRoot,
} from './tenant.js'
export type { TenantIdErrorCode } from './tenant.js'

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

export { installPeerLink, evaluateInboundAcl } from './peer-link-install.js'
export type {
  InstallPeerLinkOptions,
  InstalledPeerLink,
  PeerLinkAcl,
  InboundAclVerdict,
} from './peer-link-install.js'

// The canonical strategy → required-capabilities extractor. Re-exported so
// consumers (host workflow-controller cross-hub detection) gate on the SAME
// notion of "which caps does this dispatch ask for" as the inbound/outbound
// peer ACLs — one place, no drift.
//
// `checkOutboundDataClasses` is the canonical data-class gate (P4-M4). It lives
// inside `RemoteHubViaLink` for mesh edges; re-exported here so the OTHER
// outbound edges — `A2aRemoteParticipant` / `AcpParticipant`, which are local
// participants that never cross a `RemoteHubViaLink` (Item 2) — gate on the
// SAME function rather than a divergent re-implementation. Anti-drift: one
// place, both edges learn new data-class semantics at once.
export { extractRequiredCapabilities, checkOutboundDataClasses } from './peer-acl.js'
export type { OutboundVerdict } from './peer-acl.js'

// Lightweight FS sandbox — layer 1 (portable argv path jail). Layer 2 (OS
// kernel jail) wires beside it; both keep hub-driven commands inside the roots.
export { jailArgv, isInsideRoots, DEFAULT_INTERPRETERS } from './workspace-jail.js'
export type { JailVerdict, JailParkCode, JailArgvOptions } from './workspace-jail.js'

// Layer 2 — OS kernel jail. Pure builders (`wrapWithFsJail` + Seatbelt/bwrap
// generators) here; the spawning capability probe (`detectFsJail`) is separate.
export {
  wrapWithFsJail,
  buildSeatbeltProfile,
  buildBwrapArgs,
  MAC_ESSENTIAL_WRITABLE,
} from './workspace-jail.js'
export type {
  FsJailKind,
  FsJailSpec,
  WrappedCommand,
  WrapWithFsJailOptions,
} from './workspace-jail.js'
export { detectFsJail, resetFsJailCache, prepareFsJail } from './workspace-jail-detect.js'
export type {
  FsJailCapability,
  JailProbe,
  JailProbeResult,
  DetectFsJailOptions,
  PreparedFsJail,
  PrepareFsJailOptions,
} from './workspace-jail-detect.js'

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
