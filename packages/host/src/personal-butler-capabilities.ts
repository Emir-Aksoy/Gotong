/**
 * B1 能力发现 / help — a benign `list_my_capabilities` tool that answers "你能帮
 * 我做什么" with a list DERIVED FROM THE TOOLSETS ACTUALLY WIRED for THIS member's
 * butler, so it can never promise something it can't do.
 *
 * # Why derive, not hard-code
 *
 * A butler's verb set depends on flags + which host surfaces exist (governed on?
 * proactive on? workflows published? peers meshed? an MCP connector attached?).
 * A static "here's what I do" blurb would lie the moment a capability is off. So
 * the factory hands this tool a lazy getter over the FINAL composed benign +
 * governed tool names; the card lists only the catalog entries whose signal tool
 * is present. A capability with no live tool is simply omitted — under-reporting
 * is the safe failure; over-promising can't happen.
 *
 * # Boundaries
 *
 * Benign (same class as `set_reminder` — describing your own butler touches
 * nobody else), always offered. Zero LLM (pure catalog render over a name set),
 * no state, no new env knob. Member-facing OUTPUT (not a hidden 系统注入 card),
 * so it reads as friendly prose the member can act on — no emoji (project
 * convention), just dashed lines keyed to real, live verbs.
 */

import type { LlmAgentToolset, LlmToolCallResult, LlmToolDefinition } from '@gotong/llm'

/** The `<server>__<tool>` namespacing `McpToolset` uses (see personal-butler-mcp). */
const MCP_NAME_SEP = '__'

/**
 * One member-facing capability, lit only when a `signal` tool is live. Ordered
 * roughly by how often a personal user reaches for it. Governed verbs say so
 * ("需你确认") — honest about the /me approval gate they park behind.
 */
interface CapabilityEntry {
  /** Any-of tool names whose presence means this capability is wired. */
  signals: readonly string[]
  /** The dashed line shown to the member. */
  line: string
}

const CATALOG: readonly CapabilityEntry[] = [
  { signals: ['set_reminder'], line: '- 定时提醒 —— 「明天早上 8 点提醒我交周报」' },
  {
    signals: ['open_task_note', 'list_task_notes'],
    line: '- 多步任务盯办 —— 「记一下装修这三件事,帮我盯着一件件做完」',
  },
  { signals: ['run_my_workflow', 'list_my_workflows'], line: '- 跑你的工作流 —— 「跑一下我的日报」' },
  {
    signals: ['create_workflow', 'plan_workflow'],
    line: '- 搭个新工作流 —— 「帮我建一个每天汇总邮件的流程」(建好前先给你过目)',
  },
  { signals: ['show_my_memory'], line: '- 你记得我什么 —— 「你都记得我哪些事?」' },
  {
    signals: ['list_my_runs', 'list_my_agents', 'my_usage'],
    line: '- 看看近况 —— 你的助手、最近跑了什么、这个月花了多少',
  },
  { signals: ['diagnose_my_agents'], line: '- 体检我的助手 —— 「看看哪个 agent 还能调优」' },
  { signals: ['ask_my_agent'], line: '- 替我问我的某个助手一件事' },
  {
    signals: ['create_agent', 'edit_agent', 'delete_agent'],
    line: '- 建 / 改 / 删我的助手 —— 「给我建一个记账助手」(动手前要你确认)',
  },
  { signals: ['edit_workflow'], line: '- 改我的工作流(改动前要你确认)' },
  { signals: ['list_peers'], line: '- 看看互联了哪些 hub / 组织' },
  { signals: ['ask_peer'], line: '- 替我问对端 hub 一件事(发出前要你点头)' },
  { signals: ['backup_status'], line: '- 看这台 hub 的备份状态;打包一份备份档案(打包前要你批准)' },
  { signals: ['set_daily_brief'], line: '- 每天早上跟你说声早 + 简报' },
  { signals: ['set_run_broadcast'], line: '- 工作流跑完主动告诉你' },
  { signals: ['consolidate_my_memory'], line: '- 整理一下记忆' },
  { signals: ['set_reply_language'], line: '- 固定我回复用的语言 —— 「以后都用中文跟我说」' },
]

/** Distinct MCP server names ("notion-notes"…) present in the live tool set. */
function connectedServers(names: readonly string[]): string[] {
  const servers = new Set<string>()
  for (const n of names) {
    const sep = n.indexOf(MCP_NAME_SEP)
    if (sep > 0) servers.add(n.slice(0, sep))
  }
  return [...servers]
}

/**
 * Render the "我能帮你做这些" card from the live tool names. Only capabilities
 * with a live signal tool appear; connected MCP servers are named (truthful —
 * they came from the live tool prefixes), never enumerated tool-by-tool.
 */
export function renderCapabilityCard(toolNames: readonly string[]): string {
  const live = new Set(toolNames)
  const lines = CATALOG.filter((e) => e.signals.some((s) => live.has(s))).map((e) => e.line)
  const servers = connectedServers(toolNames)
  if (servers.length > 0) {
    lines.push(`- 你连接的外部工具(${servers.join('、')}) —— 「搜一下我笔记里关于 X 的内容」`)
  }
  if (lines.length === 0) {
    // No member-facing verb wired — still answer honestly rather than nothing.
    return '现在我主要陪你聊天、记着你告诉我的事。等接上更多能力(提醒 / 工作流 / 外部工具),我再一样样帮你。'
  }
  return ['我能帮你做这些(直接用大白话说就行,不用记命令):', '', ...lines, '', '需要哪个,跟我说一声。'].join(
    '\n',
  )
}

// ── the benign `list_my_capabilities` tool ───────────────────────────────────

const LIST_CAPABILITIES_TOOL: LlmToolDefinition = {
  name: 'list_my_capabilities',
  description:
    '当用户问「你能帮我做什么 / 你会啥 / 有什么功能 / help / 你能干嘛」这类想了解你能力范围的问题时调用,拿到一份"当前真实可用"的能力清单再答——清单只列这位用户此刻真正接上的功能,别凭空许诺没接上的。清单是给你参考的骨架,用你自己的话、结合上下文回给用户,别整段照抄。',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
}

export interface ButlerCapabilitiesDeps {
  /** Lazy getter over the FINAL composed benign + governed tool names. May be
   *  async — some toolsets (`LlmAgentToolset.listTools`) resolve their tools
   *  asynchronously, so the factory's getter awaits them. */
  toolNames: () => Promise<readonly string[]> | readonly string[]
}

class ButlerCapabilitiesToolset implements LlmAgentToolset {
  constructor(private readonly deps: ButlerCapabilitiesDeps) {}

  listTools(): LlmToolDefinition[] {
    return [LIST_CAPABILITIES_TOOL]
  }

  async callTool(name: string, _args: Record<string, unknown>): Promise<LlmToolCallResult> {
    if (name !== 'list_my_capabilities') {
      return { content: [{ type: 'text', text: `未知工具:${name}` }], isError: true }
    }
    const names = await this.deps.toolNames()
    return { content: [{ type: 'text', text: renderCapabilityCard(names) }] }
  }
}

/** Build the benign capability-discovery toolset (always offered). */
export function buildButlerCapabilitiesToolset(deps: ButlerCapabilitiesDeps): LlmAgentToolset {
  return new ButlerCapabilitiesToolset(deps)
}
