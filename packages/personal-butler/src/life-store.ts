/**
 * life-store.ts — LIFE-M1。生活档案的**磁盘层**:登记表、只追加流水、按分区存的档案、
 * 派生状态(提醒/最近记录)。叶子模块,只收 host 递进来的绝对目录,纯文件操作。
 *
 * # 布局(`<成员目录>/life/`,随记忆树的 git 快照与备份走)
 *
 *   registry.json            登记表:存在 = 启用(file-first,不加环境变量)
 *   <domain>/<stream>.jsonl  流水,只追加;取代/撤回也是追加一行
 *   <domain>/dossier.json    档案正文(现状判断/目标/洞察/待澄清/补充条款/提议)
 *   state.json               派生状态:每领域最近记录日、条数、提醒(可随时重算)
 *   views/<名>.md            给人看的投影(只写不读回,手改会被覆盖)
 *   reviews/<周>.md          周复盘(维护期写)
 *
 * # 并发
 *
 * 同一进程里有三个写者:成员轮的常驻句柄、6h 维护的临时句柄、主动推送 sweeper 的
 * 句柄。按**目录**而不是按句柄串行(模块级锁表),三者对同一份档案的读改写不会互踩;
 * 写盘一律 `writeFileAtomic`,崩溃不留半份文件。
 *
 * # 坏数据
 *
 * 流水里解析不了的行跳过并计数(不改写原文件——原样留给人看);档案 JSON 坏了改名
 * 隔离为 `.corrupt-<ts>` 再从空档案开始,绝不销毁。
 */

