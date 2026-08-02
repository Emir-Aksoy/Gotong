/**
 * personal-butler-panel.ts — SDUI-M4 管家编排工具(岔口 E1:benign 直改 +
 * 三重安全网)。两个工具,目录层长尾:
 *
 *   - `get_my_panel` 只读自省:成员当前面板形态(来源/配置 JSON)+ 形态库
 *     + **从 PANEL_COMPONENT_CONTRACTS 现场派生**的组件契约小抄(零手写
 *     零漂移——模型照着拼配置,幻觉面最小化)。
 *   - `set_panel_layout` 四模式互斥写:config 整体替换 / libraryId 换形态 /
 *     reset 恢复默认 / undo 撤销上一次改动。每一笔都落进 M3 店面的
 *     `setPanel` 同一校验咽喉(one validator, no drift)并带 `by:'butler'`
 *     归因——快照先行、SPA 横幅响亮播报、成员一键撤销,三重安全网全在
 *     店面/渲染器层结构性成立,本文件不承担任何安全判定。
 *
 * benign 三段式论证(计划文档 §12.3):只写**本成员自己的**展示编排
 * (userId 构造时闭包,不是工具参数——够不到别人)/ 不执行任何真实动作
 * (卡片只是摆位)/ 卡片引用的动作各走各的治理闸(start_workflow 等真跑
 * 时照常过审)。与 TN 记笔记、LIB 上架同域。
 *
 * 改不坏:幻觉组件名/越界值被 validatePanelConfig 当场拒,文件字节不变;
 * 瞒不住:改动归因 'butler' → GET /api/me/panel 带 lastChange → SPA 顶部
 *         横幅「阿同调整了你的面板 [撤销]」,不依赖模型自觉转述;
 * 退得回:店面每笔改动前快照,undo 交换语义永不丢状态。
 */

import type { Logger } from '@gotong/core'
import type { LlmAgentToolset, LlmToolCallResult, LlmToolDefinition } from '@gotong/llm'
import {
  PANEL_ACTION_PREFIXES,
  PANEL_COMPONENT_CONTRACTS,
  PANEL_FIXED_ACTIONS,
  PANEL_LIMITS,
  PANEL_RESERVED_TABS,
  PANEL_SCALES,
  PANEL_TAB_IDS,
} from '@gotong/personal-butler'

/** 店面窄鸭子(host 的 MePanelSurfaceHost 结构性满足;web 面不经这里)。 */
export interface ButlerPanelSurface {
  panel(userId: string): Promise<{
    schemaVersion: number
    config: unknown
    source: 'default' | 'member' | 'fallback'
    lastChange?: { by: 'butler' | 'human'; at: string }
  }>
  listLibrary(): Promise<{ id: string; title: string; description?: string }[]>
  setPanel(userId: string, value: unknown, opts?: { by?: 'butler' | 'human' }): Promise<unknown>
  applyLibrary(
    userId: string,
    libraryId: string,
    opts?: { by?: 'butler' | 'human' },
  ): Promise<unknown>
  resetPanel(userId: string, opts?: { by?: 'butler' | 'human' }): Promise<void>
  restoreSnapshot(userId: string, opts?: { by?: 'butler' | 'human' }): Promise<unknown>
  // C1-c 展示内容(markdown-card 的 content:<id> 与 connector:<槽> 中转文件)
  listContent(userId: string): Promise<{ id: string; updatedAt: string; bytes: number }[]>
  readContent(userId: string, fileId: string): Promise<{ markdown: string; updatedAt: string } | null>
  writeContent(userId: string, fileId: string, markdown: string | null): Promise<void>
}

const GET_TOOL: LlmToolDefinition = {
  name: 'get_my_panel',
  description:
    '看这位成员「面板」页的当前形态:配置 JSON、来源(自配/默认/降级)、可换的形态库,以及组件契约小抄(有哪些组件、各自能绑什么数据源和参数)。成员聊到面板布局(「把天气挪上面」「加张新闻卡」)时,先用它看现状再动手。只读。',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
}

