/**
 * personal-butler-run-broadcast.ts — Track A BE-M5. The resident butler tells a
 * member, UNPROMPTED, when a workflow run THEY started has FINISHED.
 *
 * BE-M1 gave the butler eyes it uses on demand: "我那个流程跑完了吗?" →
 * `list_my_runs`. BE-M5 closes the loop the other way — the member shouldn't have
 * to ASK. A run is fire-and-forget (S1-M1 `run_my_workflow`, a `/me` dispatch, or a
 * schedule) and finishes minutes→hours later; this watches for that terminal
 * transition and pushes a short "『X』跑完了:成功 / 失败 — 原因…" to the member's IM.
 *
 * ── Why a poll + high-water mark (mirrors ButlerProactiveSweeper) ────────────
 * There's no run-completion event bus to subscribe to, and adding one would couple
 * the workflow controller to the butler. Instead this mirrors the S3-M2
 * `ButlerProactiveSweeper`: a background poll over the on-disk per-user namespaces
 * (`<rootDir>/user/*`) — the SAME members who have a butler memory — reading each
 * opted-in member's recent runs (the BE-M1 `listRunsByUser` projection, already
 * scoped + secret-scrubbed server-side) and announcing the ones that crossed into a
 * terminal state since we last looked. Dedup is a single monotonic high-water mark
 * `announcedMax` (the max run `endedAt` already announced): a run is announced iff
 * its `endedAt > announcedMax`. Strict `>` makes a double-announce impossible; the
 * only edge (two runs finishing in the SAME millisecond, one lost past the mark) is
 * an acceptable best-effort MISS, never a duplicate ping.
 *
 * ── Why the message is DETERMINISTIC (zero-LLM), unlike the daily brief ──────
 * A run-completion notice is a factual RELAY — workflow id, status, scrubbed reason
 * — not a generative synthesis of the member's profile. So it needs no provider /
 * key and burns no tokens: it's assembled straight from the observed run row. (The
 * daily brief composes WITH the model because it PHRASES a personal greeting; this
 * doesn't.) A welcome side effect: broadcast works on a hub with no butler LLM key
 * configured at all — the same posture as the S3-M1 reminder relay.
 *
 * ── DEFAULT-OFF per member; no backfill on opt-in ────────────────────────────
 * A member with no `run-broadcast.json` gets nothing (the sweep reads the absent
 * config and skips). Only an explicit `set_run_broadcast` (below) writes the file,
 * and it stamps `announcedMax = now()` at that instant — so turning it on never
 * back-announces runs that finished BEFORE opt-in (no history dump). Like the
 * proactive sweep it does NOT run at boot (first tick one interval in) and is
 * best-effort throughout: one member's throw is logged and the sweep moves on; a
 * delivery MISS does not advance the mark, so it retries next tick.
 */

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { Logger } from '@gotong/core'
import type { LlmAgentToolset, LlmToolCallResult, LlmToolDefinition } from '@gotong/llm'
import { ownerDir } from '@gotong/service-memory-file'

import { guideBreadcrumb } from './personal-butler-guide.js'
import type { ButlerRunSurface, ButlerRunView } from './personal-butler-observe.js'

/** Default poll cadence — 5 min. Tighter than the 15-min morning brief because
 *  "your run finished" is more time-sensitive; cheap because a member with no
 *  opt-in file costs only a config read. */
export const BUTLER_RUN_BROADCAST_INTERVAL_MS = 5 * 60 * 1000

/** How many finished runs to announce to ONE member in a single tick — a burst
 *  cap so a member who kicked off many runs at once gets a trickle, not a flood.
 *  The rest ride the high-water mark and land next tick (still `endedAt > mark`). */
const DEFAULT_MAX_PER_TICK = 5

/** How many recent runs to project per member per tick. The high-water mark makes
 *  a modest window plenty — a member won't finish more than this between ticks. */
const DEFAULT_SCAN_LIMIT = 25

