/**
 * personal-butler-proactive.ts — S3-M2: the resident butler REACHES OUT.
 *
 * Everything so far has the butler REACT — a member sends an IM message, the
 * butler answers. S3-M2 lets it ACT proactively: a member opts in ("每天早上跟
 * 我说声早") and the butler sends a short good-morning brief once a day, grounded
 * in what it has curated about them.
 *
 * # Why a poll, not a self-renewing park
 *
 * A reminder (S3-M1) is a one-shot timer, so it rides the Phase 11 park→sweep
 * cleanly. A DAILY brief would have to self-renew (re-park +24h) AND be
 * cancellable — cancelling a parked row means reaching into `suspended_tasks`,
 * which is heavier than the value. Instead this mirrors the BF-M8
 * `ButlerMaintenanceSweeper`: a background poll over the per-user namespaces
 * (`<rootDir>/user/*`) whose OPT-IN is a plain per-user config file. Turning the
 * brief off is just `enabled: false` in that file — no parked row to remove.
 *
 * # The opt-in is DEFAULT-OFF (the settled decision)
 *
 * A member with no `proactive.json` gets nothing. The sweep is cheap for them —
 * it reads the (absent) config and skips. Only an explicit `set_daily_brief`
 * (see `personal-butler-daily-brief.ts`) writes the file. So the FEATURE is
 * opt-in per member even though the sweeper itself runs whenever the butler is on.
 *
 * # Quiet hours = the "fire at/after HOUR, once per member-local day" gate
 *
 * The single hour+dedup gate IS the quiet-hours model for a morning brief: a
 * brief may fire only at/after the member's configured local hour, and at most
 * once per member-local calendar date. No separate night window needed — a brief
 * set for 08:00 simply never fires at 02:00, and never twice in a day.
 *
 * # Silence when there's nothing to say
 *
 * The composer returns `null` when there's nothing worth a note (no curated
 * profile yet, or the model replies with the SKIP sentinel). That applies the
 * heartbeat "don't bother me when idle" convention — but the day is still MARKED
 * so we make exactly ONE composition attempt per member per day (no re-polling
 * the model all morning). A DELIVERY miss (bridge down) is NOT marked, so it
 * retries next tick — best-effort, same posture as the reminder broker.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

import type { Logger } from '@gotong/core'
import {
  drainStream,
  type LlmAgentToolset,
  type LlmContentBlock,
  type LlmMessage,
  type LlmProvider,
  type LlmToolDefinition,
  type LlmToolResultBlock,
} from '@gotong/llm'
import { ownerDir } from '@gotong/service-memory-file'

import { openButlerMemory } from './personal-butler-memory.js'

/** Default poll cadence — 15 min. Tight enough that an 08:00 brief lands by ~08:15,
 *  cheap because a not-yet-due member costs only a config read + local-time math. */
export const BUTLER_PROACTIVE_INTERVAL_MS = 15 * 60 * 1000

/** Default member-local hour a brief may fire at/after when none is given (早上). */
export const DEFAULT_BRIEF_HOUR = 8

/** Default member UTC offset in minutes — Malaysia (+08:00). Overridable per member. */
export const DEFAULT_TZ_OFFSET_MIN = 480

/** How many curated (semantic) facts to ground a brief in. */
const DEFAULT_BRIEF_PROFILE_K = 12

/** The per-user opt-in file name, stored beside the member's memory jsonl. */
const PROACTIVE_FILE = 'proactive.json'

/**
 * The model's "nothing worth a morning note" sentinel — mirrors {@link
 * BUTLER_BRIEF_SYSTEM}'s instruction and the heartbeat's `HEARTBEAT_OK`. A brief
 * that comes back as exactly this maps to `null` (stay silent).
 */
export const BRIEF_SKIP_SENTINEL = 'SKIP'

