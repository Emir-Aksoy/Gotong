/**
 * Host wiring for `@gotong/workflow-assistant` — Phase 13 M3.
 *
 * Spawns ONE persistent `WorkflowAssistantAgent` on the hub at boot
 * (id=`workflow-assistant`, capability=`workflow:assist`), and exposes
 * a `WorkflowAssistSurface` for the Web layer to call from the
 * `POST /api/admin/workflows/assist` HTTP route.
 *
 * Why a host-built-in agent (not in `agents.json`):
 *   - The assistant is a host-level admin tool, not a user-authored
 *     agent. Auto-registering it lets `gotong repl` / admin UI work
 *     out of the box, no manual setup.
 *   - When no LLM API key is available (no org-pool key, no env), we
 *     skip registration and Web responds 503. The host boots fine
 *     either way; non-AI workflow consumers see zero impact.
 *
 * Key resolution (same chain as LocalAgentPool's managed agents, minus
 * per-agent and workspace tiers — neither applies to a system agent):
 *   1. OrgApiPool (if wired) — picks any active vault entry for the provider
 *   2. host env (ANTHROPIC_API_KEY / OPENAI_API_KEY)
 * `openai-compatible` (S1-M4) skips both tiers: each baseURL is a different
 * vendor, so its key comes ONLY from the env var GOTONG_ASSISTANT_API_KEY_ENV
 * names (pointer-not-key, the tokenEnv discipline).
 * No key → return `null` from `createWorkflowAssistAgent`, log a warning;
 * caller leaves `workflowAssist` unset on the Web ctx.
 *
 * Quota: assist requests come from the admin UI editor (no `task.origin`),
 * which under the LocalAgentPool convention free-rides quota debits
 * ("admins are operators, not consumers" — see local-agent-pool.ts ~L511).
 * We honor the same posture here, so no preCallHook is wired. If you want
 * to debit the operator, dispatch via /api/me/* with an origin instead.
 *
 * Transcript: `hub.dispatch` writes a task + task_result entry for each
 * assist call. That's intentional — admins editing workflows via AI
 * authoring deserve to show up in the audit trail.
 */

import { randomUUID } from 'node:crypto'

import type { Hub, Logger, ParticipantId } from '@gotong/core'
import { MockLlmProvider, readMultimodalInlineCapFromEnv, type LlmProvider } from '@gotong/llm'
import { AnthropicProvider } from '@gotong/llm-anthropic'
import { OpenAIProvider } from '@gotong/llm-openai'
import {
  WorkflowAssistantAgent,
  WORKFLOW_ASSISTANT_CAPABILITY,
  WORKFLOW_ASSISTANT_DEFAULT_ID,
  loadBundledExamples,
  type WorkflowAssistantOutput,
  type WorkflowAssistantPayload,
} from '@gotong/workflow-assistant'

import type { OrgApiPool } from './org-api-pool.js'

/** Concrete provider choice for the host-built-in assistant. */
export type WorkflowAssistProviderKind = 'anthropic' | 'openai' | 'openai-compatible' | 'mock'

/**
 * Resolved configuration. Built by `resolveWorkflowAssistConfig` from
 * env vars; passed to `createWorkflowAssistAgent`.
 */
export interface WorkflowAssistAgentConfig {
  provider: WorkflowAssistProviderKind
  /** Optional model override (e.g. 'claude-3-5-sonnet-latest'). */
  model?: string
  /** Optional maxTokens override. Default 4096 — plenty for one workflow draft. */
  maxTokens?: number
  /**
   * S1-M4 — OpenAI-compatible endpoint (DeepSeek / MiMo / Qwen / Ollama…).
   * Required when `provider === 'openai-compatible'`; ignored otherwise.
   */
  baseURL?: string
  /**
   * S1-M4 — NAME of the env var holding the vendor's API key (the tokenEnv /
   * headerEnv discipline: config points at the var, never carries the key).
   * Each compatible baseURL is a different vendor, so the shared
   * ANTHROPIC/OPENAI key tiers deliberately don't apply.
   */
  apiKeyEnv?: string
}

