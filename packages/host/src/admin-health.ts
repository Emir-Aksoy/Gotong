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

import type { HealthRoutingRow } from './routing-health.js'

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
  /**
   * FDE-M1b — declared connector slots of installed packs, with live
   * fulfilment. Same optional-dep contract: host 未注入 `listConnectorSlots`
   * → 字段整个缺席 (前端隐藏该块); 注入了但没人声明过槽位 → `[]`。
   */
  connectorSlots?: HealthConnectorSlotRow[]
  /**
   * CARE-M7 — LLM 断供的**当下事实**,喂 web 体检面板一条红信号(此前断供只在
   * IM 可见:CARE-M2 播报 + CARE-M6 巡检升级,web 运维看面板看不到「大脑挂了」)。
   * 三态同 imBridges 的「可选=诚实未知」约定:host 未注入 `readLlmOutage` →
   * 字段整个缺席(前端不显示);注入了但当前无断供 → `null`(体检过、正常);
   * 断供中 → 行(前端红条「断供约 N 分钟」)。与 CARE-M6 巡检读同一份
   * `runtime/llm-outage.json`,但**无阈值**:面板要当下真相,即时显示(巡检的
   * 30 分钟阈值只为不刷 IM,不是面板的事)。
   */
  llmOutage?: HealthLlmOutageRow | null
  /**
   * MR-M3 — per-provider routing health (degraded / circuit-open fallback
   * candidates), surfaced beyond CARE-M7's binary "brain out". A LIST, like
   * `connectorSlots`: field absent → host didn't wire routing health (no
   * agents route, or bare host); `[]` → wired, every candidate healthy; rows →
   * candidates a routed agent is currently failing over from. All rows render
   * YELLOW — a tripped breaker means the agent is still working on a backup,
   * not down (that's `llmOutage`). Minutes/cooldown fold in the panel.
   */
  routing?: HealthRoutingRow[]
  /**
   * Perf audit B② — a newer release exists (fed by the opt-in
   * GOTONG_UPDATE_CHECK probe). Tri-state like `llmOutage`: field absent →
   * probe not wired OR no successful probe yet (honest unknown — never
   * conflated with "up to date"); null → probed, running the latest; row →
   * newer available (panel renders an advisory yellow line; applying stays
   * a human running `gotong update`).
   */
  updateAvailable?: { current: string; latest: string } | null
  /** ISO timestamp the snapshot was taken. */
  checkedAt: string
}

/** DEPLOY-B3 — one live IM bridge row (mirrors host ImBridgeStatusRow). */
export interface HealthImRow {
  platform: string
  /** 'env' | 'vault' — where the credential came from (换 token 该去哪). */
  source?: string
}

/**
 * CARE-M7 — 断供当下事实的只读行。`kind` 是结构化病名码(auth/quota/network/
 * timeout/rate_limited/model_not_found),前端 i18n 映射成本地化文案;`since`
 * 是断供起点(epoch ms),前端对着 `checkedAt` 算「已断供多久」。故意不在这
 * 算分钟数:host 只出事实,呈现层(带语言)自己折。 */
export interface HealthLlmOutageRow {
  kind: string
  since: number
}

/**
 * FDE-M1b — one declared connector slot with its LIVE fulfilment verdict.
 * `filled` is computed here against the hub's actual MCP wiring (name-identity:
 * a hub-registry server OR an inline agent server named `id` exists), so the
 * row can never go stale — the file only stores the intent.
 */
export interface HealthConnectorSlotRow {
  /** The installed template that declared the need. */
  pack: string
  /** Slot name = the MCP server name that fulfils it. */
  id: string
  /**
   * true = the solution degrades gracefully unfilled. Display note: unfilled
   * slots are YELLOW either way (template intent is never host-verified fact,
   * so it can't escalate the panel to red); optional only tweaks the wording.
   */
  optional: boolean
  /** Installer-facing one-liner (what to hang, where to find backends). */
  hint?: string
  /** true = an MCP server with this name exists on the hub today. */
  filled: boolean
}

