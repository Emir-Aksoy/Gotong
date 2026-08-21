/**
 * effect-signals.ts — EFF-M3. 效果回路的生产信号只读投影(零 LLM,零新落盘)。
 *
 * 效果回路(docs/zh/EFFECT-LOOP.md)的半边二:方向 A「LLM 自适应」要按**实际
 * 效果**持续校准,而生产里可数的效果事实早就都在盘上 —— 本文件只是把它们
 * 折成体检面板一张卡,不新增任何权威点:
 *
 *   - park 决定:`<space>/inbox/*.json` 已决项原地留存(resolved-in-place 从
 *     不删),`decision.approved` / `changesRequested` 就是批准/拒绝/打回三计数。
 *   - 转派:`<space>/butler/escalate/<userId>.jsonl` 事实行(EFF-M2)。
 *   - 分母:identity 用量账本的 calls(注入缝,identity 缺席 = 分母如实缺席)。
 *
 * ── 三条纪律 ────────────────────────────────────────────────────────────────
 * ① 观察者永不隔离(me-panel-data 同款):坏文件/坏行跳过,证据原地留 —— 写者
 *    才有隔离权,这里只是旁观。
 * ② 「读不到」≠「没发生」(HANDS-M4 磁盘教训):目录 ENOENT 是诚实的零(从没
 *    发生过),读目录抛别的错则整块**缺席** + warn —— 计数读失败当 0 会把
 *    「我看不见」谎报成「一切安静」。
 * ③ 数字只与自己比:这张卡是内部回路的仪表,不是榜单;比率在呈现层折,host
 *    只出原始计数与分母。
 *
 * 成本:线性于已决项文件数,只在 admin 体检刷新时跑(on-demand,非热路径)。
 */

import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

/** 体检面板「效果信号」一行。子块缺席 = 读不动(warn 过);在场的零 = 真的零。 */
export interface HealthEffectSignalsRow {
  /** 统计窗口(天),印在卡上 —— 卡对自己的窗口诚实。 */
  windowDays: number
  /** park 决定三计数(审批类;choice/edit 不算进来 —— 那不是效果信号)。 */
  parks?: { approved: number; rejected: number; changesRequested: number }
  /** 转派行数与其中 ok 的(EFF-M2 事实行;ok 语义见那边:kind==='ok' 才真)。 */
  escalations?: { total: number; ok: number }
  /** 窗口内 LLM 调用总数(比率的分母)。缺席 = 账本未接/读不动,绝不冒充 0。 */
  llmCalls?: number
}

export interface EffectSignalsDeps {
  /** 空间根(inbox/ 与 butler/escalate/ 都从它派生)。 */
  spaceRoot: string
  /** 窗口内 LLM 调用计数(identity aggregateLedger 折的 thunk)。缺席 = 无分母。 */
  countLlmCalls?: (sinceMs: number) => Promise<number> | number
  /** 统计窗口天数,默认 30。 */
  windowDays?: number
  now?: () => number
  logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void }
}

const DEFAULT_WINDOW_DAYS = 30

/**
 * 构造读者。返回的 thunk **自身永不抛**:每个子块独立降级(缺席),体检快照
 * 的其余部分不被这张卡连累。
 */
export function buildEffectSignalsReader(
  deps: EffectSignalsDeps,
): () => Promise<HealthEffectSignalsRow> {
  const windowDays = deps.windowDays ?? DEFAULT_WINDOW_DAYS
  const now = deps.now ?? Date.now
  return async () => {
    const since = now() - windowDays * 24 * 60 * 60 * 1000
    const row: HealthEffectSignalsRow = { windowDays }

    const parks = await readParkCounts(join(deps.spaceRoot, 'inbox'), since, deps.logger)
    if (parks) row.parks = parks

    const esc = await readEscalationCounts(join(deps.spaceRoot, 'butler', 'escalate'), since, deps.logger)
    if (esc) row.escalations = esc

    if (deps.countLlmCalls) {
      try {
        const n = await deps.countLlmCalls(since)
        if (typeof n === 'number' && Number.isFinite(n) && n >= 0) row.llmCalls = n
      } catch (err) {
        deps.logger?.warn('effect signals: llm-call denominator unreadable (omitted)', {
          err: err instanceof Error ? err.message : String(err),
        })
      }
    }
    return row
  }
}

/** 已决审批项三计数。ENOENT = 诚实零;别的读目录错 = 块缺席 + warn(纪律②)。 */
async function readParkCounts(
  inboxDir: string,
  since: number,
  log?: EffectSignalsDeps['logger'],
): Promise<{ approved: number; rejected: number; changesRequested: number } | undefined> {
  let files: string[]
  try {
    files = await readdir(inboxDir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { approved: 0, rejected: 0, changesRequested: 0 } // 从没 park 过
    }
    log?.warn('effect signals: inbox dir unreadable (parks omitted)', {
      err: err instanceof Error ? err.message : String(err),
    })
    return undefined
  }
  const counts = { approved: 0, rejected: 0, changesRequested: 0 }
  for (const file of files) {
    if (!file.endsWith('.json')) continue
    let item: {
      status?: unknown
      resolvedAt?: unknown
      decision?: { kind?: unknown; approved?: unknown; changesRequested?: unknown }
    }
    try {
      item = JSON.parse(await readFile(join(inboxDir, file), 'utf8')) as typeof item
    } catch {
      continue // 坏/消失的文件跳过 —— 观察者永不隔离(纪律①)
    }
    if (item?.status !== 'resolved') continue
    if (typeof item.resolvedAt !== 'number' || item.resolvedAt < since) continue
    const d = item.decision
    if (!d || d.kind !== 'approval') continue // choice/edit 不是效果信号
    // inbox-service.outcomeOf 同一三分法:打回优先于批/拒。
    if (d.changesRequested === true) counts.changesRequested++
    else if (d.approved === true) counts.approved++
    else counts.rejected++
  }
  return counts
}

/** EFF-M2 事实行计数。窗口按 `at` 的 ISO 时间戳过滤;坏行跳过。 */
async function readEscalationCounts(
  escDir: string,
  since: number,
  log?: EffectSignalsDeps['logger'],
): Promise<{ total: number; ok: number } | undefined> {
  let files: string[]
  try {
    files = await readdir(escDir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { total: 0, ok: 0 } // 从没转派过(或 EFF-M2 之前的老家)
    }
    log?.warn('effect signals: escalate dir unreadable (escalations omitted)', {
      err: err instanceof Error ? err.message : String(err),
    })
    return undefined
  }
  const counts = { total: 0, ok: 0 }
  for (const file of files) {
    if (!file.endsWith('.jsonl')) continue
    let raw: string
    try {
      raw = await readFile(join(escDir, file), 'utf8')
    } catch {
      continue
    }
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      let fact: { at?: unknown; ok?: unknown }
      try {
        fact = JSON.parse(trimmed) as typeof fact
      } catch {
        continue // 坏行跳过
      }
      if (typeof fact?.at !== 'string') continue
      const at = Date.parse(fact.at)
      if (Number.isNaN(at) || at < since) continue
      counts.total++
      if (fact.ok === true) counts.ok++
    }
  }
  return counts
}