/** The resident butler's proactive daily-brief opt-in, per member. */
export interface ButlerProactiveConfig {
  /** Whether a daily brief is on for this member. DEFAULT-OFF (absent file ⇒ off). */
  enabled: boolean
  /** Member-local hour (0-23) at/after which the brief may fire. */
  hour: number
  /** Member's UTC offset in minutes (Malaysia = 480 = +08:00). */
  tzOffsetMinutes: number
  /**
   * B2 — opt-in to letting the brief call the member's CONNECTED read-only
   * connectors (weather / calendar / news) for real data. DEFAULT-OFF (absent ⇒
   * off): attaching a connector authorizes on-demand chat use, but an unattended
   * brief that auto-calls it every morning is a stronger authorization the member
   * flips ON explicitly (via `set_daily_brief`). Off ⇒ the brief is the historical
   * tool-less pass, byte-identical.
   */
  enrich?: boolean
  /** Member-local `YYYY-MM-DD` of the last brief ATTEMPT — the once-per-day dedup. */
  lastSentDate?: string
}

/** What one member tick did — surfaced for logging + the acceptance gate. */
export type ProactiveTickOutcome =
  | { fired: true }
  | {
      fired: false
      reason: 'disabled' | 'before-hour' | 'already-today' | 'nothing-to-say' | 'delivery-failed' | 'compose-error'
    }

// ---------------------------------------------------------------------------
// Config store — a plain JSON file in the member's own namespace
// ---------------------------------------------------------------------------

/** The opt-in file path — resolved through `ownerDir` so it runs the SAME
 *  `assertSafeOwnerId` traversal guard the memory jsonl uses and lands right
 *  beside it. Zero path-safety drift from the memory backend. */
function proactiveConfigPath(rootDir: string, userId: string): string {
  return join(ownerDir(rootDir, { kind: 'user', id: userId }), PROACTIVE_FILE)
}

/** Coerce a parsed file into a safe config — missing/bad fields fall back to
 *  defaults so a partial or hand-edited file degrades to "off / default" rather
 *  than throwing on a background tick. */
function normalizeConfig(raw: Partial<ButlerProactiveConfig>): ButlerProactiveConfig {
  const enabled = raw.enabled === true
  const hour =
    typeof raw.hour === 'number' && Number.isInteger(raw.hour) && raw.hour >= 0 && raw.hour <= 23
      ? raw.hour
      : DEFAULT_BRIEF_HOUR
  const tzOffsetMinutes =
    typeof raw.tzOffsetMinutes === 'number' && Number.isFinite(raw.tzOffsetMinutes)
      ? raw.tzOffsetMinutes
      : DEFAULT_TZ_OFFSET_MIN
  const out: ButlerProactiveConfig = { enabled, hour, tzOffsetMinutes }
  if (raw.enrich === true) out.enrich = true
  if (typeof raw.lastSentDate === 'string') out.lastSentDate = raw.lastSentDate
  return out
}

/**
 * Read a member's proactive opt-in. Returns `null` when they never opted in (no
 * file) or the file is corrupt (best-effort — the `set_daily_brief` tool rewrites
 * it). A `null` makes the sweep skip that member cleanly.
 */
export async function readButlerProactiveConfig(
  rootDir: string,
  userId: string,
): Promise<ButlerProactiveConfig | null> {
  let raw: string
  try {
    raw = await readFile(proactiveConfigPath(rootDir, userId), 'utf8')
  } catch {
    return null // never opted in
  }
  try {
    return normalizeConfig(JSON.parse(raw) as Partial<ButlerProactiveConfig>)
  } catch {
    return null // corrupt → treat as not-configured
  }
}

/** Persist a member's proactive opt-in (the `set_daily_brief` tool + the sweep's
 *  daily-dedup mark write through here). */
export async function writeButlerProactiveConfig(
  rootDir: string,
  userId: string,
  cfg: ButlerProactiveConfig,
): Promise<void> {
  const dir = ownerDir(rootDir, { kind: 'user', id: userId })
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, PROACTIVE_FILE), JSON.stringify(cfg, null, 2), 'utf8')
}

// ---------------------------------------------------------------------------
// Member-local time — host-TZ-independent
// ---------------------------------------------------------------------------

/**
 * Derive the member's local wall-clock hour + calendar date from a UTC instant
 * and their offset. The standard shift-then-read-UTC trick: add the offset to the
 * epoch, then read the shifted Date's UTC fields. Deterministic and independent of
 * the HOST's timezone (we never touch the server's local zone), so a brief set for
 * 08:00 fires at the member's 08:00 whatever zone the host runs in.
 */
