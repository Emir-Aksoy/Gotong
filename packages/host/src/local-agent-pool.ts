import {
  createLogger,
  type AgentRecord,
  type Hub,
  type ManagedAgentLifecycle,
  type ManagedAgentSpec,
  type McpServerSpec,
  type ParticipantId,
  type ServiceUseSpec,
  type Space,
  type Task,
} from '@aipehub/core'
import { LlmAgent, MockLlmProvider, type LlmProvider } from '@aipehub/llm'
import { PersonalGrowthAgent } from './agents/personal-growth-agent.js'
import { AnthropicProvider } from '@aipehub/llm-anthropic'
import { OpenAIProvider } from '@aipehub/llm-openai'
import { McpToolset, type McpServerConfig } from '@aipehub/mcp-client'
import {
  resolveOwner,
  type AgentDispatchOpts,
  type AgentDispatchResult,
  type AgentDispatchSurface,
  type ArtifactHandle,
  type DatastoreHandle,
  type MemoryHandle,
  type Owner,
  type Scope,
  type ServiceCtx,
} from '@aipehub/services-sdk'

import type { HubServices, ServiceUseSpec as AttachSpec } from './services/index.js'
import type { OrgApiPool, QuotaGate } from './org-api-pool.js'
import {
  AUDIT_ACTIONS,
  type IdentityStore,
} from '@aipehub/identity'

const log = createLogger('local-agents')

/**
 * Phase 6 #2 — discriminates which tier of the priority chain
 * delivered the resolved LLM key. The host wires different recovery
 * behaviour per tier:
 *
 *   - `'org-pool'` carries `vaultEntryId` — a 401 from the provider
 *     triggers `identity.revokeVaultEntry(vaultEntryId)` + audit +
 *     `OrgApiPool.invalidate()`. Owner sees the revocation in the
 *     audit log; next call re-resolves and either picks another
 *     active entry or fails clearly with "no key configured".
 *   - `'per-agent'` / `'workspace'` / `'env'` — host has no automatic
 *     remediation; the operator owns these. 401 just surfaces as a
 *     task failure (no key rotation; the next call uses the same bad
 *     key and fails again — the audit log of repeated failures is the
 *     signal there).
 */
export type LlmApiKeySource =
  | { kind: 'per-agent' }
  | { kind: 'org-pool'; vaultEntryId: string }
  | { kind: 'workspace' }
  | { kind: 'env' }

/**
 * Phase 6 #2 — `selectLlmApiKey` / `resolveApiKey` return shape.
 * Carries the plaintext key alongside its origin so the spawn site
 * can wire tier-specific behaviour (e.g. revoke-on-401 for org-pool).
 */
export interface LlmApiKeyResolution {
  readonly apiKey: string
  readonly source: LlmApiKeySource
}

/**
 * `LocalAgentPool` is **not** a separate component — it is a small piece
 * of the host binary's startup code, factored into a class so the Web
 * layer can call its `start` / `stop` / `availableProviders` through the
 * `ManagedAgentLifecycle` interface without taking a direct dependency
 * on `@aipehub/llm-*`.
 *
 * Everything stays in one process, one package (`@aipehub/host`). When
 * the host boots, the pool walks `agents.json` and instantiates an
 * `LlmAgent` for every record that has a `managed` spec, registering
 * each one on the same Hub the WS / Web layers serve. When an admin
 * creates / edits / deletes an agent through the Web API, the same pool
 * methods are called to keep the in-memory set in sync with the file.
 *
 * Key resolution (per spawn):
 *   1. per-agent override (Space.getAgentApiKey) — set in the create
 *      form's "this agent uses its own key" field
 *   2. org pool (v4 identity vault, ownerKind='org' llm_provider row)
 *      — admin UI / CLI writes here; this is the authoritative v4 path
 *   3. workspace default for that provider (Space.getProviderApiKey)
 *      — v3 legacy fallback, kept until B1.3 retires it
 *   4. host environment (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY`)
 *   5. throw — and the spawn fails loudly so the admin sees an error
 *
 * API keys never appear on the wire after the initial POST that sets
 * them; the Space encrypts v3 keys at rest with AES-256-GCM (key in
 * `runtime/secret.key`, 0600) and the v4 identity vault uses its own
 * master key (`identity-master.key`, 0600).
 *
 * B2.2.2 — when `orgApiPool` is wired, every non-mock LlmAgent is
 * spawned with `preCallHook = (task) => gate(task.origin)`. The gate
 * (built once via `orgApiPool.makeLlmQuotaGate(...)`) debits a per-day
 * counter on the dispatching user; admin-triggered tasks (no `origin`)
 * pass through free. Quota exceeded → preCallHook throws → LlmAgent
 * fails the task with `quota_exceeded`.
 */
