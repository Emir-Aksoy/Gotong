/**
 * Host wiring for `@aipehub/hub-steward` — the "管家" (hub steward).
 *
 * Spawns ONE persistent `HubStewardAgent` on the hub at boot
 * (id=`hub-steward`, capability=`hub:steward`) and exposes a `HubStewardSurface`
 * the Web layer drives from `POST /api/me/steward/plan` (+ `/apply`, SW-M4/M5).
 *
 * The steward lets a member manage THEIR OWN hub resources by talking to it in
 * plain language. This file is the propose half (`plan`): build a read-only
 * snapshot of what the member owns → dispatch to the agent → classify each
 * proposed action server-side → return a `ClassifiedProposal` for the member to
 * preview. NOTHING is executed here; `apply()` (SW-M4) is the execute half, and
 * dangerous / cross-hub actions route through the Phase 16 approval inbox
 * (SW-M5) — the user's two hard constraints
 * (「跨 hub 工作流 + 危险动作都再次确认」).
 *
 * Mirrors `workflow-assist-agent.ts` almost exactly:
 *   - env-driven config (`resolveStewardConfig`), same provider/key chain;
 *   - no key for a real provider ⇒ skip registration, Web responds 503;
 *   - per-call streaming via a private sink key stamped into the payload
 *     (WFEDIT-D4), so a member can watch the steward "type" without ever
 *     touching the global admin transcript stream.
 *
 * Quota: a member calling the steward via `/api/me/*` carries a `task.origin`
 * (`{ orgId: 'local', userId }`), so the LLM spend is attributed + quota-gated
 * by Phase 17 like any member dispatch — unlike the admin-facing workflow
 * assistant which free-rides ("admins are operators, not consumers").
 */

import { randomUUID } from 'node:crypto'

import type { Hub, Logger } from '@aipehub/core'
import { MockLlmProvider, readMultimodalInlineCapFromEnv, type LlmProvider } from '@aipehub/llm'
import { AnthropicProvider } from '@aipehub/llm-anthropic'
import { OpenAIProvider } from '@aipehub/llm-openai'
import {
  HubStewardAgent,
  HUB_STEWARD_CAPABILITY,
  HUB_STEWARD_DEFAULT_ID,
  classifyStewardAction,
  type ClassifiedAction,
  type ClassifiedProposal,
  type HubStewardOutput,
  type HubStewardPayload,
  type StewardAction,
  type StewardAgentProvider,
  type StewardSnapshot,
  type StewardSnapshotAgent,
  type StewardSnapshotWorkflow,
  type StewardTurn,
} from '@aipehub/hub-steward'

import type { OrgApiPool } from './org-api-pool.js'

/** Concrete provider choice for the host-built-in steward. */
export type StewardProviderKind = 'anthropic' | 'openai' | 'mock'

/** Resolved configuration, built by `resolveStewardConfig` from env vars. */
export interface HubStewardAgentConfig {
  provider: StewardProviderKind
  /** Optional model override (e.g. 'claude-3-5-sonnet-latest'). */
  model?: string
  /** Optional maxTokens override. Default 2048 — a proposal is small. */
  maxTokens?: number
}

// --- duck-typed dependencies ------------------------------------------------
// The real `HostMeAgentService` satisfies `StewardAgentDirectory`; a small
// adapter over `WorkflowController` + RBAC satisfies `StewardWorkflowDirectory`
// (wired in main.ts, SW-M8). Narrow interfaces keep this service unit-testable
// with light fakes (no Hub key, no sqlite) and keep web out of host's runtime.

/**
 * The member-agent slice the steward reads for its snapshot. (SW-M4 widens this
 * with create / update / remove for the executor.) `HostMeAgentService`
 * satisfies it — so the steward structurally cannot exceed what the member could
 * do by hand: the same `resource_grants` RBAC + member limits apply.
 */
export interface StewardAgentDirectory {
  /** The member's owned managed agents (the snapshot's `agents`). */
  listOwned(userId: string): Promise<StewardOwnedAgent[]>
  /** Providers the member may pick (org/workspace/env + their own BYO keys). */
  availableProviders(userId: string): Promise<string[]>
}

/** The fields the steward reads off an owned agent for its snapshot. */
export interface StewardOwnedAgent {
  id: string
  label: string
  capabilities: string[]
  provider: string
  model?: string
}

/**
 * The workflow slice the steward reads. Lists the workflows THIS member may edit
 * (editor+ grant), each flagged cross-hub — the SAME `crossHub` the WFEDIT editor
 * lock derives, so "what the steward tiers cross_hub" and "what the editor locks"
 * never drift. The host adapter composes it from `WorkflowController.listAll` +
 * the workflow RBAC view.
 */
