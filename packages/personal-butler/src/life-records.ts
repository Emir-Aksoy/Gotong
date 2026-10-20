/**
 * life-records.ts — LIFE-M1。生活档案流水的**纯函数核**:字段校验、取代/撤回解析、
 * 日期算术、聚合计算、提醒评估。零 IO、零时钟(今天由调用方传入)。
 *
 * # 为什么聚合必须在代码里
 *
 * 「这个月瘦得怎么样」今天的做法是模型读整份档案再心算——慢(长思考撞上游 100 秒
 * 切断)、会算错、还要把整份原文搬进上下文。这里把均线、周斜率、月合计、连续天数
 * 全做成确定性函数:模型拿到算好的数,只负责解释。同一份数据永远算出同一个结果,
 * 测试能逐项对表。
 *
 * # 取代而不是改写
 *
 * 流水只追加。记错了写一条 `supersedes` 指向旧 id 的新记录;删掉 = 写一条
 * `retracted` 的撤回记录。读侧解析出「当前有效」集合,历史行原样留在盘上可查——
 * 与时间记忆「失效而不删除」同一立场。
 */

import { ButlerError } from './errors.js'
import type {
  LifeAlertRule,
  LifeDomainTemplate,
  LifeFieldSpec,
  LifeStatusAgg,
  LifeStatusMetric,
  LifeStreamSpec,
} from './life-templates.js'

export type LifeFieldValue = string | number | boolean

export interface LifeRecordSource {
  /** user = 成员当轮说的;inferred = 阿同推断;import = 迁移导入。 */
  readonly kind: 'user' | 'inferred' | 'import'
  /** 当轮成员原话的开头片段(自动附上,模型不用复述)。 */
  readonly excerpt?: string
}

export interface LifeRecord {
  readonly id: string
  /** `health.weight` 这种流水引用。 */
  readonly stream: string
  /** 事件时间:`YYYY-MM-DD` 或 `YYYY-MM-DD HH:MM`(本地时区)。 */
  readonly at: string
  /** 记录时间(ISO,UTC)。 */
  readonly recordedAt: string
  readonly source: LifeRecordSource
  readonly fields: Readonly<Record<string, LifeFieldValue>>
  readonly supersedes?: string
  readonly retracted?: true
}

// ─── 日期 ────────────────────────────────────────────────────────────────────

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const AT_RE = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}):(\d{2}))?$/
const TIME_RE = /^(\d{2}):(\d{2})$/

/** 某时刻在给定 IANA 时区里的本地日期 `YYYY-MM-DD`。 */
export function localDate(ms: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(ms))
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00'
  return `${get('year')}-${get('month')}-${get('day')}`
}

/** 某时刻在给定时区里的本地小时(0–23)。 */
export function localHour(ms: number, timeZone: string): number {
  const h = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hourCycle: 'h23' }).format(new Date(ms))
  return Number.parseInt(h, 10) % 24
}

/** 某时刻在给定时区里的本地时刻 `HH:MM`。 */
export function localTime(ms: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms))
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00'
  return `${get('hour')}:${get('minute')}`
}

function dateToUtcMs(date: string): number {
  const m = DATE_RE.exec(date)
  if (!m) throw new ButlerError('life_invalid', `日期要写成 YYYY-MM-DD(收到「${date}」)`)
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
}

export function isValidDate(date: string): boolean {
  const m = DATE_RE.exec(date)
  if (!m) return false
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return new Date(ms).toISOString().slice(0, 10) === date
}

export function addDays(date: string, n: number): string {
  return new Date(dateToUtcMs(date) + n * 86_400_000).toISOString().slice(0, 10)
}

export function daysBetween(from: string, to: string): number {
  return Math.round((dateToUtcMs(to) - dateToUtcMs(from)) / 86_400_000)
}

/** ISO 周的周一。 */
export function weekStart(date: string): string {
  const dow = new Date(dateToUtcMs(date)).getUTCDay() // 0=周日
  return addDays(date, -((dow + 6) % 7))
}

export function monthStart(date: string): string {
  return `${date.slice(0, 7)}-01`
}

