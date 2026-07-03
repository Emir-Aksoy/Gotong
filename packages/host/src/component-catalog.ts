/**
 * component-catalog.ts — WIZ-M1. 统一组件目录：把「这个 hub 现在能用什么搭工作流、
 * 还能装什么」聚合成一份带用途描述的机器可读清单。
 *
 * 五个源，全部已存在，这里只做零 LLM 的纯合并：
 *
 *   1. participants        — 本 hub 的人 + agent（人也是 Participant，同列同权）
 *   2. installedMcpServers — 已装进 MCP 注册表的服务器
 *   3. resources           — RES-M1 的软硬件探测（本地端点 / 编码 CLI / LLM key 可用性）
 *   4. presetTemplates     — 模板画廊里**还没装**的预置模板（一键装）
 *   5. presetConnectors    — 内置 MCP 连接器目录里**还没装**的连接器
 *
 * 为什么是纯函数：目录要喂给三个消费者 —— 建流向导的 LLM prompt（WIZ-M3）、缺口
 * 分析（WIZ-M2）、以及最终给用户看的「用这些搭的」清单。三个消费者共享同一份事实，
 * 就不会出现「prompt 里有、缺口分析里没有」的漂移。输入全部鸭子类型（真实来源
 * 分别是 hub.participants / space.mcpServers / ResourceInventory / 画廊卡片 /
 * BUILTIN_MCP_CONNECTORS），接线放 WIZ-M4，本文件零 import、light fake 可单测 ——
 * 与 RES-M2 提议引擎同一形态。
 *
 * 诚实边界：`status: 'available'` 的条目是「预置、可装、**装之前不可用**」——
 * 渲染时必须和已装的分开摆，且装任何东西都走人批准（RES 纪律：绝不静默改）。
 * 探测到但不可用的资源（端点不通 / CLI 不在 PATH / key 没设）**不进目录**：
 * 目录回答「能用什么」，不是「配置了什么」——后者是 RES 面板的事。
 */

// ── 目录条目 ────────────────────────────────────────────────────────────────

export type ComponentKind =
  | 'human' // 本 hub 的成员（人）——和 agent 一样能被工作流派活
  | 'agent' // 已注册的 agent participant
  | 'mcp' // 已装的 MCP 服务器（agent 的工具面）
  | 'endpoint' // 活着的本地模型端点（如 Ollama）
  | 'cli' // PATH 上找得到的编码 agent CLI
  | 'llm-provider' // key 可解析的 LLM provider —— 「还能再建新 LLM agent」的燃料
  | 'template' // 预置模板（可装：一组 agent / 工作流 / KB 槽位）
  | 'connector' // 预置 MCP 连接器（可装）

export type ComponentStatus = 'installed' | 'available'

export interface ComponentEntry {
  kind: ComponentKind
  /** 目录内稳定 id（participant id / MCP name / 模板 id / 连接器 id…）。 */
  id: string
  /** 一句话「这东西能干嘛」——给用户和 LLM 看的同一句话。 */
  description?: string
  /** participant 能满足的 capabilities（人和 agent 都有；其余 kind 无）。 */
  capabilities?: readonly string[]
  status: ComponentStatus
  /** status==='available' 时怎么装：模板导入还是连接器安装，ref 是对应目录 id。 */
  install?: { via: 'template' | 'connector'; ref: string }
  /** 资源类附注（端点 URL、CLI 命令名、连接器需自备的 env 等）。 */
  note?: string
}

// ── 鸭子类型输入（真实来源见文件头；全部可缺省，缺 = 该源为空） ─────────────

