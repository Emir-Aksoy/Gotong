/**
 * personal-butler-diagnose.ts — Track A BE-M2. The resident butler's BENIGN
 * "check my agents for problems" eye, plus the honest boundary on what it can
 * FIX itself.
 *
 * A member asks their butler "我的助手有没有问题?" and it runs the SAME
 * deterministic, zero-LLM RES-M2 proposal engine (`proposeAdaptations`) the admin
 * 资源适配 panel uses — but over THIS member's OWNED agents only (scoped via
 * `listOwned(userId)`, so no-leak). It returns a plain-language diagnosis.
 *
 * ── The fix path REUSES the existing governed action; it invents nothing ─────
 * The butler does NOT get a new write verb. For a proposal it can enact, it tells
 * the butler (in the tool result) the exact EXISTING governed action to call:
 * `edit_agent { agentId, changes: { provider } }`. That tool already parks →
 * `/me` inbox → approve → real change (BF-M7). So diagnose is a READ; the write is
 * the same approval-gated `edit_agent` a member could drive by hand.
 *
 * ── Why only `switch_provider`→native is butler-enactable ────────────────────
 * The butler is "structurally incapable of exceeding what the member could do by
 * hand." A member CANNOT wire an `openai-compatible` + baseURL agent in `/me`
 * (`MEMBER_PROVIDERS` excludes it — that's operator infra), and the steward action
 * vocabulary (`StewardAgentFields.provider`) is native-only + secret-free by
 * design. So `use_local_endpoint` (needs openai-compatible + baseURL) and the
 * advisory kinds (`set_env_key` / `wire_mcp_server`) are surfaced as DIAGNOSIS but
 * NOT enacted by the butler — it points the member at the admin 资源适配 panel,
 * where a human (operator) applies them. The ONLY butler-enactable fix is a
 * `switch_provider` to a provider that already has a key AND is a native managed
 * literal (anthropic/openai) — exactly what `edit_agent`'s `changes.provider`
 * accepts. See the BE-M2 boundary decision.
 *
 * Host-only: it needs a per-user owned-agent lister (`HostMeAgentService.listOwned`)
 * + the RES adaptation service (`createResourceAdaptationService`), injected as
 * narrow duck-typed surfaces. Per-user — the router builds one per `origin.userId`.
 */

import type {
  LlmAgentToolset,
  LlmToolCallResult,
  LlmToolDefinition,
} from '@aipehub/llm'

import type { AdaptationProposal } from './resource-adaptation.js'

/** One owned agent the engine reasons over — id + its declared provider. */
export interface ButlerOwnedAgent {
  id: string
  provider: string
}

/** Lists the agents THIS member owns. `HostMeAgentService.listOwned` fits. */
export interface ButlerOwnedAgentSource {
  listOwned(userId: string): Promise<ButlerOwnedAgent[]>
}

/** Runs the pure RES-M2 engine over caller-supplied agents. `ResourceAdaptationSurface` fits. */
export interface ButlerAdaptationSource {
  propose(input: { agents: readonly ButlerOwnedAgent[] }): Promise<AdaptationProposal[]>
}

export interface ButlerDiagnoseDeps {
  /** The member this butler serves — diagnosis is scoped to their owned agents. */
  userId: string
  ownedAgents?: ButlerOwnedAgentSource
  adaptation?: ButlerAdaptationSource
  logger?: { error: (msg: string, meta?: Record<string, unknown>) => void }
}

// ---------------------------------------------------------------------------
// Classification — the ONE place that decides butler-enactable vs advisory.
// ---------------------------------------------------------------------------

/**
 * A proposal is butler-enactable ONLY when it's a provider switch to a
 * key-having NATIVE provider (`applicable` is true exactly then — RES-M2 sets it
 * to match `NATIVE_MANAGED_PROVIDERS`). Everything else is advisory: the fix is
 * operator infra (openai-compatible baseURL / env var / MCP wiring) a member
 * can't do by hand, so the butler mustn't either.
 */
function enactableProvider(p: AdaptationProposal): string | null {
  if (p.kind === 'switch_provider' && p.applicable === true) return p.toProvider
  return null
}