/** `2026-W43` 形式的 ISO 周标签。 */
export function isoWeekLabel(date: string): string {
  const ms = dateToUtcMs(date)
  const d = new Date(ms)
  const dow = (d.getUTCDay() + 6) % 7
  const thursday = new Date(ms + (3 - dow) * 86_400_000)
  const yearStart = Date.UTC(thursday.getUTCFullYear(), 0, 1)
  const week = Math.floor((thursday.getTime() - yearStart) / 86_400_000 / 7) + 1
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

export const recordDate = (r: Pick<LifeRecord, 'at'>): string => r.at.slice(0, 10)

/** 规范化事件时间;缺省 = 今天。未来日期与 2000 年以前一律拒。 */
export function normalizeAt(raw: unknown, today: string): string {
  if (raw === undefined || raw === null || raw === '') return today
  if (typeof raw !== 'string') throw new ButlerError('life_invalid', 'at 要写成 YYYY-MM-DD 或 YYYY-MM-DD HH:MM')
  const m = AT_RE.exec(raw.trim())
  if (!m || !isValidDate(m[1]!)) {
    throw new ButlerError('life_invalid', `at 要写成 YYYY-MM-DD 或 YYYY-MM-DD HH:MM(收到「${raw}」)`)
  }
  const date = m[1]!
  if (m[2] !== undefined && (Number(m[2]) > 23 || Number(m[3]) > 59)) {
    throw new ButlerError('life_invalid', `at 的时间不对(收到「${raw}」)`)
  }
  if (date > today) throw new ButlerError('life_invalid', `at 是未来日期(${date} > 今天 ${today})——事件只能记已经发生的`)
  if (date < '2000-01-01') throw new ButlerError('life_invalid', `at 太早(${date})`)
  return m[2] !== undefined ? `${date} ${m[2]}:${m[3]}` : date
}

// ─── 字段校验 ────────────────────────────────────────────────────────────────

const DEFAULT_TEXT_CHARS = 200

function describeField(f: LifeFieldSpec): string {
  const parts: string[] = [f.label]
  if (f.type === 'enum' && f.values) parts.push(`可选:${f.values.join('/')}`)
  if (f.unit) parts.push(`单位 ${f.unit}`)
  if (f.min !== undefined || f.max !== undefined) parts.push(`范围 ${f.min ?? '-∞'}–${f.max ?? '∞'}`)
  if (f.type === 'date') parts.push('YYYY-MM-DD')
  if (f.type === 'time') parts.push('HH:MM')
  return parts.join(',')
}

/** 给工具描述/报错用的字段一行说明:`kg(体重,单位 kg,范围 20–300,必填)`。 */
export function describeStreamFields(stream: LifeStreamSpec): string {
  return stream.fields
    .map((f) => `${f.name}(${describeField(f)}${f.required ? ',必填' : ''})`)
    .join(';')
}

function coerceField(f: LifeFieldSpec, raw: unknown): LifeFieldValue {
  const bad = (why: string): never => {
    throw new ButlerError('life_invalid', `字段 ${f.name}(${describeField(f)}):${why}`)
  }
  switch (f.type) {
    case 'number':
    case 'integer': {
      const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw.trim()) : NaN
      if (!Number.isFinite(n)) bad(`要是数字(收到「${String(raw)}」)——单位按 ${f.unit ?? '模板'} 换算后只填数字`)
      if (f.type === 'integer' && !Number.isInteger(n)) bad(`要是整数(收到 ${n})`)
      if (f.min !== undefined && n < f.min) bad(`不能小于 ${f.min}(收到 ${n})`)
      if (f.max !== undefined && n > f.max) bad(`不能大于 ${f.max}(收到 ${n})`)
      if (f.type === 'number' && f.decimals !== undefined) {
        const k = 10 ** f.decimals
        return Math.round(n * k) / k
      }
      return n
    }
    case 'enum': {
      const s = typeof raw === 'string' ? raw.trim() : String(raw)
      if (!f.values?.includes(s)) bad(`只能是 ${f.values?.join(' / ')}(收到「${s}」)`)
      return s
    }
    case 'date': {
      const s = typeof raw === 'string' ? raw.trim() : ''
      if (!isValidDate(s)) bad(`要写成 YYYY-MM-DD(收到「${String(raw)}」)`)
      return s
    }
    case 'time': {
      const s = typeof raw === 'string' ? raw.trim() : ''
      const m = TIME_RE.exec(s)
      if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) bad(`要写成 HH:MM(收到「${String(raw)}」)`)
      return s
    }
    case 'boolean': {
      if (typeof raw === 'boolean') return raw
      if (raw === 'true' || raw === '是') return true
      if (raw === 'false' || raw === '否') return false
      return bad(`要是 true/false(收到「${String(raw)}」)`)
    }
    case 'text': {
      const s = typeof raw === 'string' ? raw.trim() : String(raw)
      const max = f.maxChars ?? DEFAULT_TEXT_CHARS
      if ([...s].length > max) bad(`太长(${[...s].length} > ${max} 字)——写要点`)
      return s
    }
  }
}

