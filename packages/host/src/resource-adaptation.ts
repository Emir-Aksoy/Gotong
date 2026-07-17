/**
 * resource-adaptation.ts — RES-M2: turn a resource inventory + the hub's agents
 * into a list of ADAPTATION PROPOSALS. A proposal is pure data describing a
 * change that would let a loaded agent actually run on THIS machine's resources
 * (use the local Ollama, switch to a provider that already has a key, …).
 *
 * ── The human-approval invariant (the whole RES point) ───────────────────────
 * `proposeAdaptations` is a PURE FUNCTION with ZERO side effects — it never
 * writes an agent, sets an env var, or wires an MCP server. Proposals are
 * suggestions a human reviews. RES-M3 is the ONLY place a proposal turns into a
 * write, and only on an explicit per-item operator apply. Probing (RES-M1) and
 * proposing (here) are strictly read-only; nothing is ever silently changed.
 *
 * ── `applicable` splits the two kinds of proposal ────────────────────────────
 *   applicable: true  — RES-M3 can enact it via the existing agent-update write
 *                       path (rewrite the agent's provider/baseURL). Reusing the
 *                       agent PUT means validation + audit + reconcile all apply.
 *   applicable: false — advisory only: the fix is a HUMAN action outside the hub
 *                       (set a host env var, point a KB slot at an MCP server).
 *                       The panel shows it as guidance; there's no apply button.
 *
 * Deterministic + zero-LLM: same inputs → same proposals, in a stable order. The
 * engine reasons purely over the inventory booleans and the agents' declared
 * providers — it never resolves or reads a key value.
 */

import type { ResourceInventory } from './resource-inventory.js'

/**
 * Providers that map 1:1 to a native managed-agent provider literal, so a
 * switch can be enacted by just setting `provider` (the key resolves from
 * env / workspace / vault, no baseURL needed). Inventory tags outside this set
 * (e.g. `deepseek`) are openai-compatible providers whose baseURL the inventory
 * doesn't carry — a switch to them is advisory (the operator must fill baseURL).
 */
const NATIVE_MANAGED_PROVIDERS = new Set(['anthropic', 'openai'])

/** The minimal agent shape the engine reasons over — id + declared provider. */
export interface AdaptAgentLike {
  id: string
  provider: string
  /**
   * Optional — true when THIS agent's own key chain already resolves (per-agent
   * stored key / apiKeyEnv / owner vault …). The inventory only knows
   * provider-LEVEL existence (env / vault), which an openai-compatible agent's
   * key never shows up in (it can ONLY be per-agent) — without this bit a
   * healthy compat agent with a stored key reads as keyless and draws rewrite
   * proposals. Callers that can't probe omit it (undefined = fall back to the
   * inventory-level judgment); the service fills it via its injected probe.
   */
  hasResolvableKey?: boolean
}

/** A template KB slot that wasn't auto-wired (name + optional referenced server). */
export interface AdaptKbSlot {
  name: string
  useMcpServer?: string
}

export interface ProposeAdaptationsInput {
  inventory: ResourceInventory
  agents: readonly AdaptAgentLike[]
  /** Optional — only the template-import path carries KB slots. */
  kbSlots?: readonly AdaptKbSlot[]
}

interface AdaptBase {
  /** Stable deterministic id — the token RES-M3 apply references. */
  id: string
  /** Short zh human-readable title for the panel row. */
  title: string
  /** zh explanation of what this proposal would do. */
  detail: string
  /**
   * true = RES-M3 can apply it via an agent update; false = advisory (the fix is
   * a human action outside the hub). The apply route rejects `applicable:false`.
   */
  applicable: boolean
}

/** Rewire a keyless agent to a reachable local model server (no key needed). */
export interface AdaptUseLocalEndpoint extends AdaptBase {
  kind: 'use_local_endpoint'
  agentId: string
  fromProvider: string
  endpointLabel: string
  /** The OpenAI-compatible base URL derived from the probed endpoint (a suggestion). */
  suggestedBaseURL: string
  applicable: true
}

/**
 * Switch a keyless agent to a provider that already has a resolvable key.
 * `applicable` is true only when `toProvider` is a native managed literal
 * (anthropic/openai) — a switch to an openai-compatible provider needs a
 * baseURL the inventory can't supply, so it's advisory (see NATIVE_MANAGED_PROVIDERS).
 */
export interface AdaptSwitchProvider extends AdaptBase {
  kind: 'switch_provider'
  agentId: string
  fromProvider: string
  toProvider: string
  keySource: 'env' | 'vault'
  applicable: boolean
}