/** The per-user opt-in file, stored beside the member's memory jsonl + proactive.json. */
const RUN_BROADCAST_FILE = 'run-broadcast.json'

/**
 * A run's status is TERMINAL — it will not change again — so its result is worth a
 * one-time notice. The workflow run-level `RunStatus` is `running | done | failed |
 * cancelled` (a human-parked run is still `running`, so it is NOT announced until it
 * truly ends). `canceled` is tolerated as a spelling variant; `completed` /
 * `succeeded` are accepted defensively though the real value is `done`.
 */
const TERMINAL_STATUSES = new Set(['done', 'failed', 'cancelled', 'canceled', 'completed', 'succeeded'])

function isTerminal(status: string): boolean {
  return TERMINAL_STATUSES.has(status)
}

/** The resident butler's run-result broadcast opt-in, per member. */
export interface ButlerRunBroadcastConfig {
  /** Whether run-result broadcast is on for this member. DEFAULT-OFF (absent ⇒ off). */
  enabled: boolean
  /** High-water mark: the max run `endedAt` already announced. Stamped to the opt-in
   *  instant on turn-ON so runs finished before opt-in are never back-announced. */
  announcedMax: number
}

/** What one member tick did — surfaced for logging + the acceptance gate. */
export interface RunBroadcastTickOutcome {
  /** How many finished runs were delivered to the member this tick. */
  announced: number
  /** Why nothing (more) fired, when `announced` is 0 or a delivery cut the batch short. */
  reason?: 'disabled' | 'read-error' | 'nothing-new' | 'delivery-failed'
}

// ---------------------------------------------------------------------------
// Config store — a plain JSON file in the member's own namespace.
// ---------------------------------------------------------------------------

/** The opt-in file path — resolved through `ownerDir` so it runs the SAME
 *  `assertSafeOwnerId` traversal guard the memory jsonl uses and lands beside it. */
function configPath(rootDir: string, userId: string): string {
  return join(ownerDir(rootDir, { kind: 'user', id: userId }), RUN_BROADCAST_FILE)
}

/** Coerce a parsed file into a safe config — a partial / hand-edited file degrades
 *  to "off / mark=0" rather than throwing on a background tick. */
function normalizeConfig(raw: Partial<ButlerRunBroadcastConfig>): ButlerRunBroadcastConfig {
  const enabled = raw.enabled === true
  const announcedMax =
    typeof raw.announcedMax === 'number' && Number.isFinite(raw.announcedMax) && raw.announcedMax >= 0
      ? raw.announcedMax
      : 0
  return { enabled, announcedMax }
}

/**
 * Read a member's broadcast opt-in. Returns `null` when they never opted in (no
 * file) or the file is corrupt (best-effort — `set_run_broadcast` rewrites it). A
 * `null` makes the sweep skip that member cleanly.
 */
export async function readButlerRunBroadcastConfig(
  rootDir: string,
  userId: string,
): Promise<ButlerRunBroadcastConfig | null> {
  let raw: string
  try {
    raw = await readFile(configPath(rootDir, userId), 'utf8')
  } catch {
    return null // never opted in
  }
  try {
    return normalizeConfig(JSON.parse(raw) as Partial<ButlerRunBroadcastConfig>)
  } catch {
    return null // corrupt → treat as not-configured
  }
}

/** Persist a member's broadcast opt-in (the tool + the sweep's mark-advance write
 *  through here). */
export async function writeButlerRunBroadcastConfig(
  rootDir: string,
  userId: string,
  cfg: ButlerRunBroadcastConfig,
): Promise<void> {
  const dir = ownerDir(rootDir, { kind: 'user', id: userId })
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, RUN_BROADCAST_FILE), JSON.stringify(cfg, null, 2), 'utf8')
}

// ---------------------------------------------------------------------------
// The message — a deterministic factual relay of one finished run.
// ---------------------------------------------------------------------------

/** Assemble the member-facing notice for one finished run. Pure + zero-LLM: the
 *  status + scrubbed reason come straight off the (already secret-scrubbed) row. */