/**
 * 按模板校验并规范化一条记录的字段。未知字段、缺必填、越界、枚举不符一律响亮拒,
 * 报错带上正确写法——模型据此自行纠正,绝不静默丢字段。
 */
export function validateLifeFields(stream: LifeStreamSpec, raw: unknown): Record<string, LifeFieldValue> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ButlerError('life_invalid', `fields 要是对象。这条流水的字段:${describeStreamFields(stream)}`)
  }
  const input = raw as Record<string, unknown>
  const known = new Set(stream.fields.map((f) => f.name))
  const unknown = Object.keys(input).filter((k) => !known.has(k))
  if (unknown.length > 0) {
    throw new ButlerError(
      'life_invalid',
      `不认识的字段:${unknown.join('、')}。这条流水的字段:${describeStreamFields(stream)}`,
    )
  }
  const out: Record<string, LifeFieldValue> = {}
  for (const f of stream.fields) {
    const v = input[f.name]
    if (v === undefined || v === null || v === '') {
      if (f.default !== undefined) out[f.name] = f.default
      continue
    }
    out[f.name] = coerceField(f, v)
  }
  for (const f of stream.fields) {
    const need =
      f.required === true ||
      (f.requiredWhen !== undefined && out[f.requiredWhen.field] === f.requiredWhen.equals)
    if (need && out[f.name] === undefined) {
      const why = f.requiredWhen ? `(${f.requiredWhen.field} 为「${f.requiredWhen.equals}」时必填)` : ''
      throw new ButlerError('life_invalid', `缺少必填字段 ${f.name}(${describeField(f)})${why}`)
    }
  }
  if (stream.requireAny && !stream.requireAny.some((n) => out[n] !== undefined)) {
    throw new ButlerError('life_invalid', `至少要填 ${stream.requireAny.join(' / ')} 中的一项`)
  }
  return out
}

// ─── 取代解析 ────────────────────────────────────────────────────────────────

const byTime = (a: LifeRecord, b: LifeRecord): number =>
  a.at < b.at ? -1 : a.at > b.at ? 1 : a.recordedAt < b.recordedAt ? -1 : a.recordedAt > b.recordedAt ? 1 : 0

/**
 * 当前有效记录,按事件时间升序。被取代的、撤回的(含撤回记录本身)不在其中;
 * 状态型流水按键只留最新一条。
 */
export function resolveActive(records: readonly LifeRecord[], stream: LifeStreamSpec): LifeRecord[] {
  const superseded = new Set<string>()
  for (const r of records) if (r.supersedes) superseded.add(r.supersedes)
  const live = records.filter((r) => !r.retracted && !superseded.has(r.id)).sort(byTime)
  if (!stream.key) return live
  const latest = new Map<string, LifeRecord>()
  for (const r of live) {
    const k = String(r.fields[stream.key] ?? '')
    if (k) latest.set(k, r) // 升序遍历 ⇒ 最后写入的就是最新
  }
  return [...latest.values()].sort(byTime)
}

/** 一条记录能不能被取代/撤回:存在、同流水、且还没被取代。 */
export function assertSupersedable(records: readonly LifeRecord[], targetId: string, streamRef: string): LifeRecord {
  const target = records.find((r) => r.id === targetId)
  if (!target || target.stream !== streamRef) {
    throw new ButlerError('life_not_found', `${streamRef} 里没有 id「${targetId}」(用 read_records 查 id)`)
  }
  if (target.retracted) throw new ButlerError('life_invalid', `「${targetId}」是一条撤回记录,不能再取代`)
  const newer = records.find((r) => r.supersedes === targetId)
  if (newer) {
    throw new ButlerError('life_invalid', `「${targetId}」已被「${newer.id}」取代——要改就针对最新那条`)
  }
  return target
}

// ─── 聚合 ────────────────────────────────────────────────────────────────────

export function numericValue(r: LifeRecord, field: string, stream: LifeStreamSpec): number | undefined {
  const v = r.fields[field]
  if (typeof v !== 'number') return undefined
  const neg = stream.negateWhen && stream.negateWhen.values.includes(String(r.fields[stream.negateWhen.field] ?? ''))
  return neg ? -v : v
}

export function matchesWhere(r: LifeRecord, where: Readonly<Record<string, string>> | undefined): boolean {
  if (!where) return true
  return Object.entries(where).every(([k, v]) => String(r.fields[k] ?? '') === v)
}

