/**
 * two-tier-toolset.ts — AFR-M2. 工具面两层化的纯核(ComposedToolset 的兄弟件)。
 *
 * 背景:AFR-M1 实测管家每轮携带 35 个工具 schema(~6,038 token,MCP 按 0 计)。
 * 负担的真身不是美元(NA-M1 已进缓存前缀)而是:①30+ 候选里选 1 个的注意力稀释;
 * ②上下文永驻占用;③工具集一变缓存前缀全失效。两层化把低频 BENIGN 长尾折进一个
 * 目录:每轮只付两个一等工具(`list_tool_directory` + `use_tool`)的 schema,长尾
 * 工具的说明书以【工具结果】形式按需进上下文,用完即走,不碰稳定前缀。
 *
 * ── 五条设计红线(AFR §三) ─────────────────────────────────────────────
 * · 热路径零 LLM:目录渲染=纯字符串拼接,分发=查表转发;绝不按消息内容选工具集。
 * · 能力零阉割:长尾工具的 callTool 结果/异常与直调【逐字节一致】(原样透传,
 *   不包不改);`runForTask` 全转发(依赖 per-task 作用域的长尾工具照常工作)。
 * · governed 永不进长尾:目录只收 BENIGN 工具 —— 风险面最需要一等 schema 的参数
 *   精度与描述红线。本纯核在类型上挡不住(llm 层不认识 GovernedActionToolset),
 *   由 M3 装配处 + 防腐门钉死;此处用选项名 `benignLongTail` + 本注释立约。
 * · 缓存前缀稳定:长尾集合在首次 listTools 时【快照】,此后 use_tool 的 enum、
 *   目录内容、路由表全部静止 —— 会话内工具面绝不变形(NA-M1 轮内复用假设不破)。
 *   运行中会长出新工具的 toolset(某些 MCP server)不适合进长尾,留一等。
 * · 校验是礼貌不是闸:use_tool 的服务端参数校验是 fail-open 子集(只校验认识的
 *   关键字:type/required/properties/enum/items;不认识的特性一律放行)——目的是
 *   给模型比「工具自己报错」更指路的错误信息,绝不比一等暴露更严。参数的最终
 *   权威永远是工具自身(它们本就防御性解析模型产出)。
 */

import type {
  LlmAgentToolset,
  LlmToolCallResult,
  LlmToolDefinition,
} from './types.js'

/** 一等工具名:渲染长尾目录(名字/用途/参数)。 */
export const LIST_TOOL_DIRECTORY = 'list_tool_directory'
/** 一等工具名:目录工具的统一调用入口。 */
export const USE_TOOL = 'use_tool'

/** 同名长尾工具被多个 child 广告(镜像 ComposedToolCollision)。 */
export interface TwoTierToolCollision {
  readonly name: string
  /** 构造入参数组里广告了该名字的 child 下标。 */
  readonly childIndices: number[]
}

/**
 * 首次快照时发现布线 bug 就大声抛(镜像 ComposedToolNameCollisionError):
 * 跨 child 重名会让 use_tool 静默路由到错的 child;长尾里出现保留名
 * (list_tool_directory / use_tool)会被一等工具遮蔽。两者都是装配错误。
 */
export class TwoTierToolNameCollisionError extends Error {
  readonly collisions: TwoTierToolCollision[]
  constructor(collisions: TwoTierToolCollision[]) {
    const detail = collisions
      .map((c) => `${c.name} (children ${c.childIndices.join(', ')})`)
      .join('; ')
    super(
      `TwoTierToolset: 长尾工具名冲突 — ${detail}。` +
        `重名会让 use_tool 静默错路由;保留名会被一等工具遮蔽。改名或拆开。`,
    )
    this.name = 'TwoTierToolNameCollisionError'
    this.collisions = collisions
  }
}

export interface TwoTierToolsetOptions {
  /**
   * 折进目录的 BENIGN 长尾 toolset。红线:绝不放 governed/会 park 的工具集
   * (它们必须保留一等 schema —— M3 装配处与防腐门负责钉死)。
   */
  benignLongTail: ReadonlyArray<LlmAgentToolset>
}

interface TailEntry {
  def: LlmToolDefinition
  owner: LlmAgentToolset
}

interface TailSnapshot {
  defs: LlmToolDefinition[]
  byName: Map<string, TailEntry>
}

/** value 是否匹配 JSON Schema 的 type 关键字(不认识的 type 一律放行=fail-open)。 */
function typeMatches(t: unknown, value: unknown): boolean {
  if (Array.isArray(t)) return t.some((one) => typeMatches(one, value))
  switch (t) {
    case 'string':
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number'
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value)
    case 'array':
      return Array.isArray(value)
    case 'null':
      return value === null
    default:
      return true
  }
}

