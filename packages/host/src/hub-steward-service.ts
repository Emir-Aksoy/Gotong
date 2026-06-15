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
  validateStewardAction,
  isStewardActionKind,
  type ClassifiedAction,
  type ClassifiedProposal,
  type HubStewardOutput,
  type HubStewardPayload,
  type StewardAction,
  type StewardActionTier,
  type StewardAgentFields,
  type StewardAgentProvider,
  type StewardSnapshot,
  type StewardSnapshotAgent,
  type StewardSnapshotWorkflow,
  type StewardTurn,
  type StewardTurnInput,
  type StewardTurnResult,
} from '@aipehub/hub-steward'

import type { InboxStore } from '@aipehub/inbox'

import type { OrgApiPool } from './org-api-pool.js'
import type { HostMeAgentService } from './me-agent-service.js'
import type { MeWorkflowEditResult, MeWorkflowEditService } from './me-workflow-edit-service.js'
import type { StewardSensitiveExecutors } from './steward-sensitive.js'
import {
  StewardApprovalBroker,
  STEWARD_EXEC_CAPABILITY,
  STEWARD_EXEC_PARTICIPANT_ID,
  type StewardExecPayload,
} from './steward-approval.js'

/**
 * The four ids that distinguish ONE steward instance on the hub (A-M1). The
 * member-facing steward (`/api/me/steward/*`) and the operator console steward
 * (`/api/admin/steward/*`, SW-M9) are two instances of `createHubStewardService`
 * on the SAME hub; they coexist ONLY because each registers under a DISJOINT set
 * of these ids, so capability dispatch never crosses between them. The privilege
 * boundary is the REGISTERED identity + the host surface that built it — NEVER a
 * payload flag a member could forge (chat input is untrusted data).
 */
export interface StewardServiceIds {
  /** The `HubStewardAgent` participant id + the capability `plan` dispatches to. */
  agentId: string
  capability: string
  /** The `StewardApprovalBroker` participant id + the capability `apply` gates to. */
  brokerId: string
  brokerCapability: string
}

/** The member-facing steward's ids — the existing constants, byte-for-byte. */
export const DEFAULT_STEWARD_IDS: StewardServiceIds = {
  agentId: HUB_STEWARD_DEFAULT_ID,
  capability: HUB_STEWARD_CAPABILITY,
  brokerId: STEWARD_EXEC_PARTICIPANT_ID,
  brokerCapability: STEWARD_EXEC_CAPABILITY,
}

/**
 * The operator console steward's ids — disjoint from the member set so both
 * register on one hub without collision (SW-M9). `apply` on the operator surface
 * dispatches to `brokerCapability` here, landing on the operator broker; a parked
 * operator action's suspended-task row carries `brokerId`, so the inbox resolve
 * resumes the OPERATOR broker, never the member's (R1).
 */
export const OPERATOR_STEWARD_IDS: StewardServiceIds = {
  agentId: 'hub-steward-operator',
  capability: 'hub:steward:operator',
  brokerId: 'aipehub:steward-exec:operator',
  brokerCapability: 'aipehub.steward.exec.operator/v1',
}

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

// Input types for the executor's write verbs, DERIVED from the real
// `HostMeAgentService` so the live service is GUARANTEED to satisfy
// `StewardAgentDirectory` (the same `Parameters<…>` discipline
// `me-workflow-edit-service.ts` uses to track the web opts). A light test fake
// only ever RECEIVES these — it never has to construct them.
type MeAgentCreateInput = Parameters<HostMeAgentService['create']>[1]
type MeAgentUpdateInput = Parameters<HostMeAgentService['update']>[2]

/**
 * The member-agent slice the steward uses — READ (snapshot) + WRITE (executor).
 * `HostMeAgentService` satisfies it, so the steward structurally CANNOT exceed
 * what the member could do by hand: the same `resource_grants` RBAC ladder +
 * member limits (no inline key, provider-must-have-key, per-member cap) gate
 * every create / edit / delete the steward performs.
 */