export function inRange(r: LifeRecord, from: string | undefined, to: string | undefined): boolean {
  const d = recordDate(r)
  return (from === undefined || d >= from) && (to === undefined || d <= to)
}

const round = (n: number, digits = 2): number => {
  const k = 10 ** digits
  return Math.round(n * k) / k
}

/** 每天的均值(同一天多条取均值),按日期升序。 */
export function dailyMeans(records: readonly LifeRecord[], field: string, stream: LifeStreamSpec): Array<[string, number]> {
  const acc = new Map<string, { sum: number; n: number }>()
  for (const r of records) {
    const v = numericValue(r, field, stream)
    if (v === undefined) continue
    const d = recordDate(r)
    const a = acc.get(d) ?? { sum: 0, n: 0 }
    a.sum += v
    a.n++
    acc.set(d, a)
  }
  return [...acc.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([d, a]) => [d, a.sum / a.n])
}

/** 最小二乘斜率(每天),至少 3 个不同日期才算。 */
export function slopePerDay(points: ReadonlyArray<[string, number]>): number | undefined {
  if (points.length < 3) return undefined
  const x0 = points[0]![0]
  const xs = points.map(([d]) => daysBetween(x0, d))
  const ys = points.map(([, v]) => v)
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length
  const my = ys.reduce((a, b) => a + b, 0) / ys.length
  let num = 0
  let den = 0
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i]! - mx) * (ys[i]! - my)
    den += (xs[i]! - mx) ** 2
  }
  return den === 0 ? undefined : num / den
}

/** 连续有记录的天数,从 `end` 往回数(end 当天没有就从最近一条有记录的那天数起)。 */
export function streakDays(records: readonly LifeRecord[], end: string): { days: number; until?: string } {
  const dates = new Set(records.map(recordDate).filter((d) => d <= end))
  if (dates.size === 0) return { days: 0 }
  let cursor = [...dates].sort().pop()!
  const until = cursor
  let days = 0
  while (dates.has(cursor)) {
    days++
    cursor = addDays(cursor, -1)
  }
  return { days, until }
}

export type LifeQueryAgg = 'latest' | 'count' | 'sum' | 'avg' | 'min' | 'max' | 'ma7' | 'trend' | 'streak' | 'current'
export type LifeGroupBy = 'day' | 'week' | 'month' | string

export interface LifeQuerySpec {
  readonly agg: LifeQueryAgg
  readonly field?: string
  readonly from?: string
  readonly to: string
  readonly where?: Readonly<Record<string, string>>
  readonly groupBy?: LifeGroupBy
}

export interface LifeQueryGroup {
  readonly key: string
  readonly count: number
  readonly value?: number
}

export interface LifeQueryResult {
  readonly n: number
  readonly from?: string
  readonly to: string
  readonly field?: string
  /** agg 的单值结果(无数据时缺席)。 */
  readonly value?: number
  /** latest 的那条记录 / streak 截止日。 */
  readonly at?: string
  readonly groups?: readonly LifeQueryGroup[]
  /** current:状态型流水的当前状态。 */
  readonly current?: readonly LifeRecord[]
  /** 金额类流水跨币种时按币种分列(不擅自换算)。 */
  readonly byCurrency?: ReadonlyArray<{ currency: string; value?: number; n: number; note?: string }>
  readonly note?: string
}

function reduceValues(values: number[], agg: 'sum' | 'avg' | 'min' | 'max' | 'count'): number | undefined {
  if (agg === 'count') return values.length
  if (values.length === 0) return undefined
  switch (agg) {
    case 'sum':
      return round(values.reduce((a, b) => a + b, 0))
    case 'avg':
      return round(values.reduce((a, b) => a + b, 0) / values.length)
    case 'min':
      return Math.min(...values)
    case 'max':
      return Math.max(...values)
  }
}

function groupKey(r: LifeRecord, groupBy: LifeGroupBy): string {
  const d = recordDate(r)
  if (groupBy === 'day') return d
  if (groupBy === 'week') return `${isoWeekLabel(d)}(${weekStart(d)} 起)`
  if (groupBy === 'month') return d.slice(0, 7)
  return String(r.fields[groupBy] ?? '(未填)')
}

/**
 * 对**已解析为有效**的记录做一次查询。纯函数:同样的输入永远同样的输出。
 */