export class LocalAgentPool implements ManagedAgentLifecycle {
  private readonly hub: Hub
  private readonly space: Space
  /**
   * Optional Hub Services. Present when the host successfully booted
   * services (see `bootstrapServices`). Absent on hosts that disabled
   * services or where the boot failed — the pool still works, but
   * agents declaring `uses:` will fail to spawn with a clear error.
   */
  private readonly services?: HubServices
  private readonly running = new Map<ParticipantId, LlmAgent>()
  /**
   * Per-agent record of the Owner used to file service data, so
   * `stop(id)` can detach the right handles. Owner derivation depends
   * on scope (`'private'` → agentId; `'workflow'` → runId; etc.); we
   * keep the owner explicit to avoid re-deriving on tear-down.
   */
  private readonly serviceOwnerForAgent = new Map<ParticipantId, Owner>()
  /**
   * Per-agent record of the live `ServiceCtx` that was built from
   * `attachServicesIfDeclared(record)` at spawn time. Kept here so
   * out-of-band callers — the v2.4 growth-reports admin endpoint,
   * future workflow-driven introspection — can fetch the same
   * handles the agent uses, instead of re-attaching against the
   * plugin (which would race against the agent's own writes).
   *
   * Entries appear at spawn and disappear at stop. The map only ever
   * contains agents that declared `uses:` — agents with no service
   * declaration never get a key written here.
   */
  private readonly serviceCtxForAgent = new Map<ParticipantId, ServiceCtx>()
  /**
   * Per-agent record of the live `McpToolset` (only present when the
   * agent's manifest declared `mcpServers:`). Held here so `stop(id)`
   * can disconnect the child processes alongside the Hub unregister.
   * Each agent gets its own toolset — sharing across agents is left
   * to applications that need it (they can pass `tools:` to `LlmAgent`
   * directly).
   */
  private readonly mcpToolsetForAgent = new Map<ParticipantId, McpToolset>()
  /**
   * B1.2 — optional v4 identity-vault key pool. When present,
   * `resolveApiKey` consults the org pool between the per-agent
   * override and the legacy workspace fallback. Absent on hosts that
   * couldn't open the identity store (missing masterKey, sqlite open
   * failure) — the chain transparently skips the pool.
   */
  private readonly orgApiPool?: OrgApiPool
  /**
   * B2.2.2 — per-call quota gate, built once from `orgApiPool` at
   * construction. Every spawned non-mock LlmAgent is given a
   * `preCallHook` that calls this gate; the gate no-ops for tasks
   * with no `origin.userId` (admin / system-triggered) and otherwise
   * debits `metric='llm_requests' period='daily'` from the user.
   * Throws `QuotaExceededError` on cap breach — the LlmAgent
   * surfaces that as a normal task failure.
   *
   * Absent when `orgApiPool` is absent (identity bootstrap failed,
   * or running with the v3-only fallback path).
   */
  private readonly llmQuotaGate?: QuotaGate
  /**
   * Phase 6 #2 — IdentityStore reference for vault revoke + audit on
   * 401. Independent of orgApiPool because audit / revoke is a write
   * surface; orgApiPool only handles the read + cache. When absent
   * (orgApiPool may still be present in some test wirings) the
   * `onAuthFailure` closure simply isn't constructed and 401s
   * surface as plain task failures.
   */
  private readonly identity?: IdentityStore

  constructor(opts: {
    hub: Hub
    space: Space
    services?: HubServices
    orgApiPool?: OrgApiPool
    /**
     * Phase 6 #2 — pass-through so a 401 from a provider whose key
     * came from the vault triggers `revokeVaultEntry` + audit. Wire
     * the same `IdentityStore` you passed to `OrgApiPool`.
     */
    identity?: IdentityStore
  }) {
    this.hub = opts.hub
    this.space = opts.space
    this.services = opts.services
    this.orgApiPool = opts.orgApiPool
    this.identity = opts.identity
    // Built once: the gate is a stateless closure over `identity`,
    // shared by every managed LlmAgent. Settings (metric/period) are
    // hardcoded here in B2.2.2; C2 will surface them in admin UI.
    if (this.orgApiPool) {
      this.llmQuotaGate = this.orgApiPool.makeLlmQuotaGate({
        metric: 'llm_requests',
        period: 'daily',
      })
    }
  }

  /**
   * Walk `agents.json` and spawn every managed agent. Existing
   * participants with the same id are unregistered first so a fresh
   * provider instance is used (cleaner than mutating in place).
   */
  async start(): Promise<void>
  async start(record: AgentRecord): Promise<void>
  async start(record?: AgentRecord): Promise<void> {
    if (!record) {
      const agents = await this.space.agents()
      for (const a of agents) {
        if (!a.managed) continue
        try {
          await this.spawn(a)
        } catch (err) {
          log.error('spawn failed', { id: a.id, err })
        }
      }
      return
    }
    if (!record.managed) {
      // not a managed record — nothing to spawn; harmless
      return
    }
    await this.spawn(record)
  }