export interface StewardWorkflowDirectory {
  listForUser(userId: string): Promise<StewardSnapshotWorkflow[]>
}

/** One `plan` request — the member's instruction + the running conversation. */
export interface HubStewardPlanInput {
  /** The authenticated member (server-resolved; NEVER client-supplied). */
  userId: string
  /** The member's plain-language instruction. */
  instruction: string
  /** Prior turns of this steward conversation, for follow-up instructions. */
  history?: ReadonlyArray<StewardTurn>
  /**
   * Live LLM chunks for THIS call only (WFEDIT-D4 pattern). Routed per-call via
   * a private key, never the global transcript — so a member can watch the
   * steward type without a path to anyone else's tasks. Best-effort; absent ⇒
   * no streaming.
   */
  onChunk?: (chunk: string) => void
}

/** Duck-typed surface the Web layer consumes via `serveWeb({ hubSteward })`. */
export interface HubStewardSurface {
  /**
   * Plan: the LLM turns the instruction into a classified proposal. ZERO side
   * effects — nothing is created / changed / deleted. The member previews the
   * returned `ClassifiedProposal`, then `apply`s the actions they accept.
   *
   * Throws iff `hub.dispatch` resolves with `kind !== 'ok'` (the Web layer maps
   * to HTTP 500). A "no_json" reply (the steward just chatted) is NOT an error —
   * it returns `{ reply, actions: [] }`.
   */
  plan(input: HubStewardPlanInput): Promise<ClassifiedProposal>
}

/**
 * Read env vars and pick a config. Returns null when the operator explicitly
 * disabled the steward via `AIPE_STEWARD_DISABLED=1`.
 *
 *   AIPE_STEWARD_PROVIDER    'anthropic' (default) | 'openai' | 'mock'
 *   AIPE_STEWARD_MODEL       provider-specific model id (optional)
 *   AIPE_STEWARD_MAX_TOKENS  integer (optional, default 2048)
 *   AIPE_STEWARD_DISABLED    '1' / 'true' → skip registration entirely
 */
export function resolveStewardConfig(): HubStewardAgentConfig | null {
  const disabled = process.env.AIPE_STEWARD_DISABLED
  if (disabled === '1' || disabled === 'true') return null

  const raw = process.env.AIPE_STEWARD_PROVIDER ?? 'anthropic'
  const provider: StewardProviderKind =
    raw === 'openai' ? 'openai' : raw === 'mock' ? 'mock' : 'anthropic'

  const model = process.env.AIPE_STEWARD_MODEL
  const maxTokensRaw = process.env.AIPE_STEWARD_MAX_TOKENS
  let maxTokens: number | undefined
  if (maxTokensRaw !== undefined) {
    const n = Number(maxTokensRaw)
    if (Number.isFinite(n) && n > 0) maxTokens = Math.floor(n)
  }

  const cfg: HubStewardAgentConfig = { provider }
  if (model) cfg.model = model
  if (maxTokens !== undefined) cfg.maxTokens = maxTokens
  return cfg
}

/**
 * Resolve an API key for the configured provider — same chain as the workflow
 * assistant (OrgApiPool → host env), minus per-agent/workspace tiers (the
 * steward is a host-built-in, not a user-authored agent).
 *
 * `undefined` for mock (no key needed); `null` when a real provider has no key
 * in any tier (caller skips registration).
 */
function resolveStewardApiKey(
  provider: StewardProviderKind,
  orgApiPool: OrgApiPool | undefined,
): string | null | undefined {
  if (provider === 'mock') return undefined
  if (orgApiPool) {
    const hit = orgApiPool.resolveLlmKey(provider)
    if (hit) return hit.apiKey
  }
  const env = provider === 'anthropic' ? process.env.ANTHROPIC_API_KEY : process.env.OPENAI_API_KEY
  return env ?? null
}