export function queryLifeRecords(
  active: readonly LifeRecord[],
  stream: LifeStreamSpec,
  spec: LifeQuerySpec,
): LifeQueryResult {
  const field = spec.field ?? stream.primary
  if (field !== undefined && !stream.fields.some((f) => f.name === field)) {
    throw new ButlerError('life_invalid', `没有字段 ${field}。可用:${stream.fields.map((f) => f.name).join('、')}`)
  }
  const numericAgg = ['sum', 'avg', 'min', 'max', 'ma7', 'trend'].includes(spec.agg)
  if (numericAgg) {
    const spec_ = field ? stream.fields.find((f) => f.name === field) : undefined
    if (!spec_ || (spec_.type !== 'number' && spec_.type !== 'integer')) {
      throw new ButlerError('life_invalid', `${spec.agg} 需要数值字段(这条流水的数值字段:${
        stream.fields.filter((f) => f.type === 'number' || f.type === 'integer').map((f) => f.name).join('、') || '无'
      })`)
    }
  }
  if (spec.agg === 'current') {
    if (!stream.key) throw new ButlerError('life_invalid', 'current 只用于状态型流水(项目、承诺、决定、账户、固定支出)')
    const cur = active.filter((r) => matchesWhere(r, spec.where))
    return { n: cur.length, to: spec.to, current: cur }
  }
  // ma7 / trend / streak 自带窗口,from 缺省时按各自口径取。
  const from =
    spec.from ?? (spec.agg === 'ma7' ? addDays(spec.to, -6) : spec.agg === 'trend' ? addDays(spec.to, -27) : undefined)
  const rows = active.filter((r) => inRange(r, from, spec.to) && matchesWhere(r, spec.where))
  const base = { n: rows.length, ...(from !== undefined ? { from } : {}), to: spec.to, ...(field ? { field } : {}) }

  // 多币种且没按币种筛:数值聚合按币种分列,分组时组名带上币种——不同币种绝不相加。
  let splitCurrency = false
  if (stream.currencyField && numericAgg && spec.where?.[stream.currencyField] === undefined) {
    const currencies = [...new Set(rows.map((r) => String(r.fields[stream.currencyField!] ?? '')))]
    splitCurrency = currencies.length > 1
    if (currencies.length > 1 && !spec.groupBy) {
      // 每个币种按同一个 agg 单独算一遍(钉住该币种后不会再分列):ma7 就是 ma7、trend 就是斜率。
      const byCurrency = currencies.sort().map((c) => {
        const sub = queryLifeRecords(active, stream, { ...spec, where: { ...spec.where, [stream.currencyField!]: c } })
        return { currency: c, n: sub.n, ...(sub.value !== undefined ? { value: sub.value } : {}), ...(sub.note ? { note: sub.note } : {}) }
      })
      return { ...base, byCurrency, note: '含多种币种,按币种分列,未换算' }
    }
  }

  if (spec.groupBy) {
    if (spec.groupBy !== 'day' && spec.groupBy !== 'week' && spec.groupBy !== 'month' && !stream.fields.some((f) => f.name === spec.groupBy)) {
      throw new ButlerError('life_invalid', `group_by 只能是 day / week / month 或字段名(收到「${spec.groupBy}」)`)
    }
    const groups = new Map<string, number[]>()
    const counts = new Map<string, number>()
    for (const r of rows) {
      const g = groupKey(r, spec.groupBy)
      const k = splitCurrency ? `${g}·${String(r.fields[stream.currencyField!] ?? '')}` : g
      counts.set(k, (counts.get(k) ?? 0) + 1)
      const v = field ? numericValue(r, field, stream) : undefined
      if (v !== undefined) groups.set(k, [...(groups.get(k) ?? []), v])
    }
    const reducer = spec.agg === 'sum' || spec.agg === 'avg' || spec.agg === 'min' || spec.agg === 'max' ? spec.agg : 'count'
    const out = [...counts.keys()].sort().map((k) => {
      const value = reducer === 'count' ? undefined : reduceValues(groups.get(k) ?? [], reducer)
      return { key: k, count: counts.get(k)!, ...(value !== undefined ? { value } : {}) }
    })
    return { ...base, groups: out, ...(splitCurrency ? { note: '含多种币种,组名带币种,未换算' } : {}) }
  }

  const values = field
    ? rows.map((r) => numericValue(r, field, stream)).filter((v): v is number => v !== undefined)
    : []
  switch (spec.agg) {
    case 'latest': {
      const last = rows[rows.length - 1]
      if (!last) return base
      const v = field ? numericValue(last, field, stream) : undefined
      return { ...base, at: last.at, ...(v !== undefined ? { value: v } : {}), current: [last] }
    }
    case 'count':
      return { ...base, value: rows.length }
    case 'sum':
    case 'avg':
    case 'min':
    case 'max': {
      const v = reduceValues(values, spec.agg)
      return v === undefined ? base : { ...base, value: v }
    }
    case 'ma7': {
      const days = dailyMeans(rows, field!, stream)
      if (days.length === 0) return base
      return { ...base, value: round(days.reduce((a, [, v]) => a + v, 0) / days.length), note: `${days.length} 天有数据` }
    }
    case 'trend': {
      const days = dailyMeans(rows, field!, stream)
      const s = slopePerDay(days)
      if (s === undefined) return { ...base, note: '不足 3 天数据,算不出趋势' }
      return { ...base, value: round(s * 7), note: `每周变化,基于 ${days.length} 天数据` }
    }
    case 'streak': {
      const s = streakDays(rows, spec.to)
      return { ...base, value: s.days, ...(s.until ? { at: s.until } : {}) }
    }
  }
}