/** The plain-language "what to do next" line for a proposal. */
function actionHint(p: AdaptationProposal): string {
  switch (p.kind) {
    case 'switch_provider':
      return p.applicable
        ? `我可以帮你改:用 edit_agent 把「${p.agentId}」的 provider 切到已配好密钥的「${p.toProvider}」，会先送 /me 让你点批准，再真正改。`
        : // applicable:false → an openai-compatible target that needs a baseURL.
          `「${p.toProvider}」已配好密钥，但它是 openai 兼容提供方，需要先填 baseURL(管理员操作），我不能一键切。`
    case 'use_local_endpoint':
      return `本机「${p.endpointLabel}」在跑，可让「${p.agentId}」改用它(无需密钥）。但接本地端点要填 baseURL，属于管理员操作——去 admin『资源适配』面板点「应用」，或让管理员帮你改。我这里改不了。`
    case 'set_env_key':
      return `给 provider「${p.provider}」配好环境变量 ${p.envVar}(或在 vault 加一条凭证），然后重启。这步在 hub 之外，我改不了。`
    case 'wire_mcp_server':
      return `知识库槽位「${p.slotName}」可接已装的「${p.candidateServer}」——把用它的 agent 的 useMcpServers 指过去即可。建议在 admin 面板做。`
  }
}

const DIAGNOSE_TOOL: LlmToolDefinition = {
  name: 'diagnose_my_agents',
  description:
    '给这个成员自己拥有的助手做体检:哪些声明的 provider 没有可用密钥、能怎么修。用来回答「我的助手是不是坏了 / 为什么用不了」。这是只读诊断——真要改某个助手，得用 edit_agent(会先送 /me 批准）；有些修法(接本地端点/配环境变量）要管理员在面板里做，我只会告诉你怎么弄。',
  inputSchema: {
    type: 'object',
    properties: {
      agentId: { type: 'string', description: '只体检某一个助手(可选，完整 id）。' },
    },
    additionalProperties: false,
  },
}

class ButlerDiagnoseToolset implements LlmAgentToolset {
  constructor(private readonly deps: ButlerDiagnoseDeps) {}

  listTools(): LlmToolDefinition[] {
    // Needs BOTH surfaces to do anything useful.
    return this.deps.ownedAgents && this.deps.adaptation ? [DIAGNOSE_TOOL] : []
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<LlmToolCallResult> {
    if (name !== 'diagnose_my_agents') return text(`未知工具:${name}`, true)
    const { ownedAgents, adaptation, userId } = this.deps
    if (!ownedAgents || !adaptation) return text('体检功能未接线。', true)

    let owned: ButlerOwnedAgent[]
    try {
      owned = await ownedAgents.listOwned(userId)
    } catch (err) {
      this.deps.logger?.error('butler diagnose: listOwned failed', { err })
      return text('暂时读不到你的助手列表，稍后再试。', true)
    }

    const focus = typeof args.agentId === 'string' ? args.agentId : undefined
    // Feed the engine only agents with a declared provider; focus filters to one.
    const agents = owned
      .filter((a) => a.provider && (!focus || a.id === focus))
      .map((a) => ({ id: a.id, provider: a.provider }))

    if (agents.length === 0) {
      return text(focus ? `没找到你拥有的助手「${focus}」。` : '你名下还没有可体检的助手。')
    }

    let proposals: AdaptationProposal[]
    try {
      proposals = await adaptation.propose({ agents })
    } catch (err) {
      // Fail closed: report the read failed rather than imply "all healthy".
      this.deps.logger?.error('butler diagnose: propose failed', { err })
      return text('体检暂时跑不了，稍后再试。', true)
    }

    if (proposals.length === 0) {
      return text(
        focus
          ? `助手「${focus}」看起来正常，没发现需要适配的地方。`
          : '你的助手都能正常用，没发现需要适配的地方(provider 都有可用密钥）。',
      )
    }

    const enactable = proposals.filter((p) => enactableProvider(p) !== null).length
    const lines = proposals.map((p) => `• ${p.title}\n  ${p.detail}\n  → ${actionHint(p)}`)
    const head =
      enactable > 0
        ? `体检发现 ${proposals.length} 处可以改进，其中 ${enactable} 处我能帮你改(要你在 /me 批准）:`
        : `体检发现 ${proposals.length} 处可以改进，都需要你或管理员手动处理:`
    return text(`${head}\n${lines.join('\n')}`)
  }
}

function text(t: string, isError = false): LlmToolCallResult {
  return isError ? { content: [{ type: 'text', text: t }], isError: true } : { content: [{ type: 'text', text: t }] }
}

/**
 * Build the per-user benign "diagnose my agents" toolset for a resident butler.
 * Add it to the butler's `benign` set. Returns a toolset that offers no tools
 * (so it's invisible) when either surface is absent.
 */
export function buildButlerDiagnoseToolset(deps: ButlerDiagnoseDeps): LlmAgentToolset {
  return new ButlerDiagnoseToolset(deps)
}
