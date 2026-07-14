/**
 * personal-butler-llms.ts — LSA-M1. The resident butler's BENIGN self-awareness
 * of its OWN model chain: "阿同你现在能调用哪些大模型".
 *
 * The butler can see runs / helpers / peers (BE-M1, NET-M1) but is blind to the
 * models it itself routes over — a member asking "你用的什么模型 / 有没有备用 /
 * 是不是哪个挂了" gets an improvised answer. This toolset is the read-only
 * projection that grounds it, joining the pool's candidate chain (config) with
 * the RoutingHealthTracker's live per-candidate health (runtime).
 *
 * ── Read-only, sanitized ─────────────────────────────────────────────────────
 * The sanitize red line (mirrors list_peers): the API KEY and full baseURL NEVER
 * enter the projection — a member should see WHICH provider/model backs their
 * butler and whether it's healthy, not the operator's credentials. The label is
 * `routingLabel`'s provider-type/host base (already what the routing-health panel
 * shows), never the key. Enforced structurally: ButlerLlmRow has no key field,
 * and the renderer only reads the fields it knows.
 *
 * ── Why this is the floor for the whole LSA track ────────────────────────────
 * Discovering more (free) providers (M3) and using several at once (M4) both
 * start from the butler being able to SEE what it has — you can't ask "should I
 * add a fallback?" until you know you have none. M1 is that eye.
 */

import type { LlmAgentToolset, LlmToolCallResult, LlmToolDefinition } from '@gotong/llm'

/** One routing candidate in the butler's chain, projected member-safe (no key/baseURL). */
export interface ButlerLlmCandidate {
  /** 0 = primary, ≥1 = fallback (routing order). */
  index: number
  role: 'primary' | 'fallback'
  /** Provider-type label (anthropic / deepseek / openai-compatible:host) — NEVER the key. */
  label: string
  /** Model id, or null when the provider default is used. */
  model: string | null
}

/** The butler's candidate chain + the agentId health is keyed by. */
export interface ButlerLlmChain {
  agentId: string
  candidates: ButlerLlmCandidate[]
}

/** One candidate's live health, overlaid from the routing-health snapshot. */
export type ButlerLlmHealth = 'healthy' | 'degraded' | 'open' | 'half_open'

/** A projected row = config candidate + health overlay. */
export interface ButlerLlmRow extends ButlerLlmCandidate {
  health: ButlerLlmHealth
  /** Structured error kind when degraded/open (auth/quota/network/…). */
  errorKind?: string
}

/** The roster the toolset reads. */
export interface ButlerLlmSurface {
  listForButler(): Promise<ButlerLlmRow[]>
}

/**
 * The two narrow host inputs the surface joins — duck-typed slices of the pool's
 * `butlerLlmRoster()` (config chain) and `RoutingHealthTracker.snapshot()` (live
 * health), so the module needs no host import and unit tests need no real pool.
 */
export interface ButlerLlmSurfaceDeps {
  /** The butler's candidate chain (config). Null when no butler-enabled row exists. */
  roster: () => Promise<ButlerLlmChain | null>
  /** Live UNHEALTHY candidates across all agents; filtered to the butler's agentId here. */
  health: () => Array<{ agentId: string; index: number; state: 'open' | 'half_open' | 'degraded'; errorKind?: string }>
}

/**
 * Join the config candidate chain with the live health overlay. `snapshot()`
 * surfaces ONLY degraded candidates (health is a signal, not a dump), so any
 * candidate absent from it is healthy. Filtered to the butler's own agentId so a
 * flaky OTHER agent never colors the butler's self-report.
 */
