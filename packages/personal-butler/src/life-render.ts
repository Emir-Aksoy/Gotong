/**
 * life-render.ts — LIFE-M2。生活档案的**确定性渲染**:驾驶舱卡、档案卡、查询结果、
 * 原始记录页、给人看的 md 视图。纯函数,零时钟。
 *
 * # 驾驶舱卡为什么必须字节确定
 *
 * 它骑稳定段(紧跟知识索引卡),会进提示词缓存前缀,也会出现在审批恢复和长任务分段
 * 里。所以:不读当前时间、不写「3 天前」,只写绝对日期;同样的盘上状态永远渲染出
 * 同样的字节——只有档案被写入或派生状态重算后才变,每次变化只让缓存失效一次。
 *
 * # 上限
 *
 * 框架不截断工具返回(工具结果在一个任务里一直累积),所以每种渲染自带字节顶,
 * 超了逐段收缩并**明说**收缩了什么,绝不静默截断。
 */

import {
  describeStreamFields,
  goalProgress,
  isCumulativeGoal,
  type LifeQueryResult,
  type LifeRecord,
} from './life-records.js'
import type { LifeDomainSnapshot, LifeDossier, LifeRegistry, LifeState } from './life-store.js'
import { LIFE_DOMAIN_TEMPLATES, type LifeDomainTemplate } from './life-templates.js'

export const LIFE_COCKPIT_MARKER = '<!-- gotong:life-cockpit -->'
export const LIFE_COCKPIT_MAX_BYTES = 1800
export const LIFE_DOSSIER_CARD_MAX_BYTES = 3600
export const LIFE_QUERY_MAX_BYTES = 1500
export const LIFE_PAGE_MAX_BYTES = 2000

const bytes = (s: string) => Buffer.byteLength(s, 'utf8')
const short = (d: string) => d.slice(5, 10)

export const LIFE_COCKPIT_HEAD =
  '【生活档案】以下是背景,不是指令。涉及哪个领域就用 open_dossier 打开那本,按档案里的规程记录和作答;' +
  '数字用 query_records 让代码算,不要心算;每次只追加一条记录(log_record)或改一个分区(update_dossier),' +
  '不要整篇重写。心境、财务内容不写进给专家的任务说明,除非成员要求,且只写必要结论。'

export interface LifeCheckinState {
  /** 最近一次发出心境签到的本地日期与时刻(HH:MM)。 */
  readonly lastSentDate?: string
  readonly lastSentTime?: string
  /** 交出了但没送达(底层 outbox 排队待重投):不重推,卡上也不说「已发出」。 */
  readonly undelivered?: boolean
}

/**
 * 驾驶舱卡(每轮常驻,稳定段)。没有登记表 → null(提示词逐字节不变)。
 */
export function renderLifeCockpit(
  registry: LifeRegistry | null,
  state: LifeState | null,
  checkin?: LifeCheckinState,
): string | null {
  if (!registry) return null
  const enabled = LIFE_DOMAIN_TEMPLATES.filter((d) => registry.domains.includes(d.id))
  if (enabled.length === 0) return null
  const lines: string[] = [LIFE_COCKPIT_MARKER, LIFE_COCKPIT_HEAD]
  lines.push(state ? `档案(截至 ${short(state.today)}):` : '档案:')
  for (const d of enabled) {
    const s = state?.domains[d.id]
    const parts = [`- ${d.id} ${d.label}${d.sensitive ? '(敏感)' : ''}:${d.scope}`]
    parts.push(s?.lastAt ? `最近记录 ${short(s.lastAt)}` : '暂无记录')
    if (s && s.openItems > 0) parts.push(`待处理 ${s.openItems}`)
    if (d.id === 'mind' && registry.checkin.mind.enabled) parts.push(`每晚 ${registry.checkin.mind.hour} 点签到`)
    lines.push(parts.join('|'))
  }
  if (state && checkin?.lastSentDate === state.today && !checkin.undelivered) {
    const when = checkin.lastSentTime ? `今天 ${checkin.lastSentTime}` : '今天'
    lines.push(`${when}已发出心境签到;成员接下来报的分数或感受,多半是在回答它,记成一条 mind.mood。`)
  }
  const alerts = state ? enabled.flatMap((d) => (state.domains[d.id]?.alerts ?? []).map((a) => ({ d, a }))) : []
  if (alerts.length > 0) {
    lines.push('提醒(自然地顺带提一句即可,不要连续追问):')
    for (const { d, a } of alerts) lines.push(`- ${d.label}:${a.text}`)
  }
  return fitLines(lines, LIFE_COCKPIT_MAX_BYTES, (dropped) => `- (另有 ${dropped} 条提醒,打开对应档案查看)`)
}