export interface StewardAgentDirectory {
  /** The member's owned managed agents (the snapshot's `agents`). */
  listOwned(userId: string): Promise<StewardOwnedAgent[]>
  /** Providers the member may pick (org/workspace/env + their own BYO keys). */
  availableProviders(userId: string): Promise<string[]>
  /** Build a new owned agent — the `create_agent` action (SW-M4 executor). */
  create(userId: string, input: MeAgentCreateInput): Promise<StewardOwnedAgent>
  /** Change an owned agent's config — the `edit_agent` action. */
  update(userId: string, agentId: string, input: MeAgentUpdateInput): Promise<StewardOwnedAgent>
  /** Remove an owned agent — the `delete_agent` action (DANGEROUS, gated by M5). */
  remove(userId: string, agentId: string): Promise<boolean>
}

/** The fields the steward reads off an owned agent for its snapshot / write result. */
export interface StewardOwnedAgent {
  id: string
  label: string
  capabilities: string[]
  provider: string
  model?: string
}

/**
 * The workflow-edit executor — the SAME `MeWorkflowEditService.edit` the
 * OpenClaw-style `/me` editor uses, so a steward `edit_workflow` inherits the
 * cross-hub 出入口 lock + structure hard-gate + run-drift-safe versioning + the
 * line diff for free, and a member can NEVER repoint a cross-hub edge through the
 * steward that they couldn't through the editor. Input / result are the service's
 * own types, so the live service satisfies this with no adapter; a test passes a
 * light fake.
 */
export interface StewardWorkflowEditor {
  edit(req: Parameters<MeWorkflowEditService['edit']>[0]): Promise<MeWorkflowEditResult>
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
  /**
   * Prior turns of this steward conversation, for follow-up instructions. The
   * LOOSE input shape (`kind`/`status` as plain strings) — the SPA only
   * shape-coerces. `plan` runs this through `sanitizeStewardHistory`, which
   * re-validates against `STEWARD_ACTION_KINDS` + the status set and renders the
   * prompt line itself, so a forged value can never inject a fake outcome. The
   * looser declared type lets the web's `MeHubStewardSurface` boundary satisfy
   * this method's parameter (contravariance under `strictFunctionTypes`).
   */
  history?: ReadonlyArray<StewardTurnInput>
  /**
   * Live LLM chunks for THIS call only (WFEDIT-D4 pattern). Routed per-call via
   * a private key, never the global transcript — so a member can watch the
   * steward type without a path to anyone else's tasks. Best-effort; absent ⇒
   * no streaming.
   */
  onChunk?: (chunk: string) => void
}

/** One `apply` request — the member + the single action they accepted. */
export interface HubStewardApplyInput {
  /** The authenticated member (server-resolved; NEVER client-supplied). */
  userId: string
  /**
   * The action to apply, forwarded VERBATIM from the request body — hence
   * `unknown`. `apply` is the validation authority: it runs the action through
   * `validateStewardAction` (the ONE validation contract, shared with the
   * LLM-reply parser + the approval broker) before doing anything, then
   * re-derives the TIER server-side (the client's classification is never
   * trusted) and the member services re-check RBAC — so neither a malformed nor
   * a forged action can escalate.
   */
  action: unknown
}

/**
 * What `performStewardAction` produces for a successfully executed action.
 *
 * The four B-M3 sensitive results carry NO plaintext secret — only the env-var
 * NAME (for a credential), ids, and plain scalars. The result flows back to the
 * caller / inbox / transcript, so a secret here would defeat the whole
 * "never carry plaintext" invariant. The executor (`steward-sensitive.ts`) is the
 * ONLY plaintext holder; it returns just the vault id it minted.
 */
export type StewardActionResult =
  | { kind: 'inspect'; answer: string }
  | { kind: 'create_agent'; agent: StewardOwnedAgent }
  | { kind: 'edit_agent'; agent: StewardOwnedAgent }
  | { kind: 'delete_agent'; removed: boolean }
  | { kind: 'edit_workflow'; edit: MeWorkflowEditResult }
  | { kind: 'set_credential_ref'; provider: string; envVarName: string; credentialId: string }
  | { kind: 'revoke_credential'; credentialId: string; removed: boolean }
  | { kind: 'set_peer_policy'; peerId: string }
  | { kind: 'set_security_quota'; scope: string; metric: string; period: string; limit: number }