  /**
   * Remove the live participant for `id` from the Hub registry and
   * forget the internal handle. Safe to call with unknown ids.
   *
   * Also calls `services.detachFor(owner)` so the plugin layer
   * releases any cached per-owner handles. Note: detach does **not**
   * delete data — only `softDelete` (PR-10) moves it to trash.
   */
  async stop(id: ParticipantId): Promise<void> {
    const live = this.running.get(id)
    if (live) this.running.delete(id)
    if (this.hub.participant(id)) this.hub.unregister(id)
    // Best-effort service detach. We swallow errors here because
    // tearing down a participant on shutdown is the wrong moment to
    // fail loudly — the plugin's own next attach will reinitialise.
    const owner = this.serviceOwnerForAgent.get(id)
    if (owner && this.services) {
      try {
        await this.services.detachFor(owner)
      } catch (err) {
        log.warn('service detach failed during stop', { id, err })
      }
    }
    this.serviceOwnerForAgent.delete(id)
    this.serviceCtxForAgent.delete(id)
    // Tear down any MCP toolset that was spawned alongside this
    // agent. Same swallow-on-shutdown discipline: a hung server
    // shouldn't block the host from shutting down.
    const toolset = this.mcpToolsetForAgent.get(id)
    if (toolset) {
      try {
        await toolset.disconnect()
      } catch (err) {
        log.warn('mcp toolset disconnect failed during stop', { id, err })
      }
      this.mcpToolsetForAgent.delete(id)
    }
  }

  /**
   * Which providers we can spawn an agent for **right now**, based on
   * what keys are available. A provider is available if any of the
   * following supplies a key:
   *   - per-provider workspace key (encrypted at rest in the Space)
   *   - the host's environment variable (legacy fallback)
   *   - `mock` — no key needed
   *   - `openai-compatible` — always listed; the per-agent `apiKey`
   *     field on the create form is the only key source (every
   *     `baseURL` is a different vendor, so a single workspace key
   *     wouldn't model the world correctly)
   *
   * Per-agent overrides are NOT consulted here; this list is what shows
   * up in the create form, and an agent with its own key can still be
   * created even if its provider has no default key.
   */
  async availableProviders(): Promise<readonly string[]> {
    const list: string[] = ['mock']
    const ws: Record<string, string> = await this.space.listProviderApiKeys().catch(() => ({}))
    if (ws.anthropic || process.env.ANTHROPIC_API_KEY) list.push('anthropic')
    if (ws.openai    || process.env.OPENAI_API_KEY)    list.push('openai')
    // openai-compatible is always available — the per-agent apiKey field
    // is the only source of credentials and is enforced at spawn time.
    list.push('openai-compatible')
    return list
  }

  /**
   * Return the live `ServiceCtx` for `id`, or `undefined` when the
   * agent isn't running, didn't declare any `uses:`, or hasn't been
   * spawned yet. Used by the v2.4 growth-reports admin endpoint to
   * borrow the synthesist's artifact handle for list / download.
   *
   * The returned ctx is the same reference the agent itself uses, so
   * readers see the agent's latest writes without lag — and we avoid
   * an extra `attach` (which would race against the agent's own
   * handle and could fight for plugin-internal caches).
   */
  liveServicesFor(id: ParticipantId): ServiceCtx | undefined {
    return this.serviceCtxForAgent.get(id)
  }

  /** Stop every managed agent — called by host shutdown. */
  async stopAll(): Promise<void> {
    for (const id of [...this.running.keys()]) {
      await this.stop(id).catch((err) =>
        log.error('stop failed', { id, err }),
      )
    }
  }

  /**
   * Web-layer hook: soft-delete every Hub Service plugin's data for
   * the agent that was just removed from `agents.json`. RFC Q3=A:
   * the agent's data goes to per-plugin `.trash/` for the retention
   * window so a mistaken delete can be reversed. Failures are logged
   * but never re-thrown — the agents.json record is gone and we're
   * past the rollback window.
   */
  async onAgentRemoved(id: ParticipantId): Promise<void> {
    if (!this.services) return
    const owner: Owner = { kind: 'agent', id }
    try {
      const results = await this.services.softDeleteAllForOwner(owner, {
        reason: 'agent_removed',
      })
      const trashed = results.filter((r) => r.ref).length
      const failed = results.filter((r) => r.error).length
      log.info('agent removed — services soft-deleted', { id, trashed, failed })
    } catch (err) {
      log.error('services soft-delete failed', { id, err })
    }
  }

