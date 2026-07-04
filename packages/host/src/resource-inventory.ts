/**
 * resource-inventory.ts — RES-M1: a deterministic, READ-ONLY snapshot of the
 * local deployment's adaptable resources. It answers "what does this machine
 * already have that a loaded agent / workflow could be wired to?" so the RES-M2
 * proposal engine can suggest adaptations and a human can approve them.
 *
 * ── North-Star discipline ────────────────────────────────────────────────────
 *   - ZERO LLM. Every signal is a static file/env check or one cheap local
 *     endpoint probe. The framework never runs a model to inventory itself.
 *   - READ-ONLY. Nothing here writes, spawns a subprocess, or mutates config.
 *     PATH scanning is `existsSync` only (never exec `--version`); vault
 *     listing goes through `listVaultEntries` which by contract does NOT decrypt.
 *   - NO SECRET VALUES, EVER. Key families report EXISTENCE booleans only
 *     (env var set? vault entry present?). A plaintext key never enters this
 *     module's output — the whole point is it's safe to echo to the admin UI.
 *   - Best-effort per family (mirrors `admin-health.ts`): a fault in one probe
 *     family degrades that family to "empty / not-found", never throws. A
 *     resource inventory that crashes because Ollama's port hung would be worse
 *     than useless.
 *
 * ── The four families ────────────────────────────────────────────────────────
 *   llmKeys        — for each provider (well-known ∪ whatever the vault already
 *                    holds): is an env var set for it, and is a vault entry
 *                    configured for it? Existence only.
 *   localEndpoints — is a local OpenAI-compatible server (Ollama, …) actually
 *                    LISTENING right now? The ONE family that does I/O: a short,
 *                    injectable, fail-open GET against localhost. This is the
 *                    deliberate "probe" RES-M1 is named for — unlike the purely
 *                    static admin-health panel, detecting a running local model
 *                    server is precisely the adaptation signal we want.
 *   cliAgents      — are known coding-agent CLIs (claude / codex / …) present on
 *                    PATH? `existsSync` over PATH dirs, no subprocess.
 *   mcpServers     — which hub MCP servers are already installed? (RES-M2 matches
 *                    template KB slots against these.)
 *
 * Lives host-side (it has env, the vault provider list, the MCP registry, PATH)
 * and is injected into `serveWeb` as a duck-typed `ResourceInventorySurface` —
 * web stays a thin requireAdmin → echo, zero host runtime dependency, exactly
 * like `AdminHealthSurface`.
 */

import { existsSync } from 'node:fs'
import { join, delimiter } from 'node:path'

/**
 * One provider's key availability — EXISTENCE ONLY. `envSet` / `vaultConfigured`
 * are booleans; no plaintext key material is ever carried here.
 */
export interface ResLlmKeyRow {
  provider: string
  /** The well-known env var this provider's key would live in, if any. */
  envVar?: string
  /** true = that env var is set (non-empty). NEVER the value. */
  envSet: boolean
  /**
   * true = a vault `llm_provider` entry is configured for this provider. Comes
   * from `listVaultEntries` (does NOT decrypt) — existence, not the secret.
   */
  vaultConfigured: boolean
}

/** One local model-server endpoint's liveness. */
export interface ResLocalEndpointRow {
  label: string
  url: string
  /** true = something answered on that URL within the probe timeout. */
  reachable: boolean
}

/** One known coding-agent CLI's presence on PATH. */
export interface ResCliAgentRow {
  /** The executable name looked for on PATH. */
  command: string
  label: string
  /** true = found in at least one PATH dir (existsSync, no subprocess). */
  found: boolean
  /** The env var this CLI reads its own API key from, if it needs one. */
  apiKeyEnv?: string
  /** true = that env var is set (non-empty). Existence only. Absent when the CLI has no key env. */
  apiKeyEnvSet?: boolean
}

/** One installed hub MCP server (name only). */
export interface ResMcpServerRow {
  name: string
}

/** The full read-only resource snapshot echoed to the admin UI. */
export interface ResourceInventory {
  llmKeys: ResLlmKeyRow[]
  localEndpoints: ResLocalEndpointRow[]
  cliAgents: ResCliAgentRow[]
  mcpServers: ResMcpServerRow[]
  /** ISO timestamp the snapshot was taken. */
  checkedAt: string
}