export function runBroadcastMessage(r: ButlerRunView): string {
  const wf = `「${r.workflowId}」`
  const ref = ` [run: ${r.runId}]`
  if (r.status === 'failed') {
    const why = r.error ? `,原因:${r.error}` : ''
    // AFR-M5 面包屑:失败才附(done/cancelled 没有「修法」可指)。
    return `你发起的工作流${wf}跑失败了${why}。想让我帮你看看哪一步出的问题吗?(${guideBreadcrumb('workflow-failed', '想看常见修法')})${ref}`
  }
  if (r.status === 'cancelled' || r.status === 'canceled') {
    return `你发起的工作流${wf}被取消了(没有跑完)。${ref}`
  }
  // done / completed / succeeded — a clean finish.
  return `你发起的工作流${wf}已经跑完了(成功)。${ref}`
}

// ---------------------------------------------------------------------------
// The sweeper.
// ---------------------------------------------------------------------------

/** How the sweeper delivers a notice — structurally satisfied by the F1
 *  `pushToMember` (`ImBridgesHandle['pushToMember']`); typed narrowly so this
 *  module takes no `im-bridge` dependency. Shared shape with `ButlerBriefPush`. */
export type ButlerRunBroadcastPush = (
  userId: string,
  text: string,
) => Promise<{ delivered: boolean; reason?: string } | void>

export interface ButlerRunBroadcastSweeperOptions {
  /** Butler memory root (`<space>/butler/memory`) — the opt-in file lives per-user under it. */
  rootDir: string
  /** This member's recent runs (the BE-M1 `WorkflowController.listRunsByUser` projection). */
  runs: ButlerRunSurface
  /** Deliver a notice to the member's IM (the F1 `pushToMember`, read lazily in main.ts). */
  push: ButlerRunBroadcastPush
  logger: Logger
  /** Cadence; defaults to {@link BUTLER_RUN_BROADCAST_INTERVAL_MS} (5 min). */
  intervalMs?: number
  /** Burst cap per member per tick; defaults to {@link DEFAULT_MAX_PER_TICK}. */
  maxPerTick?: number
  /** Runs projected per member per tick; defaults to {@link DEFAULT_SCAN_LIMIT}. */
  scanLimit?: number
}

/**
 * A background sweep that pushes each opted-in member a notice for every run of
 * theirs that has finished since the last pass. Enumerates the on-disk per-user
 * namespaces (`<rootDir>/user/*`) so there's no roster to keep in sync — the same
 * approach as {@link ButlerProactiveSweeper}.
 *
 * Deliberately does NOT run at boot (first tick lands one interval after {@link
 * start}) and is best-effort throughout: one member's throw is logged and the sweep
 * moves on.
 */
export class ButlerRunBroadcastSweeper {
  private readonly rootDir: string
  private readonly runs: ButlerRunSurface
  private readonly push: ButlerRunBroadcastPush
  private readonly log: Logger
  private readonly intervalMs: number
  private readonly maxPerTick: number
  private readonly scanLimit: number

  private timer?: ReturnType<typeof setInterval>
  private running = false

  constructor(opts: ButlerRunBroadcastSweeperOptions) {
    this.rootDir = opts.rootDir
    this.runs = opts.runs
    this.push = opts.push
    this.log = opts.logger
    this.intervalMs = opts.intervalMs ?? BUTLER_RUN_BROADCAST_INTERVAL_MS
    this.maxPerTick = opts.maxPerTick ?? DEFAULT_MAX_PER_TICK
    this.scanLimit = opts.scanLimit ?? DEFAULT_SCAN_LIMIT
  }

