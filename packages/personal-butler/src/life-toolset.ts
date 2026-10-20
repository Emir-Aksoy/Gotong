/**
 * life-toolset.ts — LIFE-M2。阿同的生活档案工具:一等四件 + 目录一件。
 *
 *   open_dossier    打开一本档案(现状/目标/待澄清/规程/流水统计)       一等
 *   log_record      校验后追加一条流水                                 一等
 *   query_records   按时间段聚合,由代码算数                           一等
 *   update_dossier  只改一个分区,带版本号                              一等
 *   read_records    原始记录分页(核对用)                              目录
 *
 * # 为什么是这个形状
 *
 * 今天阿同维护身体档案 = 打开工具目录 → 读整篇(最多 32KB 原样进上下文)→ 想清楚 →
 * 整篇写回(约 7200 字且越来越长)。长思考 + 长输出正是撞上游 100 秒切断的形状。
 * 这里每一步都小:记一条体重输出几十字,问趋势拿回代码算好的一行数,改判断只动一个
 * 分区。四件日常动词留一等(进缓存前缀),低频的原始记录核对折进目录。
 *
 * # 边界
 *
 *   - **benign**:只整理成员自己的档案,与任务本、知识库同级;档案里记下的对外动作
 *     执行时照样走各自的审批闸。
 *   - **读取预算**:一次执行内 open/query/read 共用一份字节预算(独立于记忆预算),
 *     同一内容(按内容哈希)重复读直接告知已读过、不再扣;用完响亮拒绝。写入的回执不扣。
 *   - **目标与规程只认成员原话**:直接设定/移除/确认提议都要 `user_quote`,且必须
 *     **整句等于**成员当轮消息(空白归一化;与 `remember` 的证据门同一标准)——只摘
 *     一段会让「今天」「好的」这类碎片配上任意目标。本轮刚提的提议本轮不能确认:
 *     成员得先看到它。否则只能写成提议。
 *   - 一等工具的描述不点名目录工具(防腐门的结构断言);read_records 只在档案卡
 *     正文里指路,并说明要经 use_tool。
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'

import type { Task } from '@gotong/core'
import type { LlmAgentToolset, LlmToolCallResult, LlmToolDefinition } from '@gotong/llm'
import { extractUserText, isHeartbeatPayload } from '@gotong/personal-memory'

import { ButlerError } from './errors.js'
import {
  addDays,
  isValidDate,
  monthStart,
  queryLifeRecords,
  resolveActive,
  weekStart,
  type LifeGoalMetric,
  type LifeQueryAgg,
} from './life-records.js'
import {
  LIFE_PAGE_MAX_BYTES,
  renderLifeDossierCard,
  renderLifeQueryResult,
  renderLifeRecordPage,
  renderLifeView,
} from './life-render.js'
import type { LifeArchive, LifeDossier } from './life-store.js'
import { LIFE_DOMAIN_TEMPLATES, allLifeStreamRefs, findLifeDomain, findLifeStream } from './life-templates.js'
import { readLongRunChildMarker, readLongRunSegmentMarker } from './longrun-dossier.js'

/** 读取预算:由 host 用 `new MemoryReadBudget(total, page)` 构造后注入(鸭子类型)。 */
export interface LifeReadBudget {
  readonly totalBytes: number
  runForTask<T>(task: { id: string }, fn: () => Promise<T>): Promise<T>
  consume(text: string, key?: string): boolean
  seen(key: string): boolean
  remaining(): number
}

export const LIFE_READ_BYTES = 9000
export const LIFE_READ_PAGE_BYTES = 3600

/** `runForTask` 收到的任务:`LlmAgent` 与管家的四个调用点都传完整 Task(有回归测试守着)。 */
export type LifeTaskLike = { readonly id: string; readonly from: string; readonly payload?: unknown }

export interface LifeToolsetOptions {
  readonly archive: LifeArchive
  readonly budget?: LifeReadBudget
  /** 当轮成员原话;拿不到 = 只能提议,不能确认。缺省 = `lifeTurnText`。 */
  readonly turnText?: (task: LifeTaskLike) => string | undefined
  readonly logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void }
}

