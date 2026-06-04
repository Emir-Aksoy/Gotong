/**
 * Deterministic stand-in participants for the cafe-ops runnable demo.
 *
 * In the loadable template the worker capabilities are served by KB-backed
 * `LlmAgent`s (onboarding-trainer / ops-assistant on DeepSeek + mcp-obsidian).
 * Here we substitute deterministic stand-ins that serve the SAME capabilities
 * with real, assertable logic — so the demo runs with no API key and the hub
 * wiring (the workflow dispatches to a capability, a participant answers) is
 * identical to production. Swap these for the real LlmAgents and nothing in the
 * workflow YAML or the hub changes.
 *
 * The little SOP / policy tables below stand in for the store-operations manual
 * the real agents would read out of the Obsidian KB — they are NOT the KB
 * itself (a template carries wiring + a pointer, never content; decision #4).
 */

import { AgentParticipant, type Task } from '@aipehub/core'

// --- the "manual" the real agents would read from the KB --------------------

/** Per-position standard operating procedure + the norms a new hire must learn. */
const POSITION_SOP: Record<string, { title: string; steps: string[]; norms: string[] }> = {
  barista: {
    title: '制饮 (吧台)',
    steps: ['开机预热 + 校准糖度秤', '按订单贴杯 → 取料 → 出品 → 复核杯贴', '收档清洗封口机 + 记录物料耗用'],
    norms: ['出品温度/糖度按配方卡, 不凭手感', '过敏原 (奶/坚果) 必须口头复述确认', '掉落物料一律弃用不回收'],
  },
  cashier: {
    title: '收银 (前台)',
    steps: ['开班点钱箱 + 核对备用金', '唱收唱付 → 出小票 → 复述取餐号', '换班双人对账签字'],
    norms: ['现金长短款当班登记, 不私自垫付', '退款须店长授权码', '会员信息只查不抄不外传'],
  },
  support: {
    title: '清洁 / 出品支持',
    steps: ['按区域清洁表逐项打勾', '补货先进先出 + 查保质期', '垃圾分类 + 地面防滑巡查'],
    norms: ['清洁剂不混用, 配比按标签', '保质期临界品贴标先用', '湿滑区域必摆警示牌'],
  },
}

/** Overtime policy: base hourly rate (¥) and the multiplier applied to OT hours. */
const OVERTIME_POLICY = { baseHourly: 22, multiplier: 1.5, currency: '¥' }

// --- stand-in participants --------------------------------------------------

/** Serves `cafe.train-position` — the onboarding trainer (KB-backed in prod). */
export class TrainPositionStandin extends AgentParticipant {
  constructor() {
    super({ id: 'onboarding-trainer', capabilities: ['cafe.train-position'] })
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

/** Serves `cafe.overtime-policy` — suggests an amount per policy (manager confirms). */
export class OvertimePolicyStandin extends AgentParticipant {
  constructor() {
    super({ id: 'ops-assistant', capabilities: ['cafe.overtime-policy', 'cafe.schedule-draft'] })
  }

  protected async handleTask(task: Task): Promise<unknown> {
    const cap = task.strategy?.kind === 'capability' ? task.strategy.capabilities?.[0] : undefined
    if (cap === 'cafe.schedule-draft') return this.draftSchedule(task)
    return this.assessOvertime(task)
  }

  /** Deterministic money math — the headline reason money work is NOT done by an LLM. */
  private assessOvertime(task: Task): unknown {
    const { hours, date } = (task.payload ?? {}) as { hours?: number; date?: string }
    const h = typeof hours === 'number' && hours > 0 ? hours : 0
    const { baseHourly, multiplier, currency } = OVERTIME_POLICY
    const amount = Math.round(h * baseHourly * multiplier * 100) / 100
    return {
      date,
      hours: h,
      rate: baseHourly,
      multiplier,
      currency,
      suggestedAmount: amount,
      note: `按店面政策: ${currency}${baseHourly}/小时 × ${multiplier} 倍 × ${h} 小时 = ${currency}${amount} (建议, 待店长确认)。`,
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
      note: `已把 ${slots.length} 段可排时段整理成排班建议, 待店长确认。`,
    }
  }
}