export interface CatalogInputs {
  /** hub.participants 的投影。`kind` 用 Participant 自己的 'human' | 'agent'。 */
  participants?: ReadonlyArray<{
    id: string
    kind: string
    capabilities: readonly string[]
    description?: string
  }>
  /** 已装 MCP 服务器（space.mcpServers → spec.name）。 */
  installedMcpServers?: ReadonlyArray<{ name: string; description?: string }>
  /** RES-M1 `ResourceInventory` 的相关三族（llmKeys / localEndpoints / cliAgents）。 */
  resources?: {
    llmKeys?: ReadonlyArray<{ provider: string; envSet: boolean; vaultConfigured: boolean }>
    localEndpoints?: ReadonlyArray<{ label: string; url: string; reachable: boolean }>
    cliAgents?: ReadonlyArray<{ command: string; label: string; found: boolean }>
  }
  /** 画廊预置模板的卡片投影（template-routes 已解析出 name/description）。 */
  presetTemplates?: ReadonlyArray<{
    id: string
    name?: string
    description?: string
  }>
  /** 内置连接器目录（BUILTIN_MCP_CONNECTORS 的投影）。`specName` 用于已装去重。 */
  presetConnectors?: ReadonlyArray<{
    id: string
    name: string
    /** 连接器目录的「一句话用途」（whatFor）。 */
    whatFor?: string
    /** 装进注册表后的技术名（spec.name）——已装同名服务器时这条预置不再列出。 */
    specName?: string
    needsEnv?: readonly string[]
  }>
}

// ── 聚合 ────────────────────────────────────────────────────────────────────

/**
 * 把五个源合并成一份确定性排序的目录。同输入必同输出（组内按 id 排序，组间
 * 按「已装在前、预置在后」的固定 kind 顺序），LLM provider 的 prompt 缓存友好。
 */
export function buildComponentCatalog(inputs: CatalogInputs): ComponentEntry[] {
  const out: ComponentEntry[] = []

  // 1+2. 人和 agent：Participant.kind 直接定 kind。未知 kind 按 agent 兜底
  //（外部桥接的 participant 也是「可派活的东西」，漏掉比归错类更糟）。
  for (const p of inputs.participants ?? []) {
    out.push({
      kind: p.kind === 'human' ? 'human' : 'agent',
      id: p.id,
      ...(p.description ? { description: p.description } : {}),
      capabilities: [...p.capabilities],
      status: 'installed',
    })
  }

  // 3. 已装 MCP 服务器。
  const installedMcpNames = new Set<string>()
  for (const m of inputs.installedMcpServers ?? []) {
    installedMcpNames.add(m.name)
    out.push({
      kind: 'mcp',
      id: m.name,
      ...(m.description ? { description: m.description } : {}),
      status: 'installed',
    })
  }

  // 4. 软硬件资源：只收「现在就能用」的（见文件头的诚实边界）。
  for (const ep of inputs.resources?.localEndpoints ?? []) {
    if (!ep.reachable) continue
    out.push({ kind: 'endpoint', id: ep.label, status: 'installed', note: ep.url })
  }
  for (const cli of inputs.resources?.cliAgents ?? []) {
    if (!cli.found) continue
    out.push({ kind: 'cli', id: cli.label, status: 'installed', note: cli.command })
  }
  for (const k of inputs.resources?.llmKeys ?? []) {
    if (!k.envSet && !k.vaultConfigured) continue
    out.push({ kind: 'llm-provider', id: k.provider, status: 'installed' })
  }

  // 5. 预置模板（可装）。
  for (const t of inputs.presetTemplates ?? []) {
    out.push({
      kind: 'template',
      id: t.id,
      ...(descOf(t.name, t.description) ? { description: descOf(t.name, t.description) } : {}),
      status: 'available',
      install: { via: 'template', ref: t.id },
    })
  }

  // 6. 预置连接器（可装）——已装同名（spec.name）的不再列，防止「装过的还提议装」。
  for (const c of inputs.presetConnectors ?? []) {
    if (c.specName && installedMcpNames.has(c.specName)) continue
    const needs = c.needsEnv && c.needsEnv.length > 0 ? `需自备 env: ${c.needsEnv.join(', ')}` : undefined
    out.push({
      kind: 'connector',
      id: c.id,
      ...(descOf(c.name, c.whatFor) ? { description: descOf(c.name, c.whatFor) } : {}),
      status: 'available',
      install: { via: 'connector', ref: c.id },
      ...(needs ? { note: needs } : {}),
    })
  }

  return sortCatalog(out)
}