/**
 * The outcome of `apply`.
 *
 *   - `done`           — a SAFE action executed inline; `result` carries the
 *                        per-kind outcome (incl. the WFEDIT diff / denial for an
 *                        `edit_workflow` — a locally-safe edit can still come
 *                        back `edit.ok === false`, e.g. the assistant failed).
 *   - `refused`         — a FORBIDDEN action; nothing executed, `reason` explains.
 *   - `invalid`         — the action didn't pass `validateStewardAction` (a
 *                         malformed / unrecognized shape from the request body);
 *                         nothing executed. The Web layer maps it to HTTP 400.
 *   - `pending_approval`— a DANGEROUS / CROSS_HUB action dispatched to the
 *                         approval broker: parked in the member's inbox, NOT
 *                         executed. The member's `/me` resolve later runs it (the
 *                         user's two hard constraints — 「跨 hub + 危险动作都再次确认」).
 *                         `inboxItemId` is the parked item to confirm.
 *   - `needs_approval`  — the SAME tier but NO approval inbox is wired (a unit
 *                         test, or steward-without-inbox mode): the need for a
 *                         second confirmation is surfaced without parking
 *                         anything. Production always wires the broker, so this
 *                         is the graceful-degradation fallback, not the hot path.
 */
export type StewardApplyResult =
  | { status: 'done'; tier: StewardActionTier; result: StewardActionResult }
  | { status: 'refused'; reason: string }
  | { status: 'invalid'; reason: string }
  | { status: 'pending_approval'; tier: 'dangerous' | 'cross_hub'; inboxItemId: string }
  | { status: 'needs_approval'; tier: 'dangerous' | 'cross_hub' }

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

  /**
   * Apply ONE action the member accepted from a prior `plan`. The action arrives
   * `unknown` (forwarded verbatim from the body): `apply` first VALIDATES it via
   * `validateStewardAction` (→ `invalid` on a bad shape), then re-classifies it
   * server-side (never the client's tier) and:
   *   - SAFE → executes inline via `performStewardAction` (reusing the member
   *     services, so their RBAC + member limits apply);
   *   - FORBIDDEN → refuses without executing;
   *   - DANGEROUS / CROSS_HUB → dispatches to the approval broker, which parks
   *     the action in the member's inbox and returns `pending_approval` (the
   *     user's "跨 hub + 危险动作都再次确认"). With no inbox wired it degrades to
   *     `needs_approval` (nothing parked).
   *
   * The member services throw `{ status: 4xx }` on RBAC / not-found / validation;
   * those propagate for the Web layer to map.
   */
  apply(input: HubStewardApplyInput): Promise<StewardApplyResult>
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
  /** Executes an `edit_workflow` action — the member's OpenClaw-style editor. */
  workflowEditor: StewardWorkflowEditor
  /**
   * The member inbox store. When present, a `StewardApprovalBroker` is built +
   * registered so DANGEROUS / CROSS_HUB actions route through the Phase 16
   * approval inbox (the user's two hard constraints). Absent (a unit test) ⇒
   * `apply` degrades those tiers to `needs_approval` without parking anything.
   */
  inbox?: InboxStore
  orgApiPool?: OrgApiPool
  logger: Logger
  /**
   * Pre-built provider override. When present, the config-driven key resolution
   * + provider build are skipped and this provider is used as-is (config.model /
   * .maxTokens still apply). Lets a test inject a scripted `MockLlmProvider`, or
   * a host pass a provider it built itself; absent ⇒ the normal env/key path.
   */
  provider?: LlmProvider
  /**
   * The id set this instance registers under (A-M1). Default = the member-facing
   * `DEFAULT_STEWARD_IDS`; the operator console passes `OPERATOR_STEWARD_IDS` so
   * both stewards coexist on one hub without dispatch crossing between them.
   */
  ids?: StewardServiceIds
  /**
   * Replace the agent's built-in system prompt (A-M5). The operator steward
   * passes its own prompt (knows it manages SITE-WIDE resources + sensitive
   * writes always re-confirm); absent ⇒ the member prompt.
   */
  systemOverride?: string
  /**
   * Whether THIS instance is the OPERATOR console (B-M2). Flows into the
   * classifier `ctx.operator`, which is the ONLY thing that lets the four
   * sensitive writes (credentials / peer / security) tier as `dangerous` (inbox)
   * instead of `forbidden`. The privilege boundary is THIS host-side flag, not a
   * member-forgeable payload field. Default `false` (member steward).
   */
  operator?: boolean
  /**
   * The OPERATOR-ONLY sensitive executors (B-M3). Passed ONLY for the operator
   * console; the member steward omits it. They back the four sensitive writes
   * (credentials / peer / security) after the second confirmation. Absent ⇒ those
   * writes fail closed in `performStewardAction` (gate 2 — the privilege is this
   * injected dependency, not a flag). Threaded into the approval broker, which is
   * where a sensitive action actually executes after approval.
   */
  sensitive?: StewardSensitiveExecutors
}): HubStewardSurface | null {
  const { hub, config, agents, workflows, workflowEditor, orgApiPool, logger } = deps
  const ids = deps.ids ?? DEFAULT_STEWARD_IDS
  const operator = deps.operator ?? false

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
  agentOpts.id = ids.agentId
  agentOpts.capabilities = [ids.capability]
  if (deps.systemOverride) agentOpts.systemOverride = deps.systemOverride
  if (config.model) agentOpts.model = config.model
  agentOpts.maxTokens = config.maxTokens ?? 2048
  agentOpts.onStreamChunk = (chunk, task) => {
    // Mirror the assistant: pipe chunks into the transcript so an operator
    // auditing the trail sees the steward typing. Best-effort.
    try {
      hub.transcript.append({
        ts: Date.now(),
        kind: 'llm_stream_chunk',
        data: { taskId: task.id, agentId: ids.agentId, chunk },
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
    id: ids.agentId,
    capability: ids.capability,
    provider: config.provider,
    model: config.model ?? '(provider default)',
  })

  // SW-M5 — the approval broker that turns a DANGEROUS / CROSS_HUB action into a
  // second confirmation in the member's inbox (the user's two hard constraints).
  // Only wired when an inbox store is supplied; absent ⇒ `apply` degrades those
  // tiers to `needs_approval`. The broker reuses the SAME executor deps as the
  // safe inline path, so an approved action runs `performStewardAction` exactly
  // as a safe one does.
  let broker: StewardApprovalBroker | null = null
  if (deps.inbox) {
    broker = new StewardApprovalBroker({
      store: deps.inbox,
      agents,
      workflowEditor,
      id: ids.brokerId,
      capability: ids.brokerCapability,
      // B-M3 — operator-only sensitive executors. The broker is where a sensitive
      // action runs AFTER the member approves it in their inbox, so the executors
      // must reach it here; absent (member steward) ⇒ those kinds never get this far
      // (forbidden) and would fail closed even if they did.
      ...(deps.sensitive ? { sensitive: deps.sensitive } : {}),
    })
    hub.register(broker)
    logger.info('hub-steward: approval broker registered', {
      id: ids.brokerId,
      capability: ids.brokerCapability,
    })
  }

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
      // Re-inject the conversation, sanitised: each prior turn's structured
      // outcome (Phase C) is host-validated + folded into a fixed-format
      // `[执行结果] …` line so the steward builds on what ACTUALLY happened — a
      // forged result can't make anything run (the next apply re-classifies).
      const history = sanitizeStewardHistory(input.history)
      if (history.length > 0) payload.history = history
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
          strategy: { kind: 'capability', capabilities: [ids.capability] },
          payload,
          origin: { orgId: 'local', userId },
          title: ids.capability,
        })
        if (result.kind !== 'ok') {
          const reason =
            result.kind === 'failed'
              ? result.error
              : result.kind === 'cancelled'
                ? `cancelled: ${result.reason}`
                : result.kind === 'no_participant'
                  ? `no participant for capability ${ids.capability}: ${result.reason}`
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
        tier: classifyStewardAction(action, { crossHubWorkflowIds, stewardId: ids.agentId, operator }),
        summary: summarizeStewardAction(action),
      }))
      return { reply: output.reply, actions: classified }
    },

    async apply(input) {
      const { userId } = input

      // The action arrives VERBATIM from the request body (typed `unknown`).
      // `validateStewardAction` is the ONE validation contract — the same the
      // LLM-reply parser and the approval broker use — so a malformed /
      // unrecognized shape is rejected uniformly HERE, before it can reach a
      // member service half-formed. (TS method bivariance would let a bad shape
      // typecheck through the duck-typed web surface; this is the runtime guard.)
      const action = validateStewardAction(input.action)
      if (!action) {
        return {
          status: 'invalid',
          reason: '这个动作的格式不对(可能不是管家提议过的动作),没有执行。',
        }
      }

      // Re-derive the tier server-side. An `edit_workflow`'s cross-hub-ness comes
      // from the SAME `listForUser` the plan snapshot + the editor lock use, so
      // "what the steward gates as cross_hub" can't drift from "what the editor
      // locks". Only fetched for `edit_workflow` — other actions don't need it.
      const crossHubWorkflowIds =
        action.kind === 'edit_workflow'
          ? new Set(
              (await workflows.listForUser(userId)).filter((w) => w.crossHub).map((w) => w.id),
            )
          : EMPTY_CROSS_HUB
      const tier = classifyStewardAction(action, {
        crossHubWorkflowIds,
        stewardId: ids.agentId,
        operator,
      })

      switch (tier) {
        case 'forbidden':
          // Never executed — the steward only explains + points to settings.
          return {
            status: 'refused',
            reason:
              action.kind === 'refuse'
                ? action.reason
                : '这个动作超出管家的范围(凭证 / peer / 安全 / 权限),请到对应的设置面板手动操作。',
          }
        case 'dangerous':
        case 'cross_hub': {
          // The user's two hard constraints: a delete / a cross-hub workflow edit
          // gets a SECOND confirmation. Dispatch to the approval broker, which
          // parks the action in the member's inbox and suspends — NOTHING runs
          // until they resolve it in `/me`. With no inbox wired, degrade to
          // `needs_approval` (surface the requirement without parking).
          if (!broker) return { status: 'needs_approval', tier }
          const execPayload: StewardExecPayload = { userId, action }
          const result = await hub.dispatch({
            from: userId,
            strategy: { kind: 'capability', capabilities: [ids.brokerCapability] },
            payload: execPayload,
            origin: { orgId: 'local', userId },
            title: `hub:steward exec (${tier})`,
          })
          if (result.kind === 'suspended') {
            return { status: 'pending_approval', tier, inboxItemId: result.taskId }
          }
          // The broker ALWAYS suspends a gated action. Any other terminal result
          // is a wiring fault — surface it rather than silently dropping the ask.
          const detail =
            result.kind === 'failed'
              ? result.error
              : result.kind === 'no_participant'
                ? result.reason
                : result.kind
          throw new Error(
            `hub:steward approval dispatch did not suspend — got ${result.kind}: ${detail}`,
          )
        }
        case 'safe': {
          const result = await performStewardAction(userId, action, { agents, workflowEditor })
          return { status: 'done', tier, result }
        }
      }
    },
  }
}