  private async spawn(record: AgentRecord): Promise<void> {
    if (!record.managed) {
      throw new Error(`spawn: record '${record.id}' has no managed spec`)
    }
    // If an agent with this id is already on the registry — either a
    // previous managed instance or an external SDK agent — yank it before
    // overwriting. The persisted record wins; that's the whole point of
    // "agents.json is the source of truth."
    if (this.hub.participant(record.id)) {
      // also detach old service handles, otherwise the plugin keeps
      // pointing at stale state for this owner
      const oldOwner = this.serviceOwnerForAgent.get(record.id)
      if (oldOwner && this.services) {
        await this.services.detachFor(oldOwner).catch((err) =>
          log.warn('respawn detach failed', { id: record.id, err }),
        )
      }
      this.hub.unregister(record.id)
    }
    this.running.delete(record.id)
    this.serviceOwnerForAgent.delete(record.id)
    this.serviceCtxForAgent.delete(record.id)

    // Resolve service handles BEFORE we build the agent — the spawn
    // must fail atomically if any plugin attach throws (e.g. config
    // validation rejected the yaml). A half-attached state would
    // leave the plugin with cached handles for a participant the Hub
    // doesn't actually have.
    const { ctx, owner } = await this.attachServicesIfDeclared(record)

    const resolution = await this.resolveApiKey(record.id, record.managed.provider)
    const apiKey = resolution?.apiKey
    const provider = buildProvider(record.managed, apiKey)

    // If the manifest declared `mcpServers:`, spawn the toolset NOW
    // (before constructing LlmAgent) so the connect()'s child-process
    // failures bubble up as a spawn failure rather than first
    // manifesting on the very first hub.dispatch into this agent.
    // A failed-to-spawn server still leaves its peers usable — see
    // McpToolset's "one server crashed, others stay live" contract.
    let toolset: McpToolset | undefined
    if (record.managed.mcpServers && record.managed.mcpServers.length > 0) {
      toolset = buildToolset(record.id, record.managed.mcpServers)
      try {
        await toolset.connect()
      } catch (err) {
        // Don't let a transient `npx -y` network hiccup tank the spawn.
        // Mark the toolset as failed-to-connect by leaving its dead
        // state visible via `.status()`; LlmAgent's tool-use loop will
        // just see an empty tool list and skip the loop entirely. The
        // operator sees the failure in `'server-stderr'` events.
        log.error('mcp toolset connect failed (continuing with empty toolset)', {
          id: record.id,
          err,
        })
      }
    }

    // v2.5: inject a reverse-dispatch surface so agents can ask
    // questions of the human who triggered them ("human-in-the-loop"
    // — e.g. the personal-growth interviewer pausing to ask follow-
    // up questions when the user's 4-段自述 is too thin). The agent
    // calls `services.dispatch?.dispatch({...})` and `await`s the
    // human task result. We stamp `from = record.id` (the asking
    // agent's id) so accounting + audit can trace "agent X asked
    // admin Y" cleanly. The narrowing to `kind: 'explicit'` only is
    // intentional — broad capability fan-out from inside an agent
    // would be a footgun (think: dispatch storms).
    //
    // We build a fresh object that spreads ctx; never mutate the
    // shared ctx from `attachServicesIfDeclared` (the plugin layer
    // may keep a reference).
    const hub = this.hub
    const dispatchSurface: AgentDispatchSurface = {
      dispatch: async (opts: AgentDispatchOpts): Promise<AgentDispatchResult> => {
        const r = await hub.dispatch({
          from: record.id,
          strategy: opts.strategy,
          payload: opts.payload,
          title: opts.title,
          priority: opts.priority,
        })
        // Hub returns the full TaskResult; mirror it across to the
        // narrower AgentDispatchResult (drop taskId — agents don't
        // need it and it'd leak hub-internal ids into agent code).
        switch (r.kind) {
          case 'ok':
            return { kind: 'ok', output: r.output, by: r.by, ts: r.ts }
          case 'failed':
            return { kind: 'failed', error: r.error, by: r.by, ts: r.ts }
          case 'cancelled':
            return { kind: 'cancelled', reason: r.reason, ts: r.ts }
          case 'no_participant':
            return { kind: 'no_participant', reason: r.reason, ts: r.ts }
        }
      },
    }
    const ctxWithDispatch: ServiceCtx = { ...ctx, dispatch: dispatchSurface }

    // B2.2.2 — wire the per-call quota gate. Only when:
    //   - we have a gate (orgApiPool present at host boot), AND
    //   - this isn't the mock provider (mock calls don't cost money;
    //     debiting them would surprise demo / test users who don't
    //     think of `mock` as a real LLM call).
    // The gate closes over `task.origin` — tasks dispatched by /me
    // or by the workflow runner (which re-stamps origin) get debited;
    // admin-triggered tasks (no origin) free-ride. That asymmetry is
    // by design: admins are the operators, not the consumers.
    const gate = this.llmQuotaGate
    const preCallHook =
      gate && record.managed.provider !== 'mock'
        ? (task: Task): void => gate(task.origin)
        : undefined

    // Phase 6 #2 — wire an auth-failure hook when the resolved key
    // came from the vault. Extracted into a method so tests can
    // exercise the closure independently of the spawn pipeline (the
    // real provider HTTP path is hard to drive from a unit test).
    const onAuthFailure = this.buildAuthFailureHook(record, resolution)

    // Pick the agent class by `managed.kind`. v2.4 added
    // `'personal-growth'` as the first non-base kind; the switch is
    // structured so a future `'custom'` kind that names a package
    // class fits in cleanly. Default `'llm'` is the historical
    // behaviour — all pre-v2.4 agents.json entries land here.
    const agentOpts = {
      id: record.id,
      capabilities: record.allowedCapabilities,
      provider,
      system: record.managed.system,
      model: record.managed.model,
      services: ctxWithDispatch,
      ...(toolset ? { tools: toolset } : {}),
      ...(preCallHook ? { preCallHook } : {}),
      ...(onAuthFailure ? { onAuthFailure } : {}),
    }
    let agent: LlmAgent
    switch (record.managed.kind) {
      case 'personal-growth':
        agent = new PersonalGrowthAgent(agentOpts)
        break
      case 'llm':
      default:
        agent = new LlmAgent(agentOpts)
        break
    }
    this.hub.register(agent)
    this.running.set(record.id, agent)
    if (owner) this.serviceOwnerForAgent.set(record.id, owner)
    if (ctx) this.serviceCtxForAgent.set(record.id, ctx)
    if (toolset) this.mcpToolsetForAgent.set(record.id, toolset)
    log.info('spawned', {
      id: record.id,
      provider: record.managed.provider,
      services: record.managed.uses
        ? record.managed.uses.map((u) => `${u.type}:${u.impl}`)
        : [],
      mcpServers: record.managed.mcpServers
        ? record.managed.mcpServers.map((m) => m.name)
        : [],
    })
  }