const SET_TOOL: LlmToolDefinition = {
  name: 'set_panel_layout',
  description:
    '调整这位成员自己的「面板」页布局。四种用法(每次恰好一种):config=完整面板配置整体替换(先用 get_my_panel 拿现状和组件契约,改完整份传回);libraryId=换上形态库里的一张形态;reset=true 恢复内置默认;undo=true 撤销上一次改动(交换式,再撤一次换回)。只改排布不执行动作;每次改动成员面板顶部都会出现「阿同调整了你的面板」横幅并可一键撤销——改完如实告诉成员即可,瞒不住也不必瞒。',
  inputSchema: {
    type: 'object',
    properties: {
      config: {
        type: 'object',
        description: '完整面板配置(整体替换,不是增量 patch)。结构见 get_my_panel 的小抄。',
      },
      libraryId: { type: 'string', description: '形态库条目 id(get_my_panel 可列)。' },
      reset: { type: 'boolean', description: 'true = 恢复内置默认面板。' },
      undo: { type: 'boolean', description: 'true = 撤销上一次面板改动。' },
    },
    additionalProperties: false,
  },
}

// C1-c 展示内容三件(岔口 A=管家中转):面板永不直呼连接器——管家读到什么
// (晨报 enrich / 成员开口问),整理后写成本成员的展示内容文件,卡片渲染那份
// 文件并固定标注「阿同写的/整理 · 更新于 X」。写的只是给本人看的展示文本,
// 不执行任何动作(benign 三段式同 set_panel_layout)。
const LIST_CONTENT_TOOL: LlmToolDefinition = {
  name: 'list_panel_content',
  description:
    '列这位成员面板的展示内容文件(id / 更新时间 / 大小)。markdown-card 绑 content:<id> 显示对应文件;天气/新闻/日历等绑 connector:<槽位> 的卡显示 connector.<槽位> 这份文件。只读。',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
}

const READ_CONTENT_TOOL: LlmToolDefinition = {
  name: 'read_panel_content',
  description: '读一份面板展示内容文件的当前 markdown(改写前先看现状)。只读。',
  inputSchema: {
    type: 'object',
    properties: { fileId: { type: 'string', description: '内容文件 id(list_panel_content 可列)。' } },
    required: ['fileId'],
    additionalProperties: false,
  },
}

const WRITE_CONTENT_TOOL: LlmToolDefinition = {
  name: 'write_panel_content',
  description:
    '写/删这位成员自己的面板展示内容文件(整篇替换)。markdown-card 绑 content:<fileId> 即显示它;把连接器读到的最新内容(天气/新闻/日历)整理后写进 connector.<槽位>(如 connector.weather),面板对应的卡就会更新并标注整理时间。纯 markdown 文本(标题/列表/粗体;链接不会渲染成可点),单份 ≤8KB、每人 ≤24 份。只是展示文本,不执行动作;删除传 delete:true。',
  inputSchema: {
    type: 'object',
    properties: {
      fileId: { type: 'string', description: '内容文件 id(标识符,如 farming-notes / connector.weather)。' },
      markdown: { type: 'string', description: '整篇 markdown 内容(与 delete 二选一)。' },
      delete: { type: 'boolean', description: 'true = 删除这份内容(与 markdown 二选一)。' },
    },
    required: ['fileId'],
    additionalProperties: false,
  },
}

