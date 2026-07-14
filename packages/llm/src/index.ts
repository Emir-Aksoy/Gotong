export type {
  LlmMessage,
  LlmRequest,
  LlmResponse,
  LlmStopReason,
  LlmUsage,
  LlmProvider,
  // v0.3 tool-use surface
  LlmContentBlock,
  LlmTextBlock,
  LlmToolUseBlock,
  LlmToolResultBlock,
  LlmToolDefinition,
  LlmAgentToolset,
  LlmToolCallResult,
  // Phase 8 streaming surface
  LlmStreamChunk,
  LlmStreamTextChunk,
  LlmStreamToolUseChunk,
  LlmStreamUsageChunk,
  LlmStreamEndChunk,
  LlmStreamErrorChunk,
  // Phase 9 multimodal surface
  LlmImageBlock,
  LlmAudioBlock,
  LlmFileRefBlock,
  LlmImageSource,
  LlmArtifactResolver,
} from './types.js'
export {
  drainStream,
  // Phase 9 multimodal helpers + errors
  DEFAULT_MULTIMODAL_INLINE_BYTE_CAP,
  MultimodalNotSupportedError,
  MultimodalInlineSizeError,
  extractInlineBase64Size,
  readMultimodalInlineCapFromEnv,
} from './types.js'
export {
  LlmAgent,
  type LlmAgentOptions,
  type LlmTaskOutput,
  type LlmTaskPayload,
  type LlmUsageSinkMeta,
} from './agent.js'
export {
  MockLlmProvider,
  type MockProviderOptions,
  type MockScriptEntry,
} from './mock.js'
// Phase 10 M1 — Agent → 子 agent dispatch toolset
export {
  DispatchToolset,
  type DispatchSurface,
  type DispatchToolsetOptions,
} from './dispatch-toolset.js'
// Phase 10 M4 — combine multiple toolsets behind one LlmAgent.tools slot
export {
  ComposedToolset,
  ComposedToolNameCollisionError,
  type ComposedToolCollision,
} from './composed-toolset.js'
// CARE-M1 — provider 错误分类(纯函数,host 失败翻译表的地基)
export {
  classifyLlmError,
  llmErrorSummary,
  type LlmErrorKind,
} from './errors.js'
// MR-M1 — 确定性多 provider 有序降级 + per-candidate 熔断
export {
  RoutingProvider,
  RoutingExhaustedError,
  DEFAULT_BREAKER,
  type RoutingCandidate,
  type RoutingProviderOptions,
  type RoutingEvent,
  type RoutingLogger,
  type BreakerConfig,
} from './routing-provider.js'
// NA-M2 — 调用韧性:挂死看门狗 + 瞬态单次重试(装配缝见 host 的 buildRoutedProvider)
export {
  withCallWatchdog,
  withTransientRetry,
  LlmCallTimeoutError,
  DEFAULT_WATCHDOG,
  DEFAULT_RETRY,
  TRANSIENT_KINDS,
  type WatchdogConfig,
  type WatchdogOptions,
  type TransientRetryOptions,
} from './resilience.js'
// LSA-M4 — 并行多模型 + 综合(RoutingProvider 兄弟:routing 顺序选一个,ensemble 并行用全部)
export {
  EnsembleProvider,
  EnsembleExhaustedError,
  sumUsage,
  type EnsembleMember,
  type EnsembleStrategy,
  type EnsembleProviderOptions,
  type EnsembleEvent,
  type EnsembleLogger,
} from './ensemble-provider.js'