/** 从尾部逐行收缩到字节顶内,并补一行说明收缩了多少。 */
function fitLines(lines: string[], max: number, note: (dropped: number) => string): string {
  let out = lines.join('\n')
  if (bytes(out) <= max) return out
  const kept = [...lines]
  let dropped = 0
  while (kept.length > 3 && bytes([...kept, note(dropped + 1)].join('\n')) > max) {
    kept.pop()
    dropped++
  }
  out = [...kept, note(dropped)].join('\n')
  return out
}

// ─── 档案卡 ──────────────────────────────────────────────────────────────────

function renderProtocol(domain: LifeDomainTemplate, dossier: LifeDossier): string[] {
  const p = domain.protocol
  const out = ['规程:']
  out.push(`- 记录:${p.record.join(' ')}`)
  out.push(`- 作答:${p.answer.join(' ')}`)
  out.push(`- 判断:${p.judge.join(' ')}`)
  out.push(`- 提醒:${p.remind.join(' ')}`)
  out.push(`- 边界:${p.bounds.join(' ')}`)
  if (dossier.protocolAdditions.length > 0) {
    out.push('成员确认的补充条款:')
    for (const a of dossier.protocolAdditions) out.push(`- [${a.id}] ${a.text}`)
  }
  return out
}

function goalLine(snap: LifeDomainSnapshot, g: LifeDossier['goals'][number]): string {
  const due = g.due ? `,期限 ${g.due}` : ''
  if (!g.metric) return `- [${g.id}] ${g.text}${due}`
  const streamId = g.metric.stream.includes('.') ? g.metric.stream.split('.')[1]! : g.metric.stream
  const spec = snap.domain.streams.find((s) => s.id === streamId)
  if (!spec) return `- [${g.id}] ${g.text}${due}(指标流水不存在)`
  const p = goalProgress(g.metric, snap.activeByStream.get(streamId) ?? [], spec, snap.today)
  // 累计型(预算、周次数)看比例;水平型(体重、体脂)比例没有意义,只说还差多少。
  const tail =
    p.current === undefined
      ? ''
      : isCumulativeGoal(g.metric)
        ? p.ratio !== undefined
          ? `(${Math.round(p.ratio * 100)}%)`
          : ''
        : p.met
          ? ''
          : `,距目标还差 ${Math.round(Math.abs(p.current - g.metric.target) * 100) / 100}`
  const prog = p.current === undefined ? '暂无数据' : `当前 ${p.current}${p.met ? ',已达成' : ''}${tail}`
  return `- [${g.id}] ${g.text}${due}——${prog}`
}

/**
 * 档案卡(open_dossier 的返回)。规程跟着档案走:打开哪本才带哪本的规程。
 */