export function memberLocalNow(
  nowMs: number,
  tzOffsetMinutes: number,
): { hour: number; date: string; weekday: number } {
  const shifted = new Date(nowMs + tzOffsetMinutes * 60_000)
  const y = shifted.getUTCFullYear()
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0')
  const d = String(shifted.getUTCDate()).padStart(2, '0')
  // weekday (0=Sunday, JS convention) rides along for the LIFE-L1 workflow
  // scheduler's weekly cadence — one shift-then-read implementation, two
  // consumers, instead of a second copy of the same date math.
  return { hour: shifted.getUTCHours(), date: `${y}-${m}-${d}`, weekday: shifted.getUTCDay() }
}

// ---------------------------------------------------------------------------
// The brief composer — the ONE place the butler's model runs for a brief
// ---------------------------------------------------------------------------

/** System prompt for a daily brief. Grounded, short, with an explicit SKIP out so
 *  the model can decline when there's genuinely nothing worth a morning note.
 *  自称「阿同」(Atong,「同」取自 Gotong / 同伴)——这是唯一一处框架自声的管家
 *  persona prompt(成员配置的 system 人设不在晨报 sweep 现场),品牌名落在这。 */
const BUTLER_BRIEF_SYSTEM = [
  '你叫「阿同」(Atong),是这位成员的常驻私人管家,现在是他当地的早晨。',
  '根据你长期记住的关于他的信息,写一条简短(1-3 句)、自然、贴心的主动问候,',
  '可以顺带提一件你觉得他今天可能想跟进的事。只依据给你的信息,不要编造具体日程、时间或数字。',
  `如果实在没有值得主动说的,就只回复 ${BRIEF_SKIP_SENTINEL}(不要多写)。用中文。`,
].join('\n')

/**
 * B2 — the enrich addendum, appended to {@link BUTLER_BRIEF_SYSTEM} only when the
 * member opted the brief into their connectors. Keeps the "don't fabricate" rule
 * and adds a hard round cap so an unattended brief can't loop the model.
 */
const BRIEF_ENRICH_SYSTEM = [
  BUTLER_BRIEF_SYSTEM,
  '',
  '你还连了成员的一些只读工具(可能包含天气、日历/日程、新闻等)。如果其中有助于今早的问候,',
  '可以调用它们查一两条真实信息(例如今天天气、今天的安排),自然地融进问候里;查不到、失败或不相关就跳过,',
  '绝不要编造数字或日程。最多查两三次就给出最终问候。',
].join('\n')

/** Max provider round-trips for an enriched brief (tool calls + the final text).
 *  A morning brief needs one round of look-ups then the greeting; 3 is generous. */
const BRIEF_MAX_TOOL_ROUNDS = 3

/** Cap a single tool result's text so a chatty connector can't blow the brief's
 *  context (weather/calendar payloads are tiny; this only bounds a pathological one). */
const BRIEF_TOOL_RESULT_CHAR_CAP = 2000

/** Resolve the butler's provider for a brief (usually `() => pool.buildButlerProvider()`).
 *  Called per compose so a key added after boot is picked up; a null result ⇒ no brief. */
export type ButlerBriefProviderBuilder = () => Promise<LlmProvider | null>

export interface ButlerBriefComposerOptions {
  rootDir: string
  buildProvider: ButlerBriefProviderBuilder
  logger: Logger
  /**
   * B2 — resolve the member's connected READ-ONLY connector tools (weather /
   * calendar / news), or null when none is live. Only consulted for a member who
   * opted the brief in (`enrich`). Read-only by construction (the butler's WRITE
   * MCP half is a governed gate that would PARK — never handed here), so an
   * unattended brief can look but never act. Absent ⇒ enrichment simply never runs.
   */
  mcpReadTools?: () => Promise<LlmAgentToolset | null>
  /** Per-request model / token overrides for the brief call. */
  model?: string
  maxTokens?: number
  now?: () => number
}

/** Flatten a tool result's content blocks to text (images/handles dropped — the
 *  model can't read them here), capped so one connector can't bloat the brief. */
function flattenToolResultText(content: LlmToolCallResultContent): string {
  const text = content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
  return text.length > BRIEF_TOOL_RESULT_CHAR_CAP ? text.slice(0, BRIEF_TOOL_RESULT_CHAR_CAP) : text
}

/** The `content` shape an `LlmAgentToolset.callTool` returns (a small text-block
 *  array in practice); typed locally to avoid importing the full result type. */