/** 从校验器同一份契约表现场派生小抄——绝不手抄一份任其烂掉。 */
export function renderPanelContractCheatsheet(): string {
  const lines: string[] = [
    `组件契约(配置只能用这些;上限 ${PANEL_LIMITS.maxSections} 个分区 / 共 ${PANEL_LIMITS.maxComponents} 个组件):`,
  ]
  for (const [type, contract] of Object.entries(PANEL_COMPONENT_CONTRACTS)) {
    const bits: string[] = []
    if (contract.source === 'forbidden') {
      bits.push('无 source')
    } else {
      const srcs = (contract.sources ?? [])
        .map((s) => (s.endsWith(':') ? `${s}<id>` : s))
        .join(' | ')
      bits.push(`source ${contract.source === 'required' ? '必填' : '可选'}: ${srcs}`)
    }
    const params = contract.params ?? {}
    const paramBits = Object.entries(params).map(([key, spec]) => {
      if (spec.kind === 'enum') return `${key} ∈ {${spec.values.join(',')}}`
      if (spec.kind === 'int') return `${key} ${spec.min}-${spec.max}`
      if (spec.kind === 'string') return `${key} ≤${spec.maxChars}字`
      // 'actions':固定动词 + 前缀族(后缀是标识符),上限同校验器。
      const verbs = [...PANEL_FIXED_ACTIONS, ...PANEL_ACTION_PREFIXES.map((p) => `${p}<id>`)]
      return `${key}: [${verbs.join(' | ')}] ≤${PANEL_LIMITS.maxActions}个`
    })
    if (paramBits.length > 0) bits.push(`params: ${paramBits.join(', ')}`)
    if (type === 'approval-inbox') bits.push('保留区:只能摆位置,盖不掉待批徽章')
    lines.push(`- ${type}(${bits.join(';')})`)
  }
  lines.push(
    '顶层结构: { "schemaVersion": 1, "title"?: string, "tabs"?: string[], "scale"?: string, "sections": [{ "heading"?: string, "components": [{ "type", "source"?, "params"? }] }] }',
  )
  // SHELL-M4.5 — tabs 也从 schema 常量现场派生,同一条零手抄纪律。
  lines.push(
    `tabs(可选,导航骨架): 从 [${PANEL_TAB_IDS.join(', ')}] 里挑并排序,第一个是打开 app 的首屏;` +
      `${PANEL_RESERVED_TABS.join('/')} 是保留区(删了客户端也会补回);写了角色够不着的页签不会出现也不会给权限。`,
  )
  // POLISH-M1 — 同一条零手抄纪律:成员说「字太小/按钮太小」时,改的就是这个键。
  lines.push(
    `scale(可选,显示档): ${PANEL_SCALES.join(' | ')};large=大字大按钮(老人/视力不便),只改这位成员自己看到的大小,不改数据。`,
  )
  return lines.join('\n')
}

const SOURCE_LABEL: Record<'default' | 'member' | 'fallback', string> = {
  default: '内置默认(成员没自配)',
  member: '成员自配',
  fallback: '降级中(存的配置损坏/失效,正在回退默认——改一版好的存进去即可修复)',
}

export interface ButlerPanelDeps {
  /** 构造时闭包——工具面结构性只够到本成员自己的面板。 */
  userId: string
  surface: ButlerPanelSurface
  logger?: Pick<Logger, 'warn'>
}

function text(s: string, isError = false): LlmToolCallResult {
  return isError ? { content: [{ type: 'text', text: s }], isError: true } : { content: [{ type: 'text', text: s }] }
}

/** PanelStoreError 走鸭子 code(不 import host 内部类,与 web 路由同姿态)。 */
function storeCode(err: unknown): string | null {
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : null
}

class ButlerPanelToolset implements LlmAgentToolset {
  // contentOnly — 晨报小刀(2026-08-02)的无人值守面:只有内容三件,布局两件
  // (get_my_panel/set_panel_layout)连 callTool 都拒 —— 无人值守循环可以刷新
  // 卡片内容,永远不能重排面板(重排有快照/横幅/撤销一整套会话语境,sweep 没有)。
  constructor(
    private readonly deps: ButlerPanelDeps,
    private readonly contentOnly = false,
  ) {}

