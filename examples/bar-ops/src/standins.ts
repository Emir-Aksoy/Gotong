/**
 * Deterministic stand-in participants for the bar-ops runnable demo.
 *
 * In the loadable template the worker capabilities are served by KB-backed
 * `LlmAgent`s (bar-onboarding-trainer / bar-ops-assistant / bar-compliance-aide
 * on DeepSeek + mcp-obsidian). Here we substitute deterministic stand-ins that
 * serve the SAME capabilities with real, assertable logic — so the demo runs
 * with no API key and the hub wiring (the workflow dispatches to a capability, a
 * participant answers) is identical to production. Swap these for the real
 * LlmAgents and nothing in the workflow YAML or the hub changes.
 *
 * The little SOP / policy tables below stand in for the bar-operations manual
 * the real agents would read out of the Obsidian KB — they are NOT the KB itself
 * (a template carries wiring + a pointer, never content; decision #4).
 */

import { AgentParticipant, type Task } from '@gotong/core'

// --- the "manual" the real agents would read from the KB --------------------

/** Per-position standard operating procedure + the norms a new hire must learn. */
const POSITION_SOP: Record<string, { title: string; steps: string[]; norms: string[] }> = {
  bartender: {
    title: '调酒师 (吧台)',
    steps: ['开档校酒具 + 备冰 + 核对酒单', '按单调制 → 出品 → 复核', '收档清吧台 + 封酒 + 记耗损'],
    norms: [
      '年龄核查红线: 见到疑似未成年必查证件、拒售、必要时报安保',
      '对明显醉酒客停止售酒并通知安保',
      '计量按配方卡, 不凭手感',
    ],
  },
  server: {
    title: '侍酒 / 服务 (前场)',
    steps: ['开场摆台 + 核对预订', '点单 → 上酒 → 结账', '收台清洁'],
    norms: ['送酒到桌先确认年龄符合', '不向明显醉酒者继续供酒', '会员 / 顾客信息只查不外传'],
  },
  security: {
    title: '安保 / 门口',
    steps: ['开门前检查通道 / 消防', '入口查证件核年龄 + 控人流', '打烊清场'],
    norms: ['年龄核查红线: 证件存疑一律拒入并记录', '冲突先隔离再报警', '营业时间到点停止入场'],
  },
  cashier: {
    title: '收银',
    steps: ['开班点钱箱 + 核备用金', '唱收唱付 → 出票', '换班双人对账签字'],
    norms: ['现金长短款当班登记, 不私自垫付', '退款须经理授权码', '会员信息只查不抄不外传'],
  },
}

/**
 * Late-night wage policy: base hourly rate (¥) and the multiplier applied by
 * shift kind. The multiplier is SITUATIONAL (结合班次) — a late-night or weekend
 * shift pays more than a day shift, mirroring how bars actually pay. The same
 * hours yield a different recommendation depending on WHICH shift they were.
 * Money stays deterministic here; the owner still confirms the final amount.
 */
type ShiftKind = 'day' | 'late-night' | 'weekend' | 'holiday'
const WAGE_POLICY = {
  baseHourly: 25,
  currency: '¥',
  multiplierByShift: { day: 1.0, 'late-night': 1.5, weekend: 2.0, holiday: 3.0 } as Record<
    ShiftKind,
    number
  >,
}
const SHIFT_LABEL: Record<ShiftKind, string> = {
  day: '日班',
  'late-night': '深夜班',
  weekend: '周末',
  holiday: '法定节假日',
}

/** Normalize a free-text/选项 shift kind to a known ShiftKind (defaults to a day shift). */
function asShiftKind(raw: unknown): ShiftKind {
  return raw === 'late-night' || raw === 'weekend' || raw === 'holiday' ? raw : 'day'
}

// --- stand-in participants --------------------------------------------------

/** Serves `bar.train-position` — the onboarding trainer (KB-backed in prod). */
export class TrainBarPositionStandin extends AgentParticipant {
  constructor() {
    super({ id: 'bar-onboarding-trainer', capabilities: ['bar.train-position'] })
  }

  protected async handleTask(task: Task): Promise<unknown> {
    const { position, question } = (task.payload ?? {}) as { position?: string; question?: string }
    const sop = POSITION_SOP[position ?? ''] ?? {
      title: String(position),
      steps: ['(运营手册暂无此岗位条目)'],
      norms: [],
    }
    return {
      position,
      positionTitle: sop.title,
      operations: sop.steps,
      norms: sop.norms,
      // The real LlmAgent would answer the new hire's free-text question from the
      // KB; the stand-in just echoes it was received so the demo is assertable.
      answeredQuestion: question ? `已就「${question}」结合 ${sop.title} 规范作答。` : undefined,
    }
  }
}

/** Serves `bar.shift-draft` + `bar.late-night-wage` (schedule draft + wage suggestion). */
export class BarOpsAssistantStandin extends AgentParticipant {
  constructor() {
    super({ id: 'bar-ops-assistant', capabilities: ['bar.shift-draft', 'bar.late-night-wage'] })
  }

  protected async handleTask(task: Task): Promise<unknown> {
    const cap = task.strategy?.kind === 'capability' ? task.strategy.capabilities?.[0] : undefined
    if (cap === 'bar.shift-draft') return this.draftSchedule(task)
    return this.lateNightWage(task)
  }