  /**
   * Resolve `record.managed.uses` to live handles + an Owner.
   *
   * Returns `{ ctx: undefined, owner: undefined }` when the agent
   * declared no uses — the most common case, especially for agents
   * authored before v2.2. Otherwise:
   *
   *   1. Each `uses` entry's `config.scope` decides the Owner (default
   *      `'private'` → `(agent, record.id)` per RFC §4).
   *   2. The Hub Services facade attaches per (plugin, owner) and
   *      returns typed handles.
   *   3. Handles are sorted into a `ServiceCtx`: singular `memory`
   *      and `artifact` go on their named field; `datastore` entries
   *      group into a record keyed by `config.name` (with a fallback
   *      to `<impl>` when the plugin author forgot to name).
   *
   * Throws if `services` is absent but uses is declared, or any
   * single attach fails — the agent spawn aborts loudly. The caller
   * (`start(record)` / `start()` loop) catches and logs without
   * killing the whole pool.
   */
  private async attachServicesIfDeclared(
    record: AgentRecord,
  ): Promise<{ ctx?: ServiceCtx; owner?: Owner }> {
    const uses = record.managed?.uses
    if (!uses || uses.length === 0) return {}
    if (!this.services) {
      throw new Error(
        `agent '${record.id}' declares uses[] but Hub Services failed to bootstrap on this host — check earlier 'services:' log lines`,
      )
    }
    // Owner derivation is per-entry: an agent COULD theoretically
    // declare a private-scope memory and a workflow-scope datastore.
    // But the LocalAgentPool only spawns at host boot (no live
    // workflow run id available), so workflow scope on a managed
    // agent doesn't make sense yet — we accept the spec but file
    // everything under `(agent, id)` for now and revisit in MVP-2
    // (workflow-driven agents).
    const owner: Owner = { kind: 'agent', id: record.id }
    const specs: AttachSpec[] = uses.map((u) => buildAttachSpec(u, owner))
    const live = await this.services.attachAll(specs)

    const ctx = buildCtx(live)
    return { ctx, owner }
  }

  /**
   * Collect every key source the host has wired up and let
   * {@link selectLlmApiKey} pick the first hit. `mock` short-circuits;
   * `openai-compatible` short-circuits after the per-agent check (every
   * baseURL is a different vendor — DeepSeek vs. Qwen vs. Zhipu — so a
   * generic workspace/org-pool key for the umbrella tag wouldn't
   * disambiguate). The spawn step throws a clear error when no source
   * yields a key.
   */
  private async resolveApiKey(
    agentId: ParticipantId,
    provider: ManagedAgentSpec['provider'],
  ): Promise<LlmApiKeyResolution | undefined> {
    if (provider === 'mock') return undefined
    const perAgent = await this.space.getAgentApiKey(agentId).catch(() => null)
    // openai-compatible: skip workspace + env sources outright (vendor
    // ambiguity), but org-pool may still hold a vendor-specific row.
    const workspace =
      provider === 'openai-compatible'
        ? null
        : await this.space.getProviderApiKey(provider).catch(() => null)
    const env =
      provider === 'anthropic'
        ? process.env.ANTHROPIC_API_KEY ?? null
        : provider === 'openai'
          ? process.env.OPENAI_API_KEY ?? null
          : null
    return selectLlmApiKey({
      provider,
      perAgent,
      orgPool: this.orgApiPool ?? null,
      workspace,
      env,
    })
  }