/** Narrow view of an agent record — only the fields the snapshot reads. */
export interface HealthAgentLike {
  id: string
  managed?: {
    kind?: string
    provider?: string
    useMcpServers?: readonly string[]
    /** FDE-M1b — inline MCP wiring; only the names matter for slot fulfilment. */
    mcpServers?: readonly { name: string }[]
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
  /**
   * FDE-M1b — 已装模板声明的连接器槽位 (host 从 template-connector-slots.json
   * 读回, 摊平成带 pack 的行)。可选: absent → snapshot 不含 connectorSlots。
   * fulfilment (filled) 由本服务对着 listAgents/listMcpServers 现算。
   */
  listConnectorSlots?(): Promise<
    readonly { pack: string; id: string; optional: boolean; hint?: string }[]
  >
  /**
   * CARE-M7 — 读断供状态文件(host 注入 `readOutageSnapshotFile(runtime/
   * llm-outage.json)`)。可选:absent → snapshot 不含 llmOutage(host 未接断供
   * 子系统的诚实「未知」);返回 null = 当前无断供。读盘的解析/损坏降级在
   * readOutageSnapshotFile 内(损坏当空),故这里的实现体不会抛。
   */
  readLlmOutage?(): Promise<{ kind: string; since: number } | null>
  /**
   * MR-M3 — read the in-memory routing-health projection (host injects
   * `() => routingHealthTracker.snapshot()`). Synchronous + pure (no disk, no
   * network). 可选:absent → snapshot 不含 routing(host 未接路由健康的诚实
   * 「未知」);注入了但一切正常 → `[]`。实现体不抛(纯读内存 Map)。
   */
  routingHealth?(): HealthRoutingRow[]
  /**
   * B② — read the version-check handle's in-memory answer (host injects
   * `() => versionCheck?.latest()`). Synchronous, no network — the probe
   * itself runs on its own daily timer. Returns undefined when the knob is
   * off or no probe has succeeded yet → field absent (honest unknown).
   */
  readUpdateAvailable?(): { current: string; latest: string } | null | undefined
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

      // FDE-M1b — declared connector slots + live fulfilment. Name-identity:
      // a slot is filled iff an MCP server named `slot.id` exists TODAY —
      // in the hub registry, or inline on any agent (managed check is not
      // limited to LLM agents: any record can carry MCP wiring). Deterministic
      // set-membership, zero heuristics — 半解析绝不猜 applies to fulfilment
      // too. Best-effort read: dep 在但抛错 → 当「没声明过」([]), dep 不在 →
      // 字段整个缺席。
      // CARE-M7 — 断供当下事实。同 best-effort 契约:dep 在但抛错 → 当「没断供」
      // (null,advisory 绝不因体检读盘失败误报红);dep 不在 → 字段整个缺席。
      // 三态:undefined(未接)/ null(接了·正常)/ 行(断供中)。
      let llmOutage: HealthLlmOutageRow | null | undefined
      if (deps.readLlmOutage) {
        try {
          llmOutage = await deps.readLlmOutage()
        } catch {
          llmOutage = null
        }
      }

      let slotRows: HealthConnectorSlotRow[] | undefined
      if (deps.listConnectorSlots) {
        let declared: readonly { pack: string; id: string; optional: boolean; hint?: string }[] =
          []
        try {
          declared = await deps.listConnectorSlots()
        } catch {
          declared = []
        }
        const present = new Set<string>(servers.map((s) => s.spec.name))
        for (const a of agents) {
          for (const s of a.managed?.mcpServers ?? []) present.add(s.name)
        }
        slotRows = declared.map((d) => ({
          pack: d.pack,
          id: d.id,
          optional: d.optional,
          ...(d.hint !== undefined ? { hint: d.hint } : {}),
          filled: present.has(d.id),
        }))
      }

      // MR-M3 — per-provider routing health. best-effort: a sink fault → [] (an
      // empty, honest "nothing degraded"), never blocks the rest of the panel.
      let routing: HealthRoutingRow[] | undefined
      if (deps.routingHealth) {
        try {
          routing = deps.routingHealth()
        } catch {
          routing = []
        }
      }

      // B② — new-version notice. On a dep fault degrade to ABSENT (unknown),
      // not null — null would claim "checked, up to date", which we don't know.
      let updateAvailable: { current: string; latest: string } | null | undefined
      if (deps.readUpdateAvailable) {
        try {
          updateAvailable = deps.readUpdateAvailable()
        } catch {
          updateAvailable = undefined
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
        ...(slotRows !== undefined ? { connectorSlots: slotRows } : {}),
        ...(llmOutage !== undefined ? { llmOutage } : {}),
        ...(routing !== undefined ? { routing } : {}),
        ...(updateAvailable !== undefined ? { updateAvailable } : {}),
        checkedAt: new Date().toISOString(),
      }
    },
  }
}