/** A shared empty cross-hub set for `apply` on non-`edit_workflow` actions. */
const EMPTY_CROSS_HUB: ReadonlySet<string> = new Set()

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

// --- result-aware history (Phase C) -----------------------------------------
//
// The SPA holds the steward conversation (stateless across `plan` calls, like
// WFEDIT-D3) and echoes it back as `history[]`. From Phase C each prior turn may
// carry the STRUCTURED outcome of the action it applied (`result`), so the
// steward's NEXT proposal builds on what ACTUALLY happened, not what it merely
// proposed. The host is the authority on that outcome: `sanitizeStewardHistory`
// validates the round-tripped shape and RE-RENDERS it into a fixed-format
// `[执行结果] …` line folded into the turn's content — the client never supplies
// the rendered text, only the whitelisted `{kind,status,subject}`, so it can't
// inject a "succeeded" narrative the model would read as ground truth. Advisory
// only: the next `apply` is re-classified + re-executed server-side regardless.

/** Keep recent turns only — what "接着上一步 / 再…一点" point at. */
const MAX_STEWARD_HISTORY_TURNS = 8
/** Clip a turn's folded content (defence against a bloated echo). */
const MAX_STEWARD_CONTENT_CHARS = 2000
/** Clip the result subject (an id / provider — never long). */
const MAX_STEWARD_SUBJECT_CHARS = 200