/** Advisory: the agent's provider needs an env-var key that isn't set. */
export interface AdaptSetEnvKey extends AdaptBase {
  kind: 'set_env_key'
  agentId: string
  provider: string
  envVar: string
  applicable: false
}

/** Advisory: a KB slot references an installed MCP server that could serve it. */
export interface AdaptWireMcpServer extends AdaptBase {
  kind: 'wire_mcp_server'
  slotName: string
  candidateServer: string
  applicable: false
}

export type AdaptationProposal =
  | AdaptUseLocalEndpoint
  | AdaptSwitchProvider
  | AdaptSetEnvKey
  | AdaptWireMcpServer

/** Provider-LEVEL key existence per the inventory (env / vault booleans only). */
function providerHasInventoryKey(inventory: ResourceInventory, provider: string): boolean {
  const r = inventory.llmKeys.find((k) => k.provider === provider)
  return !!r && (r.envSet || r.vaultConfigured)
}

/** Derive an OpenAI-compatible base URL from a probed endpoint URL (origin + /v1). */
function suggestedBaseUrl(probeUrl: string): string {
  try {
    return new URL(probeUrl).origin + '/v1'
  } catch {
    return probeUrl
  }
}

/**
 * The pure proposal engine. No side effects, deterministic, zero-LLM. For each
 * agent whose declared provider has NO resolvable key it emits the available
 * adaptation options (local endpoint / switch provider / advisory set-env), and
 * for each unwired KB slot naming an installed server, a wiring suggestion.
 */
export function proposeAdaptations(input: ProposeAdaptationsInput): AdaptationProposal[] {
  const { inventory, agents, kbSlots } = input
  const out: AdaptationProposal[] = []

  // provider → its key-availability row (existence booleans only, no values).
  const keyRow = new Map(inventory.llmKeys.map((r) => [r.provider, r]))
  const hasKey = (provider: string): boolean => providerHasInventoryKey(inventory, provider)
  // providers that DO have a key, alphabetical (llmKeys is already sorted).
  const providersWithKey = inventory.llmKeys.filter((r) => r.envSet || r.vaultConfigured)
  // reachable local endpoints, stable order by label.
  const reachable = inventory.localEndpoints
    .filter((e) => e.reachable)
    .slice()
    .sort((a, b) => a.label.localeCompare(b.label))

  for (const agent of agents) {
    // `mock` needs no key; a provider that already resolves is fine — no proposal.
    if (agent.provider === 'mock') continue
    // A per-agent key the provider-level inventory can't see (stored key /
    // apiKeyEnv / owner vault) — the caller probed it; keyed → no proposal.
    if (agent.hasResolvableKey === true) continue
    // An explicit probe verdict OVERRIDES the provider-level view: MR-M6
    // apiKeyEnv is exclusive, so an agent bound to a missing env var is
    // keyless even when its provider has a workspace key. Only an unprobed
    // agent falls back to the inventory row.
    if (agent.hasResolvableKey === undefined && hasKey(agent.provider)) continue

    // Option A — point it at a running local model server (one per reachable one).
    for (const ep of reachable) {
      out.push({
        kind: 'use_local_endpoint',
        id: `adapt:use_local_endpoint:${agent.id}:${ep.label}`,
        agentId: agent.id,
        fromProvider: agent.provider,
        endpointLabel: ep.label,
        suggestedBaseURL: suggestedBaseUrl(ep.url),
        applicable: true,
        title: `让「${agent.id}」改用本地 ${ep.label}`,
        detail: `${agent.id} 声明的 provider「${agent.provider}」当前没有可用密钥，但本机 ${ep.label} 在运行。可改成 openai-compatible 指向 ${suggestedBaseUrl(ep.url)}，无需密钥即可跑。`,
      })
    }

    // Option B — switch to the first provider that already has a key. Only
    // native providers (anthropic/openai) are one-click applicable; a switch to
    // an openai-compatible provider needs a baseURL we don't have → advisory.
    const alt = providersWithKey.find((r) => r.provider !== agent.provider)
    if (alt) {
      const native = NATIVE_MANAGED_PROVIDERS.has(alt.provider)
      out.push({
        kind: 'switch_provider',
        id: `adapt:switch_provider:${agent.id}:${alt.provider}`,
        agentId: agent.id,
        fromProvider: agent.provider,
        toProvider: alt.provider,
        keySource: alt.envSet ? 'env' : 'vault',
        applicable: native,
        title: `把「${agent.id}」切到已配好密钥的 ${alt.provider}`,
        detail: native
          ? `${agent.id} 的 provider「${agent.provider}」没有密钥，而「${alt.provider}」已配好（${alt.envSet ? '环境变量' : 'vault'}）。可一键切过去直接用。`
          : `${agent.id} 的 provider「${agent.provider}」没有密钥，而「${alt.provider}」已配好（${alt.envSet ? '环境变量' : 'vault'}）。它是 openai-compatible 提供方，需要你手动填 baseURL 后编辑该 agent，不能一键切换。`,
      })
    }

    // Option C — advisory: the provider has a conventional env var; set it.
    const row = keyRow.get(agent.provider)
    if (row?.envVar) {
      out.push({
        kind: 'set_env_key',
        id: `adapt:set_env_key:${agent.id}`,
        agentId: agent.id,
        provider: agent.provider,
        envVar: row.envVar,
        applicable: false,
        title: `为「${agent.id}」配置 ${row.envVar}`,
        detail: `给 provider「${agent.provider}」设置环境变量 ${row.envVar}（或在 vault 里加一条凭证），然后重启。这一步需要你在 hub 之外操作，不能由这里代改。`,
      })
    }
  }

  // KB slots — advisory: a slot referencing an INSTALLED server could be wired.
  if (kbSlots && kbSlots.length > 0) {
    const installed = new Set(inventory.mcpServers.map((s) => s.name))
    for (const slot of kbSlots) {
      if (slot.useMcpServer && installed.has(slot.useMcpServer)) {
        out.push({
          kind: 'wire_mcp_server',
          id: `adapt:wire_mcp:${slot.name}:${slot.useMcpServer}`,
          slotName: slot.name,
          candidateServer: slot.useMcpServer,
          applicable: false,
          title: `知识库槽位「${slot.name}」可接已装的 ${slot.useMcpServer}`,
          detail: `模板的知识库槽位「${slot.name}」引用了 MCP server「${slot.useMcpServer}」，而它已经装在本 hub 上。把用它的 agent 的 useMcpServers 指过去即可接通（模板导入按设计不自动接线）。`,
        })
      }
    }
  }

  return out
}

