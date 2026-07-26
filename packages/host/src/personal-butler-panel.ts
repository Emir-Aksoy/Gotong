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
    '顶层结构: { "schemaVersion": 1, "title"?: string, "sections": [{ "heading"?: string, "components": [{ "type", "source"?, "params"? }] }] }',
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
  constructor(private readonly deps: ButlerPanelDeps) {}

  listTools(): LlmToolDefinition[] {
    return [GET_TOOL, SET_TOOL]
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<LlmToolCallResult> {
    if (name === GET_TOOL.name) return this.getPanel()
    if (name === SET_TOOL.name) return this.setLayout(args)
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
      if (typeof args.libraryId === 'string') {
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
}

/**
 * benign 面板编排工具(目录层)。userId 闭包 + 店面归因 'butler' 是本
 * builder 的两条不变量——工厂只在有店面时装(无 surface = 工具不存在)。
 */
export function buildButlerPanelToolset(deps: ButlerPanelDeps): LlmAgentToolset {
  return new ButlerPanelToolset(deps)
}