export function buildButlerLlmSurface(deps: ButlerLlmSurfaceDeps): ButlerLlmSurface {
  return {
    async listForButler() {
      const chain = await deps.roster()
      if (!chain) return []
      const bad = new Map<number, { state: ButlerLlmHealth; errorKind?: string }>()
      for (const h of deps.health()) {
        if (h.agentId !== chain.agentId) continue
        bad.set(h.index, { state: h.state, ...(h.errorKind ? { errorKind: h.errorKind } : {}) })
      }
      return chain.candidates.map((c) => {
        const h = bad.get(c.index)
        return { ...c, health: h?.state ?? 'healthy', ...(h?.errorKind ? { errorKind: h.errorKind } : {}) }
      })
    },
  }
}

const LIST_TOOL: LlmToolDefinition = {
  name: 'list_my_llms',
  description:
    '看你(阿同)自己现在能调用哪些大模型:主模型 + 备用链(按路由顺序)、各自的 provider 和模型名、哪个健康哪个降级。成员问「你用的什么模型」「有没有备用」「是不是哪个挂了」时先用它,别猜。',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
}

export interface ButlerLlmsDeps {
  llms: ButlerLlmSurface
  logger?: { error: (msg: string, meta?: Record<string, unknown>) => void }
}

class ButlerLlmsToolset implements LlmAgentToolset {
  constructor(private readonly deps: ButlerLlmsDeps) {}

  listTools(): LlmToolDefinition[] {
    return [LIST_TOOL]
  }

  async callTool(name: string): Promise<LlmToolCallResult> {
    if (name !== 'list_my_llms') return text(`未知工具:${name}`, true)
    let rows: ButlerLlmRow[]
    try {
      rows = await this.deps.llms.listForButler()
    } catch (err) {
      this.deps.logger?.error('butler llms: list failed', { err })
      return text('暂时读不到自己的模型配置,稍后再试。', true)
    }
    if (rows.length === 0) return text('读不到我当前挂的模型(可能托管模型还没配置好)。')
    const lines = rows.map((r) => {
      const who = r.role === 'primary' ? '主模型' : `备用 ${r.index}`
      const model = r.model ? `${r.label}(${r.model})` : r.label
      return `- ${who}:${model} — ${healthLine(r)}`
    })
    // A single-provider butler has no failover: say so plainly (this is the honest
    // hook into LSA-M3 — you can't want a fallback until you know you have none).
    const chainNote =
      rows.length === 1
        ? '\n\n只有 1 个模型 — 没有备用,它一挂我就没退路。想更稳可以加个备用(不同 provider),我会在它挂时自动切过去。'
        : ''
    return text(`我现在能调用这些模型(按路由顺序,首选在最上):\n${lines.join('\n')}${chainNote}`)
  }
}

/** Render a candidate's health with its real routing semantics — never invent a state. */
function healthLine(r: ButlerLlmRow): string {
  if (r.health === 'healthy') return '健康'
  const kind = r.errorKind ? errorKindZh(r.errorKind) : '有故障'
  if (r.health === 'open') return `暂时熔断(${kind}) — 正在快速跳过它、稍后自动重试`
  if (r.health === 'half_open') return `恢复探测中(${kind})`
  return `刚出过错(${kind}),已降级`
}

/** Map the structured LLM error kind to a short Chinese label (best-effort; unknown → 原样). */
function errorKindZh(kind: string): string {
  switch (kind) {
    case 'auth':
      return '鉴权失败'
    case 'quota':
      return '配额耗尽'
    case 'rate_limited':
      return '被限流'
    case 'network':
      return '网络不通'
    case 'timeout':
      return '超时'
    case 'model_not_found':
      return '模型不存在'
    case 'server':
      return '服务端错误'
    default:
      return kind
  }
}

function text(t: string, isError = false): LlmToolCallResult {
  return isError
    ? { content: [{ type: 'text', text: t }], isError: true }
    : { content: [{ type: 'text', text: t }] }
}

/**
 * Build the benign model-self-awareness eye. Add to the butler's `benign` set;
 * the factory drops it when the roster surface is absent (pool not wired).
 */
export function buildButlerLlmsToolset(deps: ButlerLlmsDeps): LlmAgentToolset {
  return new ButlerLlmsToolset(deps)
}