/**
 * 当轮成员原话:与 `remember` 证据门同一来源(`extractUserText`)。心跳与长任务
 * 段/子轮的 payload 是机器渲染的提示词,不算成员原话。审批恢复的任务 payload
 * 仍是原来那句话——恢复的是同一轮,所以照常可用。
 */
export function lifeTurnText(task: LifeTaskLike): string | undefined {
  const payload = task.payload
  if (payload === undefined || payload === null) return undefined
  if (readLongRunSegmentMarker(payload) !== null || readLongRunChildMarker(payload) !== null) return undefined
  const t = task as unknown as Task
  if (isHeartbeatPayload(t)) return undefined
  const said = extractUserText(t).trim()
  return said === '' ? undefined : said
}

const DOMAIN_IDS = LIFE_DOMAIN_TEMPLATES.map((d) => d.id)
const QUERY_AGGS: LifeQueryAgg[] = ['latest', 'count', 'sum', 'avg', 'min', 'max', 'ma7', 'trend', 'streak', 'current']
const GOAL_AGGS = ['latest', 'ma7', 'avg7', 'week_count', 'week_sum', 'month_sum'] as const

const text = (t: string, isError = false): LlmToolCallResult => ({
  content: [{ type: 'text', text: t }],
  ...(isError ? { isError: true } : {}),
})

const norm = (s: string) => s.replace(/\s+/g, '')

function str(v: unknown, what: string, max = 200): string {
  if (typeof v !== 'string' || v.trim().length === 0) throw new ButlerError('life_invalid', `${what}不能为空`)
  const s = v.trim()
  if ([...s].length > max) throw new ButlerError('life_invalid', `${what}最多 ${max} 字(收到 ${[...s].length} 字)`)
  return s
}

function parseMetric(raw: unknown, domainId: string): LifeGoalMetric | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new ButlerError('life_invalid', 'metric 要是对象')
  const m = raw as Record<string, unknown>
  const ref = typeof m.stream === 'string' ? (m.stream.includes('.') ? m.stream : `${domainId}.${m.stream}`) : ''
  const found = findLifeStream(ref)
  if (!found || found.domain.id !== domainId) {
    throw new ButlerError('life_invalid', `metric.stream 要是本档案的流水(${findLifeDomain(domainId)!.streams.map((s) => `${domainId}.${s.id}`).join('、')})`)
  }
  if (!GOAL_AGGS.includes(m.agg as (typeof GOAL_AGGS)[number])) {
    throw new ButlerError('life_invalid', `metric.agg 只能是 ${GOAL_AGGS.join(' / ')}`)
  }
  if (m.op !== '<=' && m.op !== '>=') throw new ButlerError('life_invalid', 'metric.op 只能是 <= 或 >=')
  if (typeof m.target !== 'number' || !Number.isFinite(m.target)) throw new ButlerError('life_invalid', 'metric.target 要是数字')
  const field = typeof m.field === 'string' ? m.field : undefined
  if (field) {
    const f = found.stream.fields.find((x) => x.name === field)
    if (!f || (f.type !== 'number' && f.type !== 'integer')) throw new ButlerError('life_invalid', `metric.field「${field}」不是数值字段`)
  } else if (!found.stream.primary && m.agg !== 'week_count') {
    throw new ButlerError('life_invalid', 'metric 需要给数值字段 field')
  }
  let where: Record<string, string> | undefined
  if (m.where !== undefined) {
    if (!m.where || typeof m.where !== 'object' || Array.isArray(m.where)) throw new ButlerError('life_invalid', 'metric.where 要是对象')
    where = {}
    for (const [k, v] of Object.entries(m.where as Record<string, unknown>)) {
      if (!found.stream.fields.some((f) => f.name === k)) throw new ButlerError('life_invalid', `metric.where 里没有字段「${k}」`)
      where[k] = String(v)
    }
  }
  // 带币种的流水:目标没指定币种就按该字段的默认币种算,不把 CNY 和 MYR 加在一起。
  const cf = found.stream.currencyField
  if (cf && where?.[cf] === undefined) {
    const def = found.stream.fields.find((f) => f.name === cf)?.default
    if (def !== undefined) where = { ...where, [cf]: String(def) }
  }
  return {
    stream: ref,
    agg: m.agg as LifeGoalMetric['agg'],
    ...(field ? { field } : {}),
    ...(where ? { where } : {}),
    op: m.op,
    target: m.target,
  }
}

