export { Hub, newId } from './hub.js'
export type { HubConfig, TaskStatus, TaskView } from './hub.js'
export { readMaxDispatchDepth } from './hub.js'

export {
  Space,
  SpaceUnsafeError,
  DEFAULT_CONFIG,
  SPACE_FILE_VERSION,
} from './space.js'

// 原子写 —— 「写唯一临时文件再 rename」的唯一实现。全仓十来处曾各写各的
// `${path}.tmp`（同一个并发撞名 bug 被独立发现过三次），从这里 import，别再手搓。
export {
  SECURE_FILE_MODE,
  uniqueTmpPath,
  writeFileAtomic,
  writeFileAtomicSync,
  writeJsonAtomic,
  writeJsonAtomicSync,
} from './fs-atomic.js'
export type {
  SpaceMeta,
  SpaceConfig,
  SpaceUnsafeCode,
  AdminRecord,
  AgentRecord,
  ManagedAgentSpec,
  FallbackCandidate,
  // LONG-M4 — 长任务工种×模型槽(compactor/synthesizer;host 驱动器消费)
  LongRunModelSlot,
  LongRunModelSlots,
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
  SECRETS_FILE_VERSION_UNIFIED,
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
// perf audit A③ (修订) —— 「哪些流片段值得落盘」的唯一判据。导出是为了让
// @gotong/host 的防腐门能拿真判据去对 `LlmStreamChunk` 那个联合逐个点名:
// 白名单的代价是「新加的动作型片段会被静默丢掉」,那道门把它变成红灯。
export { chunkDeservesDisk } from './transcript.js'

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
// outbound edge — `A2aRemoteParticipant`, a local participant that never
// crosses a `RemoteHubViaLink` (Item 2) — gates on the SAME function rather
// than a divergent re-implementation. Anti-drift: one place, every edge learns
// new data-class semantics at once.
export { extractRequiredCapabilities, checkOutboundDataClasses } from './peer-acl.js'
export type { OutboundVerdict } from './peer-acl.js'

// GT-M1 分级信任(Graded Trust)—— 一条 mesh 边的信任档 + 决策矩阵。纯函数、
// 零依赖、热路径零 LLM;与 reputation / pinnedKid / PeerKind 全部正交。
// 见 docs/zh/GRADED-TRUST.md。
export {
  TRUST_TIERS,
  TRUST_TIER_CODENAMES,
  DEFAULT_TRUST_TIER,
  tierRank,
  isTrustTier,
  isUpgrade,
  isDowngrade,
  decideTrust,
  decisionRequiresHuman,
  // GT-M4 纯软连接:身份确证 → advisory 升降档建议(绝不自动改档)。
  suggestTierFromIdentity,
  // GT-M5 信任引荐:可信 peer 引荐 → advisory 初始档建议(信任不传递,恒地板 T1)。
  suggestTierFromReferral,
} from './trust-tier.js'
export type {
  TrustTier,
  OutboundActionRisk,
  TrustDecision,
  IdentityConfidence,
  TierSuggestion,
  ReferralSuggestion,
} from './trust-tier.js'

// Lightweight FS sandbox — layer 1 (portable argv path jail). Layer 2 (OS
// kernel jail) wires beside it; both keep hub-driven commands inside the roots.
export { jailArgv, isInsideRoots, DEFAULT_INTERPRETERS } from './workspace-jail.js'
export type { JailVerdict, JailParkCode, JailArgvOptions } from './workspace-jail.js'

// Layer 2 — OS kernel jail. Pure builders (`wrapWithFsJail` + Seatbelt/bwrap
// generators) here; the spawning capability probe (`detectFsJail`) is separate.
export {
  wrapWithFsJail,
  // HANDS-M2b — the ONE spec→options copier; adapters must not hand-copy fields.
  jailWrapOptions,
  buildSeatbeltProfile,
  buildBwrapArgs,
  MAC_ESSENTIAL_WRITABLE,
} from './workspace-jail.js'
export type {
  FsJailKind,
  FsJailSpec,
  FsJailHardening,
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
