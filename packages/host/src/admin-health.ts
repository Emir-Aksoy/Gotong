/**
 * ❷-M1 — read-only "hub 体检" (health-check) aggregation for the admin overview
 * panel. One snapshot that answers "where is my hub red right now?" without the
 * admin hunting across the agents / MCP / setup tabs.
 *
 * Design (plan D2): every signal here is a **zero-cost STATIC check** — no LLM
 * ping, no network round-trip. The expensive "is this provider actually
 * reachable" probe stays a per-agent MANUAL button in ②-M2 (reuses the existing
 * 测试连接 route), because a personal user on a metered DeepSeek/MiMo key does not
 * want the panel silently spending tokens on every open.
 *
 * What it aggregates:
 *   - managed LLM agents whose API key does NOT resolve (the headline signal —
 *     reuses the pool's spawn-time resolution chain so it never disagrees with
 *     whether the agent will actually start);
 *   - configured MCP servers that no agent references yet ("installed but
 *     unused" — the kbSlotsToWire intuition generalized to the resident roster);
 *   - whether the host can still WRITE to its space dir (a cheap fs early-warning
 *     for disk-full / permission-drift that would otherwise only surface when a
 *     write fails mid-task).
 *
 * Deliberately NOT included: a runtime web-port probe. Post-boot the host is
 * itself listening on that port, so the probe would always report "in use" and
 * scare the admin about a non-problem. The genuine pre-flight port check lives
 * in `aipehub doctor` (③), where the host is NOT yet bound.
 *
 * The aggregation lives host-side (it already has `space.agents()`, the key
 * probe, the MCP registry, and the space path) and is injected into `serveWeb`
 * as a duck-typed `AdminHealthSurface` — web stays a thin requireAdmin → echo,
 * zero host runtime dependency.
 */

import { access, constants as FS } from 'node:fs/promises'

/** One managed LLM agent's at-a-glance health. */
export interface HealthAgentRow {
  id: string
  provider: string
  /**
   * true = a managed LLM agent whose API key does not currently resolve.
   * Fail-OPEN: a probe fault counts as "fine" (false) — the panel is advisory,
   * it must never cry wolf over a transient lookup error.
   */
  missingKey: boolean
  /** true = currently registered as a live participant on the hub. */
  online: boolean
}

/** One configured hub MCP server's wiring health. */
export interface HealthMcpRow {
  name: string
  /** true = referenced by at least one managed agent's `useMcpServers`. */
  wired: boolean
}

/** The full read-only health snapshot echoed to the admin overview panel. */
export interface HealthSnapshot {
  agents: HealthAgentRow[]
  /** Convenience count for the panel header badge. */
  agentsMissingKey: number
  /** Total managed LLM agents (the denominator for the header). */
  managedCount: number
  /** Managed LLM agents currently online. */
  onlineCount: number
  mcpServers: HealthMcpRow[]
  /** MCP servers configured but referenced by no agent (yellow signal). */
  mcpUnwired: number
  /** Filesystem early-warning: can the host still write to its space dir? */
  spaceWritable: boolean
  /** The space directory path (shown next to the writability signal). */
  spacePath: string
  /** ISO timestamp the snapshot was taken. */
  checkedAt: string
}

/** Narrow view of an agent record — only the fields the snapshot reads. */
export interface HealthAgentLike {
  id: string
  managed?: {
    kind?: string
    provider?: string
    useMcpServers?: readonly string[]
  }
}

/** Narrow view of an MCP server record — only `spec.name`. */
export interface HealthMcpLike {
  spec: { name: string }
}

/**
 * Injected dependencies. All are thin host-side accessors the host already
 * has wired (mirrors `meAgents.listForMembers` / `llmKeyProbe` / `mcpRegistry`).
 * `probeWritable` is injectable so tests don't touch a real fs.
 */
export interface AdminHealthDeps {
  /** All persisted agent records (managed + plain). */
  listAgents(): Promise<readonly HealthAgentLike[]>
  /** Live participant ids (for the online flag). */
  liveIds(): Set<string>
  /** Reuse the pool's spawn-time key resolution (fail-open by contract). */
  resolvesKey(id: string, provider: string): Promise<boolean>
  /** Configured hub MCP servers. */
  listMcpServers(): Promise<readonly HealthMcpLike[]>
  /** Absolute space directory; probed for writability. */
  spacePath: string
  /** Injected for tests; defaults to a real `fs.access(W_OK)` check. */
  probeWritable?(path: string): Promise<boolean>
}

/** The duck-typed surface injected into `serveWeb`. */
export interface AdminHealthSurface {
  snapshot(): Promise<HealthSnapshot>
}

/** Default writability probe: a real `W_OK` access check, fault → not writable. */
async function realProbeWritable(path: string): Promise<boolean> {
  try {
    await access(path, FS.W_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Build the read-only health service. Pure aggregation over injected accessors —
 * no side effects, safe to call on every panel open.
 */
export function createAdminHealthService(deps: AdminHealthDeps): AdminHealthSurface {
  const probeWritable = deps.probeWritable ?? realProbeWritable
  return {
    async snapshot(): Promise<HealthSnapshot> {
      const agents = await deps.listAgents()
      const live = deps.liveIds()

      // Only managed LLM agents have a provider + key to check. Plain
      // participants (remote sidecars, IM bridges) carry no host-resolvable key.
      const managed = agents.filter((a) => a.managed?.kind === 'llm')

      const rows: HealthAgentRow[] = []
      for (const a of managed) {
        const provider = a.managed?.provider ?? 'unknown'
        // hasResolvableLlmKey is fail-OPEN (fault → true). missingKey is its
        // negation, so a fault → missingKey=false → the panel stays quiet.
        let resolved = true
        try {
          resolved = await deps.resolvesKey(a.id, provider)
        } catch {
          // advisory: a probe fault is "looks fine", never a false alarm.
          resolved = true
        }
        rows.push({
          id: a.id,
          provider,
          missingKey: !resolved,
          online: live.has(a.id),
        })
      }

      // "configured but unused" — an MCP server no agent's useMcpServers names.
      const referenced = new Set<string>()
      for (const a of managed) {
        for (const name of a.managed?.useMcpServers ?? []) referenced.add(name)
      }
      const servers = await deps.listMcpServers()
      const mcpServers: HealthMcpRow[] = servers.map((s) => ({
        name: s.spec.name,
        wired: referenced.has(s.spec.name),
      }))

      const spaceWritable = await probeWritable(deps.spacePath)

      return {
        agents: rows,
        agentsMissingKey: rows.filter((r) => r.missingKey).length,
        managedCount: rows.length,
        onlineCount: rows.filter((r) => r.online).length,
        mcpServers,
        mcpUnwired: mcpServers.filter((s) => !s.wired).length,
        spaceWritable,
        spacePath: deps.spacePath,
        checkedAt: new Date().toISOString(),
      }
    },
  }
}