  /**
   * Deterministic money math — the headline reason wage work is NOT done by an
   * LLM. The multiplier adapts to the shift kind (day / late-night / weekend /
   * holiday), so the recommendation fits the actual shift, not a flat rate.
   *
   * The demo probes this with a single-shift `{ hours, shift_kind }` payload (the
   * assertable path). In the loadable template the compute step instead passes a
   * multi-line `shifts` text that the real LLM agent parses per policy — this
   * stand-in intentionally doesn't parse that text; it only proves the multiplier
   * math is deterministic and situational.
   */
  private lateNightWage(task: Task): unknown {
    const { hours, shift_kind } = (task.payload ?? {}) as { hours?: number; shift_kind?: unknown }
    const h = typeof hours === 'number' && hours > 0 ? hours : 0
    const shift = asShiftKind(shift_kind)
    const { baseHourly, currency, multiplierByShift } = WAGE_POLICY
    const multiplier = multiplierByShift[shift]
    const amount = Math.round(h * baseHourly * multiplier * 100) / 100
    return {
      hours: h,
      shiftKind: shift,
      shiftLabel: SHIFT_LABEL[shift],
      rate: baseHourly,
      multiplier,
      currency,
      suggestedAmount: amount,
      note: `按店深夜薪政策 (${SHIFT_LABEL[shift]} ${multiplier} 倍): ${currency}${baseHourly}/小时 × ${multiplier} × ${h} 小时 = ${currency}${amount} (建议, 待老板确认)。`,
    }
  }

  private draftSchedule(task: Task): unknown {
    const { week, availability } = (task.payload ?? {}) as { week?: string; availability?: string }
    const slots = String(availability ?? '')
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
    return {
      week,
      proposedSlots: slots,
      slotCount: slots.length,
      note: `已把 ${slots.length} 段可排时段整理成排班建议 (标清深夜 / 周末档), 待领班确认。`,
    }
  }
}

/**
 * Serves `bar.age-incident-review` — the bar's signature compliance capability.
 * Two branches by payload.step: `review` drafts an incident review sheet for the
 * duty manager; `record` writes the one-line compliance-log entry once approved.
 *
 * Honest boundary baked in: it summarizes the REPORTED facts and flags whether
 * the report TEXT mentions each required compliance action (keyword presence, not
 * a verified determination). It does NOT rule on the customer's real age, does NOT
 * judge whether the staffer acted correctly (they already refused), and the record
 * is an INTERNAL log — not a report to authorities.
 */
export class BarComplianceStandin extends AgentParticipant {
  constructor() {
    super({ id: 'bar-compliance-aide', capabilities: ['bar.age-incident-review'] })
  }

  protected async handleTask(task: Task): Promise<unknown> {
    const p = (task.payload ?? {}) as {
      step?: string
      occurred_at?: string
      station?: string
      detail?: string
      reviewed_summary?: string
    }
    return p.step === 'record' ? this.record(p) : this.review(p)
  }

  private review(p: { occurred_at?: string; station?: string; detail?: string }): unknown {
    const detail = String(p.detail ?? '')
    // A SHALLOW keyword prefilter — does the report TEXT mention each required
    // compliance action? This is deliberately NOT a verified determination: a
    // plain keyword scan can't reliably tell "已拒售" from "未拒售" (Chinese
    // negation is positional), so it only flags keyword PRESENCE to draw the
    // manager's eye. The manager decides from the 经过 text; the customer's real
    // age and whether the staffer acted correctly are never adjudicated here. (In
    // the loadable template the real LLM does a better read — still not a legal
    // determination.)
    const mentionsIdCheck = /证件|身份证|驾照|护照|查证/.test(detail)
    const mentionsRefusal = /拒|不卖|不售/.test(detail)
    const mentionsEscalation = /安保|保安|报警|上报/.test(detail)
    return {
      occurredAt: p.occurred_at,
      station: p.station,
      // `keywordScan` (not `compliance`): these booleans mean "the word appears",
      // NOT "the action was verified" — the honest name for what the scan does.
      keywordScan: { mentionsIdCheck, mentionsRefusal, mentionsEscalation },
      // A human-readable review sheet — what the manager sees on the approval card.
      text: [
        `年龄核查事件复核单 · ${p.occurred_at ?? '(未填时间)'} · 岗位 ${p.station ?? '(未填)'}`,
        `经过: ${detail || '(未填)'}`,
        `关键词初筛(仅提示命中, 不代表已核实、可能误判否定句 —— 以经过为准): 证件 ${mentionsIdCheck ? '命中' : '未命中'} / 拒售 ${mentionsRefusal ? '命中' : '未命中'} / 上报安保 ${mentionsEscalation ? '命中' : '未命中'}`,
        '注: 本单只整理上报事实并做关键词初筛, 不裁定顾客真实年龄、不裁定员工对错, 是否合规由经理据经过判断。',
      ].join('\n'),
    }
  }

  private record(p: { occurred_at?: string; station?: string; reviewed_summary?: string }): unknown {
    const reviewedSummary = String(p.reviewed_summary ?? '')
    const line = `[拒售记录] ${p.occurred_at ?? '(未填时间)'} · 岗位 ${p.station ?? '(未填)'} · 疑似未成年已拒售, 值班经理已复核确认。`
    return {
      occurredAt: p.occurred_at,
      station: p.station,
      logEntry: line,
      // Echo that the reviewed summary actually flowed in — the age-incident record
      // step passes `reviewed_summary: $review.output.text`. The demo asserts this
      // is true, so a broken ref there fails the demo loudly instead of silently.
      reviewedSummaryReceived: reviewedSummary.length > 0,
      text: `${line}\n(这是一条正式拒售条目, 写进本次工作流运行记录 —— 每次运行都留痕 (拒绝的运行 record 步记 skipped);非上报官方, 要不要上报由人另行决定。)`,
    }
  }
}