/**
 * Injected dependencies. All optional with real defaults, so production wires a
 * few accessors and tests inject fakes for a fully hermetic snapshot (no fs, no
 * network, no real PATH).
 */
export interface ResourceInventoryDeps {
  /** Environment map. Default `process.env`. Read for env-var EXISTENCE only. */
  env?: Record<string, string | undefined>
  /**
   * Provider tags that have a vault entry (existence, no decrypt). The host
   * wires `OrgApiPool.listProviders()`. Absent → the vault side is all `false`.
   */
  listVaultProviders?(): string[] | Promise<string[]>
  /** Installed hub MCP servers. Host wires `space.mcpServers()`. */
  listMcpServers?(): Promise<readonly { spec: { name: string } }[]>
  /** Injectable for hermetic tests; default global `fetch`. */
  fetchImpl?: typeof fetch
  /** Per-endpoint probe timeout (ms). Default 800 — a local port is sub-ms when up. */
  probeTimeoutMs?: number
  /** PATH dirs to scan. Default: `env.PATH` split on the platform delimiter. */
  pathDirs?: string[]
  /** File-existence check. Default `fs.existsSync`. Injectable for tests. */
  exists?(p: string): boolean
  /**
   * Local endpoints to probe. Default: Ollama + anything in `GOTONG_RES_ENDPOINTS`
   * (comma-separated `label=url`). Pass `[]` to skip the network family entirely.
   */
  localEndpoints?: { label: string; url: string }[]
}

/** The duck-typed surface injected into `serveWeb`. */
export interface ResourceInventorySurface {
  inventory(): Promise<ResourceInventory>
}

/**
 * Well-known provider → its conventional API-key env var. Providers NOT here
 * (e.g. an openai-compatible vendor like MiMo/DeepSeek behind a custom env) still
 * surface via the vault provider list — they just carry no `envVar` guess.
 */
const WELL_KNOWN_LLM_ENV: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
}

/**
 * Known coding-agent CLIs. Baked in (host can't import the `coding-agent-bridge`
 * example's `CLI_PRESETS`) but kept in lockstep with it. `apiKeyEnv` is the var
 * the CLI reads ITS OWN key from — some (opencode/aider/goose) manage their own
 * auth and need none from us.
 */
const KNOWN_CLI_AGENTS: readonly { command: string; label: string; apiKeyEnv?: string }[] = [
  { command: 'claude', label: 'Claude Code', apiKeyEnv: 'ANTHROPIC_API_KEY' },
  { command: 'codex', label: 'OpenAI Codex', apiKeyEnv: 'OPENAI_API_KEY' },
  { command: 'opencode', label: 'OpenCode (sst)' },
  { command: 'aider', label: 'Aider' },
  { command: 'goose', label: 'Goose' },
]

/** Ollama's default list endpoint — a GET that answers 200 when the server is up. */
const DEFAULT_LOCAL_ENDPOINTS: readonly { label: string; url: string }[] = [
  { label: 'Ollama', url: 'http://127.0.0.1:11434/api/tags' },
]

/** true iff `v` is a non-empty (trimmed) string — the EXISTENCE test for env vars. */
function isSet(v: string | undefined): boolean {
  return typeof v === 'string' && v.trim().length > 0
}

/**
 * Parse the `GOTONG_RES_ENDPOINTS` extension: comma-separated `label=url` pairs.
 * Malformed entries are skipped silently (advisory config, never a boot blocker).
 */
function parseEndpointEnv(raw: string | undefined): { label: string; url: string }[] {
  if (!isSet(raw)) return []
  const out: { label: string; url: string }[] = []
  for (const chunk of raw!.split(',')) {
    const eq = chunk.indexOf('=')
    if (eq <= 0) continue
    const label = chunk.slice(0, eq).trim()
    const url = chunk.slice(eq + 1).trim()
    if (label && url) out.push({ label, url })
  }
  return out
}