type LlmToolCallResultContent = ReadonlyArray<{ type: string; text?: string }>

/**
 * Run the enriched brief: a BOUNDED read-only tool-use loop that lets the model
 * call the member's connectors and weave real data in. Mirrors the LlmAgent loop
 * (feed assistant tool_use + our tool_result back) but hard-capped at
 * {@link BRIEF_MAX_TOOL_ROUNDS} and read-only. Returns the brief, or null on
 * SKIP / empty. A tool that throws becomes an `isError` result the model can
 * recover from — a flaky connector never crashes the brief.
 */
async function composeEnrichedBrief(
  provider: LlmProvider,
  facts: string,
  toolset: LlmAgentToolset,
  opts: ButlerBriefComposerOptions,
): Promise<string | null> {
  let tools: LlmToolDefinition[]
  try {
    tools = await toolset.listTools()
  } catch {
    tools = []
  }
  const messages: LlmMessage[] = [
    {
      role: 'user',
      content: `这是你长期记住的关于他的信息:\n${facts}\n\n请写今天的主动问候(没有值得说的就回 ${BRIEF_SKIP_SENTINEL})。`,
    },
  ]
  let lastText = ''
  for (let round = 0; round < BRIEF_MAX_TOOL_ROUNDS; round++) {
    const res = await drainStream(
      provider.stream({
        system: BRIEF_ENRICH_SYSTEM,
        messages,
        maxTokens: opts.maxTokens ?? 300,
        ...(tools.length > 0 ? { tools } : {}),
        ...(opts.model ? { model: opts.model } : {}),
      }),
    )
    lastText = res.text.trim()
    const toolUses = res.stopReason === 'tool_use' ? (res.toolUses ?? []) : []
    if (toolUses.length === 0) break // the model produced its final greeting
    // Feed the assistant's tool_use blocks + our tool_result blocks back.
    const assistantBlocks: LlmContentBlock[] = []
    if (res.text) assistantBlocks.push({ type: 'text', text: res.text })
    assistantBlocks.push(...toolUses)
    messages.push({ role: 'assistant', content: assistantBlocks })
    const results: LlmToolResultBlock[] = []
    for (const tu of toolUses) {
      try {
        const out = await toolset.callTool(tu.name, tu.input)
        results.push({
          type: 'tool_result',
          toolUseId: tu.id,
          content: flattenToolResultText(out.content as LlmToolCallResultContent),
          ...(out.isError ? { isError: true } : {}),
        })
      } catch (err) {
        results.push({
          type: 'tool_result',
          toolUseId: tu.id,
          content: err instanceof Error ? err.message : String(err),
          isError: true,
        })
      }
    }
    messages.push({ role: 'user', content: results })
  }
  if (lastText.length === 0 || lastText === BRIEF_SKIP_SENTINEL) return null
  return lastText
}

/**
 * Build the injectable `composeBrief` the sweeper calls when a member is DUE. It
 * grounds the brief in the member's curated `semantic` profile (the same bytes the
 * `/me` privacy view + the butler's frozen block read) and asks the butler's OWN
 * model to phrase it — so the proactive voice never disagrees with the
 * conversational one and its usage bills to the same place.
 *
 * When the member opted in (`ctx.enrich`) AND a read-only connector is live, the
 * brief runs a bounded tool-use loop (B2) so it can weave in real weather / agenda
 * / news; otherwise it's the historical single tool-less pass, byte-identical.
 *
 * Returns `null` (stay silent) when there's no provider (no key / no butler row),
 * no curated profile yet, or the model replies with the SKIP sentinel / empty.
 */