/**
 * The mark + zh label for each outcome status. Exhaustive by type — TS errors if
 * a `StewardTurnResult['status']` is added without a label here, so the rendered
 * vocabulary never drifts from the type.
 */
const STEWARD_RESULT_LABEL: Record<
  StewardTurnResult['status'],
  { mark: string; label: string }
> = {
  done: { mark: '✓', label: '已执行' },
  pending_approval: { mark: '⏳', label: '已送收件箱待确认' },
  refused: { mark: '✗', label: '已拒绝(超出范围)' },
  invalid: { mark: '✗', label: '动作无效' },
}

function isStewardResultStatus(x: unknown): x is StewardTurnResult['status'] {
  return typeof x === 'string' && Object.prototype.hasOwnProperty.call(STEWARD_RESULT_LABEL, x)
}

function clipStewardText(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s
}

/**
 * Render a round-tripped structured result into a deterministic outcome line, or
 * `null` if it isn't well-formed (unknown kind / status, or no object). Reads ONLY
 * the whitelisted `kind` / `status` / `subject` — any other field the client
 * stuffed in is ignored, so it can never reach the prompt.
 */
function renderStewardTurnResult(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (!isStewardActionKind(o.kind)) return null
  if (!isStewardResultStatus(o.status)) return null
  const meta = STEWARD_RESULT_LABEL[o.status]
  const subject =
    typeof o.subject === 'string' && o.subject.trim()
      ? ` → ${clipStewardText(o.subject.trim(), MAX_STEWARD_SUBJECT_CHARS)}`
      : ''
  return `[执行结果] ${o.kind} ${meta.mark} ${meta.label}${subject}`
}