  listTools(): LlmToolDefinition[] {
    return this.contentOnly
      ? [LIST_CONTENT_TOOL, READ_CONTENT_TOOL, WRITE_CONTENT_TOOL]
      : [GET_TOOL, SET_TOOL, LIST_CONTENT_TOOL, READ_CONTENT_TOOL, WRITE_CONTENT_TOOL]
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<LlmToolCallResult> {
    if (!this.contentOnly && name === GET_TOOL.name) return this.getPanel()
    if (!this.contentOnly && name === SET_TOOL.name) return this.setLayout(args)
    if (name === LIST_CONTENT_TOOL.name) return this.listContent()
    if (name === READ_CONTENT_TOOL.name) return this.readContent(args)
    if (name === WRITE_CONTENT_TOOL.name) return this.writeContent(args)
    return text(`未知工具:${name}`, true)
  }

  private async getPanel(): Promise<LlmToolCallResult> {
    try {
      const [current, library] = await Promise.all([
        this.deps.surface.panel(this.deps.userId),
        this.deps.surface.listLibrary(),
      ])
      const lines: string[] = [`当前面板形态:${SOURCE_LABEL[current.source]}`]
      if (current.lastChange) {
        const who = current.lastChange.by === 'butler' ? '我(阿同)' : '成员/管理员'
        lines.push(`上次改动:${who},${current.lastChange.at}(可用 set_panel_layout {"undo":true} 撤销)`)
      }
      lines.push('', '当前配置 JSON:', JSON.stringify(current.config, null, 2))
      lines.push(
        '',
        library.length === 0
          ? '形态库:空(还没装形态模板)。'
          : `形态库(set_panel_layout {"libraryId":…} 可换上):${library
              .map((e) => `${e.id}「${e.title}」`)
              .join(' / ')}`,
      )
      lines.push('', renderPanelContractCheatsheet())
      return text(lines.join('\n'))
    } catch (err) {
      this.deps.logger?.warn('butler panel: read failed', { err })
      return text('暂时读不到面板配置,稍后再试。', true)
    }
  }

  private async setLayout(args: Record<string, unknown>): Promise<LlmToolCallResult> {
    const modes = [
      args.config !== undefined,
      typeof args.libraryId === 'string' && args.libraryId.length > 0,
      args.reset === true,
      args.undo === true,
    ].filter(Boolean).length
    if (modes !== 1) {
      return text(
        '每次调用恰好用一种模式:config(整体替换)/ libraryId(换形态)/ reset:true(恢复默认)/ undo:true(撤销上次改动)。',
        true,
      )
    }
    const by = { by: 'butler' as const }
    const banner = '成员面板顶部会出现改动横幅,本人可一键撤销。'
    try {
      if (args.undo === true) {
        await this.deps.surface.restoreSnapshot(this.deps.userId, by)
        return text(`已撤销上一次面板改动(再撤一次会换回)。${banner}`)
      }
      if (args.reset === true) {
        await this.deps.surface.resetPanel(this.deps.userId, by)
        return text(`已恢复内置默认面板。${banner}`)
      }
      // Same predicate as the mode count above — a bare typeof check would
      // let {config, libraryId:""} route here and refuse instead of applying.
      if (typeof args.libraryId === 'string' && args.libraryId.length > 0) {
        await this.deps.surface.applyLibrary(this.deps.userId, args.libraryId, by)
        return text(`已换上形态「${args.libraryId}」。${banner}`)
      }
      await this.deps.surface.setPanel(this.deps.userId, args.config, by)
      return text(`面板已按新配置整体替换。${banner}`)
    } catch (err) {
      const code = storeCode(err)
      const msg = err instanceof Error ? err.message : String(err)
      if (code === 'invalid' || code === 'too_large') {
        // 校验器的病名逐条回给模型自纠——文件字节未动(fail-closed)。
        return text(`配置被校验器拒绝,面板未改动:${msg}\n对照 get_my_panel 的组件契约小抄改后重试。`, true)
      }
      if (code === 'not_found') {
        if (args.undo === true) return text('面板从没被改过,没有可撤销的记录。', true)
        return text(`形态库里没有这张形态:${msg}(用 get_my_panel 看可用的形态 id)。`, true)
      }
      this.deps.logger?.warn('butler panel: write failed', { err })
      return text('面板改动没能落盘,稍后再试。', true)
    }
  }

  private async listContent(): Promise<LlmToolCallResult> {
    try {
      const rows = await this.deps.surface.listContent(this.deps.userId)
      if (rows.length === 0) {
        return text('还没有展示内容文件。write_panel_content 可写;connector:<槽位> 的卡读 connector.<槽位> 这份文件。')
      }
      const lines = rows.map((r) => `- ${r.id}(${r.bytes} 字节,更新于 ${r.updatedAt})`)
      return text(`展示内容文件 ${rows.length} 份:\n${lines.join('\n')}`)
    } catch (err) {
      this.deps.logger?.warn('butler panel: content list failed', { err })
      return text('暂时列不出展示内容,稍后再试。', true)
    }
  }

  private async readContent(args: Record<string, unknown>): Promise<LlmToolCallResult> {
    if (typeof args.fileId !== 'string' || args.fileId.length === 0) {
      return text('要读哪份?fileId 必填(list_panel_content 可列)。', true)
    }
    try {
      const doc = await this.deps.surface.readContent(this.deps.userId, args.fileId)
      if (doc === null) return text(`没有「${args.fileId}」这份内容(还没写过,或 id 不合法)。`)
      return text(`「${args.fileId}」(更新于 ${doc.updatedAt}):\n${doc.markdown}`)
    } catch (err) {
      this.deps.logger?.warn('butler panel: content read failed', { err })
      return text('暂时读不到这份内容,稍后再试。', true)
    }
  }

  private async writeContent(args: Record<string, unknown>): Promise<LlmToolCallResult> {
    if (typeof args.fileId !== 'string' || args.fileId.length === 0) {
      return text('fileId 必填(标识符,如 farming-notes / connector.weather)。', true)
    }
    // markdown 与 delete 恰好一种 —— 同 set_panel_layout 的互斥纪律。
    const writing = typeof args.markdown === 'string'
    const deleting = args.delete === true
    if (writing === deleting) {
      return text('每次调用恰好一种:markdown(整篇替换)或 delete:true(删除)。', true)
    }
    try {
      await this.deps.surface.writeContent(
        this.deps.userId,
        args.fileId,
        deleting ? null : (args.markdown as string),
      )
      if (deleting) return text(`已删除展示内容「${args.fileId}」。`)
      return text(
        `已写入「${args.fileId}」。绑 content:${args.fileId} 的 markdown-card 会显示它` +
          (args.fileId.startsWith('connector.')
            ? `;绑 connector:${args.fileId.slice('connector.'.length)} 的卡也会更新,并标注整理时间。`
            : ',卡上会标注「阿同写的」和更新时间。'),
      )
    } catch (err) {
      const code = storeCode(err)
      const msg = err instanceof Error ? err.message : String(err)
      if (code === 'invalid' || code === 'too_large') {
        return text(`内容被拒,文件未动:${msg}`, true)
      }
      this.deps.logger?.warn('butler panel: content write failed', { err })
      return text('内容没能落盘,稍后再试。', true)
    }
  }
}

/**
 * benign 面板编排工具(目录层)。userId 闭包 + 店面归因 'butler' 是本
 * builder 的两条不变量——工厂只在有店面时装(无 surface = 工具不存在)。
 */
export function buildButlerPanelToolset(deps: ButlerPanelDeps): LlmAgentToolset {
  return new ButlerPanelToolset(deps)
}

/**
 * 晨报小刀(2026-08-02) — 内容-only 面板工具面,给无人值守的晨报 enrich 循环:
 * 只有 list/read/write_panel_content 三件(写的是仅本人可见的展示文本,benign
 * 三段式论证与会话面同一套),布局两件结构性不在 —— 不只是不 advertise,
 * callTool 按名点它们也拒。与会话工具面共享同一批工具定义与执行体,零漂移。
 */
export function buildButlerPanelContentToolset(deps: ButlerPanelDeps): LlmAgentToolset {
  return new ButlerPanelToolset(deps, true)
}