/** Duck-typed surface the Web layer consumes via `ServeWebOpts.workflowAssist`. */
export interface WorkflowAssistSurface {
  /**
   * Dispatch one assist request. Returns the assistant's structured
   * output (yaml + draftStatus + validationError? + explanation + raw).
   *
   * Throws iff `hub.dispatch` resolves with `kind !== 'ok'` (failed /
   * cancelled / no_participant / suspended). The Web layer catches and
   * translates to HTTP 500 with `err.message`.
   */
  assist(input: {
    description: string
    contextHints?: WorkflowAssistantPayload['contextHints']
    /**
     * ARCH-M2 — authoring vs explain. Default 'author' (today's behavior:
     * generate a fresh draft from `description`). 'explain' echoes
     * `subjectYaml` verbatim and produces ONLY a depth-controlled prose
     * explanation of that existing workflow (no regeneration).
     */
    mode?: WorkflowAssistantPayload['mode']
    /**
     * ARCH-M2 — explanation depth ('oneliner' | 'brief' | 'detailed').
     * Default 'brief' ⇒ author-mode prose is byte-for-byte unchanged.
     * Affects only the prose; the yaml + graph are unaffected by depth.
     */
    detail?: WorkflowAssistantPayload['detail']
    /**
     * ARCH-M2 — the existing workflow YAML to explain. Required (non-empty)
     * when mode==='explain'; ignored in author mode. The agent derives
     * `output.yaml` + `output.graph` deterministically from THIS value,
     * never from the LLM's echo.
     */
    subjectYaml?: WorkflowAssistantPayload['subjectYaml']
    /** Caller (admin) participant id — stamped onto the dispatched task's `from`. */
    by: ParticipantId
    /**
     * WFEDIT-D4 — live LLM chunks for THIS call only. Routed per-call (a
     * private key stamped into the dispatched payload), never via the global
     * transcript stream — so a member-facing caller can relay the typing
     * without ever seeing another task's chunks. Best-effort: a throwing sink
     * never breaks the assist call. Optional — absent ⇒ no streaming.
     */
    onChunk?: (chunk: string) => void
  }): Promise<WorkflowAssistantOutput>
}

/**
 * Read env vars and pick a config. Returns null when the operator
 * explicitly disabled the assistant via `GOTONG_ASSISTANT_DISABLED=1`.
 *
 *   GOTONG_ASSISTANT_PROVIDER  'anthropic' (default) | 'openai' | 'openai-compatible' | 'mock'
 *   GOTONG_ASSISTANT_MODEL     provider-specific model id (optional; strongly
 *                            recommended for openai-compatible — the OpenAI
 *                            default model won't exist on another vendor)
 *   GOTONG_ASSISTANT_MAX_TOKENS  integer (optional, default 4096)
 *   GOTONG_ASSISTANT_BASE_URL  openai-compatible only — the vendor endpoint
 *                            (e.g. https://api.deepseek.com/v1)
 *   GOTONG_ASSISTANT_API_KEY_ENV openai-compatible only — NAME of the env var
 *                            holding that vendor's key (never the key itself)
 *   GOTONG_ASSISTANT_DISABLED  '1' / 'true' → skip registration entirely
 *   GOTONG_ASSISTANT_NO_EXAMPLES '1' / 'true' → skip few-shot examples
 *                              (consumed in createWorkflowAssistAgent, not here)
 */
export function resolveWorkflowAssistConfig(): WorkflowAssistAgentConfig | null {
  const disabled = process.env.GOTONG_ASSISTANT_DISABLED
  if (disabled === '1' || disabled === 'true') return null

  const raw = process.env.GOTONG_ASSISTANT_PROVIDER ?? 'anthropic'
  const provider: WorkflowAssistProviderKind =
    raw === 'openai'
      ? 'openai'
      : raw === 'openai-compatible'
        ? 'openai-compatible'
        : raw === 'mock'
          ? 'mock'
          : 'anthropic'

  const model = process.env.GOTONG_ASSISTANT_MODEL
  const maxTokensRaw = process.env.GOTONG_ASSISTANT_MAX_TOKENS
  let maxTokens: number | undefined
  if (maxTokensRaw !== undefined) {
    const n = Number(maxTokensRaw)
    if (Number.isFinite(n) && n > 0) maxTokens = Math.floor(n)
  }

  const cfg: WorkflowAssistAgentConfig = { provider }
  if (model) cfg.model = model
  if (maxTokens !== undefined) cfg.maxTokens = maxTokens
  if (provider === 'openai-compatible') {
    const baseURL = process.env.GOTONG_ASSISTANT_BASE_URL?.trim()
    const apiKeyEnv = process.env.GOTONG_ASSISTANT_API_KEY_ENV?.trim()
    if (baseURL) cfg.baseURL = baseURL
    if (apiKeyEnv) cfg.apiKeyEnv = apiKeyEnv
  }
  return cfg
}

