/**
 * personal-butler-observe.ts — the resident butler's BENIGN "eyes" (Track A
 * BE-M1). Three read-only tools that let a member ask their butler, in plain
 * language, what's going on with THEIR corner of the hub:
 *
 *   - `list_my_runs`   — "我昨天的工作流跑成了吗?" → this member's recent runs
 *                        (status + scrubbed failure reason).
 *   - `list_my_agents` — "我有哪些 AI 助手?" → the sanitized helper roster.
 *   - `my_usage`       — "我这段时间用了多少?" → this member's LLM call / token /
 *                        cost roll-up.
 *
 * ── Why these are benign (run inline, never park) ────────────────────────────
 * Every one is a READ the member can already do by clicking around `/me`
 * (recent-runs panel, "my AI helpers", usage). Reading your own run status /
 * the shared helper roster / your own bill consequences nobody else, so there's
 * no approval to gate — the butler just reports what the web surface would show.
 * The WRITE counterparts (fix an agent, create a workflow) stay governed.
 *
 * ── The no-leak boundary, mirrored from `/me` ────────────────────────────────
 * `list_my_runs` and `my_usage` are scoped to THIS member server-side:
 * `listRunsByUser` keys on the run's `triggeredByOrigin.userId`, and the usage
 * roll-up filters the ledger by `userId`. The butler is built per-user (the
 * router keys on `origin.userId`), so alice's butler is handed alice's id and
 * can never read bob's runs or bill. `list_my_agents` returns the hub-wide
 * helper roster, but through the SAME host sanitization `/api/me/agents` uses —
 * only `{id,label,capabilities,online}`, never a system prompt / model /
 * provider baseURL / per-agent key.
 *
 * Host-only: it needs the host's run surface (`WorkflowController.listRunsByUser`),
 * the sanitized agent projection, and the identity usage ledger. All three are
 * injected as narrow duck-typed surfaces so this file takes no wide dep and a
 * missing surface simply drops that one tool from `listTools()` (we never offer
 * a tool that can't fire).
 */

import type {
  LlmAgentToolset,
  LlmToolCallResult,
  LlmToolDefinition,
} from '@aipehub/llm'

// ---------------------------------------------------------------------------
// Narrow, duck-typed surfaces — each satisfied structurally by an existing host
// object (WorkflowController / the /me agent projection / IdentityStore ledger).
// ---------------------------------------------------------------------------

/** One run row — the member-facing projection (already secret-scrubbed). */
export interface ButlerRunView {
  runId: string
  workflowId: string
  status: string
  startedAt: number
  endedAt?: number
  /** Scrubbed failure reason for a failed run (host strips secrets at the seam). */
  error?: string
}

/** Recent runs the member kicked off. `WorkflowController.listRunsByUser` fits. */
export interface ButlerRunSurface {
  listRunsByUser(
    userId: string,
    opts?: { limit?: number; workflowId?: string },
  ): Promise<ButlerRunView[]>
}

/** Sanitized helper projection — mirror of `MeAgentView` (no prompt/key/config). */
export interface ButlerAgentView {
  id: string
  label: string
  capabilities: string[]
  online: boolean
}

/** The hub's sanitized agent roster. The host's `meAgents` projection fits. */
export interface ButlerAgentSurface {
  listForMembers(): Promise<ButlerAgentView[]>
}

/** One usage bucket — a subset of `LedgerAggregateRow`. */
export interface ButlerUsageRow {
  key: string
  calls: number
  inputTokens: number
  outputTokens: number
  costMicros: number
}

/** This member's usage roll-up (per model). `IdentityStore.aggregateLedger` fits. */
export interface ButlerUsageSurface {
  /** Aggregate this user's ledger, one row per model, biggest cost first. */
  aggregateForUser(userId: string): ButlerUsageRow[]
}

export interface ButlerObserveDeps {
  /** The member this butler serves — runs / usage are scoped to them. */
  userId: string
  runs?: ButlerRunSurface
  agents?: ButlerAgentSurface
  usage?: ButlerUsageSurface
  logger?: { error: (msg: string, meta?: Record<string, unknown>) => void }
}

// ---------------------------------------------------------------------------
// Pure formatting helpers.
// ---------------------------------------------------------------------------

/** Friendly Chinese label for a run status; unknown values pass through raw. */
const STATUS_LABEL: Record<string, string> = {
  running: '进行中',
  completed: '已完成',
  succeeded: '成功',
  failed: '失败',
  cancelled: '已取消',
  canceled: '已取消',
  suspended: '已挂起',
  waiting: '等待中',
}

function statusLabel(status: string): string {
  return STATUS_LABEL[status] ?? status
}

/** Epoch-ms → "YYYY-MM-DD HH:MM" (UTC), deterministic given the input. */
function fmtTime(ms: number): string {
  if (!Number.isFinite(ms)) return '?'
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ')
}

