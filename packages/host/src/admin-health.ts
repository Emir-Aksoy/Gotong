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
 * in `gotong doctor` (③), where the host is NOT yet bound.
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
  /**
   * EH-M1 配置进度计数 — 喂 overview 体检面板的「下一步建议」常驻引导, 补
   * #start-here 配完第一个 agent 就永久隐藏后留下的引导缺口。纯只读投影, 零
   * schema。host 只数数; 派生「建议配什么」的文案 + CTA 在前端 (i18n)。
   *
   * **可选 = 诚实的「未知」信号**: host 未注入 workflow controller (`countWorkflows`
   * 缺) 时字段整个缺席, 而非默认 0 — 否则前端分不清「真的 0 个工作流」和「host
   * 没接」, 会错误地建议「去建个工作流」。缺席 → 前端跳过工作流相关建议。
   */
  workflowCount?: number
  /** 其中可跑的 (published / live)。 */
  publishedWorkflowCount?: number
  /** 跑过的 run 总数 (active 集, archived 除外)。countRuns 未注入时缺席。 */
  runCount?: number
  /**
   * DEPLOY-B3 — 现在活着的 IM 桥 (platform + 凭证来源), 喂 admin 设置页的
   * 「IM 通道」状态块。与 workflowCount 同一「可选 = 诚实的未知」约定:
   * host 未注入 `imStatus` dep → 字段整个缺席 (前端隐藏该块), 注入了但列表
   * 空 → `[]` (真的没有通道, 前端显示「未配置」提示)。
   */
  imBridges?: HealthImRow[]
  /** ISO timestamp the snapshot was taken. */
  checkedAt: string
}

/** DEPLOY-B3 — one live IM bridge row (mirrors host ImBridgeStatusRow). */
export interface HealthImRow {
  platform: string
  /** 'env' | 'vault' — where the credential came from (换 token 该去哪). */
  source?: string
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
  /**
   * EH-M1 — 工作流计数 (总 + 可跑), 派生「下一步建议」。可选: absent → 计数 0,
   * 前端不显示工作流相关建议 (host 未接 workflow controller 的诚实降级)。
   */
  countWorkflows?(): Promise<{ total: number; published: number }>
  /** EH-M1 — 跑过的 run 总数 (active 集)。可选: absent → 0。 */
  countRuns?(): Promise<number>
  /**
   * DEPLOY-B3 — 现在活着的 IM 桥。可选: absent → snapshot 不含 imBridges
   * (host 未接 IM 子系统的诚实「未知」)。同步纯投影 (host 侧读内存数组)。
   */
  imStatus?(): HealthImRow[]
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

      // EH-M1 配置进度 — 仅当对应 dep 注入时才包含 (缺席 = 诚实的「未知」, 前端
      // 跳过工作流建议)。数数本身 best-effort: dep 在但抛错 → 当 0 (advisory, 不
      // 阻塞、不炸整张快照); dep 不在 → 字段整个 undefined。
      let workflowCounts: { total: number; published: number } | undefined
      if (deps.countWorkflows) {
        try {
          workflowCounts = await deps.countWorkflows()
        } catch {
          workflowCounts = { total: 0, published: 0 } // 数得失败但 dep 在 → 当「0 个」
        }
      }
      let runCount: number | undefined
      if (deps.countRuns) {
        try {
          runCount = await deps.countRuns()
        } catch {
          runCount = 0
        }
      }
      // DEPLOY-B3 — IM bridge rows, same best-effort contract: dep 在但抛错 →
      // 当「无通道」([]), dep 不在 → 字段整个缺席。
      let imRows: HealthImRow[] | undefined
      if (deps.imStatus) {
        try {
          imRows = deps.imStatus()
        } catch {
          imRows = []
        }
      }

      return {
        agents: rows,
        agentsMissingKey: rows.filter((r) => r.missingKey).length,
        managedCount: rows.length,
        onlineCount: rows.filter((r) => r.online).length,
        mcpServers,
        mcpUnwired: mcpServers.filter((s) => !s.wired).length,
        spaceWritable,
        spacePath: deps.spacePath,
        ...(workflowCounts
          ? {
              workflowCount: workflowCounts.total,
              publishedWorkflowCount: workflowCounts.published,
            }
          : {}),
        ...(runCount !== undefined ? { runCount } : {}),
        ...(imRows !== undefined ? { imBridges: imRows } : {}),
        checkedAt: new Date().toISOString(),
      }
    },
  }
}