function describeValue(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/**
 * fail-open 子集校验:只对认识的关键字报问题,其余放行。返回问题列表
 * (空=放行转发)。这是礼貌层,不是安全闸 —— 见文件头红线。
 */
function collectSchemaIssues(
  schema: unknown,
  value: unknown,
  path: string,
  issues: string[],
): void {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return
  const s = schema as Record<string, unknown>
  if (s.type !== undefined && !typeMatches(s.type, value)) {
    issues.push(
      `${path}: 期望 ${Array.isArray(s.type) ? s.type.join('|') : String(s.type)},拿到 ${describeValue(value)}`,
    )
    return
  }
  if (Array.isArray(s.enum) && s.enum.length > 0) {
    // 只对原始值枚举做包含判断;含对象的枚举跳过(fail-open)。
    const primitives = s.enum.every((e) => e === null || typeof e !== 'object')
    if (primitives && !s.enum.includes(value as never)) {
      issues.push(`${path}: 只接受 ${s.enum.map((e) => JSON.stringify(e)).join(' | ')}`)
      return
    }
  }
  if (
    s.type === 'object' &&
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  ) {
    const obj = value as Record<string, unknown>
    if (Array.isArray(s.required)) {
      for (const k of s.required) {
        if (typeof k === 'string' && !(k in obj)) issues.push(`${path}.${k}: 必填缺失`)
      }
    }
    const props =
      s.properties && typeof s.properties === 'object' && !Array.isArray(s.properties)
        ? (s.properties as Record<string, unknown>)
        : undefined
    if (props) {
      for (const [k, sub] of Object.entries(props)) {
        if (k in obj) collectSchemaIssues(sub, obj[k], `${path}.${k}`, issues)
      }
    }
    // 多余的 key 不报(fail-open):工具自身是参数的权威。
  }
  if (s.type === 'array' && Array.isArray(value)) {
    const items = s.items
    if (items && typeof items === 'object' && !Array.isArray(items)) {
      value.forEach((v, i) => collectSchemaIssues(items, v, `${path}[${i}]`, issues))
    }
  }
}

/** 从 inputSchema 提炼一行紧凑参数签名(目录卡与校验错误里都用它指路)。 */
function compactParams(schema: Record<string, unknown>): string {
  const props =
    schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)
      ? (schema.properties as Record<string, unknown>)
      : undefined
  if (!props || Object.keys(props).length === 0) return '无'
  const required = new Set(Array.isArray(schema.required) ? schema.required : [])
  const parts: string[] = []
  for (const [k, raw] of Object.entries(props)) {
    const p =
      raw && typeof raw === 'object' && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : {}
    let sig = `${k}: ${typeof p.type === 'string' ? p.type : Array.isArray(p.type) ? p.type.join('|') : 'any'}`
    if (Array.isArray(p.enum) && p.enum.length > 0) {
      sig += `=${p.enum.map((e) => JSON.stringify(e)).join('|')}`
    }
    if (required.has(k)) sig += '(必填)'
    if (typeof p.description === 'string' && p.description.length > 0) {
      const d = p.description.length > 80 ? `${p.description.slice(0, 80)}…` : p.description
      sig += ` — ${d}`
    }
    parts.push(sig)
  }
  return parts.join('; ')
}

/**
 * 两层化 toolset:自身只广告两个一等工具(list_tool_directory / use_tool),
 * 长尾工具的完整说明按需以工具结果进上下文。构造后即插进 agent 的 benign 组
 * (它实现 LlmAgentToolset,与任何一等 toolset 并列组合)。
 */
export class TwoTierToolset implements LlmAgentToolset {
  private readonly benignLongTail: ReadonlyArray<LlmAgentToolset>
  private snapshot: Promise<TailSnapshot> | null = null

  constructor(opts: TwoTierToolsetOptions) {
    this.benignLongTail = opts.benignLongTail
  }

  /** 首次触达时快照长尾(此后目录/enum/路由表静止 = 会话内工具面不变形)。 */
  private resolve(): Promise<TailSnapshot> {
    if (!this.snapshot) this.snapshot = this.buildSnapshot()
    return this.snapshot
  }

  private async buildSnapshot(): Promise<TailSnapshot> {
    const defs: LlmToolDefinition[] = []
    const byName = new Map<string, TailEntry>()
    const firstOwner = new Map<string, number>()
    const collisions = new Map<string, Set<number>>()
    const reserved = new Set([LIST_TOOL_DIRECTORY, USE_TOOL])
    for (let i = 0; i < this.benignLongTail.length; i++) {
      const child = this.benignLongTail[i]!
      const tools = await child.listTools()
      for (const td of tools) {
        if (reserved.has(td.name)) {
          // 保留名当作与「一等自身(下标 -1)」冲突,同一条错误通道大声抛。
          let set = collisions.get(td.name)
          if (!set) {
            set = new Set<number>([-1])
            collisions.set(td.name, set)
          }
          set.add(i)
          continue
        }
        const prev = firstOwner.get(td.name)
        if (prev === undefined) {
          firstOwner.set(td.name, i)
          defs.push(td)
          byName.set(td.name, { def: td, owner: child })
        } else if (prev !== i) {
          let set = collisions.get(td.name)
          if (!set) {
            set = new Set<number>([prev])
            collisions.set(td.name, set)
          }
          set.add(i)
        }
      }
    }
    if (collisions.size > 0) {
      throw new TwoTierToolNameCollisionError(
        [...collisions.entries()].map(([name, set]) => ({
          name,
          childIndices: [...set].sort((a, b) => a - b),
        })),
      )
    }
    return { defs, byName }
  }