function resolveRange(args: Record<string, unknown>, today: string): { from?: string; to: string } {
  const period = args.period
  if (typeof period === 'string') {
    switch (period) {
      case 'this_week':
        return { from: weekStart(today), to: today }
      case 'last_week': {
        const start = addDays(weekStart(today), -7)
        return { from: start, to: addDays(start, 6) }
      }
      case 'this_month':
        return { from: monthStart(today), to: today }
      case 'last_month': {
        const prevEnd = addDays(monthStart(today), -1)
        return { from: monthStart(prevEnd), to: prevEnd }
      }
      case 'all':
        return { to: today }
      default:
        throw new ButlerError('life_invalid', 'period 只能是 this_week / last_week / this_month / last_month / all')
    }
  }
  const to = typeof args.to === 'string' && args.to ? args.to : today
  if (!isValidDate(to)) throw new ButlerError('life_invalid', `to 要写成 YYYY-MM-DD(收到「${to}」)`)
  if (typeof args.days === 'number') {
    if (!Number.isInteger(args.days) || args.days < 1 || args.days > 3660) {
      throw new ButlerError('life_invalid', 'days 要是 1–3660 的整数')
    }
    return { from: addDays(to, -(args.days - 1)), to }
  }
  if (typeof args.from === 'string' && args.from) {
    if (!isValidDate(args.from)) throw new ButlerError('life_invalid', `from 要写成 YYYY-MM-DD(收到「${args.from}」)`)
    return { from: args.from, to }
  }
  return { to }
}

/**
 * 两个 toolset 共享预算与当轮作用域:`core` 上脸,`archive`(read_records)进目录。
 */