function buildStewardProvider(kind: StewardProviderKind, apiKey: string | undefined): LlmProvider {
  switch (kind) {
    case 'mock':
      // Deterministic stub — emits a valid `StewardProposal` JSON (one harmless
      // read-only `inspect` action) so the plan pipeline (parse → classify)
      // stays exercisable without burning real LLM quota. Split into chunks so
      // the SPA's streaming preview demonstrates incremental delivery in mock
      // mode (a real provider naturally streams many small chunks).
      return new MockLlmProvider({
        textChunkCount: 6,
        reply: () =>
          [
            'Mock steward — set AIPE_STEWARD_PROVIDER=anthropic or openai for real planning.',
            '',
            '```json',
            '{',
            '  "reply": "我在 mock 模式下运行——接一个真 provider 我才能真正帮你建/改助手和工作流。",',
            '  "actions": [',
            '    { "kind": "inspect", "answer": "Mock mode: wire AIPE_STEWARD_PROVIDER to anthropic or openai." }',
            '  ]',
            '}',
            '```',
          ].join('\n'),
      })
    case 'anthropic':
      if (!apiKey) {
        throw new Error(
          "HubStewardAgent provider 'anthropic' has no API key — wire one through the org vault or set ANTHROPIC_API_KEY",
        )
      }
      return new AnthropicProvider({ apiKey, maxInlineBytes: readMultimodalInlineCapFromEnv() })
    case 'openai':
      if (!apiKey) {
        throw new Error(
          "HubStewardAgent provider 'openai' has no API key — wire one through the org vault or set OPENAI_API_KEY",
        )
      }
      return new OpenAIProvider({ apiKey, maxInlineBytes: readMultimodalInlineCapFromEnv() })
  }
}

/**
 * Build + register the host-built-in `HubStewardAgent` and return a
 * `HubStewardSurface`, or `null` when registration was skipped (steward
 * disabled, or no API key for the configured provider). Call once at host boot.
 */
export function createHubStewardService(deps: {
  hub: Hub
  config: HubStewardAgentConfig
  agents: StewardAgentDirectory
  workflows: StewardWorkflowDirectory
  orgApiPool?: OrgApiPool
  logger: Logger
  /**
   * Pre-built provider override. When present, the config-driven key resolution
   * + provider build are skipped and this provider is used as-is (config.model /
   * .maxTokens still apply). Lets a test inject a scripted `MockLlmProvider`, or
   * a host pass a provider it built itself; absent ⇒ the normal env/key path.
   */
  provider?: LlmProvider
}): HubStewardSurface | null {
  const { hub, config, agents, workflows, orgApiPool, logger } = deps

  let provider: LlmProvider
  if (deps.provider) {
    provider = deps.provider
  } else {
    const keyOrNull = resolveStewardApiKey(config.provider, orgApiPool)
    if (keyOrNull === null) {
      logger.warn('hub-steward: no API key resolved — skipping registration', {
        provider: config.provider,
      })
      return null
    }
    const apiKey = keyOrNull // undefined for mock; string otherwise
    try {
      provider = buildStewardProvider(config.provider, apiKey)
    } catch (err) {
      logger.warn('hub-steward: provider build failed — skipping registration', {
        provider: config.provider,
        err: err instanceof Error ? err.message : String(err),
      })
      return null
    }
  }

  // WFEDIT-D4 — per-call chunk sinks. A plan caller that wants live typing
  // registers a sink under a private random key; the key rides inside the
  // dispatched payload, so the agent's constructor-level stream hook routes each
  // chunk back to exactly the call that triggered it.
  const chunkSinks = new Map<string, (chunk: string) => void>()

  const agentOpts: ConstructorParameters<typeof HubStewardAgent>[0] = { provider }
  if (config.model) agentOpts.model = config.model
  agentOpts.maxTokens = config.maxTokens ?? 2048
  agentOpts.onStreamChunk = (chunk, task) => {
    // Mirror the assistant: pipe chunks into the transcript so an operator
    // auditing the trail sees the steward typing. Best-effort.
    try {
      hub.transcript.append({
        ts: Date.now(),
        kind: 'llm_stream_chunk',
        data: { taskId: task.id, agentId: HUB_STEWARD_DEFAULT_ID, chunk },
      })
    } catch (err) {
      logger.warn('hub-steward: transcript append failed for llm_stream_chunk', {
        err: err instanceof Error ? err.message : String(err),
      })
    }
    const sinkKey = (task.payload as { __streamSinkKey?: unknown } | undefined)?.__streamSinkKey
    if (typeof sinkKey === 'string' && chunk.type === 'text' && chunk.text) {
      try {
        chunkSinks.get(sinkKey)?.(chunk.text)
      } catch {
        /* a throwing caller sink must never break the plan call */
      }
    }
  }

  const agent = new HubStewardAgent(agentOpts)
  hub.register(agent)
  logger.info('hub-steward: registered', {
    id: HUB_STEWARD_DEFAULT_ID,
    capability: HUB_STEWARD_CAPABILITY,
    provider: config.provider,
    model: config.model ?? '(provider default)',
  })

  return {
    async plan(input) {
      const { userId, instruction } = input

      // 1. Build the read-only snapshot of what THIS member owns, so the steward
      //    proposes against real ids / capabilities (workflow-assistant's
      //    contextHints discipline). Cross-hub ids come from the SAME source the
      //    classifier tiers on — one source of truth, no drift.
      const [ownedAgents, ownedWorkflows, providers] = await Promise.all([
        agents.listOwned(userId),
        workflows.listForUser(userId),
        agents.availableProviders(userId),
      ])
      const snapshot: StewardSnapshot = {
        agents: ownedAgents.map((a) => projectSnapshotAgent(a, userId)),
        workflows: ownedWorkflows,
        providers: providers.filter(isStewardProvider),
      }
      const crossHubWorkflowIds = new Set(
        ownedWorkflows.filter((w) => w.crossHub).map((w) => w.id),
      )

      // 2. Dispatch to the steward agent. A member call carries an origin so the
      //    spend is quota-attributed (Phase 17), and `from` is the member.
      const payload: HubStewardPayload = { instruction, snapshot }
      if (input.history) payload.history = input.history
      let sinkKey: string | undefined
      if (input.onChunk) {
        sinkKey = randomUUID()
        chunkSinks.set(sinkKey, input.onChunk)
        ;(payload as unknown as Record<string, unknown>).__streamSinkKey = sinkKey
      }
      let output: HubStewardOutput
      try {
        const result = await hub.dispatch({
          from: userId,
          strategy: { kind: 'capability', capabilities: [HUB_STEWARD_CAPABILITY] },
          payload,
          origin: { orgId: 'local', userId },
          title: 'hub:steward',
        })
        if (result.kind !== 'ok') {
          const reason =
            result.kind === 'failed'
              ? result.error
              : result.kind === 'cancelled'
                ? `cancelled: ${result.reason}`
                : result.kind === 'no_participant'
                  ? `no participant for capability ${HUB_STEWARD_CAPABILITY}: ${result.reason}`
                  : `unexpected result kind: ${result.kind}`
          throw new Error(`hub:steward dispatch failed — ${reason}`)
        }
        output = result.output as HubStewardOutput
      } finally {
        if (sinkKey) chunkSinks.delete(sinkKey)
      }

      // 3. Classify each proposed action server-side (the client's tier is never
      //    trusted) and attach a member-readable summary.
      const classified: ClassifiedAction[] = output.actions.map((action) => ({
        action,
        tier: classifyStewardAction(action, { crossHubWorkflowIds, stewardId: HUB_STEWARD_DEFAULT_ID }),
        summary: summarizeStewardAction(action),
      }))
      return { reply: output.reply, actions: classified }
    },
  }
}