import { appendFile, mkdir, readFile, rename, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { writeFileAtomic } from '@gotong/core'

import { ButlerError } from './errors.js'
import {
  assertSupersedable,
  computeStatusLine,
  computeStatusValue,
  evaluateLifeAlerts,
  localDate,
  localTime,
  normalizeAt,
  recordDate,
  resolveActive,
  validateLifeFields,
  type LifeAlert,
  type LifeGoalMetric,
  type LifeRecord,
  type LifeRecordSource,
} from './life-records.js'
import {
  LIFE_DOMAIN_TEMPLATES,
  LIFE_TEMPLATE_VERSION,
  findLifeDomain,
  findLifeStream,
  allLifeStreamRefs,
  type LifeDomainTemplate,
} from './life-templates.js'

export const LIFE_LIMITS = {
  maxRecordBytes: 2048,
  maxStreamBytes: 4 * 1024 * 1024,
  maxGoals: 10,
  maxInsights: 8,
  maxQuestions: 12,
  maxProtocolAdditions: 12,
  maxProposals: 10,
  maxItemChars: 200,
  maxStatusNoteChars: 300,
  logEntries: 20,
} as const

export type LifeLimits = typeof LIFE_LIMITS

export interface LifeRegistry {
  readonly version: 1
  readonly templateVersion: number
  readonly domains: readonly string[]
  readonly defaultCurrency: string
  readonly checkin: { readonly mind: { readonly enabled: boolean; readonly hour: number } }
  readonly push: { readonly alerts: boolean; readonly review: boolean }
  readonly createdAt: string
}

export const DEFAULT_LIFE_REGISTRY: Omit<LifeRegistry, 'createdAt'> = {
  version: 1,
  templateVersion: LIFE_TEMPLATE_VERSION,
  domains: LIFE_DOMAIN_TEMPLATES.map((d) => d.id),
  defaultCurrency: 'CNY',
  // 2026-10-20 用户拍板:心境每天主动问一句;主动推送暂定默认开。
  checkin: { mind: { enabled: true, hour: 21 } },
  push: { alerts: true, review: true },
}

export interface LifeGoal {
  readonly id: string
  readonly text: string
  readonly metric?: LifeGoalMetric
  readonly due?: string
  readonly confirmedAt: string
  /** 成员确认时的原话(逐字出现在当轮消息里)。 */
  readonly quote: string
}

export interface LifeInsight {
  readonly id: string
  readonly text: string
  readonly evidence: string
  readonly confidence: '高' | '中' | '低'
  readonly at: string
}

export interface LifeQuestion {
  readonly id: string
  readonly text: string
  readonly at: string
}

export interface LifeProtocolAddition {
  readonly id: string
  readonly text: string
  readonly confirmedAt: string
  readonly quote: string
}

export interface LifeProposal {
  readonly id: string
  readonly kind: 'goal' | 'protocol' | 'remove_goal' | 'remove_protocol'
  readonly text: string
  readonly metric?: LifeGoalMetric
  readonly due?: string
  readonly targetId?: string
  readonly at: string
  readonly by: 'atong' | 'review'
  /** 提出它的任务 id:同一任务里不许确认。 */
  readonly taskId?: string
}

export interface LifeDossier {
  readonly version: 1
  readonly revision: number
  /** 分区内条目 id 的单调计数器:删掉的 id 永不复用。 */
  readonly seq: number
  readonly statusNote?: { readonly text: string; readonly at: string }
  readonly goals: readonly LifeGoal[]
  readonly insights: readonly LifeInsight[]
  readonly openQuestions: readonly LifeQuestion[]
  readonly protocolAdditions: readonly LifeProtocolAddition[]
  readonly proposals: readonly LifeProposal[]
  readonly log: ReadonlyArray<{ readonly at: string; readonly text: string }>
}

export const EMPTY_DOSSIER: LifeDossier = {
  version: 1,
  revision: 0,
  seq: 0,
  goals: [],
  insights: [],
  openQuestions: [],
  protocolAdditions: [],
  proposals: [],
  log: [],
}

export interface LifeDomainState {
  readonly lastAt?: string
  readonly records: number
  readonly openItems: number
  readonly alerts: readonly LifeAlert[]
}

export interface LifeState {
  readonly version: 1
  /** 计算时的本地日期(卡片据此写「截至」;不写相对时间)。 */
  readonly today: string
  readonly domains: Readonly<Record<string, LifeDomainState>>
}

export interface LifeDomainSnapshot {
  readonly domain: LifeDomainTemplate
  readonly dossier: LifeDossier
  readonly activeByStream: ReadonlyMap<string, readonly LifeRecord[]>
  readonly totalsByStream: ReadonlyMap<string, number>
  readonly statusLines: readonly string[]
  readonly alerts: readonly LifeAlert[]
  readonly lastAt?: string
  readonly today: string
}

export interface AppendLifeRecordInput {
  readonly stream: string
  readonly fields?: unknown
  readonly at?: unknown
  readonly supersedes?: string
  readonly retract?: boolean
  readonly source: LifeRecordSource
}

export interface LifeArchive {
  readonly dir: string
  readonly timeZone: string
  today(): string
  readRegistry(): Promise<LifeRegistry | null>
  /** 不存在则按默认值创建;已存在原样返回(幂等)。 */
  ensureRegistry(): Promise<LifeRegistry>
  readRecords(stream: string): Promise<LifeRecord[]>
  appendRecord(input: AppendLifeRecordInput): Promise<{ record: LifeRecord; target?: LifeRecord }>
  readDossier(domain: string): Promise<LifeDossier>
  /**
   * 带版本号的读改写:`expectRevision` 与盘上不符就拒(防止拿旧版本覆盖)。
   * mutate 返回新档案(revision/seq 由本层维护)与一句维护记录。
   */
  updateDossier(
    domain: string,
    expectRevision: number | undefined,
    mutate: (d: LifeDossier, nextId: (prefix: string) => string) => { dossier: LifeDossier; log: string },
  ): Promise<LifeDossier>
  snapshot(domain: string): Promise<LifeDomainSnapshot>
  /** 重算全部领域的派生状态;内容有变才写盘。 */
  recomputeState(): Promise<LifeState>
  readState(): Promise<LifeState | null>
  /** 写一份 `views/` 或 `reviews/` 下的 md(只写不读回)。 */
  writeDerived(rel: string, text: string): Promise<void>
  readDerived(rel: string): Promise<string | null>
}

export interface OpenLifeArchiveOptions {
  /** `<ownerDir>/life`——host 定位,本模块只在它下面操作。 */
  readonly dir: string
  /** 本地日期口径;默认部署环境时区(与时间记忆一致)。 */
  readonly timeZone?: string
  readonly now?: () => number
  readonly logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void }
  readonly limits?: Partial<LifeLimits>
}

/** 按目录串行:同一进程里多个句柄共享这把锁。 */
const DIR_LOCKS = new Map<string, Promise<unknown>>()

function withDirLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const prev = DIR_LOCKS.get(dir) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  const tail = next.catch(() => undefined)
  DIR_LOCKS.set(dir, tail)
  void tail.then(() => {
    if (DIR_LOCKS.get(dir) === tail) DIR_LOCKS.delete(dir)
  })
  return next
}

const DERIVED_RE = /^(views|reviews)\/[^/\\:\u0000-\u001f]{1,80}\.md$/