export function createLifeToolsets(opts: LifeToolsetOptions): { core: LlmAgentToolset; archive: LlmAgentToolset } {
  const { archive } = opts
  const turnTextOf = opts.turnText ?? lifeTurnText
  const taskScope = new AsyncLocalStorage<{ id: string; said?: string }>()
  const runForTask = <T>(task: LifeTaskLike, fn: () => Promise<T>): Promise<T> => {
    const inner = () => {
      if (taskScope.getStore()?.id === task.id) return fn()
      const said = turnTextOf(task)
      return taskScope.run({ id: task.id, ...(said ? { said } : {}) }, fn)
    }
    return opts.budget ? opts.budget.runForTask(task, inner) : inner()
  }

  const exhausted = () =>
    `本次任务的生活档案读取额度已用完(共 ${opts.budget?.totalBytes ?? 0} 字节)。请基于已经读到的内容作答;需要更多细节时请成员缩小问题范围后再问。`

  /**
   * 读类结果过预算。已读过同一内容 → 告知,不重复给;额度不够 → 拒。
   * 键是内容哈希:写入后重查,数字变了就是新内容(按长度做键会把 72.4→72.1 当成没变)。
   */
  const charge = (out: string, kind: string): LlmToolCallResult => {
    const b = opts.budget
    if (!b) return text(out)
    const key = `${kind}:${createHash('sha256').update(out).digest('hex').slice(0, 24)}`
    if (b.seen(key)) return text('这份内容本次任务里已经返回过,内容没有变化——直接用上面那份。')
    if (!b.consume(out, key)) return text(exhausted(), true)
    return text(out)
  }

  const refreshView = async (domainId: string) => {
    try {
      const snap = await archive.snapshot(domainId)
      await archive.writeDerived(`views/${snap.domain.label}.md`, renderLifeView(snap))
    } catch (err) {
      opts.logger?.warn('[life] view refresh failed', { domain: domainId, err: String(err) })
    }
  }

  /** 原话门:整句等于成员当轮消息。返回存档用的原话(过长截前 200 字)。 */
  const requireQuote = (raw: unknown): string => {
    if (typeof raw !== 'string' || raw.trim() === '') throw new ButlerError('life_invalid', 'user_quote 不能为空')
    const said = taskScope.getStore()?.said
    if (!said) {
      throw new ButlerError('life_invalid', '这一轮没有成员原话(后台心跳或长任务分段),只能先写成提议(op=propose),等成员下次确认')
    }
    if (norm(raw) !== norm(said)) {
      throw new ButlerError(
        'life_invalid',
        'user_quote 必须是成员这一轮消息的完整原话(整句照抄,不能只摘一段)——成员没有明确这么说,就写成提议(op=propose)等成员确认',
      )
    }
    const chars = [...said.trim()]
    return chars.length > 200 ? `${chars.slice(0, 200).join('')}…` : chars.join('')
  }

  const coreDefs: LlmToolDefinition[] = [
    {
      name: 'open_dossier',
      description:
        '打开一本生活档案:代码算好的现状、目标与进度、待澄清、待确认提议、提醒、这本档案的规程(怎么记、怎么答、怎么判断)和流水统计。' +
        '涉及某个生活领域时先打开它,再按规程记录和作答。',
      inputSchema: {
        type: 'object',
        properties: {
          domain: { type: 'string', enum: DOMAIN_IDS, description: LIFE_DOMAIN_TEMPLATES.map((d) => `${d.id}=${d.label}`).join(',') },
        },
        required: ['domain'],
        additionalProperties: false,
      },
    },
    {
      name: 'log_record',
      description:
        '往生活档案追加一条流水(体重、训练、睡眠、心境、收支、项目状态、承诺、决定……)。字段按档案卡里列的字段名填,写入时校验单位与范围,' +
        '不对会说明正确写法。at 是事件日期(YYYY-MM-DD 或 YYYY-MM-DD HH:MM),缺省今天;成员说「昨天」就写昨天的日期。' +
        '记错了:supersedes=旧记录 id 并给出正确 fields;要删掉:supersedes=旧 id 且 retract=true(按名称取最新的流水撤回最新一条后,当前状态回到上一条;事情不再跟踪就记一条新状态,不要撤回)。推断的数值设 inferred=true。',
      inputSchema: {
        type: 'object',
        properties: {
          stream: { type: 'string', enum: allLifeStreamRefs() },
          fields: { type: 'object', description: '字段名→值,如 {"kg":72.4,"condition":"晨起空腹"}' },
          at: { type: 'string' },
          supersedes: { type: 'string', description: '被取代/撤回那条的 id' },
          retract: { type: 'boolean' },
          inferred: { type: 'boolean', description: '数值是你推断的(成员没明说)' },
        },
        required: ['stream'],
        additionalProperties: false,
      },
    },
    {
      name: 'query_records',
      description:
        '按时间段查生活档案流水,由代码计算后只返回结果,不返回整表。agg:latest 最新一条 / count / sum / avg / min / max / ma7 七日均值 / trend 周斜率(每周变化) / ' +
        'streak 连续天数 / current 状态型流水的当前状态(项目、承诺、决定、账户、固定支出)。时间用 period(this_week/last_week/this_month/last_month/all)' +
        '或 days(最近 N 天)或 from/to;group_by 可按 day/week/month 或某字段(如 category)分组;where 按字段等值筛选(如 {"direction":"支出"})。',
      inputSchema: {
        type: 'object',
        properties: {
          stream: { type: 'string', enum: allLifeStreamRefs() },
          agg: { type: 'string', enum: QUERY_AGGS },
          field: { type: 'string', description: '数值字段,缺省用该流水的主字段' },
          period: { type: 'string', enum: ['this_week', 'last_week', 'this_month', 'last_month', 'all'] },
          days: { type: 'integer', minimum: 1, maximum: 3660 },
          from: { type: 'string' },
          to: { type: 'string' },
          group_by: { type: 'string' },
          where: { type: 'object' },
        },
        required: ['stream', 'agg'],
        additionalProperties: false,
      },
    },
    {
      name: 'update_dossier',
      description:
        '只改档案的一个分区,必须带 open_dossier 返回的版本号 revision。section/op:' +
        'status_note:set(一句现状判断,≤300 字);insights:add(text+evidence 证据日期范围+confidence 高/中/低)/replace(id)/remove(id);' +
        'open_questions:add / close(id);goals:propose(text,可带 metric 与 due;带 id 表示提议移除该目标)/ set / remove(id);' +
        'protocol:propose(补充条款;带 id 表示提议移除)/ set / remove(id);proposals:confirm(id)/ reject(id)。' +
        'goals 与 protocol 的 set/remove 以及 proposals 的 confirm 都必须带 user_quote——成员这一轮消息的完整原话(整句照抄,不要只摘一段);成员没明说就只能 propose,你这一轮刚提的提议要等成员下一条消息确认。' +
        'metric 形如 {"stream":"finance.tx","agg":"month_sum","where":{"direction":"支出","category":"餐饮"},"op":"<=","target":2000}' +
        '(agg 可用 latest/ma7/avg7/week_count/week_sum/month_sum)。',
      inputSchema: {
        type: 'object',
        properties: {
          domain: { type: 'string', enum: DOMAIN_IDS },
          revision: { type: 'integer', minimum: 0 },
          section: { type: 'string', enum: ['status_note', 'insights', 'open_questions', 'goals', 'protocol', 'proposals'] },
          op: { type: 'string', enum: ['set', 'add', 'replace', 'remove', 'close', 'propose', 'confirm', 'reject'] },
          id: { type: 'string' },
          text: { type: 'string' },
          evidence: { type: 'string' },
          confidence: { type: 'string', enum: ['高', '中', '低'] },
          metric: { type: 'object' },
          due: { type: 'string' },
          user_quote: { type: 'string' },
        },
        required: ['domain', 'revision', 'section', 'op'],
        additionalProperties: false,
      },
    },
  ]

  const archiveDefs: LlmToolDefinition[] = [
    {
      name: 'read_records',
      description:
        '分页读生活档案某条流水的原始记录(含被取代/撤回的历史行与 id),用于核对或找要更正那条的 id。可用 from/to 限定日期,offset 翻页。',
      inputSchema: {
        type: 'object',
        properties: {
          stream: { type: 'string', enum: allLifeStreamRefs() },
          from: { type: 'string' },
          to: { type: 'string' },
          offset: { type: 'integer', minimum: 0 },
        },
        required: ['stream'],
        additionalProperties: false,
      },
    },
  ]

  async function openDossier(args: Record<string, unknown>): Promise<LlmToolCallResult> {
    const domain = String(args.domain ?? '')
    const snap = await archive.snapshot(domain)
    const card = renderLifeDossierCard(snap)
    return charge(card, 'dossier')
  }

  async function logRecord(args: Record<string, unknown>): Promise<LlmToolCallResult> {
    const stream = String(args.stream ?? '')
    const said = taskScope.getStore()?.said
    const excerpt = said ? [...said].slice(0, 40).join('') : undefined
    // 第一次写入即启用(file-first:登记表在 ⇒ 驾驶舱卡出现、后台扫描开始照看)。
    await archive.ensureRegistry()
    const { record, target } = await archive.appendRecord({
      stream,
      fields: args.fields,
      at: args.at,
      ...(typeof args.supersedes === 'string' && args.supersedes ? { supersedes: args.supersedes } : {}),
      ...(args.retract === true ? { retract: true } : {}),
      // 没有成员原话的轮次(心跳、长任务分段)记下的值不算成员说的。
      source: { kind: args.inferred === true || !said ? 'inferred' : 'user', ...(excerpt ? { excerpt } : {}) },
    })
    const domainId = stream.split('.')[0]!
    const snap = await archive.snapshot(domainId)
    void refreshView(domainId)
    const fieldsText = Object.entries(record.fields).map(([k, v]) => `${k}=${String(v)}`).join(' ')
    const what = record.retracted
      ? `已撤回 ${target?.id}(原记录 ${target?.at})`
      : `已记 ${stream}(id ${record.id},${record.at}):${fieldsText}${target ? `,取代 ${target.id}` : ''}`
    const lines = [what]
    // 回执只带这条流水相关的现状(代码算的)+ 本领域当前提醒,最多三条——够模型顺口告诉成员,
    // 不必再开档案卡。
    const streamId = findLifeStream(stream)!.stream.id
    const labels = snap.domain.status.filter((m) => m.stream === streamId).map((m) => `${m.label}:`)
    const related = snap.statusLines.filter((l) => labels.some((p) => l.startsWith(p))).slice(0, 3)
    if (related.length) lines.push(`现状:${related.join(';')}`)
    if (snap.alerts.length) lines.push(`提醒:${snap.alerts.slice(0, 3).map((a) => a.text).join(';')}`)
    return text(lines.join('\n'))
  }

  async function queryRecords(args: Record<string, unknown>): Promise<LlmToolCallResult> {
    const ref = String(args.stream ?? '')
    const found = findLifeStream(ref)
    if (!found) throw new ButlerError('life_not_found', `没有流水「${ref}」`)
    const agg = String(args.agg ?? '') as LifeQueryAgg
    if (!QUERY_AGGS.includes(agg)) throw new ButlerError('life_invalid', `agg 只能是 ${QUERY_AGGS.join(' / ')}`)
    const range = resolveRange(args, archive.today())
    let where: Record<string, string> | undefined
    if (args.where !== undefined) {
      if (!args.where || typeof args.where !== 'object' || Array.isArray(args.where)) throw new ButlerError('life_invalid', 'where 要是对象')
      where = {}
      for (const [k, v] of Object.entries(args.where as Record<string, unknown>)) {
        if (!found.stream.fields.some((f) => f.name === k)) throw new ButlerError('life_invalid', `where 里没有字段「${k}」`)
        where[k] = String(v)
      }
    }
    const active = resolveActive(await archive.readRecords(ref), found.stream)
    const res = queryLifeRecords(active, found.stream, {
      agg,
      ...(typeof args.field === 'string' && args.field ? { field: args.field } : {}),
      ...(range.from ? { from: range.from } : {}),
      to: range.to,
      ...(where ? { where } : {}),
      ...(typeof args.group_by === 'string' && args.group_by ? { groupBy: args.group_by } : {}),
    })
    const out = renderLifeQueryResult(ref, agg, res)
    return charge(out, 'query')
  }

  async function readRecords(args: Record<string, unknown>): Promise<LlmToolCallResult> {
    const ref = String(args.stream ?? '')
    if (!findLifeStream(ref)) throw new ButlerError('life_not_found', `没有流水「${ref}」`)
    const from = typeof args.from === 'string' && args.from ? args.from : undefined
    const to = typeof args.to === 'string' && args.to ? args.to : undefined
    for (const [k, v] of [['from', from], ['to', to]] as const) {
      if (v !== undefined && !isValidDate(v)) throw new ButlerError('life_invalid', `${k} 要写成 YYYY-MM-DD`)
    }
    const rows = (await archive.readRecords(ref))
      .filter((r) => (!from || r.at.slice(0, 10) >= from) && (!to || r.at.slice(0, 10) <= to))
      .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.recordedAt < b.recordedAt ? -1 : 1))
    const offset = typeof args.offset === 'number' && Number.isInteger(args.offset) && args.offset >= 0 ? args.offset : 0
    if (rows.length === 0) return text(`${ref} 在这个范围里没有记录。`)
    if (offset >= rows.length) return text(`offset 超出范围(共 ${rows.length} 条)。`)
    const page = renderLifeRecordPage(ref, rows, offset)
    if (Buffer.byteLength(page.text, 'utf8') > LIFE_PAGE_MAX_BYTES) return text('单页超出上限', true)
    return charge(page.text, 'records')
  }

  async function updateDossier(args: Record<string, unknown>): Promise<LlmToolCallResult> {
    const domainId = String(args.domain ?? '')
    const domain = findLifeDomain(domainId)
    if (!domain) throw new ButlerError('life_not_found', `没有档案「${domainId}」`)
    if (typeof args.revision !== 'number' || !Number.isInteger(args.revision)) {
      throw new ButlerError('life_invalid', 'revision 要是 open_dossier 返回的版本号(整数)')
    }
    const section = String(args.section ?? '')
    const op = String(args.op ?? '')
    // 本地日期(与流水的 at 同口径):卡片只截日期显示,用 UTC 会在早晨显示成前一天。
    const at = archive.today()
    const id = typeof args.id === 'string' ? args.id.trim() : ''
    const needId = (list: ReadonlyArray<{ id: string }>, what: string) => {
      if (!id || !list.some((x) => x.id === id)) {
        throw new ButlerError('life_not_found', `${what}里没有「${id || '(未给 id)'}」——用 open_dossier 看现有条目的 id`)
      }
      return id
    }
    // 原话校验在锁外做(只读当轮作用域),锁内只做数据变换。
    const quote = ['set', 'remove', 'confirm'].includes(op) && ['goals', 'protocol', 'proposals'].includes(section)
      ? requireQuote(args.user_quote)
      : undefined
    const due = typeof args.due === 'string' && args.due ? args.due : undefined
    if (due !== undefined && !isValidDate(due)) throw new ButlerError('life_invalid', 'due 要写成 YYYY-MM-DD')
    const metric = section === 'goals' && (op === 'propose' || op === 'set') && !id ? parseMetric(args.metric, domainId) : undefined

    let summary = ''
    const scope = taskScope.getStore()
    await archive.ensureRegistry()
    const next = await archive.updateDossier(domainId, args.revision, (d, nextId) => {
      const done = (dossier: LifeDossier, log: string) => {
        summary = log
        return { dossier, log }
      }
      // 提议记下提出它的任务:同一任务里不许确认(成员还没看到)。记在盘上而不是
      // 内存里,审批挂起再恢复(新的作用域)也认得出是同一任务。
      const propose = (dossier: LifeDossier, p: { id: string }, log: string) =>
        done(
          scope
            ? { ...dossier, proposals: dossier.proposals.map((x) => (x.id === p.id ? { ...x, taskId: scope.id } : x)) }
            : dossier,
          log,
        )
      switch (`${section}:${op}`) {
        case 'status_note:set': {
          const t = str(args.text, '现状判断', 300)
          return done({ ...d, statusNote: { text: t, at } }, `更新现状判断`)
        }
        case 'insights:add': {
          const item = {
            id: nextId('i'),
            text: str(args.text, '洞察', 200),
            evidence: str(args.evidence, 'evidence(证据日期范围)', 60),
            confidence: (['高', '中', '低'].includes(String(args.confidence)) ? args.confidence : '中') as '高' | '中' | '低',
            at,
          }
          return done({ ...d, insights: [...d.insights, item] }, `新增洞察 ${item.id}`)
        }
        case 'insights:replace': {
          needId(d.insights, '洞察')
          return done(
            {
              ...d,
              insights: d.insights.map((i) =>
                i.id === id
                  ? {
                      ...i,
                      text: str(args.text, '洞察', 200),
                      ...(typeof args.evidence === 'string' && args.evidence ? { evidence: str(args.evidence, 'evidence', 60) } : {}),
                      ...(['高', '中', '低'].includes(String(args.confidence)) ? { confidence: args.confidence as '高' | '中' | '低' } : {}),
                      at,
                    }
                  : i,
              ),
            },
            `改写洞察 ${id}`,
          )
        }
        case 'insights:remove':
          needId(d.insights, '洞察')
          return done({ ...d, insights: d.insights.filter((i) => i.id !== id) }, `删除洞察 ${id}`)
        case 'open_questions:add': {
          const item = { id: nextId('q'), text: str(args.text, '待澄清', 200), at }
          return done({ ...d, openQuestions: [...d.openQuestions, item] }, `新增待澄清 ${item.id}`)
        }
        case 'open_questions:close':
          needId(d.openQuestions, '待澄清')
          return done({ ...d, openQuestions: d.openQuestions.filter((q) => q.id !== id) }, `关闭待澄清 ${id}`)
        case 'goals:propose': {
          if (id) {
            const g = d.goals.find((x) => x.id === needId(d.goals, '目标'))!
            const p = { id: nextId('p'), kind: 'remove_goal' as const, text: g.text, targetId: id, at, by: 'atong' as const }
            return propose({ ...d, proposals: [...d.proposals, p] }, p, `提议移除目标 ${id}(${p.id})`)
          }
          const p = {
            id: nextId('p'),
            kind: 'goal' as const,
            text: str(args.text, '目标', 200),
            ...(metric ? { metric } : {}),
            ...(due ? { due } : {}),
            at,
            by: 'atong' as const,
          }
          return propose({ ...d, proposals: [...d.proposals, p] }, p, `提议新目标 ${p.id}`)
        }
        case 'goals:set': {
          const g = {
            id: nextId('g'),
            text: str(args.text, '目标', 200),
            ...(metric ? { metric } : {}),
            ...(due ? { due } : {}),
            confirmedAt: at,
            quote: quote!,
          }
          return done({ ...d, goals: [...d.goals, g] }, `按成员原话设定目标 ${g.id}`)
        }
        case 'goals:remove':
          needId(d.goals, '目标')
          return done({ ...d, goals: d.goals.filter((g) => g.id !== id) }, `按成员原话移除目标 ${id}`)
        case 'protocol:propose': {
          if (id) {
            const a = d.protocolAdditions.find((x) => x.id === needId(d.protocolAdditions, '补充条款'))!
            const p = { id: nextId('p'), kind: 'remove_protocol' as const, text: a.text, targetId: id, at, by: 'atong' as const }
            return propose({ ...d, proposals: [...d.proposals, p] }, p, `提议移除条款 ${id}(${p.id})`)
          }
          const p = { id: nextId('p'), kind: 'protocol' as const, text: str(args.text, '补充条款', 200), at, by: 'atong' as const }
          return propose({ ...d, proposals: [...d.proposals, p] }, p, `提议补充条款 ${p.id}`)
        }
        case 'protocol:set': {
          const a = { id: nextId('c'), text: str(args.text, '补充条款', 200), confirmedAt: at, quote: quote! }
          return done({ ...d, protocolAdditions: [...d.protocolAdditions, a] }, `按成员原话补充条款 ${a.id}`)
        }
        case 'protocol:remove':
          needId(d.protocolAdditions, '补充条款')
          return done({ ...d, protocolAdditions: d.protocolAdditions.filter((a) => a.id !== id) }, `按成员原话移除条款 ${id}`)
        case 'proposals:reject':
          needId(d.proposals, '提议')
          return done({ ...d, proposals: d.proposals.filter((p) => p.id !== id) }, `撤回提议 ${id}`)
        case 'proposals:confirm': {
          const p = d.proposals.find((x) => x.id === needId(d.proposals, '提议'))!
          if (scope && p.taskId === scope.id) {
            throw new ButlerError('life_invalid', `提议 ${p.id} 是这一轮刚提的——先告诉成员,等成员下一条消息确认`)
          }
          const rest = d.proposals.filter((x) => x.id !== id)
          switch (p.kind) {
            case 'goal': {
              const g = {
                id: nextId('g'),
                text: p.text,
                ...(p.metric ? { metric: p.metric } : {}),
                ...(p.due ? { due: p.due } : {}),
                confirmedAt: at,
                quote: quote!,
              }
              return done({ ...d, proposals: rest, goals: [...d.goals, g] }, `成员确认提议 ${id} → 目标 ${g.id}`)
            }
            case 'protocol': {
              const a = { id: nextId('c'), text: p.text, confirmedAt: at, quote: quote! }
              return done({ ...d, proposals: rest, protocolAdditions: [...d.protocolAdditions, a] }, `成员确认提议 ${id} → 条款 ${a.id}`)
            }
            case 'remove_goal':
              return done({ ...d, proposals: rest, goals: d.goals.filter((g) => g.id !== p.targetId) }, `成员确认移除目标 ${p.targetId}`)
            case 'remove_protocol':
              return done(
                { ...d, proposals: rest, protocolAdditions: d.protocolAdditions.filter((a) => a.id !== p.targetId) },
                `成员确认移除条款 ${p.targetId}`,
              )
          }
          break
        }
      }
      throw new ButlerError(
        'life_invalid',
        `不支持 section=${section} op=${op}。见工具说明里每个分区可用的 op`,
      )
    })
    void refreshView(domainId)
    return text(`已更新 ${domain.label}:${summary}(版本 r${next.revision})`)
  }

  const wrap =
    (handlers: Record<string, (args: Record<string, unknown>) => Promise<LlmToolCallResult>>) =>
    async (name: string, args: Record<string, unknown>): Promise<LlmToolCallResult> => {
      const h = handlers[name]
      if (!h) return text(`未知工具 ${name}`, true)
      try {
        return await h(args ?? {})
      } catch (err) {
        // 拒绝(校验/上限/冲突/找不到)以友好文本回给模型自行纠正,绝不炸轮。
        return text(err instanceof Error ? err.message : String(err), true)
      }
    }

  const core: LlmAgentToolset = {
    listTools: () => coreDefs,
    callTool: wrap({
      open_dossier: openDossier,
      log_record: logRecord,
      query_records: queryRecords,
      update_dossier: updateDossier,
    }),
    runForTask,
  }
  const archiveToolset: LlmAgentToolset = {
    listTools: () => archiveDefs,
    callTool: wrap({ read_records: readRecords }),
    runForTask,
  }
  return { core, archive: archiveToolset }
}