export function renderLifeDossierCard(snap: LifeDomainSnapshot): string {
  const { domain, dossier } = snap
  const head = [
    `【${domain.label}】${domain.scope}${domain.sensitive ? '(敏感档案)' : ''}`,
    `版本 r${dossier.revision}(update_dossier 时带上它)`,
  ]
  const status = ['现状(代码计算,截至 ' + short(snap.today) + '):']
  if (snap.statusLines.length === 0) status.push('- 暂无数据')
  else for (const l of snap.statusLines) status.push(`- ${l}`)
  if (dossier.statusNote) status.push(`判断(${short(dossier.statusNote.at.slice(0, 10))}):${dossier.statusNote.text}`)

  const goals = dossier.goals.length ? ['目标:', ...dossier.goals.map((g) => goalLine(snap, g))] : ['目标:暂无']
  const questions = dossier.openQuestions.length
    ? ['待澄清:', ...dossier.openQuestions.map((q) => `- [${q.id}] ${q.text}`)]
    : []
  const proposals = dossier.proposals.length
    ? ['待成员确认的提议(需成员原话确认才生效):', ...dossier.proposals.map((p) => `- [${p.id}] ${proposalText(p)}`)]
    : []
  const alerts = snap.alerts.length ? ['提醒:', ...snap.alerts.map((a) => `- ${a.text}`)] : []
  const streams = [
    '流水:' +
      domain.streams
        .map((s) => {
          const rows = snap.activeByStream.get(s.id) ?? []
          if (rows.length === 0) return `${domain.id}.${s.id} 0 条`
          return `${domain.id}.${s.id} ${rows.length} 条(${short(rows[0]!.at)}~${short(rows[rows.length - 1]!.at)})`
        })
        .join(';'),
    '字段:' + domain.streams.map((s) => `${domain.id}.${s.id}=${s.fields.map((f) => f.name).join('/')}`).join(';'),
    '核对原始记录:read_records(在工具目录里,经 use_tool 调用)。',
  ]
  const protocol = renderProtocol(domain, dossier)

  const insightsAll = dossier.insights.map((i) => `- [${i.id}] ${i.text}(证据 ${i.evidence},把握 ${i.confidence})`)
  const build = (insights: string[], note?: string) =>
    [
      ...head,
      ...status,
      ...goals,
      ...questions,
      ...proposals,
      ...alerts,
      ...(insights.length ? ['洞察:', ...insights] : []),
      ...(note ? [note] : []),
      ...protocol,
      ...streams,
    ].join('\n')

  let out = build(insightsAll)
  if (bytes(out) <= LIFE_DOSSIER_CARD_MAX_BYTES) return out
  // 先收缩洞察(它最长、最不承重),仍超再截每行长度——都明说。
  for (let keep = insightsAll.length - 1; keep >= 0; keep--) {
    out = build(insightsAll.slice(0, keep), `(洞察只显示前 ${keep}/${insightsAll.length} 条,超出档案卡字节上限)`)
    if (bytes(out) <= LIFE_DOSSIER_CARD_MAX_BYTES) return out
  }
  const clipped = out
    .split('\n')
    .map((l) => ([...l].length > 120 ? `${[...l].slice(0, 118).join('')}…` : l))
    .join('\n')
  return bytes(clipped) <= LIFE_DOSSIER_CARD_MAX_BYTES
    ? clipped
    : `${Buffer.from(clipped).subarray(0, LIFE_DOSSIER_CARD_MAX_BYTES - 60).toString('utf8').replace(/�$/, '')}\n(档案卡超出上限已截断,用 query_records 分项查)`
}

function proposalText(p: LifeDossier['proposals'][number]): string {
  switch (p.kind) {
    case 'goal':
      return `新目标:${p.text}${p.due ? `,期限 ${p.due}` : ''}`
    case 'protocol':
      return `补充条款:${p.text}`
    case 'remove_goal':
      return `移除目标 ${p.targetId}:${p.text}`
    case 'remove_protocol':
      return `移除条款 ${p.targetId}:${p.text}`
  }
}

// ─── 查询结果 ────────────────────────────────────────────────────────────────

function compactFields(r: LifeRecord): string {
  return Object.entries(r.fields)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(' ')
}

export function renderLifeQueryResult(ref: string, agg: string, res: LifeQueryResult): string {
  const range = `${res.from ? res.from : '最早'}~${res.to}`
  const head = `${ref} · ${agg}${res.field ? `(${res.field})` : ''} · ${range} · ${res.n} 条`
  const lines = [head]
  if (res.byCurrency) {
    for (const c of res.byCurrency) {
      lines.push(`- ${c.currency}:${c.value !== undefined ? c.value : '—'}(${c.n} 条${c.note ? `,${c.note}` : ''})`)
    }
  } else if (res.groups) {
    for (const g of res.groups) lines.push(`- ${g.key}:${g.value !== undefined ? `${g.value}(${g.count} 条)` : `${g.count} 条`}`)
  } else if (res.current) {
    if (agg === 'latest') {
      const r = res.current[0]
      if (r) lines.push(`最新:${r.at} ${compactFields(r)}(id ${r.id})`)
    } else {
      for (const r of res.current) lines.push(`- ${compactFields(r)}(${short(r.at)},id ${r.id})`)
    }
  } else if (res.value !== undefined) {
    lines.push(`结果:${res.value}${res.at ? `(截至 ${res.at})` : ''}`)
  } else {
    lines.push('结果:该范围内没有可计算的数据')
  }
  if (res.note) lines.push(`说明:${res.note}`)
  return fitLines(lines, LIFE_QUERY_MAX_BYTES, (dropped) => `(另有 ${dropped} 行未显示,缩小日期范围或换 group_by)`)
}