  /** Start the interval. `.unref()` so a pending tick never keeps the process alive. */
  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.runOnce()
    }, this.intervalMs)
    this.timer.unref?.()
    this.log.info('butler run-broadcast sweep armed', { intervalMs: this.intervalMs, rootDir: this.rootDir })
  }

  /** Stop the interval (host shutdown). */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  /**
   * Fire one broadcast pass across every member namespace. Re-entrant-guarded so a
   * slow tick never overlaps the next. Best-effort: one member's throw is logged and
   * the sweep continues.
   */
  async runOnce(): Promise<void> {
    if (this.running) {
      this.log.debug('butler run-broadcast: previous tick still running, skipping')
      return
    }
    this.running = true
    try {
      const userIds = await this.listUserIds()
      if (userIds.length === 0) return
      let announced = 0
      for (const userId of userIds) {
        try {
          const outcome = await this.runOnceForMember(userId)
          announced += outcome.announced
        } catch (err) {
          this.log.warn('butler run-broadcast: member tick failed', {
            userId,
            err: err instanceof Error ? err.message : String(err),
          })
        }
      }
      if (announced > 0) this.log.info('butler run-broadcast: sweep complete', { members: userIds.length, announced })
    } finally {
      this.running = false
    }
  }

  /**
   * Run one broadcast tick for one member: skip unless opted-in; project their recent
   * runs; announce each run that is TERMINAL and finished past the high-water mark, in
   * FINISH order (oldest first), up to the per-tick cap. Advance the mark to the last
   * DELIVERED run's `endedAt` — a delivery miss cuts the batch short (that run + all
   * later ones retry next tick), so the mark only ever passes runs the member actually
   * received. Exposed for the acceptance gate.
   */
  async runOnceForMember(userId: string): Promise<RunBroadcastTickOutcome> {
    const cfg = await readButlerRunBroadcastConfig(this.rootDir, userId)
    if (!cfg || !cfg.enabled) return { announced: 0, reason: 'disabled' }

    let rows: ButlerRunView[]
    try {
      rows = await this.runs.listRunsByUser(userId, { limit: this.scanLimit })
    } catch (err) {
      // Fail closed: a read fault must NOT advance the mark — retry next tick.
      this.log.warn('butler run-broadcast: listRunsByUser failed', {
        userId,
        err: err instanceof Error ? err.message : String(err),
      })
      return { announced: 0, reason: 'read-error' }
    }

    // Terminal + finished strictly after the mark, oldest-finish first, burst-capped.
    const fresh = rows
      .filter((r): r is ButlerRunView & { endedAt: number } =>
        isTerminal(r.status) && typeof r.endedAt === 'number' && r.endedAt > cfg.announcedMax,
      )
      .sort((a, b) => a.endedAt - b.endedAt)
      .slice(0, this.maxPerTick)
    if (fresh.length === 0) return { announced: 0, reason: 'nothing-new' }

    let mark = cfg.announcedMax
    let announced = 0
    let cutShort = false
    for (const r of fresh) {
      let delivered = false
      let reason: string | undefined
      try {
        const res = await this.push(userId, runBroadcastMessage(r))
        if (res && typeof res === 'object') {
          delivered = res.delivered === true
          reason = res.reason
        }
      } catch (err) {
        reason = err instanceof Error ? err.message : String(err)
      }
      if (!delivered) {
        // Best-effort: stop here so this run + every later one retries next tick.
        this.log.warn('butler run-broadcast: notice not delivered, will retry', { userId, runId: r.runId, reason })
        cutShort = true
        break
      }
      mark = r.endedAt // ascending order ⇒ monotonic advance over delivered runs
      announced++
    }

    if (mark > cfg.announcedMax) {
      await writeButlerRunBroadcastConfig(this.rootDir, userId, { ...cfg, announcedMax: mark })
    }
    if (announced > 0) return cutShort ? { announced, reason: 'delivery-failed' } : { announced }
    return { announced: 0, reason: 'delivery-failed' }
  }

  /**
   * List the member namespaces under `<rootDir>/user/`. The directory name IS the
   * verbatim userId (written through `assertSafeOwnerId`), so reading names back is
   * safe. A missing `user/` dir (no butler members yet) yields an empty list.
   * (Duplicated from the sibling sweepers — trivial + keeps the modules independent.)
   */
  private async listUserIds(): Promise<string[]> {
    try {
      const entries = await readdir(join(this.rootDir, 'user'), { withFileTypes: true })
      return entries.filter((e) => e.isDirectory()).map((e) => e.name)
    } catch {
      return [] // user/ doesn't exist yet — no members, no work
    }
  }
}