export function openLifeArchive(opts: OpenLifeArchiveOptions): LifeArchive {
  const now = opts.now ?? (() => Date.now())
  const timeZone = opts.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC'
  const limits: LifeLimits = { ...LIFE_LIMITS, ...opts.limits }
  const dir = opts.dir
  const lock = <T>(fn: () => Promise<T>) => withDirLock(dir, fn)
  const today = () => localDate(now(), timeZone)
  // 今天的记录补上当前时刻:同一天里既有「08:00」又有只写日期的记录时,按字符串排序会把
  // 只写日期的排在前面,「最新状态」就取错了。往日补记保持只写日期(时刻不知道就不编)。
  const stampToday = (at: string, day: string) => (at === day ? `${day} ${localTime(now(), timeZone)}` : at)
  const iso = () => new Date(now()).toISOString()

  const streamFile = (ref: string) => {
    const found = findLifeStream(ref)
    if (!found) {
      throw new ButlerError('life_not_found', `没有流水「${ref}」。可用:${allLifeStreamRefs().join('、')}`)
    }
    return { ...found, file: join(dir, found.domain.id, `${found.stream.id}.jsonl`) }
  }

  const domainOf = (id: string) => {
    const d = findLifeDomain(id)
    if (!d) {
      throw new ButlerError(
        'life_not_found',
        `没有档案「${id}」。可用:${LIFE_DOMAIN_TEMPLATES.map((x) => `${x.id}(${x.label})`).join('、')}`,
      )
    }
    return d
  }

  const quarantine = async (file: string, why: string): Promise<void> => {
    const dest = `${file}.corrupt-${now()}`
    try {
      await rename(file, dest)
    } catch {
      // 改名失败也不炸:下一次写会覆盖,原文件在 git 快照里
    }
    opts.logger?.warn('[life] corrupt json quarantined', { file, dest, why })
  }

  const readJson = async <T>(file: string): Promise<T | null> => {
    let raw: string
    try {
      raw = await readFile(file, 'utf8')
    } catch {
      return null
    }
    try {
      return JSON.parse(raw) as T
    } catch {
      await quarantine(file, 'unparsable')
      return null
    }
  }

  /**
   * nextSeq = max(行数, 已有 id 的最大序号) + 1:手工删行或 git 还原让行数变少时 id 也不回退撞号。
   * torn = 文件末尾缺换行(崩溃留下半行)——追加前先补一个换行,新记录不会拼进坏行。
   */
  const readRawLines = async (
    file: string,
  ): Promise<{ records: LifeRecord[]; nextSeq: number; torn: boolean }> => {
    let raw: string
    try {
      raw = await readFile(file, 'utf8')
    } catch {
      return { records: [], nextSeq: 1, torn: false }
    }
    const lines = raw.split('\n').filter((l) => l.trim().length > 0)
    const records: LifeRecord[] = []
    let bad = 0
    let maxSeq = 0
    for (const l of lines) {
      try {
        const r = JSON.parse(l) as LifeRecord
        if (r && typeof r.id === 'string' && typeof r.at === 'string' && r.fields && typeof r.fields === 'object') {
          records.push(r)
          const m = /-(\d+)$/.exec(r.id)
          if (m) maxSeq = Math.max(maxSeq, Number(m[1]))
        } else bad++
      } catch {
        bad++
      }
    }
    if (bad > 0) opts.logger?.warn('[life] skipped unparsable record lines', { file, bad })
    return { records, nextSeq: Math.max(lines.length, maxSeq) + 1, torn: raw.length > 0 && !raw.endsWith('\n') }
  }

  const readDossierUnlocked = async (domain: string): Promise<LifeDossier> => {
    const file = join(dir, domain, 'dossier.json')
    const d = await readJson<LifeDossier>(file)
    if (!d) return EMPTY_DOSSIER
    // 能解析但形状不对(版本不认识、字段类型错):同样隔离,不能当空档案下次写入时覆盖掉。
    const listKeys = ['goals', 'insights', 'openQuestions', 'protocolAdditions', 'proposals', 'log'] as const
    const shapeOk =
      typeof d === 'object' &&
      d.version === 1 &&
      Number.isInteger(d.revision) &&
      Number.isInteger(d.seq) &&
      listKeys.every((k) => d[k] === undefined || Array.isArray(d[k]))
    if (!shapeOk) {
      await quarantine(file, 'unexpected shape')
      return EMPTY_DOSSIER
    }
    return { ...EMPTY_DOSSIER, ...d }
  }

  const snapshotUnlocked = async (domainId: string, day: string): Promise<LifeDomainSnapshot> => {
    const domain = domainOf(domainId)
    const dossier = await readDossierUnlocked(domainId)
    const activeByStream = new Map<string, readonly LifeRecord[]>()
    const totalsByStream = new Map<string, number>()
    let lastAt: string | undefined
    for (const s of domain.streams) {
      const { records } = await readRawLines(join(dir, domain.id, `${s.id}.jsonl`))
      const active = resolveActive(records, s)
      activeByStream.set(s.id, active)
      totalsByStream.set(s.id, active.length)
      const last = active.length ? recordDate(active[active.length - 1]!) : undefined
      if (last && (!lastAt || last > lastAt)) lastAt = last
    }
    const statusLines: string[] = []
    for (const m of domain.status) {
      const spec = domain.streams.find((s) => s.id === m.stream)
      if (!spec) continue
      const rows = activeByStream.get(m.stream) ?? []
      const line = computeStatusLine(m, rows, spec, day)
      if (line) statusLines.push(line)
      // 模板现状按默认币种算;别的币种有数时各列一行(不换算),免得 MYR 收支在卡上看不见。
      const cf = spec.currencyField
      const base = cf ? m.where?.[cf] : undefined
      if (cf && base) {
        const others = [...new Set(rows.map((r) => String(r.fields[cf] ?? '')))].filter((c) => c && c !== base).sort()
        for (const c of others) {
          const v = computeStatusValue(m.agg, m.field ?? spec.primary, { ...m.where, [cf]: c }, rows, spec, day)
          if (!v || !v.value) continue
          const unit = m.unit ? ` ${m.unit.replace(base, c)}` : ''
          statusLines.push(`${m.label}(${c}):${v.text.replace('{unit}', unit)}`)
        }
      }
    }
    const alerts = evaluateLifeAlerts(domain, activeByStream, dossier.goals, day)
    return {
      domain,
      dossier,
      activeByStream,
      totalsByStream,
      statusLines,
      alerts,
      ...(lastAt ? { lastAt } : {}),
      today: day,
    }
  }

  const recomputeUnlocked = async (): Promise<LifeState> => {
    const day = today()
    const domains: Record<string, LifeDomainState> = {}
    for (const d of LIFE_DOMAIN_TEMPLATES) {
      const s = await snapshotUnlocked(d.id, day)
      let records = 0
      for (const n of s.totalsByStream.values()) records += n
      domains[d.id] = {
        ...(s.lastAt ? { lastAt: s.lastAt } : {}),
        records,
        openItems: s.dossier.openQuestions.length + s.dossier.proposals.length,
        alerts: s.alerts,
      }
    }
    const state: LifeState = { version: 1, today: day, domains }
    const file = join(dir, 'state.json')
    const next = `${JSON.stringify(state, null, 2)}\n`
    let prev: string | null = null
    try {
      prev = await readFile(file, 'utf8')
    } catch {
      prev = null
    }
    if (prev !== next) {
      await mkdir(dir, { recursive: true })
      await writeFileAtomic(file, next)
    }
    return state
  }

  return {
    dir,
    timeZone,
    today,

    readRegistry: () => readJson<LifeRegistry>(join(dir, 'registry.json')),

    ensureRegistry: () =>
      lock(async () => {
        const file = join(dir, 'registry.json')
        const existing = await readJson<LifeRegistry>(file)
        if (existing) return existing
        const reg: LifeRegistry = { ...DEFAULT_LIFE_REGISTRY, createdAt: iso() }
        await mkdir(dir, { recursive: true })
        await writeFileAtomic(file, `${JSON.stringify(reg, null, 2)}\n`)
        return reg
      }),

    readRecords: async (ref) => {
      const { file } = streamFile(ref)
      return (await readRawLines(file)).records
    },

    appendRecord: (input) =>
      lock(async () => {
        const { domain, stream, file } = streamFile(input.stream)
        const ref = `${domain.id}.${stream.id}`
        const { records, nextSeq, torn } = await readRawLines(file)
        let target: LifeRecord | undefined
        if (input.supersedes !== undefined || input.retract) {
          if (!input.supersedes) throw new ButlerError('life_invalid', '撤回要给 supersedes(被撤回那条的 id)')
          target = assertSupersedable(records, input.supersedes, ref)
        }
        const day = today()
        const base = {
          id: `${stream.id}-${nextSeq}`,
          stream: ref,
          recordedAt: iso(),
          source: input.source,
        }
        const record: LifeRecord = input.retract
          ? { ...base, at: target!.at, fields: {}, supersedes: input.supersedes!, retracted: true }
          : {
              ...base,
              at: stampToday(normalizeAt(input.at ?? target?.at, day), day),
              fields: validateLifeFields(stream, input.fields),
              ...(input.supersedes ? { supersedes: input.supersedes } : {}),
            }
        const line = `${torn ? '\n' : ''}${JSON.stringify(record)}\n`
        const bytes = Buffer.byteLength(line, 'utf8')
        if (bytes > limits.maxRecordBytes) {
          throw new ButlerError('life_limit', `单条记录上限 ${limits.maxRecordBytes} 字节(这条 ${bytes})——备注写短一点`)
        }
        let size = 0
        try {
          size = (await stat(file)).size
        } catch {
          size = 0
        }
        if (size + bytes > limits.maxStreamBytes) {
          throw new ButlerError(
            'life_limit',
            `${ref} 已有 ${size} 字节(上限 ${limits.maxStreamBytes})——需要成员安排归档,先如实告诉成员`,
          )
        }
        await mkdir(dirname(file), { recursive: true })
        await appendFile(file, line, 'utf8')
        await recomputeUnlocked()
        return { record, ...(target ? { target } : {}) }
      }),

    readDossier: (domain) => {
      domainOf(domain)
      return readDossierUnlocked(domain)
    },

    updateDossier: (domain, expectRevision, mutate) =>
      lock(async () => {
        domainOf(domain)
        const cur = await readDossierUnlocked(domain)
        if (expectRevision !== undefined && expectRevision !== cur.revision) {
          throw new ButlerError(
            'life_conflict',
            `档案 ${domain} 已更新到版本 ${cur.revision}(你拿的是 ${expectRevision})——先 open_dossier 看最新内容再改`,
          )
        }
        let seq = cur.seq
        const nextId = (prefix: string) => `${prefix}${++seq}`
        const { dossier, log } = mutate(cur, nextId)
        const next: LifeDossier = {
          ...dossier,
          version: 1,
          revision: cur.revision + 1,
          seq,
          log: [...cur.log, { at: iso(), text: log }].slice(-limits.logEntries),
        }
        assertDossierLimits(next, limits)
        const file = join(dir, domain, 'dossier.json')
        await mkdir(dirname(file), { recursive: true })
        await writeFileAtomic(file, `${JSON.stringify(next, null, 2)}\n`)
        await recomputeUnlocked()
        return next
      }),

    snapshot: (domain) => lock(() => snapshotUnlocked(domain, today())),

    recomputeState: () => lock(recomputeUnlocked),

    readState: () => readJson<LifeState>(join(dir, 'state.json')),

    writeDerived: (rel, text) =>
      lock(async () => {
        if (!DERIVED_RE.test(rel) || rel.includes('..')) {
          throw new ButlerError('life_invalid', `派生文件路径不对(${rel})`)
        }
        const file = join(dir, ...rel.split('/'))
        await mkdir(dirname(file), { recursive: true })
        let prev: string | null = null
        try {
          prev = await readFile(file, 'utf8')
        } catch {
          prev = null
        }
        if (prev !== text) await writeFileAtomic(file, text)
      }),

    readDerived: async (rel) => {
      if (!DERIVED_RE.test(rel) || rel.includes('..')) return null
      try {
        return await readFile(join(dir, ...rel.split('/')), 'utf8')
      } catch {
        return null
      }
    },
  }
}

function assertDossierLimits(d: LifeDossier, limits: LifeLimits): void {
  const over = (what: string, n: number, max: number, hint: string) => {
    if (n > max) throw new ButlerError('life_limit', `${what}最多 ${max} 条(将有 ${n} 条)——${hint}`)
  }
  over('目标', d.goals.length, limits.maxGoals, '先移除已达成或放弃的')
  over('洞察', d.insights.length, limits.maxInsights, '先删掉过时的,或合并相近的')
  over('待澄清', d.openQuestions.length, limits.maxQuestions, '先关闭已问清的')
  over('补充条款', d.protocolAdditions.length, limits.maxProtocolAdditions, '先合并或移除')
  over('待确认提议', d.proposals.length, limits.maxProposals, '先请成员确认或撤回旧提议')
  if (d.statusNote && [...d.statusNote.text].length > limits.maxStatusNoteChars) {
    throw new ButlerError('life_limit', `现状判断最多 ${limits.maxStatusNoteChars} 字——写一句结论`)
  }
}