/**
 * Probe ONE endpoint: a GET with a short abort timeout. "Reachable" = we got any
 * HTTP response (even a 404 means something is listening); only a network error
 * or timeout counts as unreachable. Fail-open: never throws.
 */
async function probeEndpoint(
  ep: { label: string; url: string },
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<ResLocalEndpointRow> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    await fetchImpl(ep.url, { method: 'GET', signal: controller.signal })
    return { label: ep.label, url: ep.url, reachable: true }
  } catch {
    // network refused / DNS / timeout → not listening. Advisory only.
    return { label: ep.label, url: ep.url, reachable: false }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Build the read-only resource inventory service. Pure read aggregation over
 * injected accessors + one local probe family — safe to call on every panel open
 * (the sole I/O is a bounded localhost GET, no tokens spent).
 */
export function createResourceInventoryService(
  deps: ResourceInventoryDeps = {},
): ResourceInventorySurface {
  const env = deps.env ?? process.env
  const exists = deps.exists ?? existsSync
  const fetchImpl = deps.fetchImpl ?? fetch
  const probeTimeoutMs = deps.probeTimeoutMs ?? 800
  const pathDirs = deps.pathDirs ?? (env.PATH ?? '').split(delimiter).filter(Boolean)
  const endpoints =
    deps.localEndpoints ?? [...DEFAULT_LOCAL_ENDPOINTS, ...parseEndpointEnv(env.GOTONG_RES_ENDPOINTS)]

  return {
    async inventory(): Promise<ResourceInventory> {
      // ── llmKeys: env existence ∪ vault existence, no secret values ──────────
      let llmKeys: ResLlmKeyRow[] = []
      try {
        let vaultProviders: string[] = []
        if (deps.listVaultProviders) {
          try {
            vaultProviders = await deps.listVaultProviders()
          } catch {
            vaultProviders = [] // advisory: vault probe fault → "none configured"
          }
        }
        const vaultSet = new Set(vaultProviders)
        // The union: well-known providers we can guess an env var for, PLUS any
        // provider the vault already holds (so a MiMo/DeepSeek row shows up even
        // when it isn't in WELL_KNOWN_LLM_ENV).
        const providers = new Set<string>([...Object.keys(WELL_KNOWN_LLM_ENV), ...vaultSet])
        llmKeys = Array.from(providers)
          .sort()
          .map((provider) => {
            const envVar = WELL_KNOWN_LLM_ENV[provider]
            return {
              provider,
              ...(envVar ? { envVar } : {}),
              envSet: envVar ? isSet(env[envVar]) : false,
              vaultConfigured: vaultSet.has(provider),
            }
          })
      } catch {
        llmKeys = []
      }

      // ── localEndpoints: bounded, fail-open liveness probes ──────────────────
      let localEndpoints: ResLocalEndpointRow[] = []
      try {
        localEndpoints = await Promise.all(
          endpoints.map((ep) => probeEndpoint(ep, fetchImpl, probeTimeoutMs)),
        )
      } catch {
        localEndpoints = []
      }

      // ── cliAgents: PATH existsSync, no subprocess ───────────────────────────
      let cliAgents: ResCliAgentRow[] = []
      try {
        cliAgents = KNOWN_CLI_AGENTS.map((cli) => {
          let found = false
          try {
            found = pathDirs.some((dir) => exists(join(dir, cli.command)))
          } catch {
            found = false
          }
          return {
            command: cli.command,
            label: cli.label,
            found,
            ...(cli.apiKeyEnv
              ? { apiKeyEnv: cli.apiKeyEnv, apiKeyEnvSet: isSet(env[cli.apiKeyEnv]) }
              : {}),
          }
        })
      } catch {
        cliAgents = []
      }

      // ── mcpServers: installed hub servers (name only) ───────────────────────
      let mcpServers: ResMcpServerRow[] = []
      try {
        if (deps.listMcpServers) {
          const servers = await deps.listMcpServers()
          mcpServers = servers.map((s) => ({ name: s.spec.name }))
        }
      } catch {
        mcpServers = []
      }

      return {
        llmKeys,
        localEndpoints,
        cliAgents,
        mcpServers,
        checkedAt: new Date().toISOString(),
      }
    },
  }
}