  /**
   * Phase 6 #2 — build the onAuthFailure closure used by the spawn
   * pipeline. Returns `undefined` when no remediation is possible (key
   * didn't come from the vault, identity isn't wired, or provider is
   * mock). The closure performs three side-effects, ordered so
   * partial failure is recoverable:
   *
   *   1. revokeVaultEntry — soft-delete (sets revoked_at). Idempotent:
   *      a second 401 from the same dead key just no-ops.
   *   2. invalidate the OrgApiPool cache — next resolveLlmKey call
   *      re-reads from vault, sees activeOnly filter skipping the
   *      revoked row, picks another active entry or returns null.
   *   3. writeAuditLog — owner sees the revocation event in the audit
   *      tab. Failure here is non-fatal; the revoke + cache flush are
   *      the substantive changes.
   *
   * Tied to source.kind === 'org-pool' on purpose: per-agent /
   * workspace / env keys are operator-managed; auto-revoking them
   * would silently hide config drift. The audit log of repeated task
   * failures is the right signal for those tiers (operator rotates
   * the key by hand once they look at it).
   *
   * Exported visibility is package-internal (no JS module export);
   * tests reach in via the class instance — see
   * `local-agent-pool-auth-failure.test.ts`.
   */
  buildAuthFailureHook(
    record: AgentRecord,
    resolution: LlmApiKeyResolution | undefined,
  ): ((err: unknown, _task: Task) => void) | undefined {
    if (!record.managed) return undefined
    if (record.managed.provider === 'mock') return undefined
    if (!resolution || resolution.source.kind !== 'org-pool') return undefined
    if (!this.identity || !this.orgApiPool) return undefined
    const vaultEntryId = resolution.source.vaultEntryId
    const identityRef = this.identity
    const orgPoolRef = this.orgApiPool
    const providerName = record.managed.provider
    const agentId = record.id
    return (err) => {
      // Audit #146 — previously we always fell through to invalidate +
      // audit success:true regardless of whether revoke worked. If the
      // SQLite write threw (BUSY, schema mismatch, transient lock) the
      // entry stayed alive but audit recorded "revoked" — a perfect
      // recipe for a death-loop where the next dispatch hits the same
      // bad key, 401s again, and writes another bogus success row.
      //
      // Now: revoke success is required before we touch the cache or
      // write audit. On failure we log + bail; the next 401 will retry,
      // and the audit log honestly reflects only successful revokes.
      // Audit #157 — N concurrent in-flight LLM calls can all 401 on
      // the same dead key, firing the hook N times. The revoke itself
      // is idempotent (returns `false` on the 2nd+ call), and we use
      // that return to dedup the AUDIT write: only the call that
      // actually flipped revoked_at writes the row. The cache
      // invalidate is also idempotent (the row is gone from the next
      // resolve regardless) and cheap, so we still call it for every
      // 401 to guarantee no stale cache entry survives.
      let revokedThisCall = false
      try {
        revokedThisCall = identityRef.revokeVaultEntry(vaultEntryId) === true
      } catch (e) {
        log.error('auth-failure revoke failed; will retry on next 401', {
          vaultEntryId,
          err: e,
        })
        return
      }
      orgPoolRef.invalidate()
      if (!revokedThisCall) {
        // Already-revoked path: revoke + invalidate are idempotent
        // no-ops; skip audit to avoid N rows for a single revocation.
        return
      }
      if (typeof identityRef.writeAuditLog === 'function') {
        try {
          identityRef.writeAuditLog({
            action: AUDIT_ACTIONS.VAULT_REVOKE,
            actorSource: 'system',
            metadata: {
              reason: 'llm_auth_failure',
              provider: providerName,
              agent: agentId,
              vaultEntryId,
              // Audit #147 — never write raw err.message: provider SDKs
              // routinely interpolate `Authorization: Bearer sk-...`,
              // proxy URLs with `user:pass`, request body fragments, or
              // upstream debug strings into the message. Owners with
              // audit-read can see this row; treating it as untrusted
              // protects the very secret we're trying to revoke.
              //
              // What we keep: a class/name fingerprint (enough to spot
              // "always AuthenticationError vs sometimes RateLimitError"
              // patterns) and the numeric status when present. Both are
              // structural — no caller-supplied strings.
              errorClass: classifyAuthError(err),
              errorStatus: extractStatus(err),
            },
            success: true,
          })
        } catch (e) {
          log.error('auth-failure audit write failed', { vaultEntryId, err: e })
        }
      }
      log.warn('llm auth failure — vault entry revoked', {
        agent: agentId,
        provider: providerName,
        vaultEntryId,
      })
    }
  }
}

/**
 * Audit #147 — extract a non-sensitive class fingerprint from an LLM
 * provider error. Returns the constructor name + the `name` property
 * when distinct; never the message.
 */
function classifyAuthError(err: unknown): string {
  if (!err || typeof err !== 'object') return typeof err
  const e = err as { name?: unknown; constructor?: { name?: unknown } }
  const ctor = typeof e.constructor?.name === 'string' ? e.constructor.name : ''
  const nm = typeof e.name === 'string' ? e.name : ''
  if (ctor && nm && ctor !== nm) return `${ctor}:${nm}`
  return ctor || nm || 'unknown'
}

/**
 * Audit #147 — pull the HTTP status off the provider error when present.
 * OpenAI / Anthropic SDKs expose this as `err.status: number`. Returns
 * undefined when not present (e.g. transport-level errors).
 */
function extractStatus(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined
  const s = (err as { status?: unknown }).status
  return typeof s === 'number' ? s : undefined
}