// ─── 档案「现状」行 ──────────────────────────────────────────────────────────

const fmt = (n: number): string => (Number.isInteger(n) ? String(n) : String(round(n, 2)))
const shortDate = (d: string): string => d.slice(5, 10)

/** 现状指标 → 一行文字;没有数据返回 undefined(卡上不出现空行)。 */
export function computeStatusLine(
  metric: LifeStatusMetric,
  active: readonly LifeRecord[],
  stream: LifeStreamSpec,
  today: string,
): string | undefined {
  const value = computeStatusValue(metric.agg, metric.field ?? stream.primary, metric.where, active, stream, today)
  if (value === undefined) return undefined
  const unit = metric.unit ? ` ${metric.unit}` : ''
  return `${metric.label}:${value.text.replace('{unit}', unit)}`
}

interface StatusValue {
  readonly value?: number
  readonly text: string
}

export function computeStatusValue(
  agg: LifeStatusAgg,
  field: string | undefined,
  where: Readonly<Record<string, string>> | undefined,
  active: readonly LifeRecord[],
  stream: LifeStreamSpec,
  today: string,
): StatusValue | undefined {
  const rows = active.filter((r) => matchesWhere(r, where) && recordDate(r) <= today)
  const sumOf = (from: string) => {
    const vs = rows
      .filter((r) => recordDate(r) >= from)
      .map((r) => (field ? numericValue(r, field, stream) : undefined))
      .filter((v): v is number => v !== undefined)
    return vs.length ? round(vs.reduce((a, b) => a + b, 0)) : undefined
  }
  switch (agg) {
    case 'latest': {
      for (let i = rows.length - 1; i >= 0; i--) {
        const v = field ? numericValue(rows[i]!, field, stream) : undefined
        if (v !== undefined) return { value: v, text: `${fmt(v)}{unit}(${shortDate(rows[i]!.at)})` }
      }
      return undefined
    }
    case 'ma7': {
      const days = dailyMeans(rows.filter((r) => recordDate(r) >= addDays(today, -6)), field!, stream)
      if (days.length === 0) return undefined
      const v = round(days.reduce((a, [, x]) => a + x, 0) / days.length)
      return { value: v, text: `${fmt(v)}{unit}(${days.length} 天)` }
    }
    case 'avg7': {
      const vs = rows
        .filter((r) => recordDate(r) >= addDays(today, -6))
        .map((r) => (field ? numericValue(r, field, stream) : undefined))
        .filter((v): v is number => v !== undefined)
      if (vs.length === 0) return undefined
      const v = round(vs.reduce((a, b) => a + b, 0) / vs.length, 1)
      return { value: v, text: `${fmt(v)}{unit}(${vs.length} 条)` }
    }
    case 'trend28': {
      const s = slopePerDay(dailyMeans(rows.filter((r) => recordDate(r) >= addDays(today, -27)), field!, stream))
      if (s === undefined) return undefined
      const v = round(s * 7, 2)
      return { value: v, text: `${v > 0 ? '+' : ''}${fmt(v)}{unit}` }
    }
    case 'week_count': {
      const n = rows.filter((r) => recordDate(r) >= weekStart(today)).length
      return { value: n, text: `${n}{unit}` }
    }
    case 'week_sum': {
      const v = sumOf(weekStart(today))
      return v === undefined ? undefined : { value: v, text: `${fmt(v)}{unit}` }
    }
    case 'month_sum': {
      const v = sumOf(monthStart(today))
      return v === undefined ? undefined : { value: v, text: `${fmt(v)}{unit}` }
    }
    case 'current_sum': {
      if (rows.length === 0 || !field) return undefined
      const vs = rows.map((r) => numericValue(r, field, stream)).filter((v): v is number => v !== undefined)
      if (vs.length === 0) return undefined
      const v = round(vs.reduce((a, b) => a + b, 0))
      return { value: v, text: `${fmt(v)}{unit}(${vs.length} 项)` }
    }
    case 'current_by': {
      if (rows.length === 0 || !field) return undefined
      const counts = new Map<string, number>()
      for (const r of rows) {
        const k = String(r.fields[field] ?? '(未填)')
        counts.set(k, (counts.get(k) ?? 0) + 1)
      }
      return { text: [...counts.entries()].map(([k, n]) => `${k} ${n}`).join(' / ') }
    }
  }
}