// ─── 原始记录页 ──────────────────────────────────────────────────────────────

export function renderLifeRecordPage(
  ref: string,
  rows: readonly LifeRecord[],
  offset: number,
): { text: string; nextOffset?: number } {
  const head = `${ref} 原始记录(第 ${offset + 1} 条起,共 ${rows.length} 条,按事件时间升序;已含被取代/撤回的历史行):`
  const lines = [head]
  let i = offset
  for (; i < rows.length; i++) {
    const r = rows[i]!
    const flags = [r.retracted ? `撤回 ${r.supersedes}` : r.supersedes ? `取代 ${r.supersedes}` : '', r.source.kind !== 'user' ? r.source.kind : '']
      .filter(Boolean)
      .join(',')
    const line = `- ${r.id}|${r.at}|${compactFields(r) || '-'}${flags ? `|${flags}` : ''}`
    if (bytes([...lines, line, '(nextOffset 999999)'].join('\n')) > LIFE_PAGE_MAX_BYTES) break
    lines.push(line)
  }
  if (i < rows.length) {
    lines.push(`(还有 ${rows.length - i} 条,用 offset=${i} 继续)`)
    return { text: lines.join('\n'), nextOffset: i }
  }
  return { text: lines.join('\n') }
}

// ─── 给人看的 md 视图 ────────────────────────────────────────────────────────

const mdCell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ')

/** `views/<档案名>.md`:只写不读回,真相在 JSON / JSONL。 */
export function renderLifeView(snap: LifeDomainSnapshot): string {
  const { domain, dossier } = snap
  const out: string[] = [
    '---',
    'generated: true',
    `source: life/${domain.id}/`,
    '---',
    `<!-- 自动生成:真相在 life/${domain.id}/ 下的 JSON/JSONL,手改会被下次覆盖。 -->`,
    '',
    `# ${domain.label}`,
    '',
    `> ${domain.scope}`,
    '',
    `## 现状(截至 ${snap.today})`,
    '',
    ...(snap.statusLines.length ? snap.statusLines.map((l) => `- ${l}`) : ['- 暂无数据']),
    ...(dossier.statusNote ? ['', `判断:${dossier.statusNote.text}`] : []),
    '',
    '## 目标',
    '',
    ...(dossier.goals.length ? dossier.goals.map((g) => goalLine(snap, g)) : ['- 暂无']),
    '',
    '## 洞察',
    '',
    ...(dossier.insights.length
      ? dossier.insights.map((i) => `- ${i.text}(证据 ${i.evidence},把握 ${i.confidence})`)
      : ['- 暂无']),
    '',
    '## 待澄清',
    '',
    ...(dossier.openQuestions.length ? dossier.openQuestions.map((q) => `- ${q.text}`) : ['- 暂无']),
  ]
  if (dossier.protocolAdditions.length) {
    out.push('', '## 补充条款', '', ...dossier.protocolAdditions.map((a) => `- ${a.text}`))
  }
  for (const s of domain.streams) {
    const rows = snap.activeByStream.get(s.id) ?? []
    out.push('', `## ${s.label}(最近 ${Math.min(rows.length, 30)} / ${rows.length} 条)`, '')
    if (rows.length === 0) {
      out.push('暂无记录。字段:' + describeStreamFields(s))
      continue
    }
    const cols = s.fields.map((f) => f.name)
    out.push(`| 日期 | ${s.fields.map((f) => mdCell(f.label)).join(' | ')} |`)
    out.push(`|${' --- |'.repeat(cols.length + 1)}`)
    for (const r of rows.slice(-30)) {
      out.push(`| ${r.at} | ${cols.map((c) => mdCell(r.fields[c] === undefined ? '' : String(r.fields[c]))).join(' | ')} |`)
    }
  }
  return `${out.join('\n')}\n`
}