/** Integer micro-USD → "$0.0000" (4 dp keeps sub-cent LLM costs visible). */
function fmtCost(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(4)}`
}

const RUN_LIMIT = 10

// `satisfies` (not a `Record` annotation) keeps the exact keys, so each
// `OBSERVE_TOOLS.<name>` is a defined `LlmToolDefinition`, not `T | undefined`.
const OBSERVE_TOOLS = {
  list_my_runs: {
    name: 'list_my_runs',
    description:
      '看这个成员最近亲自发起的工作流运行(只看他自己的），带状态和失败原因。用来回答「我昨天那个流程跑成了吗 / 为什么失败」。',
    inputSchema: {
      type: 'object',
      properties: {
        workflowId: {
          type: 'string',
          description: '只看某一个工作流的运行(可选，工作流 id）。',
        },
      },
      additionalProperties: false,
    },
  },
  list_my_agents: {
    name: 'list_my_agents',
    description:
      '看这个 hub 里有哪些智能体(AI 助手）以及是否在线、能做什么。用来回答「我有哪些助手 / 谁能做 X」。只看得到名字和能力，看不到别人的提示词或密钥。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  my_usage: {
    name: 'my_usage',
    description:
      '看这个成员自己的用量(累计调用次数、token、花费，按模型分）。用来回答「我最近用了多少 / 花了多少钱」。只统计他本人的用量。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
} satisfies Record<string, LlmToolDefinition>

class ButlerObserveToolset implements LlmAgentToolset {
  constructor(private readonly deps: ButlerObserveDeps) {}

  listTools(): LlmToolDefinition[] {
    // Only offer a tool whose backing surface is actually wired.
    const out: LlmToolDefinition[] = []
    if (this.deps.runs) out.push(OBSERVE_TOOLS.list_my_runs)
    if (this.deps.agents) out.push(OBSERVE_TOOLS.list_my_agents)
    if (this.deps.usage) out.push(OBSERVE_TOOLS.my_usage)
    return out
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<LlmToolCallResult> {
    if (name === 'list_my_runs') return this.doRuns(args)
    if (name === 'list_my_agents') return this.doAgents()
    if (name === 'my_usage') return this.doUsage()
    return text(`未知工具:${name}`, true)
  }

  private async doRuns(args: Record<string, unknown>): Promise<LlmToolCallResult> {
    if (!this.deps.runs) return text('运行记录功能未接线。', true)
    const workflowId = typeof args.workflowId === 'string' ? args.workflowId : undefined
    let rows: ButlerRunView[]
    try {
      rows = await this.deps.runs.listRunsByUser(this.deps.userId, {
        limit: RUN_LIMIT,
        ...(workflowId ? { workflowId } : {}),
      })
    } catch (err) {
      // Fail closed: report the read failed rather than imply "no runs".
      this.deps.logger?.error('butler observe: listRunsByUser failed', { err })
      return text('暂时读不到你的运行记录，稍后再试。', true)
    }
    if (rows.length === 0) {
      return text(
        workflowId
          ? `工作流「${workflowId}」还没有你发起的运行记录。`
          : '你最近还没有发起过工作流运行。',
      )
    }
    const lines = rows.map((r) => {
      const when = fmtTime(r.startedAt)
      const st = statusLabel(r.status)
      const why = r.error ? ` — 原因:${r.error}` : ''
      return `• ${when} 「${r.workflowId}」${st}${why} [run: ${r.runId}]`
    })
    return text(`你最近的工作流运行(最新在前）:\n${lines.join('\n')}`)
  }

  private async doAgents(): Promise<LlmToolCallResult> {
    if (!this.deps.agents) return text('智能体目录功能未接线。', true)
    let agents: ButlerAgentView[]
    try {
      agents = await this.deps.agents.listForMembers()
    } catch (err) {
      this.deps.logger?.error('butler observe: listForMembers failed', { err })
      return text('暂时读不到助手列表，稍后再试。', true)
    }
    if (agents.length === 0) return text('这个 hub 里还没有配置智能体。')
    const lines = agents.map((a) => {
      const dot = a.online ? '在线' : '离线'
      const caps = a.capabilities.length > 0 ? ` — 能力:${a.capabilities.join('、')}` : ''
      return `• ${a.label}(${dot}）[id: ${a.id}]${caps}`
    })
    return text(`这个 hub 里的智能体:\n${lines.join('\n')}`)
  }

  private async doUsage(): Promise<LlmToolCallResult> {
    if (!this.deps.usage) return text('用量统计功能未接线。', true)
    let rows: ButlerUsageRow[]
    try {
      rows = this.deps.usage.aggregateForUser(this.deps.userId)
    } catch (err) {
      this.deps.logger?.error('butler observe: aggregateForUser failed', { err })
      return text('暂时读不到你的用量，稍后再试。', true)
    }
    if (rows.length === 0) return text('你还没有可统计的用量记录。')
    let calls = 0
    let inTok = 0
    let outTok = 0
    let cost = 0
    for (const r of rows) {
      calls += r.calls
      inTok += r.inputTokens
      outTok += r.outputTokens
      cost += r.costMicros
    }
    // rows already come cost-DESC; show the top few models as a breakdown.
    const top = rows.slice(0, 5).map((r) => {
      const model = r.key === '(none)' ? '(未标注模型)' : r.key
      return `  · ${model}:${r.calls} 次，${fmtCost(r.costMicros)}`
    })
    return text(
      [
        `你的累计用量(受账本保留期限影响）:`,
        `• 调用 ${calls} 次，输入 ${inTok} + 输出 ${outTok} tokens，合计 ${fmtCost(cost)}`,
        `• 按模型:`,
        ...top,
      ].join('\n'),
    )
  }
}

function text(t: string, isError = false): LlmToolCallResult {
  return isError ? { content: [{ type: 'text', text: t }], isError: true } : { content: [{ type: 'text', text: t }] }
}

/**
 * Build the per-user benign "observe my hub" toolset for a resident butler.
 * Add it to the butler's `benign` set. Tools whose surface is absent are simply
 * not listed (see `listTools`).
 */
export function buildButlerObserveToolset(deps: ButlerObserveDeps): LlmAgentToolset {
  return new ButlerObserveToolset(deps)
}