export function buildButlerBriefComposer(
  opts: ButlerBriefComposerOptions,
): (userId: string, ctx?: { enrich?: boolean }) => Promise<string | null> {
  return async (userId: string, ctx?: { enrich?: boolean }): Promise<string | null> => {
    const provider = await opts.buildProvider()
    if (!provider) return null // no key / no butler row — nothing to compose with
    const memory = openButlerMemory({
      rootDir: opts.rootDir,
      userId,
      logger: opts.logger,
      ...(opts.now ? { now: opts.now } : {}),
    })
    const profile = await memory.recall({ kinds: ['semantic'], k: DEFAULT_BRIEF_PROFILE_K })
    if (profile.length === 0) return null // nothing curated yet — stay silent
    const facts = profile.map((e) => `- ${e.text}`).join('\n')

    // B2 — enriched path: only when the member opted in AND a read-only connector
    // is actually live. A resolver throw / null (butler row not spawned, no MCP)
    // degrades to the plain pass below — enrichment is a bonus, never a gate.
    if (ctx?.enrich && opts.mcpReadTools) {
      let readTools: LlmAgentToolset | null = null
      try {
        readTools = await opts.mcpReadTools()
      } catch (err) {
        opts.logger.warn('butler brief: resolve connectors failed — plain brief', {
          userId,
          err: err instanceof Error ? err.message : String(err),
        })
      }
      if (readTools) return composeEnrichedBrief(provider, facts, readTools, opts)
    }

    const res = await drainStream(
      provider.stream({
        system: BUTLER_BRIEF_SYSTEM,
        messages: [
          {
            role: 'user',
            content: `这是你长期记住的关于他的信息:\n${facts}\n\n请写今天的主动问候(没有值得说的就回 ${BRIEF_SKIP_SENTINEL})。`,
          },
        ],
        maxTokens: opts.maxTokens ?? 300,
        ...(opts.model ? { model: opts.model } : {}),
      }),
    )
    const text = res.text.trim()
    if (text.length === 0 || text === BRIEF_SKIP_SENTINEL) return null
    return text
  }
}

// ---------------------------------------------------------------------------
// The sweeper
// ---------------------------------------------------------------------------

/** How the sweeper delivers a brief — structurally satisfied by the F1
 *  `pushToMember` (`ImBridgesHandle['pushToMember']`); typed narrowly so this
 *  module takes no `im-bridge` dependency. */
export type ButlerBriefPush = (
  userId: string,
  text: string,
) => Promise<{ delivered: boolean; reason?: string } | void>

export interface ButlerProactiveSweeperOptions {
  /** Butler memory root (`<space>/butler/memory`) — the same one the factory + /me view use. */
  rootDir: string
  /** Compose a brief for a member (or `null` = nothing to say). Called only when
   *  DUE; `ctx.enrich` (B2) forwards the member's connector opt-in from the config
   *  the sweeper already read, so the composer needn't re-read it. */
  composeBrief: (userId: string, ctx?: { enrich?: boolean }) => Promise<string | null>
  /** Deliver a brief to the member's IM (the F1 `pushToMember`, read lazily in main.ts). */
  push: ButlerBriefPush
  logger: Logger
  /** Cadence; defaults to {@link BUTLER_PROACTIVE_INTERVAL_MS} (15 min). */
  intervalMs?: number
  /** Injectable clock (deterministic tests). Default `Date.now`. */
  now?: () => number
}

/**
 * A background sweep that sends each opted-in member their daily brief. Enumerates
 * the on-disk per-user namespaces (`<rootDir>/user/*`) — the same members who have
 * a butler memory — so there's no roster to keep in sync.
 *
 * Like {@link ButlerMaintenanceSweeper} it deliberately does NOT run at boot (the
 * first tick lands one interval after {@link start}) and is best-effort throughout:
 * one member's throw is logged and the sweep moves on.
 */
export class ButlerProactiveSweeper {
  private readonly rootDir: string
  private readonly composeBrief: (userId: string, ctx?: { enrich?: boolean }) => Promise<string | null>
  private readonly push: ButlerBriefPush
  private readonly log: Logger
  private readonly intervalMs: number
  private readonly now: () => number

  private timer?: ReturnType<typeof setInterval>
  private running = false

  constructor(opts: ButlerProactiveSweeperOptions) {
    this.rootDir = opts.rootDir
    this.composeBrief = opts.composeBrief
    this.push = opts.push
    this.log = opts.logger
    this.intervalMs = opts.intervalMs ?? BUTLER_PROACTIVE_INTERVAL_MS
    this.now = opts.now ?? Date.now
  }