// ─── 目标 ────────────────────────────────────────────────────────────────────

export interface LifeGoalMetric {
  readonly stream: string
  readonly agg: 'latest' | 'ma7' | 'avg7' | 'week_count' | 'week_sum' | 'month_sum'
  readonly field?: string
  readonly where?: Readonly<Record<string, string>>
  readonly op: '<=' | '>='
  readonly target: number
}

/** 累计型目标(预算类):按比例提醒;水平型目标(体重等):达成时提醒。 */
export const isCumulativeGoal = (m: LifeGoalMetric): boolean =>
  m.agg === 'week_count' || m.agg === 'week_sum' || m.agg === 'month_sum'

export function goalProgress(
  metric: LifeGoalMetric,
  active: readonly LifeRecord[],
  stream: LifeStreamSpec,
  today: string,
): { current?: number; met: boolean; ratio?: number } {
  const v = computeStatusValue(metric.agg, metric.field ?? stream.primary, metric.where, active, stream, today)
  const current = v?.value ?? (isCumulativeGoal(metric) ? 0 : undefined)
  if (current === undefined) return { met: false }
  const met = metric.op === '<=' ? current <= metric.target : current >= metric.target
  const ratio = metric.target !== 0 ? round(current / metric.target, 3) : undefined
  return { current, met, ...(ratio !== undefined ? { ratio } : {}) }
}

// ─── 提醒评估 ────────────────────────────────────────────────────────────────

export interface LifeAlert {
  /** 稳定 id:同一次「事件」永远同一个 id(推送去重靠它)。 */
  readonly id: string
  readonly domain: string
  readonly text: string
  readonly push: boolean
}

export interface LifeGoalForAlerts {
  readonly id: string
  readonly text: string
  readonly metric?: LifeGoalMetric
}

const fill = (tpl: string, vars: Record<string, string | number>): string =>
  tpl.replace(/\{(\w+)\}/g, (m, k: string) => (vars[k] !== undefined ? String(vars[k]) : m))

/**
 * 评估一个领域的提醒。纯函数:今天、有效记录(按流水 id)、目标都由调用方给。
 * 只有「已经有过记录」的流水才会触发「多日无记录」——从没记过的流水不催。
 */
export function evaluateLifeAlerts(
  domain: LifeDomainTemplate,
  activeByStream: ReadonlyMap<string, readonly LifeRecord[]>,
  goals: readonly LifeGoalForAlerts[],
  today: string,
): LifeAlert[] {
  const out: LifeAlert[] = []
  for (const rule of domain.alerts) out.push(...evaluateRule(domain, rule, activeByStream, goals, today))
  return out
}