/**
 * Validate + normalise the SPA-echoed conversation history before it re-enters a
 * prompt. Mirrors `sanitizeEditHistory` (WFEDIT-D3): drop malformed turns,
 * validate role, fold a whitelisted structured result into the content, clip,
 * keep the last N. Returns PLAIN `{ role, content }` turns (the `result` is
 * folded away) — so the agent needs no change; it only ever reads role+content.
 */
export function sanitizeStewardHistory(history: unknown): StewardTurn[] {
  if (!Array.isArray(history)) return []
  const out: StewardTurn[] = []
  for (const turn of history) {
    if (!turn || typeof turn !== 'object') continue
    const role = (turn as { role?: unknown }).role
    if (role !== 'user' && role !== 'assistant') continue
    const rawContent = (turn as { content?: unknown }).content
    let content = typeof rawContent === 'string' ? rawContent.trim() : ''
    const rendered = renderStewardTurnResult((turn as { result?: unknown }).result)
    if (rendered) content = content ? `${content}\n${rendered}` : rendered
    // A turn with neither usable content nor a renderable result carries nothing.
    if (!content) continue
    out.push({ role, content: clipStewardText(content, MAX_STEWARD_CONTENT_CHARS) })
  }
  return out.slice(-MAX_STEWARD_HISTORY_TURNS)
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
    case 'set_credential_ref':
      // Never names the secret — only the env var the operator set out of band.
      return `注册 ${action.provider} 凭证(密钥读环境变量 ${action.envVarName},不在这里填明文)`
    case 'revoke_credential':
      return `吊销凭证 ${action.credentialId}`
    case 'set_peer_policy':
      return `改对端 ${action.peerId} 的信任契约(数据类/配额/摘要)`
    case 'set_security_quota':
      return `给 ${action.scope} 设 ${action.metric} 配额(每${action.period} ${action.limit})`
    case 'refuse':
      return `这个超出管家范围:${action.reason}`
  }
}

/**
 * The single execution chokepoint — the SAFE inline path (`apply`, SW-M4) AND the
 * post-approval path (`StewardApprovalBroker`, SW-M5) both run a write through
 * here, so a dangerous / cross-hub action takes the EXACT same code path after a
 * human approves it as a safe action does immediately. Every write delegates to a
 * member service, which enforces that member's RBAC ladder + limits — the steward
 * cannot exceed what the member could do by hand. `refuse` is never executed
 * (forbidden); reaching here with one is a programming error.
 */
