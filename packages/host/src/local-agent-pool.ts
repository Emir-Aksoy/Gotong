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

const log = createLogger('local-agents')

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
 *   2. workspace default for that provider (Space.getProviderApiKey)
 *   3. host environment (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY`)
 *   4. throw — and the spawn fails loudly so the admin sees an error
 *
 * API keys never appear on the wire after the initial POST that sets
 * them; the Space encrypts them at rest with AES-256-GCM and a master
 * key that lives outside any backup (`runtime/secret.key`, 0600).
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

  constructor(opts: { hub: Hub; space: Space; services?: HubServices }) {
    this.hub = opts.hub
    this.space = opts.space
    this.services = opts.services
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

    const apiKey = await this.resolveApiKey(record.id, record.managed.provider)
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
   * Walk the three sources of API keys in order and return the first
   * hit. `mock` never needs a key — return undefined and the provider
   * builder will skip the check.
   *
   * `openai-compatible` short-circuits to per-agent only: every baseURL
   * is a different vendor (DeepSeek vs. Qwen vs. Zhipu), so a single
   * workspace-level `openai-compatible` key wouldn't make sense. The
   * spawn step throws a clear error if the per-agent key is missing.
   */
  private async resolveApiKey(
    agentId: ParticipantId,
    provider: ManagedAgentSpec['provider'],
  ): Promise<string | undefined> {
    if (provider === 'mock') return undefined
    const perAgent = await this.space.getAgentApiKey(agentId).catch(() => null)
    if (perAgent) return perAgent
    // openai-compatible has no workspace / env fallback — see comment above.
    if (provider === 'openai-compatible') return undefined
    const workspace = await this.space.getProviderApiKey(provider).catch(() => null)
    if (workspace) return workspace
    if (provider === 'anthropic') return process.env.ANTHROPIC_API_KEY
    if (provider === 'openai')    return process.env.OPENAI_API_KEY
    return undefined
  }
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