/**
 * Resolve an API key for the configured provider. Walks the same
 * chain as `LocalAgentPool.resolveApiKey` — minus per-agent (this is a
 * host-built-in, not a user-authored agent) and minus workspace
 * (`space.getProviderApiKey` is wired through LocalAgentPool only).
 *
 * Returns `undefined` for the mock provider (it doesn't need a key).
 * Returns `null` when a real provider is configured but no key was
 * found in any tier — caller must skip registration.
 */
function resolveAssistApiKey(
  config: WorkflowAssistAgentConfig,
  orgApiPool: OrgApiPool | undefined,
): string | null | undefined {
  const provider = config.provider
  if (provider === 'mock') return undefined
  if (provider === 'openai-compatible') {
    // Per-vendor key, read from the env var the config NAMES. The org pool /
    // shared OPENAI_API_KEY tiers deliberately don't apply — each compatible
    // baseURL is a different vendor, and silently sending the real OpenAI key
    // to a third-party endpoint would be a leak, not a convenience.
    if (!config.apiKeyEnv) return null
    return process.env[config.apiKeyEnv] || null
  }
  if (orgApiPool) {
    const hit = orgApiPool.resolveLlmKey(provider)
    if (hit) return hit.apiKey
  }
  const env =
    provider === 'anthropic'
      ? process.env.ANTHROPIC_API_KEY
      : process.env.OPENAI_API_KEY
  return env ?? null
}

function buildAssistProvider(
  config: WorkflowAssistAgentConfig,
  apiKey: string | undefined,
): LlmProvider {
  const kind = config.provider
  switch (kind) {
    case 'mock':
      // Deterministic stub — emits a single ```yaml fence with a
      // skeleton workflow so the editor pipeline (parseWorkflow →
      // draftStatus) can be exercised without burning real LLM quota.
      // The skeleton is intentionally valid against
      // gotong.workflow/v1 so the round-trip happy path
      // (draftStatus === 'valid') stays exercisable in mock mode.
      return new MockLlmProvider({
        // Phase 13 follow-up — split the reply into 8 chunks so admin
        // UI's streaming preview pane actually demonstrates incremental
        // delivery in mock mode. Real providers naturally stream many
        // small chunks; the mock would otherwise spit the whole reply
        // as one chunk and the "live typing" UX wouldn't show.
        textChunkCount: 8,
        reply: () =>
          [
            'Mock assistant — replace `GOTONG_ASSISTANT_PROVIDER=mock` with `anthropic` or `openai` for real generation.',
            '',
            '```yaml',
            'schema: gotong.workflow/v1',
            'workflow:',
            '  id: assistant-mock-draft',
            '  name: Mock-generated draft',
            '  trigger:',
            // Deliberately NOT the same cap as the step's dispatch — the
            // M4 deep checker flags self-cycles, and a stub that always
            // triggers itself would confuse users who enable contextHints.
            '    capability: mock-draft:run',
            '  steps:',
            '    - id: greet',
            '      dispatch:',
            '        strategy: { kind: capability, capabilities: [chat] }',
            '        payload:',
            '          text: $trigger.payload.text',
            '```',
          ].join('\n'),
      })
    case 'anthropic':
      if (!apiKey) {
        throw new Error(
          "WorkflowAssistantAgent provider 'anthropic' has no API key — wire one through the org vault or set ANTHROPIC_API_KEY",
        )
      }
      return new AnthropicProvider({ apiKey, maxInlineBytes: readMultimodalInlineCapFromEnv() })
    case 'openai':
      if (!apiKey) {
        throw new Error(
          "WorkflowAssistantAgent provider 'openai' has no API key — wire one through the org vault or set OPENAI_API_KEY",
        )
      }
      return new OpenAIProvider({ apiKey, maxInlineBytes: readMultimodalInlineCapFromEnv() })
    case 'openai-compatible': {
      // S1-M4 — same two hard requirements as a managed 'openai-compatible'
      // agent row (local-agent-pool.ts buildProvider), env-driven here.
      if (!config.baseURL) {
        throw new Error(
          "WorkflowAssistantAgent provider 'openai-compatible' needs GOTONG_ASSISTANT_BASE_URL — point it at an OpenAI-compatible /v1 endpoint",
        )
      }
      if (!apiKey) {
        throw new Error(
          "WorkflowAssistantAgent provider 'openai-compatible' needs a key — set GOTONG_ASSISTANT_API_KEY_ENV to the NAME of the env var holding it",
        )
      }
      // Truthful provider name in logs/ledger: the vendor host, not 'openai'.
      let name: string
      try {
        name = new URL(config.baseURL).host
      } catch {
        name = 'openai-compatible'
      }
      return new OpenAIProvider({
        apiKey,
        baseURL: config.baseURL,
        name,
        maxInlineBytes: readMultimodalInlineCapFromEnv(),
        // Compatible vendors (DeepSeek, MiMo, Qwen, Ollama…) speak the legacy
        // max_tokens field, not OpenAI's max_completion_tokens.
        maxTokensField: 'max_tokens',
      })
    }
  }
}