/** Reuse the RES-M1 inventory surface to feed the pure engine. */
export interface ResourceAdaptationDeps {
  inventory(): Promise<ResourceInventory>
  /**
   * Optional per-agent key probe — `LocalAgentPool.hasResolvableLlmKey` fits
   * (the same duck-typed probe the web `LlmKeyProbe` rides). It answers with
   * the SAME resolution chain spawn uses, so proposals can never disagree with
   * whether the agent actually starts. Fail-open by contract: a probe fault
   * reads as "has a key" — a rewrite proposal must never rest on bad data.
   * Absent → inventory-level judgment only (previous behavior).
   */
  resolvesKey?(agentId: string, provider: string): Promise<boolean>
}

/** The duck-typed surface injected into `serveWeb`. */
export interface ResourceAdaptationSurface {
  propose(input: {
    agents: readonly AdaptAgentLike[]
    kbSlots?: readonly AdaptKbSlot[]
  }): Promise<AdaptationProposal[]>
}

/**
 * Build the adaptation service: fetch a fresh inventory, then run the pure
 * engine over the caller-supplied agents/KB slots. No side effects. When a
 * per-agent key probe is wired, agents the inventory reads as keyless are
 * probed first (concurrently) so a per-agent stored key / apiKeyEnv suppresses
 * proposals the same way a provider-level key does.
 */
export function createResourceAdaptationService(
  deps: ResourceAdaptationDeps,
): ResourceAdaptationSurface {
  return {
    async propose({ agents, kbSlots }) {
      const inventory = await deps.inventory()
      const probe = deps.resolvesKey
      let enriched: readonly AdaptAgentLike[] = agents
      if (probe) {
        enriched = await Promise.all(
          agents.map(async (a) => {
            // Probe every non-mock agent: the per-agent chain (apiKeyEnv is
            // EXCLUSIVE per MR-M6) can be keyless even when the provider-level
            // inventory shows a workspace key, so an inventory hit must not
            // suppress the probe. Probe failure stays fail-open (treated as
            // keyed) — a rewrite proposal is never built on broken data.
            if (a.provider === 'mock' || a.hasResolvableKey !== undefined) return a
            const hasResolvableKey = await probe(a.id, a.provider).catch(() => true)
            return { ...a, hasResolvableKey }
          }),
        )
      }
      return proposeAdaptations({ inventory, agents: enriched, ...(kbSlots ? { kbSlots } : {}) })
    },
  }
}