  /** Start the interval. `.unref()` so a pending tick never keeps the process alive. */
  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      // Fire-and-forget: a rejected tick must degrade to a log line, never an
      // unhandledRejection that crashes the host.
      void this.runOnce().catch((err) =>
        this.log.warn('butler proactive: tick failed', {
          err: err instanceof Error ? err.message : String(err),
        }),
      )
    }, this.intervalMs)
    this.timer.unref?.()
    this.log.info('butler proactive sweep armed', { intervalMs: this.intervalMs, rootDir: this.rootDir })
  }

  /** Stop the interval (host shutdown). */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  /**
   * Fire one proactive pass across every member namespace. Re-entrant-guarded so a
   * slow tick (many members / a slow model) never overlaps the next. Best-effort:
   * one member's throw is logged and the sweep continues.
   */
  async runOnce(): Promise<void> {
    if (this.running) {
      this.log.debug('butler proactive: previous tick still running, skipping')
      return
    }
    this.running = true
    try {
      const userIds = await this.listUserIds()
      if (userIds.length === 0) return
      let fired = 0
      for (const userId of userIds) {
        try {
          const outcome = await this.runOnceForMember(userId)
          if (outcome.fired) fired++
        } catch (err) {
          this.log.warn('butler proactive: member tick failed', {
            userId,
            err: err instanceof Error ? err.message : String(err),
          })
        }
      }
      if (fired > 0) this.log.info('butler proactive: sweep complete', { members: userIds.length, fired })
    } finally {
      this.running = false
    }
  }

  /**
   * Run one proactive tick for one member: skip unless opted-in + at/after their
   * local hour + not already sent today; compose (LLM at the edge) + push; mark the
   * day on a delivered brief OR a nothing-to-say (one attempt/day), but NOT on a
   * delivery miss (retry next tick). Exposed for the acceptance gate.
   */
  async runOnceForMember(userId: string): Promise<ProactiveTickOutcome> {
    const cfg = await readButlerProactiveConfig(this.rootDir, userId)
    if (!cfg || !cfg.enabled) return { fired: false, reason: 'disabled' }

    const { hour, date } = memberLocalNow(this.now(), cfg.tzOffsetMinutes)
    if (hour < cfg.hour) return { fired: false, reason: 'before-hour' }
    if (cfg.lastSentDate === date) return { fired: false, reason: 'already-today' }

    // Due. Compose the brief (the only place the butler's model runs for a brief).
    // Forward the member's connector opt-in (B2) so the composer can enrich.
    let brief: string | null
    try {
      brief = await this.composeBrief(userId, { enrich: cfg.enrich === true })
    } catch (err) {
      // A compose fault must NOT mark the day — retry next tick (best-effort).
      this.log.warn('butler proactive: compose failed', {
        userId,
        err: err instanceof Error ? err.message : String(err),
      })
      return { fired: false, reason: 'compose-error' }
    }

    const text = typeof brief === 'string' ? brief.trim() : ''
    if (text.length === 0) {
      // Nothing worth a note — stay SILENT (heartbeat idle convention) but MARK today
      // so we make exactly one composition attempt per member per day.
      await this.mark(cfg, userId, date)
      return { fired: false, reason: 'nothing-to-say' }
    }

    // Deliver. On success mark today; on a delivery MISS do NOT mark (retry next tick).
    let delivered = false
    let reason: string | undefined
    try {
      const res = await this.push(userId, text)
      if (res && typeof res === 'object') {
        delivered = res.delivered === true
        reason = res.reason
      }
    } catch (err) {
      reason = err instanceof Error ? err.message : String(err)
    }
    if (delivered) {
      await this.mark(cfg, userId, date)
      this.log.info('butler proactive: brief delivered', { userId })
      return { fired: true }
    }
    this.log.warn('butler proactive: brief composed but not delivered', { userId, reason })
    return { fired: false, reason: 'delivery-failed' }
  }

  /** Record today as the last-attempt date so we don't recompose all day. */
  private async mark(cfg: ButlerProactiveConfig, userId: string, date: string): Promise<void> {
    await writeButlerProactiveConfig(this.rootDir, userId, { ...cfg, lastSentDate: date })
  }

  /**
   * List the member namespaces under `<rootDir>/user/`. The directory name IS the
   * verbatim userId (written through `assertSafeOwnerId`), so reading names back is
   * safe. A missing `user/` dir (no butler members yet) yields an empty list.
   * (Duplicated from `ButlerMaintenanceSweeper` — trivial + keeps the modules
   * independent; extracting a shared util would couple two otherwise-separate sweeps.)
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
