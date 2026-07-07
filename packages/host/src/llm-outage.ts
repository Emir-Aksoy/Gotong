/**
 * CARE-M2 — 断供不失联:LLM provider 断供的边沿检测 + 状态文件。
 *
 * 为什么是边沿而不是电平:断供期间每条消息都已经拿到 canned 回复,
 * 播报若跟着电平走就是刷屏;成员要的只有两个时刻——「坏了」一声、
 * 「好了」一声。dedup 靠 `runtime/llm-outage.json` 落盘(file-first),
 * host 重启后不重播;文件损坏当空(诚实降级:大不了多播一次,绝不
 * 因为一个坏文件让播报环崩掉)。
 *
 * 写盘失败不吞边沿:磁盘病了是另一种病,不该把「告诉用户大脑坏了」
 * 一并绑架——代价是极端情况下重启后重播一次,可接受。
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { LlmErrorKind } from '@gotong/llm'

import { translateLlmFailureKind, type FailureLang } from './failure-translator.js'

/** 落盘形状:kind + 起点 + 已播标记。文件不存在 = 一切正常。 */
export interface LlmOutageSnapshot {
  kind: LlmErrorKind
  since: number
  announced: boolean
}

const KINDS: ReadonlySet<string> = new Set([
  'auth', 'quota', 'rate_limited', 'network', 'model_not_found', 'timeout', 'unknown',
])

function isSnapshot(v: unknown): v is LlmOutageSnapshot {
  if (!v || typeof v !== 'object') return false
  const s = v as Partial<LlmOutageSnapshot>
  return typeof s.kind === 'string' && KINDS.has(s.kind)
    && typeof s.since === 'number' && Number.isFinite(s.since)
    && typeof s.announced === 'boolean'
}

export class LlmOutageTracker {
  private loaded = false
  private state: LlmOutageSnapshot | null = null

  constructor(
    private readonly file: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** 当前断供快照(null = 正常)。测试与体检面用。 */
  async snapshot(): Promise<LlmOutageSnapshot | null> {
    await this.load()
    return this.state
  }

  /**
   * provider 病了。首次(含重启后读到未播状态)→ 'announce' 恰一次;
   * 已在断供 → 'quiet',kind 漂移只更新事实不再打扰——一次断供播一次,
   * 病名变了不值得再吵一遍,恢复播报才是下一个该出声的时刻。
   */
  async onProviderFailure(kind: LlmErrorKind): Promise<'announce' | 'quiet'> {
    await this.load()
    if (this.state && this.state.announced) {
      if (this.state.kind !== kind) {
        this.state = { ...this.state, kind }
        await this.persist()
      }
      return 'quiet'
    }
    this.state = { kind, since: this.state?.since ?? this.now(), announced: true }
    await this.persist()
    return 'announce'
  }

  /** provider 答上话了。之前在断供 → 'announce_recovery' 恰一次 + 清文件。 */
  async onProviderSuccess(): Promise<'announce_recovery' | 'quiet'> {
    await this.load()
    if (!this.state) return 'quiet'
    this.state = null
    try {
      await rm(this.file, { force: true })
    } catch {
      // 清不掉就留着——下次失败会覆写;恢复边沿已在内存判定,不重播。
    }
    return 'announce_recovery'
  }

  private async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const parsed: unknown = JSON.parse(await readFile(this.file, 'utf8'))
      this.state = isSnapshot(parsed) ? parsed : null
    } catch {
      this.state = null // 不存在或损坏当空
    }
  }

  private async persist(): Promise<void> {
    try {
      await mkdir(dirname(this.file), { recursive: true })
      await writeFile(this.file, JSON.stringify(this.state, null, 2), 'utf8')
    } catch {
      // 见文件头:写盘失败不吞边沿。
    }
  }
}

/** 断供播报(零 LLM,文案来自 CARE-M1 翻译表)。 */
export function llmOutageAnnouncement(kind: LlmErrorKind, lang: FailureLang): string {
  const t = translateLlmFailureKind(kind, lang)
  return lang === 'zh'
    ? `⚠️ 管家大脑暂时不可用:${t.headline}\n${t.fix}\n期间命令(/help /agents /workflow)照常可用;恢复了我会说一声。`
    : `⚠️ The butler's brain is temporarily unavailable: ${t.headline}\n${t.fix}\nCommands (/help /agents /workflow) still work; I'll ping you when it recovers.`
}