/**
 * Pure key-selection logic. Exported for unit-testability so we don't
 * need to boot a full LocalAgentPool just to assert the order. Callers
 * gather every source up-front (Space lookups + env reads + the org
 * pool reference) and this function picks the first non-empty hit.
 *
 * Priority (B1.2):
 *   1. per-agent override
 *   2. org pool (v4 vault, ownerKind='org' llm_provider row)
 *   3. workspace default (v3 Space-stored per-provider key)
 *   4. host env (ANTHROPIC_API_KEY / OPENAI_API_KEY)
 *
 * Special cases:
 *   - `mock`: returns undefined unconditionally — no provider needs a
 *     key for the mock backend.
 *   - `openai-compatible`: only per-agent is considered for the workspace
 *     and env tiers (callers should pass `workspace=null` and `env=null`
 *     for this provider). The org pool tier is still consulted because
 *     a vault row with `metadata.provider='openai-compatible'` is a
 *     legitimate way to scope a vendor-specific key org-wide.
 *
 * @internal
 */
export function selectLlmApiKey(args: {
  provider: ManagedAgentSpec['provider']
  perAgent: string | null
  orgPool: OrgApiPool | null
  workspace: string | null
  env: string | null
}): LlmApiKeyResolution | undefined {
  if (args.provider === 'mock') return undefined
  if (args.perAgent) {
    return { apiKey: args.perAgent, source: { kind: 'per-agent' } }
  }
  if (args.orgPool) {
    const hit = args.orgPool.resolveLlmKey(args.provider)
    if (hit) {
      return {
        apiKey: hit.apiKey,
        source: { kind: 'org-pool', vaultEntryId: hit.entryId },
      }
    }
  }
  if (args.workspace) {
    return { apiKey: args.workspace, source: { kind: 'workspace' } }
  }
  if (args.env) {
    return { apiKey: args.env, source: { kind: 'env' } }
  }
  return undefined
}

/**
 * Translate one `ServiceUseSpec` from yaml into the `AttachSpec` shape
 * the `HubServices.attachAll` API expects. The differences are
 * organisational:
 *
 *   - the yaml-side spec is a plain JSON record; the attach-side spec
 *     is the same plus a fully-derived Owner;
 *   - the yaml-side spec calls the data blob `config`; the attach side
 *     keeps that name verbatim — the plugin only ever sees its own
 *     opaque config.
 *
 * Per-entry scope override lives inside `config.scope` (RFC §6). The
 * default `'private'` Owner is already passed in; this function only
 * overrides when the yaml asks for `'workflow'` or `'shared:<group>'`.
 */
function buildAttachSpec(use: ServiceUseSpec, defaultOwner: Owner): AttachSpec {
  let owner = defaultOwner
  const scope = (use.config?.scope as Scope | undefined)
  if (scope && scope !== 'private') {
    // Workflow scope requires a runId we don't have at managed-agent
    // boot — leave it to a future MVP-2 workflow integration. We
    // resolve to the default Owner today rather than throw, so a
    // yaml that previews a future feature still imports cleanly.
    if (scope.startsWith('shared:')) {
      const groupId = scope.slice('shared:'.length)
      if (groupId) {
        owner = resolveOwner(scope, { groupId })
      }
    }
    // 'workflow' scope on a managed agent is a no-op today; we log
    // once at attach time so admin can grep for it.
    if (scope === 'workflow') {
      log.warn('uses.config.scope=workflow on managed agent — falling back to private', {
        agent: defaultOwner.id,
        type: use.type,
        impl: use.impl,
      })
    }
  }
  return {
    type: use.type,
    impl: use.impl,
    owner,
    config: use.config ?? {},
  }
}

/**
 * Group attached handles into a `ServiceCtx` for the LlmAgent
 * constructor. The mapping is:
 *
 *   - memory   → singular ctx.memory     (last attach wins; in
 *                practice the yaml parser already rejects duplicate
 *                memory entries so "last" == "only")
 *   - artifact → singular ctx.artifact   (same as above)
 *   - datastore → record keyed by config.name; falls back to
 *                `<impl>` when name absent
 *   - other (third-party type strings) → `ctx.extra[type]` so the
 *                agent can cast on the use site
 */
function buildCtx(
  live: ReadonlyArray<{ type: string; impl: string; handle: unknown; owner: Owner }>,
): ServiceCtx {
  const ctx: { memory?: MemoryHandle; artifact?: ArtifactHandle; datastore?: Record<string, DatastoreHandle>; extra?: Record<string, unknown> } = {}
  for (const h of live) {
    if (h.type === 'memory') {
      ctx.memory = h.handle as MemoryHandle
    } else if (h.type === 'artifact') {
      ctx.artifact = h.handle as ArtifactHandle
    } else if (h.type === 'datastore') {
      ctx.datastore ??= {}
      // Datastores key on `handle.name` — the plugin guarantees this
      // is the same string the yaml put under `config.name`, so two
      // databases declared as `cases` and `sessions` end up at those
      // exact keys on the ctx.
      const handle = h.handle as DatastoreHandle
      ctx.datastore[handle.name] = handle
    } else {
      ctx.extra ??= {}
      ctx.extra[h.type] = h.handle
    }
  }
  return ctx
}

/**
 * Map a persisted `ManagedAgentSpec` to a concrete `LlmProvider`,
 * passing the resolved API key. Failure modes are intentionally noisy.
 */