  private directoryDef(): LlmToolDefinition {
    return {
      name: LIST_TOOL_DIRECTORY,
      description:
        '列出工具目录:长尾工具的名字、用途与参数说明。当你需要的能力不在眼前的工具里时,先调它看目录 —— 目录工具与一等工具能力相同,只是按需取用。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    }
  }

  private useToolDef(snap: TailSnapshot): LlmToolDefinition {
    const names = snap.defs.map((d) => d.name)
    return {
      name: USE_TOOL,
      description:
        '调用工具目录里的长尾工具:name=目录里的工具名,args=该工具的参数对象(形状见 list_tool_directory 或参数报错里的签名)。',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: '目录里的工具名',
            ...(names.length > 0 ? { enum: names } : {}),
          },
          args: {
            type: 'object',
            description: '目标工具的参数对象;无参数的工具可省略',
          },
        },
        required: ['name'],
        additionalProperties: false,
      },
    }
  }

  private renderDirectory(snap: TailSnapshot): string {
    if (snap.defs.length === 0) return '工具目录是空的(没有折进目录的长尾工具)。'
    const blocks = snap.defs.map((d) => {
      // description 全文保留 —— 长尾工具的「何时调用/红线」都写在里面,截断=丢红线。
      const desc = d.description && d.description.length > 0 ? d.description : '(无说明)'
      return `· ${d.name} — ${desc}\n  参数:${compactParams(d.inputSchema)}`
    })
    return [
      `工具目录(共 ${snap.defs.length} 个,按需取用;用 use_tool(name, args) 调用):`,
      '',
      blocks.join('\n\n'),
    ].join('\n')
  }

  async listTools(): Promise<LlmToolDefinition[]> {
    const snap = await this.resolve()
    return [this.directoryDef(), this.useToolDef(snap)]
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<LlmToolCallResult> {
    if (name === LIST_TOOL_DIRECTORY) {
      const snap = await this.resolve()
      return { content: [{ type: 'text', text: this.renderDirectory(snap) }] }
    }
    if (name === USE_TOOL) {
      const inner = args?.name
      if (typeof inner !== 'string' || inner.length === 0) {
        return {
          content: [
            { type: 'text', text: `use_tool 需要 name(目录里的工具名);先调 ${LIST_TOOL_DIRECTORY} 看清单。` },
          ],
          isError: true,
        }
      }
      const rawArgs = args?.args
      if (
        rawArgs !== undefined &&
        (typeof rawArgs !== 'object' || rawArgs === null || Array.isArray(rawArgs))
      ) {
        return {
          content: [{ type: 'text', text: `use_tool 的 args 必须是对象(拿到 ${describeValue(rawArgs)})。` }],
          isError: true,
        }
      }
      const snap = await this.resolve()
      const hit = snap.byName.get(inner)
      if (!hit) {
        const names = snap.defs.map((d) => d.name)
        return {
          content: [
            {
              type: 'text',
              text:
                `目录里没有「${inner}」。` +
                (names.length > 0 ? `可用:${names.join('、')}。` : '目录是空的。') +
                `先调 ${LIST_TOOL_DIRECTORY} 看说明。`,
            },
          ],
          isError: true,
        }
      }
      const innerArgs = (rawArgs ?? {}) as Record<string, unknown>
      const issues: string[] = []
      collectSchemaIssues(hit.def.inputSchema, innerArgs, 'args', issues)
      if (issues.length > 0) {
        return {
          content: [
            {
              type: 'text',
              text:
                `参数不符合 ${inner} 的要求:\n- ${issues.join('\n- ')}\n` +
                `该工具的参数:${compactParams(hit.def.inputSchema)}`,
            },
          ],
          isError: true,
        }
      }
      // 原样透传:结果对象/抛出的异常都与直调逐字节一致(不包不改不 catch)。
      return hit.owner.callTool(inner, innerArgs)
    }
    // 镜像 ComposedToolset:未知一等名回 isError,让 LLM 的回合活着。
    return { content: [{ type: 'text', text: `unknown tool: ${name}` }], isError: true }
  }

  /**
   * 镜像 ComposedToolset.runForTask:长尾 child 的 per-task 作用域全转发
   * (第一个 child 的作用域在最外层)。漏了这条,依赖 ALS 状态的长尾工具
   * 挪进目录就坏 —— 那是能力阉割,红线不许。
   */
  runForTask<T>(
    task: {
      readonly id: string
      readonly from: string
      readonly ancestry?: ReadonlyArray<{ taskId: string; by: string }>
    },
    fn: () => Promise<T>,
  ): Promise<T> {
    const layers = this.benignLongTail
      .filter((t): t is LlmAgentToolset & Required<Pick<LlmAgentToolset, 'runForTask'>> =>
        typeof t.runForTask === 'function',
      )
      .map((t) => t.runForTask.bind(t))
    if (layers.length === 0) return fn()
    const composed = layers.reduceRight<() => Promise<T>>(
      (next, layer) => () => layer(task, next),
      fn,
    )
    return composed()
  }
}