// ---------------------------------------------------------------------------
// The benign opt-in tool — `set_run_broadcast`.
// ---------------------------------------------------------------------------

export interface ButlerRunBroadcastToolDeps {
  /** The member this butler serves — the opt-in is scoped/written to their namespace. */
  userId: string
  /** Butler memory root — the opt-in file lives per-user under it. */
  rootDir: string
  /** Injectable clock (deterministic tests). Default `Date.now`. */
  now?: () => number
  logger?: { error: (msg: string, meta?: Record<string, unknown>) => void }
}

const RUN_BROADCAST_TOOL: LlmToolDefinition = {
  name: 'set_run_broadcast',
  description:
    '开启或关闭"工作流跑完了主动告诉我"。用户想让你在他发起的工作流运行结束时(成功或失败)主动通知他,就 enabled=true;想关掉就 enabled=false。开启后只通知开启之后才结束的运行,不会翻旧账。这是这位成员自己的偏好,只影响他自己。',
  inputSchema: {
    type: 'object',
    properties: {
      enabled: { type: 'boolean', description: '开启(true)还是关闭(false)工作流跑完的主动播报。' },
    },
    required: ['enabled'],
    additionalProperties: false,
  },
}

class ButlerRunBroadcastToolset implements LlmAgentToolset {
  constructor(private readonly deps: ButlerRunBroadcastToolDeps) {}

  listTools(): LlmToolDefinition[] {
    return [RUN_BROADCAST_TOOL]
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<LlmToolCallResult> {
    if (name !== 'set_run_broadcast') return text(`未知工具:${name}`, true)
    if (typeof args.enabled !== 'boolean') {
      return text('请说清楚是要开启(enabled=true)还是关闭(enabled=false)工作流跑完的主动播报。', true)
    }
    const enabled = args.enabled
    const now = this.deps.now ?? Date.now

    // Read the prior mark so a re-enable doesn't dump the runs finished while it was
    // OFF: keep the existing high-water mark on any transition EXCEPT a fresh turn-ON,
    // where we stamp `now()` so only runs finishing from here on are announced.
    let existing: ButlerRunBroadcastConfig | null
    try {
      existing = await readButlerRunBroadcastConfig(this.deps.rootDir, this.deps.userId)
    } catch (err) {
      this.deps.logger?.error('butler run-broadcast: read config failed', { err })
      existing = null
    }
    const turningOn = enabled && !(existing?.enabled ?? false)
    const announcedMax = turningOn ? now() : existing?.announcedMax ?? now()

    try {
      await writeButlerRunBroadcastConfig(this.deps.rootDir, this.deps.userId, { enabled, announcedMax })
    } catch (err) {
      this.deps.logger?.error('butler run-broadcast: write config failed', { err })
      return text('设置失败,没能保存你的偏好,待会儿再试一次吧。', true)
    }

    return enabled
      ? text('好,以后你发起的工作流一跑完(成功或失败)我就主动告诉你。想关就跟我说一声。')
      : text('好,以后工作流跑完我不再主动打扰你了。')
  }
}

function text(t: string, isError = false): LlmToolCallResult {
  return isError ? { content: [{ type: 'text', text: t }], isError: true } : { content: [{ type: 'text', text: t }] }
}

/**
 * Build the per-user benign "工作流跑完主动播报" opt-in toolset for a resident
 * butler. Add it to `PersonalButlerAgent({ benign })`. It only writes the per-user
 * opt-in file; the {@link ButlerRunBroadcastSweeper} polls it and delivers. Benign
 * (runs inline): flipping your OWN completion notices on/off consequences nobody else.
 */
export function buildButlerRunBroadcastToolset(deps: ButlerRunBroadcastToolDeps): LlmAgentToolset {
  return new ButlerRunBroadcastToolset(deps)
}
