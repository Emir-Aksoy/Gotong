import type {
  AgentRecord,
  Hub,
  ManagedAgentLifecycle,
  ManagedAgentSpec,
  ParticipantId,
  Space,
} from '@aipehub/core'
import { LlmAgent, MockLlmProvider, type LlmProvider } from '@aipehub/llm'
import { AnthropicProvider } from '@aipehub/llm-anthropic'
import { OpenAIProvider } from '@aipehub/llm-openai'

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
  private readonly running = new Map<ParticipantId, LlmAgent>()

  constructor(opts: { hub: Hub; space: Space }) {
    this.hub = opts.hub
    this.space = opts.space
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
          console.error(
            `[local-agents] failed to spawn '${a.id}':`,
            err instanceof Error ? err.message : err,
          )
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
   */
  async stop(id: ParticipantId): Promise<void> {
    const live = this.running.get(id)
    if (live) this.running.delete(id)
    if (this.hub.participant(id)) this.hub.unregister(id)
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

  /** Stop every managed agent — called by host shutdown. */
  async stopAll(): Promise<void> {
    for (const id of [...this.running.keys()]) {
      await this.stop(id).catch((err) =>
        console.error(`[local-agents] stop ${id} failed:`, err),
      )
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
    if (this.hub.participant(record.id)) this.hub.unregister(record.id)
    this.running.delete(record.id)

    const apiKey = await this.resolveApiKey(record.id, record.managed.provider)
    const provider = buildProvider(record.managed, apiKey)
    const agent = new LlmAgent({
      id: record.id,
      capabilities: record.allowedCapabilities,
      provider,
      system: record.managed.system,
      model: record.managed.model,
    })
    this.hub.register(agent)
    this.running.set(record.id, agent)
    console.log(`[local-agents] spawned ${record.id} (provider=${record.managed.provider})`)
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