function evaluateRule(
  domain: LifeDomainTemplate,
  rule: LifeAlertRule,
  activeByStream: ReadonlyMap<string, readonly LifeRecord[]>,
  goals: readonly LifeGoalForAlerts[],
  today: string,
): LifeAlert[] {
  const streamSpec = (id: string) => domain.streams.find((s) => s.id === id)
  switch (rule.kind) {
    case 'no_record_days': {
      const rows = activeByStream.get(rule.stream) ?? []
      if (rows.length === 0) return []
      const last = recordDate(rows[rows.length - 1]!)
      const gap = daysBetween(last, today)
      if (gap <= rule.days) return []
      // id 只认「最近一次」:天数每天在变,文字跟着变,推送去重仍是同一件事。
      return [{ id: `${rule.id}:${last}`, domain: domain.id, text: fill(rule.text, { days: rule.days, gap, last }), push: rule.push }]
    }
    case 'low_run': {
      const rows = (activeByStream.get(rule.stream) ?? []).filter((r) => typeof r.fields[rule.field] === 'number')
      if (rows.length < rule.count) return []
      const tail = rows.slice(-rule.count)
      if (!tail.every((r) => (r.fields[rule.field] as number) <= rule.threshold)) return []
      const last = tail[tail.length - 1]!
      if (daysBetween(recordDate(last), today) > 7) return [] // 陈年低谷不再提
      return [{
        id: `${rule.id}:${last.id}`,
        domain: domain.id,
        text: fill(rule.text, { count: rule.count, threshold: rule.threshold }),
        push: rule.push,
      }]
    }
    case 'due_within': {
      const spec = streamSpec(rule.stream)
      if (!spec?.key) return []
      const out: LifeAlert[] = []
      for (const r of activeByStream.get(rule.stream) ?? []) {
        if (rule.activeWhen && !rule.activeWhen.values.includes(String(r.fields[rule.activeWhen.field] ?? ''))) continue
        const due = r.fields[rule.field]
        if (typeof due !== 'string' || !isValidDate(due)) continue
        const left = daysBetween(today, due)
        if (left > rule.days) continue
        const key = String(r.fields[spec.key] ?? '')
        const overdue = left < 0 ? `(已过 ${-left} 天)` : ''
        out.push({
          id: `${rule.id}:${key}:${due}`,
          domain: domain.id,
          text: fill(rule.text, { key, value: due }) + overdue,
          push: rule.push,
        })
      }
      return out
    }
    case 'monthly_day_within': {
      const spec = streamSpec(rule.stream)
      if (!spec?.key) return []
      const out: LifeAlert[] = []
      for (const r of activeByStream.get(rule.stream) ?? []) {
        if (rule.activeWhen && !rule.activeWhen.values.includes(String(r.fields[rule.activeWhen.field] ?? ''))) continue
        const day = r.fields[rule.field]
        if (typeof day !== 'number') continue
        const next = nextMonthlyDate(today, day)
        if (daysBetween(today, next) > rule.days) continue
        const key = String(r.fields[spec.key] ?? '')
        out.push({
          id: `${rule.id}:${key}:${next}`,
          domain: domain.id,
          text: fill(rule.text, { key, value: day }),
          push: rule.push,
        })
      }
      return out
    }
    case 'goal_ratio': {
      const out: LifeAlert[] = []
      for (const g of goals) {
        if (!g.metric) continue
        const ref = g.metric.stream
        const streamId = ref.includes('.') ? ref.slice(ref.indexOf('.') + 1) : ref
        if (ref.includes('.') && !ref.startsWith(`${domain.id}.`)) continue
        const spec = streamSpec(streamId)
        if (!spec) continue
        const p = goalProgress(g.metric, activeByStream.get(streamId) ?? [], spec, today)
        if (p.current === undefined) continue
        if (isCumulativeGoal(g.metric)) {
          if (g.metric.op !== '<=' || p.ratio === undefined) continue
          const crossed = [...rule.ratios].filter((x) => p.ratio! >= x).pop()
          if (crossed === undefined) continue
          const period = g.metric.agg === 'month_sum' ? today.slice(0, 7) : weekStart(today)
          out.push({
            id: `${rule.id}:${g.id}:${crossed}:${period}`,
            domain: domain.id,
            text: `目标「${g.text}」已到 ${Math.round(p.ratio * 100)}%(${fmt(p.current)} / ${fmt(g.metric.target)})`,
            push: rule.push,
          })
        } else if (p.met) {
          out.push({
            id: `${rule.id}:${g.id}:met`,
            domain: domain.id,
            text: `目标「${g.text}」已达成(当前 ${fmt(p.current)})`,
            push: rule.push,
          })
        }
      }
      return out
    }
  }
}

/** 今天起下一个「每月第 day 号」(月份没有这一天时取月末)。 */
export function nextMonthlyDate(today: string, day: number): string {
  const y = Number(today.slice(0, 4))
  const m = Number(today.slice(5, 7))
  const clamp = (yy: number, mm: number) => {
    const last = new Date(Date.UTC(yy, mm, 0)).getUTCDate()
    return `${yy}-${String(mm).padStart(2, '0')}-${String(Math.min(day, last)).padStart(2, '0')}`
  }
  const thisMonth = clamp(y, m)
  if (thisMonth >= today) return thisMonth
  return m === 12 ? clamp(y + 1, 1) : clamp(y, m + 1)
}