function buildProvider(spec: ManagedAgentSpec, apiKey: string | undefined): LlmProvider {
  switch (spec.provider) {
    case 'mock':
      // Deterministic echo — fine for demos and "is my agent alive?"
      // checks. Operators pick real providers for actual use.
      return new MockLlmProvider({
        reply: (req) => {
          const last = req.messages[req.messages.length - 1]
          return `[mock reply to: ${last?.content ?? '<empty>'}]`
        },
      })
    case 'anthropic': {
      if (!apiKey) {
        throw new Error(
          `provider 'anthropic' needs an API key — set one in the workspace settings, attach one to this agent, or set ANTHROPIC_API_KEY in the host environment`,
        )
      }
      return new AnthropicProvider({ apiKey })
    }
    case 'openai': {
      if (!apiKey) {
        throw new Error(
          `provider 'openai' needs an API key — set one in the workspace settings, attach one to this agent, or set OPENAI_API_KEY in the host environment`,
        )
      }
      return new OpenAIProvider({ apiKey })
    }
    case 'openai-compatible': {
      // Two hard requirements at spawn time. We fail loudly with a
      // message that names the offending agent field so the admin UI
      // can surface it verbatim.
      if (!spec.baseURL) {
        throw new Error(
          `provider 'openai-compatible' needs a baseURL — point it at an OpenAI-compatible /v1/chat/completions endpoint (e.g. https://api.deepseek.com/v1)`,
        )
      }
      if (!apiKey) {
        throw new Error(
          `provider 'openai-compatible' needs a private API key set on this agent (workspace-level keys don't apply — each baseURL is a different vendor)`,
        )
      }
      // Derive a readable provider name: explicit label wins, then
      // baseURL host, then a generic fallback. Never blows up on a
      // malformed URL — the SDK call will fail with a clearer message.
      let name = spec.providerLabel?.trim()
      if (!name) {
        try { name = new URL(spec.baseURL).host } catch { name = 'openai-compatible' }
      }
      return new OpenAIProvider({
        apiKey,
        baseURL: spec.baseURL,
        name,
        // Almost every OpenAI-compatible vendor (DeepSeek, Qwen, Zhipu,
        // Moonshot, Ollama, vLLM, …) speaks the legacy `max_tokens`
        // shape, not the newer `max_completion_tokens` OpenAI reasoning
        // models require. Default to legacy here.
        maxTokensField: 'max_tokens',
      })
    }
    default: {
      const exhaustive: never = spec.provider
      throw new Error(`unknown provider: ${exhaustive as string}`)
    }
  }
}

/**
 * Build an `McpToolset` from the yaml-level `mcpServers:` declaration.
 *
 * Two transformations happen here vs. raw `McpServerConfig`:
 *
 *   1. **`${ENV_VAR}` expansion in env values** — credentials stay in
 *      the host's environment rather than persisted plain-text in
 *      `agents.json`. A missing var expands to an empty string and
 *      the spawn proceeds; the MCP server itself will fail loudly if
 *      it actually needed that variable (typical: `401 Unauthorized`
 *      bubbling up as a `server-stderr` line).
 *
 *   2. **Server stderr → host log forwarding** — auto-subscribe to
 *      `'server-stderr'` events and dump them to the structured
 *      logger so operators see Slack-MCP auth errors / Python
 *      stack traces in their normal log stream. The line carries
 *      the agent id + server name so multi-agent hosts can grep.
 */
function buildToolset(
  agentId: ParticipantId,
  servers: readonly McpServerSpec[],
): McpToolset {
  const configs: McpServerConfig[] = servers.map((s) => {
    const cfg: McpServerConfig = {
      name: s.name,
      command: s.command,
    }
    if (s.args) cfg.args = [...s.args]
    if (s.env) {
      cfg.env = expandEnvRefs(s.env, agentId, s.name)
    }
    if (s.cwd) cfg.cwd = s.cwd
    return cfg
  })
  const toolset = new McpToolset({ servers: configs })
  // Route MCP-server stderr into our structured logger. Operators
  // running `journalctl -u aipehub` get one unified stream.
  toolset.on('server-stderr', ({ serverName, line }) => {
    log.info('mcp server stderr', { agentId, serverName, line })
  })
  return toolset
}

/**
 * Expand `${ENV_VAR}` references in a `name → value` env map against
 * `process.env`. Unknown refs become empty strings (with a warning
 * log so the operator knows the spawn proceeded with a missing
 * credential). The case-sensitivity matches POSIX env var conventions.
 *
 * Exported only for unit tests — the production path always passes
 * `process.env` via the wrapper `buildToolset`.
 */
export function expandEnvRefs(
  raw: Record<string, string>,
  agentId: ParticipantId,
  serverName: string,
): Record<string, string> {
  const out: Record<string, string> = {}
  // ${NAME} — anchored to standard POSIX env-var name shape so a
  // literal "$5.99" in a value isn't mistaken for a reference.
  const REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g
  for (const [k, v] of Object.entries(raw)) {
    out[k] = v.replace(REF, (_match, name: string) => {
      const env = process.env[name]
      if (env === undefined) {
        log.warn('mcp env ref missing — expanded to empty string', {
          agentId,
          serverName,
          var: name,
        })
        return ''
      }
      return env
    })
  }
  return out
}