export async function performStewardAction(
  userId: string,
  action: StewardAction,
  deps: {
    agents: StewardAgentDirectory
    workflowEditor: StewardWorkflowEditor
    /**
     * The OPERATOR-ONLY sensitive executors (B-M3). Present iff this steward is
     * the operator console; ABSENT for the member steward, so the four sensitive
     * kinds fail closed here (gate 2 of the double gate — the privilege is the
     * injected dependency). The safe inline path never passes this either, so a
     * mis-tiered sensitive action can't run inline.
     */
    sensitive?: StewardSensitiveExecutors
  },
): Promise<StewardActionResult> {
  switch (action.kind) {
    case 'inspect':
      // Read-only — the answer was produced at plan time; nothing to execute.
      return { kind: 'inspect', answer: action.answer }
    case 'create_agent': {
      const input: MeAgentCreateInput = {
        id: action.handle, // the member service composes the namespaced id
        label: action.label,
        provider: action.provider,
        system: action.system,
        capabilities: [...action.capabilities],
        ...(action.model ? { model: action.model } : {}),
      }
      const agent = await deps.agents.create(userId, input)
      return { kind: 'create_agent', agent }
    }
    case 'edit_agent': {
      const agent = await deps.agents.update(userId, action.agentId, mapAgentChanges(action.changes))
      return { kind: 'edit_agent', agent }
    }
    case 'delete_agent': {
      const removed = await deps.agents.remove(userId, action.agentId)
      return { kind: 'delete_agent', removed }
    }
    case 'edit_workflow': {
      // Delegates to the OpenClaw-style editor: same cross-hub 出入口 lock +
      // structure gate + run-drift-safe versioning. A locally-safe edit can still
      // come back `edit.ok === false` (e.g. the assistant failed) — that's an
      // honest outcome, surfaced to the member, not an error.
      const edit = await deps.workflowEditor.edit({
        workflowId: action.workflowId,
        instruction: action.instruction,
        userId,
      })
      return { kind: 'edit_workflow', edit }
    }
    case 'set_credential_ref': {
      // The ONLY plaintext-secret holder. The action carries an env-var NAME; the
      // executor reads `process.env[name]` and mints an org vault row, returning
      // just the vault id — no secret crosses back out.
      const { credentialId } = await requireSensitive(deps, action.kind).setCredentialRef(
        userId,
        action,
      )
      return {
        kind: 'set_credential_ref',
        provider: action.provider,
        envVarName: action.envVarName,
        credentialId,
      }
    }
    case 'revoke_credential': {
      const { removed } = await requireSensitive(deps, action.kind).revokeCredential(
        userId,
        action.credentialId,
      )
      return { kind: 'revoke_credential', credentialId: action.credentialId, removed }
    }
    case 'set_peer_policy': {
      await requireSensitive(deps, action.kind).setPeerPolicy(userId, action)
      return { kind: 'set_peer_policy', peerId: action.peerId }
    }
    case 'set_security_quota': {
      await requireSensitive(deps, action.kind).setSecurityQuota(userId, action)
      return {
        kind: 'set_security_quota',
        scope: action.scope,
        metric: action.metric,
        period: action.period,
        limit: action.limit,
      }
    }
    case 'refuse':
      throw new Error('performStewardAction: a refuse action is never executed (it is forbidden)')
  }
}

/**
 * Gate 2 of the double gate (B-M3): the sensitive executors are injected ONLY for
 * the operator steward. Absent ⇒ fail closed — a sensitive action that somehow
 * reached here (a future mis-tier, or the safe inline path which never passes
 * `sensitive`) cannot run. The member steward is structurally incapable of a
 * sensitive write because it was never handed the executor.
 */
function requireSensitive(
  deps: { sensitive?: StewardSensitiveExecutors },
  kind: string,
): StewardSensitiveExecutors {
  if (!deps.sensitive) {
    throw new Error(
      `performStewardAction: sensitive write '${kind}' requires the operator executor (B-M3); not wired`,
    )
  }
  return deps.sensitive
}

/**
 * Map a steward's proposed agent changes onto the member-update input. `handle`
 * is intentionally dropped — the participant id is fixed at create time (renaming
 * = a new agent), so an `edit_agent` only touches label / provider / model /
 * system / capabilities.
 */
function mapAgentChanges(changes: Partial<StewardAgentFields>): MeAgentUpdateInput {
  const out: MeAgentUpdateInput = {}
  if (changes.label !== undefined) out.label = changes.label
  if (changes.provider !== undefined) out.provider = changes.provider
  if (changes.model !== undefined) out.model = changes.model
  if (changes.system !== undefined) out.system = changes.system
  if (changes.capabilities !== undefined) out.capabilities = [...changes.capabilities]
  return out
}