/**
 * Build + register the host-built-in WorkflowAssistantAgent. Returns
 * a `WorkflowAssistSurface` ready for `serveWeb({ workflowAssist: ... })`,
 * or `null` when registration was skipped (assistant disabled, or no
 * API key for the configured provider).
 *
 * Idempotent re-call is NOT supported — call once at host boot.
 */
export function createWorkflowAssistAgent(deps: {
  hub: Hub
  config: WorkflowAssistAgentConfig
  orgApiPool?: OrgApiPool
  logger: Logger
}): WorkflowAssistSurface | null {
  const { hub, config, orgApiPool, logger } = deps

  const keyOrNull = resolveAssistApiKey(config, orgApiPool)
  if (keyOrNull === null) {
    logger.warn('workflow-assistant: no API key resolved — skipping registration', {
      provider: config.provider,
      ...(config.provider === 'openai-compatible'
        ? { hint: 'set GOTONG_ASSISTANT_API_KEY_ENV to the NAME of the env var holding the vendor key' }
        : {}),
    })
    return null
  }
  const apiKey = keyOrNull // undefined for mock; string otherwise

  // A compatible endpoint won't serve the OpenAI default model — without an
  // explicit model every assist call would 404 confusingly. Warn, don't block:
  // some endpoints (Ollama with a configured default) do work model-less.
  if (config.provider === 'openai-compatible' && !config.model) {
    logger.warn('workflow-assistant: openai-compatible without GOTONG_ASSISTANT_MODEL — the OpenAI default model likely does not exist on this endpoint')
  }

  let provider: LlmProvider
  try {
    provider = buildAssistProvider(config, apiKey)
  } catch (err) {
    logger.warn('workflow-assistant: provider build failed — skipping registration', {
      provider: config.provider,
      err: err instanceof Error ? err.message : String(err),
    })
    return null
  }

  const agentOpts: ConstructorParameters<typeof WorkflowAssistantAgent>[0] = {
    provider,
  }
  if (config.model) agentOpts.model = config.model
  agentOpts.maxTokens = config.maxTokens ?? 4096

  // Phase 13 follow-up — few-shot examples. The bundled set (2-3 small
  // templates) gives the LLM concrete patterns to imitate (parallel
  // branches, $-refs, output composition) and noticeably improves
  // happy-path latency and accuracy. Opt out with
  // GOTONG_ASSISTANT_NO_EXAMPLES=1 if you want to A/B against the
  // schema-doc-only baseline, or pinch tokens on a tight budget.
  const noExamples = process.env.GOTONG_ASSISTANT_NO_EXAMPLES
  if (noExamples !== '1' && noExamples !== 'true') {
    const examples = loadBundledExamples()
    if (examples.length > 0) {
      agentOpts.examples = examples
    }
  }

  // WFEDIT-D4 — per-call chunk sinks. An assist caller that wants live typing
  // registers a sink under a private random key; the key rides inside the
  // dispatched payload, so the agent's (single, constructor-level) stream hook
  // can route each chunk back to exactly the call that triggered it. This is
  // how a MEMBER-facing caller streams safely: chunks flow up the call stack
  // of its own request, never via the global admin transcript stream.
  const assistChunkSinks = new Map<string, (chunk: string) => void>()

  // Phase 13 follow-up — pipe LLM stream chunks into the transcript so
  // the admin UI's assist modal can show the LLM typing in real time
  // (mirrors what LocalAgentPool does for user-authored managed agents).
  // Without this hook every assist call looks like a 30-40s silent
  // pause to the user; with it they get incremental feedback.
  // Best-effort: a failure to append a single chunk shouldn't break
  // the assist call itself, so we log and continue.
  agentOpts.onStreamChunk = (chunk, task) => {
    try {
      hub.transcript.append({
        ts: Date.now(),
        kind: 'llm_stream_chunk',
        data: { taskId: task.id, agentId: WORKFLOW_ASSISTANT_DEFAULT_ID, chunk },
      })
    } catch (err) {
      logger.warn('workflow-assistant: transcript append failed for llm_stream_chunk', {
        err: err instanceof Error ? err.message : String(err),
      })
    }
    // Per-call routing: only text deltas — tool_use/usage/end chunks are
    // protocol bookkeeping a typing preview has no use for. Concatenating the
    // text chunks reproduces the final response byte-for-byte (llm contract).
    const sinkKey = (task.payload as { __streamSinkKey?: unknown } | undefined)?.__streamSinkKey
    if (typeof sinkKey === 'string' && chunk.type === 'text' && chunk.text) {
      try {
        assistChunkSinks.get(sinkKey)?.(chunk.text)
      } catch {
        /* a throwing caller sink must never break the assist call */
      }
    }
  }

  const agent = new WorkflowAssistantAgent(agentOpts)
  hub.register(agent)
  logger.info('workflow-assistant: registered', {
    id: WORKFLOW_ASSISTANT_DEFAULT_ID,
    capability: WORKFLOW_ASSISTANT_CAPABILITY,
    provider: config.provider,
    model: config.model ?? '(provider default)',
    examplesLoaded: agentOpts.examples?.length ?? 0,
  })

  return {
    async assist(input) {
      const payload: WorkflowAssistantPayload = { description: input.description }
      if (input.contextHints) payload.contextHints = input.contextHints
      // ARCH-M2 — thread the architect dimensions through verbatim. All
      // optional; absent ⇒ author mode at brief depth (today's behavior).
      // The returned `output` (incl. `graph?`) is echoed verbatim below, so
      // no output-side change is needed — graph rides the same return.
      if (input.mode) payload.mode = input.mode
      if (input.detail) payload.detail = input.detail
      if (input.subjectYaml !== undefined) payload.subjectYaml = input.subjectYaml
      // WFEDIT-D4 — one-shot private key ties THIS dispatch's chunks to THIS
      // caller's sink. The key only ever reaches the sink registry and the
      // task payload (assistant tolerates extra payload fields), and is
      // deleted in finally so a sink can never outlive its call.
      let sinkKey: string | undefined
      if (input.onChunk) {
        sinkKey = randomUUID()
        assistChunkSinks.set(sinkKey, input.onChunk)
        ;(payload as unknown as Record<string, unknown>).__streamSinkKey = sinkKey
      }
      try {
        const result = await hub.dispatch({
          from: input.by,
          strategy: { kind: 'capability', capabilities: [WORKFLOW_ASSISTANT_CAPABILITY] },
          payload,
          title: 'workflow:assist',
        })
        if (result.kind !== 'ok') {
          // Surface the failure reason verbatim — the Web layer wraps it
          // into a 500 response body.
          const reason =
            result.kind === 'failed'
              ? result.error
              : result.kind === 'cancelled'
                ? `cancelled: ${result.reason}`
                : result.kind === 'no_participant'
                  ? `no participant for capability ${WORKFLOW_ASSISTANT_CAPABILITY}: ${result.reason}`
                  : `unexpected result kind: ${result.kind}`
          throw new Error(`workflow:assist dispatch failed — ${reason}`)
        }
        return result.output as WorkflowAssistantOutput
      } finally {
        if (sinkKey) assistChunkSinks.delete(sinkKey)
      }
    },
  }
}
