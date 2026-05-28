/**
 * Host wiring for `@aipehub/workflow-assistant` — Phase 13 M3.
 *
 * Spawns ONE persistent `WorkflowAssistantAgent` on the hub at boot
 * (id=`workflow-assistant`, capability=`workflow:assist`), and exposes
 * a `WorkflowAssistSurface` for the Web layer to call from the
 * `POST /api/admin/workflows/assist` HTTP route.
 *
 * Why a host-built-in agent (not in `agents.json`):
 *   - The assistant is a host-level admin tool, not a user-authored
 *     agent. Auto-registering it lets `aipehub repl` / admin UI work
 *     out of the box, no manual setup.
 *   - When no LLM API key is available (no org-pool key, no env), we
 *     skip registration and Web responds 503. The host boots fine
 *     either way; non-AI workflow consumers see zero impact.
 *
 * Key resolution (same chain as LocalAgentPool's managed agents, minus
 * per-agent and workspace tiers — neither applies to a system agent):
 *   1. OrgApiPool (if wired) — picks any active vault entry for the provider
 *   2. host env (ANTHROPIC_API_KEY / OPENAI_API_KEY)
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

import type { Hub, Logger, ParticipantId } from '@aipehub/core'
import { MockLlmProvider, type LlmProvider } from '@aipehub/llm'
import { AnthropicProvider } from '@aipehub/llm-anthropic'
import { OpenAIProvider } from '@aipehub/llm-openai'
import {
  WorkflowAssistantAgent,
  WORKFLOW_ASSISTANT_CAPABILITY,
  WORKFLOW_ASSISTANT_DEFAULT_ID,
  loadBundledExamples,
  type WorkflowAssistantOutput,
  type WorkflowAssistantPayload,
} from '@aipehub/workflow-assistant'

import type { OrgApiPool } from './org-api-pool.js'

/** Concrete provider choice for the host-built-in assistant. */
export type WorkflowAssistProviderKind = 'anthropic' | 'openai' | 'mock'

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
    /** Caller (admin) participant id — stamped onto the dispatched task's `from`. */
    by: ParticipantId
  }): Promise<WorkflowAssistantOutput>
}

/**
 * Read env vars and pick a config. Returns null when the operator
 * explicitly disabled the assistant via `AIPE_ASSISTANT_DISABLED=1`.
 *
 *   AIPE_ASSISTANT_PROVIDER  'anthropic' (default) | 'openai' | 'mock'
 *   AIPE_ASSISTANT_MODEL     provider-specific model id (optional)
 *   AIPE_ASSISTANT_MAX_TOKENS  integer (optional, default 4096)
 *   AIPE_ASSISTANT_DISABLED  '1' / 'true' → skip registration entirely
 *   AIPE_ASSISTANT_NO_EXAMPLES '1' / 'true' → skip few-shot examples
 *                              (consumed in createWorkflowAssistAgent, not here)
 */
export function resolveWorkflowAssistConfig(): WorkflowAssistAgentConfig | null {
  const disabled = process.env.AIPE_ASSISTANT_DISABLED
  if (disabled === '1' || disabled === 'true') return null

  const raw = process.env.AIPE_ASSISTANT_PROVIDER ?? 'anthropic'
  const provider: WorkflowAssistProviderKind =
    raw === 'openai' ? 'openai' : raw === 'mock' ? 'mock' : 'anthropic'

  const model = process.env.AIPE_ASSISTANT_MODEL
  const maxTokensRaw = process.env.AIPE_ASSISTANT_MAX_TOKENS
  let maxTokens: number | undefined
  if (maxTokensRaw !== undefined) {
    const n = Number(maxTokensRaw)
    if (Number.isFinite(n) && n > 0) maxTokens = Math.floor(n)
  }

  const cfg: WorkflowAssistAgentConfig = { provider }
  if (model) cfg.model = model
  if (maxTokens !== undefined) cfg.maxTokens = maxTokens
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
  provider: WorkflowAssistProviderKind,
  orgApiPool: OrgApiPool | undefined,
): string | null | undefined {
  if (provider === 'mock') return undefined
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
  kind: WorkflowAssistProviderKind,
  apiKey: string | undefined,
): LlmProvider {
  switch (kind) {
    case 'mock':
      // Deterministic stub — emits a single ```yaml fence with a
      // skeleton workflow so the editor pipeline (parseWorkflow →
      // draftStatus) can be exercised without burning real LLM quota.
      // The skeleton is intentionally valid against
      // aipehub.workflow/v1 so the round-trip happy path
      // (draftStatus === 'valid') stays exercisable in mock mode.
      return new MockLlmProvider({
        reply: () =>
          [
            'Mock assistant — replace `AIPE_ASSISTANT_PROVIDER=mock` with `anthropic` or `openai` for real generation.',
            '',
            '```yaml',
            'schema: aipehub.workflow/v1',
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
      return new AnthropicProvider({ apiKey })
    case 'openai':
      if (!apiKey) {
        throw new Error(
          "WorkflowAssistantAgent provider 'openai' has no API key — wire one through the org vault or set OPENAI_API_KEY",
        )
      }
      return new OpenAIProvider({ apiKey })
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

  const keyOrNull = resolveAssistApiKey(config.provider, orgApiPool)
  if (keyOrNull === null) {
    logger.warn('workflow-assistant: no API key resolved — skipping registration', {
      provider: config.provider,
    })
    return null
  }
  const apiKey = keyOrNull // undefined for mock; string otherwise

  let provider: LlmProvider
  try {
    provider = buildAssistProvider(config.provider, apiKey)
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
  // AIPE_ASSISTANT_NO_EXAMPLES=1 if you want to A/B against the
  // schema-doc-only baseline, or pinch tokens on a tight budget.
  const noExamples = process.env.AIPE_ASSISTANT_NO_EXAMPLES
  if (noExamples !== '1' && noExamples !== 'true') {
    const examples = loadBundledExamples()
    if (examples.length > 0) {
      agentOpts.examples = examples
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
    },
  }
}