/** name 和一句话用途拼成单行描述；两者缺一用另一个，全缺返回 undefined。 */
function descOf(name?: string, what?: string): string | undefined {
  if (name && what) return `${name} — ${what}`
  return name ?? what ?? undefined
}

/** 组间固定顺序（已装前、预置后），组内按 id 排 —— 确定性输出的唯一权威。 */
const KIND_ORDER: readonly ComponentKind[] = [
  'human',
  'agent',
  'mcp',
  'endpoint',
  'cli',
  'llm-provider',
  'template',
  'connector',
]

function sortCatalog(entries: ComponentEntry[]): ComponentEntry[] {
  return [...entries].sort((a, b) => {
    const ka = KIND_ORDER.indexOf(a.kind)
    const kb = KIND_ORDER.indexOf(b.kind)
    if (ka !== kb) return ka - kb
    return a.id.localeCompare(b.id)
  })
}

// ── 给 LLM / 用户看的紧凑渲染 ───────────────────────────────────────────────

const KIND_LABEL: Record<ComponentKind, string> = {
  human: '人（成员，可派活）',
  agent: 'agent',
  mcp: '已装 MCP 工具',
  endpoint: '本地模型端点',
  cli: '编码 CLI',
  'llm-provider': '可用 LLM provider（可再建新 agent）',
  template: '预置模板（装后才可用）',
  connector: '预置 MCP 连接器（装后才可用）',
}

export interface RenderCatalogOptions {
  /** false = 只渲染已装部分（比如给「只用现有件」的保守组装）。默认 true。 */
  includeAvailable?: boolean
  /** 每类最多列几条，超出以「…等 N 个」收尾（防 prompt 无界膨胀）。默认 12。 */
  maxPerKind?: number
}

/**
 * 把目录渲染成喂给 LLM（也直接可给人看）的紧凑中文文本。已装与预置**分节**摆，
 * 预置节头写明「需用户批准安装」——模型可以提议用它们，但不能假装它们已就绪。
 */
export function renderCatalogForPrompt(
  entries: ReadonlyArray<ComponentEntry>,
  opts: RenderCatalogOptions = {},
): string {
  const includeAvailable = opts.includeAvailable ?? true
  const maxPerKind = opts.maxPerKind ?? 12

  const lines: string[] = []
  const emit = (title: string, group: ComponentEntry[]) => {
    if (group.length === 0) return
    lines.push(`【${title}】`)
    for (const e of group.slice(0, maxPerKind)) {
      const caps = e.capabilities && e.capabilities.length > 0 ? ` [${e.capabilities.join(', ')}]` : ''
      const desc = e.description ? ` — ${e.description}` : ''
      const note = e.note ? `（${e.note}）` : ''
      lines.push(`  - ${e.id}${caps}${desc}${note}`)
    }
    if (group.length > maxPerKind) lines.push(`  …等 ${group.length} 个（已截断）`)
  }

  const byKind = (k: ComponentKind) => entries.filter((e) => e.kind === k)

  lines.push('=== 本 hub 已有组件（现在就能用）===')
  const installedLenBefore = lines.length
  for (const k of KIND_ORDER) {
    const group = byKind(k)
    if (group.length > 0 && group[0]!.status === 'installed') emit(KIND_LABEL[k], group)
  }
  if (lines.length === installedLenBefore) lines.push('（空 —— 这个 hub 还没有任何可用组件）')

  if (includeAvailable) {
    const preset = entries.filter((e) => e.status === 'available')
    if (preset.length > 0) {
      lines.push('=== 预置组件（还没装；提议使用需经用户批准安装）===')
      emit(KIND_LABEL.template, byKind('template'))
      emit(KIND_LABEL.connector, byKind('connector'))
    }
  }

  return lines.join('\n')
}

/** 目录里（已装的人和 agent）能满足的 capability 全集 —— WIZ-M2 缺口分析的对照面。 */
export function installedCapabilities(entries: ReadonlyArray<ComponentEntry>): Set<string> {
  const caps = new Set<string>()
  for (const e of entries) {
    if (e.status !== 'installed') continue
    for (const c of e.capabilities ?? []) caps.add(c)
  }
  return caps
}