/** 恢复播报(零 LLM)。 */
export function llmRecoveryAnnouncement(lang: FailureLang): string {
  return lang === 'zh'
    ? '✅ 管家大脑恢复了,可以正常聊天了。'
    : "✅ The butler's brain is back — chat works normally again."
}

/**
 * CARE-M5 — 探针能**证伪「恢复」**的断供 kind。只读活体探针(models-list
 * GET)本质是「够得着 + 认得过 provider」的一次握手,只有当断供本身就是
 * 「够不着 / 认不过」时,握手成功才等于恢复:
 *   - network  探针答上话 = 网络回来了
 *   - timeout  探针即时返回 = provider 又响应了
 *   - auth     探针用同一把 key,200 = key 又有效了
 * 蓄意**不含**:
 *   - quota / rate_limited —— 只读 models-list 免费,握手成功证明不了
 *     「生成配额已恢复」,探通了就播「恢复」是误报;
 *   - model_not_found —— 列表 200 证明不了那个具体模型又在了。
 * 这三类继续走反应式(下一条真派发成功才由 onProviderSuccess 清并播),
 * 主动探针在它们身上一律 no-op。(unknown 本就从不被记为断供——反应式
 * 路径把它落到通用 Task-failed 兜底,故此处不必列。)
 */
const PROBE_CONFIRMABLE_KINDS: ReadonlySet<LlmErrorKind> = new Set<LlmErrorKind>([
  'network',
  'timeout',
  'auth',
])

/** 一次主动恢复探活的结果(测试断言 + 日志用)。 */
export type OutageRecoveryOutcome =
  | 'idle' // 当前无断供 → 根本没探(健康时零 provider 调用)
  | 'skipped_kind' // 断供 kind 探针证伪不了(quota/rate_limited/model_not_found)→ 交给反应式
  | 'still_down' // 探了,没通 → 静默
  | 'recovered' // 探通了 → 已(经 tracker 边沿判定)播恢复

export interface OutageRecoveryDeps {
  tracker: LlmOutageTracker
  /** 只读活体探针(models-list GET,零 token);true = 大脑够得着且认得过。 */
  probeLiveness: () => Promise<boolean>
  /** 恢复播报出口(与 CARE-M2 边沿播报同一个 announce)。 */
  announce: (text: string) => Promise<void>
  lang: FailureLang
  log: { warn: (msg: string, ctx?: Record<string, unknown>) => void }
}

/**
 * CARE-M5 — 断供期间的一次主动恢复探活,补上 CARE-M2「恢复只在下一条用户
 * 消息成功时才播」的缺口:provider 半夜恢复、无人发消息时,由这里按节律探
 * 通后立刻播「✅ 恢复了」。
 *
 * 健康(无断供)→ 'idle',**根本不探**,零成本。恢复边沿仍由 tracker 单实例
 * 判定——与反应式路径共用同一个 tracker,谁先清谁播,绝不重复播报(另一条
 * 路径随后拿到 'quiet')。设计上不抛:所有 await 点都在 try 里或本就不 reject。
 */
export async function checkOutageRecovery(deps: OutageRecoveryDeps): Promise<OutageRecoveryOutcome> {
  const snap = await deps.tracker.snapshot()
  if (!snap) return 'idle'
  if (!PROBE_CONFIRMABLE_KINDS.has(snap.kind)) return 'skipped_kind'
  let live = false
  try {
    live = await deps.probeLiveness()
  } catch (err) {
    deps.log.warn('llm recovery probe threw', { err: String(err) })
    return 'still_down'
  }
  if (!live) return 'still_down'
  // tracker 单实例判边沿:onProviderSuccess 清文件并返回是否该播。反应式
  // 路径若同一时刻也清了,这里拿到 'quiet',不重播。
  if ((await deps.tracker.onProviderSuccess()) === 'announce_recovery') {
    try {
      await deps.announce(llmRecoveryAnnouncement(deps.lang))
    } catch (err) {
      deps.log.warn('llm recovery announce failed', { err: String(err) })
    }
  }
  return 'recovered'
}