// --- helpers ----------------------------------------------------------------

/** The providers a member may pick, as a runtime guard over `availableProviders`. */
const STEWARD_PROVIDERS = new Set<StewardAgentProvider>(['anthropic', 'openai', 'mock'])
function isStewardProvider(p: string): p is StewardAgentProvider {
  return STEWARD_PROVIDERS.has(p as StewardAgentProvider)
}

/**
 * Project an owned agent into the snapshot shape. `handle` is the member's short
 * name — the suffix of the host-composed id `me.<userId>.<handle>` — recovered
 * by stripping that exact prefix (never a naive split, since userIds can contain
 * dots). Absent when the id doesn't fit the pattern (defensive).
 */
function projectSnapshotAgent(a: StewardOwnedAgent, userId: string): StewardSnapshotAgent {
  const prefix = `me.${userId}.`
  const out: StewardSnapshotAgent = {
    id: a.id,
    label: a.label,
    capabilities: a.capabilities,
    provider: a.provider,
  }
  if (a.id.startsWith(prefix)) out.handle = a.id.slice(prefix.length)
  return out
}

/**
 * A one-line, member-readable (zh) description of an action — tier-agnostic (the
 * tier badge is a separate field; this just says WHAT the action does).
 */
export function summarizeStewardAction(action: StewardAction): string {
  switch (action.kind) {
    case 'inspect':
      return '回答你的问题(只读,不改动任何设置)'
    case 'create_agent':
      return `建一个新助手「${action.label}」(${action.provider})`
    case 'edit_agent':
      return `改助手 ${action.agentId} 的设置`
    case 'delete_agent':
      return `删掉助手 ${action.agentId}`
    case 'edit_workflow':
      return `按你的说法改工作流 ${action.workflowId}`
    case 'refuse':
      return `这个超出管家范围:${action.reason}`
  }
}
