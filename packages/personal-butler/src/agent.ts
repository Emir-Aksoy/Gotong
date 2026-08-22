/**
 * `PersonalButlerAgent` — the resident butler.
 *
 * A `MemoryAugmentedAgent` (frozen-block memory + turn capture, from
 * `@gotong/personal-memory`) with ONE addition: a bounded tool-loop whose
 * SENSITIVE tool calls are approval-gated (decision D2). Everything else —
 * memory, capture, suspend/resume working memory, usage sink — is inherited.
 *
 * The loop is the steward's governance path turned inside-out: instead of a
 * separate "propose → apply" engine, the butler runs ONE tool-loop where the
 * dangerous tools simply park the task (`SuspendTaskError` → `/me` inbox) until
 * a human approves. Benign tools (recall / dispatch / workflow-start / mcp) run
 * inline. This is the same mechanism `@gotong/acp-agent`'s permission gate uses,
 * adapted from a live subprocess to a re-runnable conversation.
 *
 * Why override `runToolLoop` (rather than seam into the base loop): the base
 * `LlmAgent` loop deliberately maps EVERY `callTool` throw to an `isError` tool
 * result (so `DispatchToolset` can surface a child-suspend without parking the
 * parent). The butler needs the opposite for governed tools — park the parent —
 * so it owns its own loop + a bespoke checkpoint state. Blast radius stays in
 * this package; the shared base loop is untouched.
 */

import { SuspendTaskError, isSuspendTaskError, type Task } from '@gotong/core'
import {
  ComposedToolset,
  type LlmAgentToolset,
  type LlmContentBlock,
  type LlmMessage,
  type LlmProvider,
  type LlmRequest,
  type LlmResponse,
  type LlmToolResultBlock,
  type LlmToolUseBlock,
} from '@gotong/llm'
import {
  DEFAULT_TIERS,
  MemoryAugmentedAgent,
  type MemoryAugmentedAgentOptions,
} from '@gotong/personal-memory'

import {
  BUTLER_NEVER_RESUME_AT,
  butlerGateState,
  type PersistedVerdict,
  readButlerDecision,
  readButlerGateState,
} from './checkpoint.js'
import { GovernedActionToolset, type GovernedVerdict } from './governed-toolset.js'
import {
  LONGRUN_COMPACTOR_SYSTEM,
  LONGRUN_LIMITS,
  checkLongRunBudget,
  cleanLongRunText,
  clipLongRunText,
  countSettledChildren,
  decideSegmentVerdict,
  longRunRelayState,
  markChildResultsSeen,
  precheckLongRunWake,
  readLongRunChildMarker,
  readLongRunRelayState,
  readLongRunSegmentMarker,
  recordSegmentUsage,
  renderCompactorInput,
  renderRelayPrompt,
  renderWindDownPrompt,
  weighLongRunUsage,
  type LongRunDossier,
  type LongRunDossierStore,
} from './longrun-dossier.js'

/**
 * LONG-M4b — the two role slots the driver consults(工种×模型:按工种派档).
 * Closed set mirroring core `LongRunModelSlots`; `planner` is deliberately
 * absent (the v1 driver has no re-planning call site — a slot nobody reads
 * is dead configuration).
 */
export type LongRunSlotName = 'compactor' | 'synthesizer'

/**
 * LONG-M4b — a resolved slot. `model` is always present (the slot's whole
 * point is "this role speaks to THAT model"); `provider` only when the slot
 * crosses providers (host built a dedicated provider from the slot's
 * provider/baseURL/apiKeyEnv). Model-only = the main chain with another model
 * name — the NA-M5 `maintenanceModel` semantics.
 */
export interface LongRunSlotResolution {
  provider?: LlmProvider
  model: string
}

/**
 * LONG-M2 — everything the segment driver needs from the host, as ONE injected
 * bundle (mirrors the store's own dependency posture: injected clock, duck
 * logger, no host imports). Absent ⇒ the butler has no long-run lane at all —
 * a segment-marked task then gets an HONEST "驱动器未接" reply instead of a
 * silently-normal chat turn that would strand the dossier.
 */
export interface ButlerLongRunDriver {
  store: LongRunDossierStore
  /** Injected clock — segment wall-time and relay resumeAt derive from THIS,
   *  never from `Date.now()` (the dossier core's zero-wall-clock rule extends
   *  to the driver so tests can steer time). */
  now: () => number
  /** Best-effort member push (done summary / blocked question / failure
   *  notice). Absent ⇒ silent; a throw is warn-and-continue — delivery must
   *  never decide a segment's fate. */
  push?: (text: string) => unknown | Promise<unknown>
  /**
   * LONG-M4b — role-slot resolver (host builds it from the row's
   * `longRunModels`; absent ⇒ BOTH roles ride the main chain = byte-identical
   * to M2). Asked once per use, never cached here (the host resolver caches
   * its own successes). The never-throws contract is enforced by the driver:
   * a throw / a malformed answer ⇒ warn + "unconfigured" — a slot can only ever
   * improve a segment, never strand one.
   */
  slotProvider?: (slot: LongRunSlotName) => Promise<LongRunSlotResolution | null>
  /**
   * What time is it — rendered by the SAME builder and timezone the per-turn
   * clock probe uses (`buildButlerClockLabel`), because a segment structurally
   * skips that probe. Absent ⇒ no clock line ⇒ prompts byte-identical to M4b.
   * Total by contract: a throw here would strand a segment over a cosmetic
   * line, so the driver treats a failure as "no clock".
   */
  clockLabel?: () => string
  /**
   * M6.2 — when this member last spoke to the butler (ms, injected-clock
   * scale), for the standby wake check. The host reads the SAME per-turn
   * presence stamp the greeting probe writes, which is exactly "成员开口":
   * segments structurally bypass that probe, so a segment can never move this
   * stamp and can never wake itself.
   *
   * Best-effort by contract: absent, throwing, or null all read as "member
   * silent" — the task then wakes only at its own check-back, which is a
   * latency cost, never a correctness one. It must never strand a segment.
   */
  memberLastSeenMs?: () => number | null | Promise<number | null>
  logger?: { warn(msg: string, meta?: Record<string, unknown>): void }
}

export interface PersonalButlerAgentOptions
  extends Omit<MemoryAugmentedAgentOptions, 'tools'> {
  /**
   * The approval-gated sensitive-action toolset(s) (change hub / spend / send /
   * delete). OPTIONAL: omit it for a PURE-MEMORY butler — one that remembers
   * across sessions and runs benign tools inline, but has no governed actions to
   * park. The host wires it this way for the IM fold-in's first cut (memory only,
   * near-zero behaviour change for a live chat agent), then injects the governed
   * steward action set in a later milestone. With no governed toolset the loop
   * simply never parks for approval — every tool is benign.
   *
   * Accepts an ARRAY so distinct governed sources compose without merging their
   * internals: the steward action set (create/edit/delete agent, edit workflow)
   * AND, say, the write half of a notes/calendar MCP each stay self-contained
   * (own classify / execute / describe). A tool is gated by the FIRST gate that
   * `governs` it; execution still routes through the composed `this.toolset`,
   * which includes every gate — so each gate's names must be disjoint (both from
   * each other and from the benign toolsets), the same rule `ComposedToolset`
   * already enforces.
   */
  governed?: GovernedActionToolset | GovernedActionToolset[]
  /**
   * Benign toolsets composed alongside memory + governed — e.g. a
   * `DispatchToolset` (sub-agents), a workflow-start toolset, an `McpToolset`.
   * These run inline; only `governed` tools can park the task.
   */
  benign?: LlmAgentToolset | LlmAgentToolset[]
  /**
   * CARE-M4 — optional per-turn context probe, run BEFORE each fresh task's
   * tool-loop. A non-null return is appended to the END of the system prompt
   * for that turn only (the frozen memory block + persona keep leading, so the
   * stable prompt-cache prefix is untouched; the probe's text is the variable
   * tail). `null` ⇒ inject nothing — the zero-injection contract the host's
   * onboarding companion rides: the probe itself decides, deterministically,
   * whether this turn needs extra context.
   *
   * Failure posture: a probe throw is swallowed (→ no injection). The probe is
   * an ADVISOR; it must never take normal chat down with it. Not re-run on
   * resume — a resumed conversation rides its saved messages, and re-probing
   * mid-approval could inject a card the parked plan never saw.
   */
  contextProbe?: (task: Task) => Promise<string | null>
  /**
   * LIB-M3 — optional per-turn STABLE-segment card (the knowledge-library
   * INDEX card rides this). Unlike `contextProbe` (per-turn ADVICE on the
   * volatile tail), this is STATE: its text changes only when the underlying
   * state changes, so it belongs in `req.system` where the prompt cache
   * amortizes it — unchanged state ⇒ identical bytes ⇒ cache hit; an edit
   * breaks the cache exactly once, then re-hits ("重算≠变更").
   *
   * Refreshed on BOTH fresh tasks and resume. The frozen block sets the
   * precedent: a park→approve→resume after a restart recomposes it from
   * CURRENT memory — state context reflects now, while advice context
   * (`contextProbe`) deliberately does not survive into a resume.
   *
   * `null` ⇒ nothing appended ⇒ byte-identical prompt. A throw degrades to
   * null (advisor discipline, same as `contextProbe`).
   */
  stableContext?: () => Promise<string | null>
  /**
   * LONG-M2 — the segmented long-run driver (dossier store + clock + push).
   * OPTIONAL: absent ⇒ no long-run lane; a segment-marked task answers with an
   * honest "驱动器未接" instead of running as normal chat. See
   * {@link ButlerLongRunDriver}.
   */
  longRun?: ButlerLongRunDriver
}

/**
 * The butler's tool-round ceiling — raised above `LlmAgent`'s framework-wide
 * default of 8.
 *
 * That 8 is a runaway-loop backstop for a GENERIC agent, and it was set when
 * every tool sat on one flat face. Two things have since made 8 bind on
 * legitimate work rather than on runaway loops:
 *
 *   1. AFR-M2/M3 two-tier tool face. The long tail now lives behind
 *      `list_tool_directory` + `use_tool`, and BOTH are ordinary tool calls —
 *      so any errand that touches a long-tail tool pays at least one extra
 *      round for the directory lookup that the flat face never charged. The
 *      cap was never re-cut for it.
 *   2. The butler is an ERRAND runner, not a one-shot answerer. A routine
 *      "check the calendar, read the relevant knowledge file, draft it, look
 *      one thing up, revise" is 5-6 rounds of honest work before the model has
 *      spent a single round on a retry or a correction.
 *
 * Hitting the cap is not a graceful degradation: `handleTask` aborts the whole
 * errand with `[butler: aborted after N tool-use rounds]`, mid-task, with
 * nothing delivered. Under-cutting it costs real completions; over-cutting it
 * costs at most a few wasted calls on the rare true runaway, which the cap
 * still catches.
 *
 * A constant, not a knob (SESS / NA-M2 idiom): the number encodes what the
 * butler IS, and shipping it as a `ManagedAgentSpec` field would mean five
 * seams (spec + manifest validation + agents-routes + panel capture-echo +
 * resource-adapt echo) and a silent-drop footgun, for a value nobody has
 * needed to tune per hub.
 */
export const BUTLER_MAX_TOOL_ROUNDS = 16

export class PersonalButlerAgent extends MemoryAugmentedAgent {
  /** Held for GATING (governs / classify / describe). Execution routes through
   *  the composed `this.toolset`, which already includes them. Empty for a
   *  pure-memory butler — the loop then never parks (every tool is benign). An
   *  array so multiple self-contained gates coexist; `governedFor` picks the
   *  first that governs a given tool. */
  private readonly governedGates: readonly GovernedActionToolset[]
  /** CARE-M4 — per-turn context probe (see the option's doc). */
  private readonly contextProbe: ((task: Task) => Promise<string | null>) | undefined
  /** The current turn's probe result; null between turns / on resume. */
  private turnContext: string | null = null
  /** LIB-M3 — stable-segment card provider (see the option's doc). */
  private readonly stableContext: (() => Promise<string | null>) | undefined
  /** The current stable card; refreshed per task AND per resume (state, not advice). */
  private stableCard: string | null = null
  /** LONG-M2 — segment driver bundle; undefined ⇒ no long-run lane. */
  private readonly longRun: ButlerLongRunDriver | undefined
  /** Hub-task ids currently executing a long-run segment (usage-metering gate).
   *  Keyed by the HUB task id (not the long-run taskId): the accumulator must
   *  meter exactly the provider calls of THIS execution, and `task.id` is the
   *  only key `streamWithAuthHook` can see. */
  private readonly longRunActive = new Set<string>()
  /** Per-execution token meter: sum of every usage report while active. */
  private readonly longRunUsage = new Map<string, number>()
  /** LONG-M4b — per-execution role-slot override (synthesizer segment / the
   *  compactor's call). Keyed by HUB task id like the meter: `providerFor` and
   *  `buildRequest` read it per call, so it scopes to exactly the execution
   *  that installed it and the two `finally` blocks below clear it. */
  private readonly longRunSlotOverride = new Map<string, LongRunSlotResolution>()

  constructor(opts: PersonalButlerAgentOptions) {
    const benignList = opts.benign
      ? Array.isArray(opts.benign)
        ? opts.benign
        : [opts.benign]
      : []
    const governedList = opts.governed
      ? Array.isArray(opts.governed)
        ? opts.governed
        : [opts.governed]
      : []
    // Benign first, governed last (distinct names → a stable ordering). A
    // pure-memory butler (no `governed`) composes only its benign toolsets; with
    // neither, `tools` stays undefined and `MemoryAugmentedAgent` still composes
    // the memory tools in front — so the butler ALWAYS has memory either way.
    const extras: LlmAgentToolset[] = [...benignList, ...governedList]
    const composed = extras.length > 0 ? ComposedToolset.of(...extras) : undefined
    // The resident butler keeps a multi-topic long-term memory, so its frozen
    // block is CLUSTERED by default (画像 / 项目 / 人物 / 承诺 / 其它). A caller
    // can override `tierConfig` (or pass a custom catalog); a plain
    // MemoryAugmentedAgent still defaults to the flat block.
    //
    // It also turns the D/E/G frozen-block features ON by default — the resident
    // butler is exactly the agent that accrues bitemporal facts, cross-links, and
    // how-tos over time, so its always-on block should show CURRENT truth (drop
    // superseded edges), link tails, and a "things I know how to do" section.
    // Each is byte-identical to off for a fact that carries none of that meta, so
    // a fresh butler's block is unchanged; a long-lived one reads cleaner. A
    // caller can still force any of them off.
    super({
      ...opts,
      ...(composed ? { tools: composed } : {}),
      tierConfig: opts.tierConfig ?? DEFAULT_TIERS,
      frozenActiveOnly: opts.frozenActiveOnly ?? true,
      frozenShowLinks: opts.frozenShowLinks ?? true,
      frozenShowProcedures: opts.frozenShowProcedures ?? true,
    })
    this.governedGates = governedList
    this.contextProbe = opts.contextProbe
    this.stableContext = opts.stableContext
    this.longRun = opts.longRun
  }

  /** LIB-M3 — refresh the stable card; a sick provider degrades to null. */
  private async refreshStableCard(): Promise<void> {
    if (!this.stableContext) return
    try {
      this.stableCard = await this.stableContext()
    } catch {
      this.stableCard = null
    }
  }

  /**
   * CARE-M4 — run the context probe before the base task path (which calls our
   * `buildRequest`). Stash-then-super keeps the injection point single: the
   * probe RESULT travels via `turnContext`, never by mutating options. A throw
   * degrades to "no injection" — chat must survive a sick probe.
   */
  protected override async handleTask(task: Task): Promise<unknown> {
    // LONG-M2 — a segment-marked task takes the driver lane and DELIBERATELY
    // bypasses `super.handleTask`: no episodic capture (the machine-rendered
    // relay prompt would pollute the conversation log every segment) and no
    // per-turn context probe (segments are unattended background work — the
    // dossier IS the context). Memory warm-up is done inside the driver.
    const segTask = readLongRunSegmentMarker(task.payload)
    if (segTask !== null) return this.longRunSegmentEntry(task, segTask)
    // LONG-M3 — a child-marked task is one bounded turn a segment spawned:
    // same lane hygiene as segments (no episodic capture, no per-turn probe),
    // and its spend meters into the PARENT dossier's budget. Without a driver
    // the marker is inert and the task is just chat.
    const childOf = readLongRunChildMarker(task.payload)
    if (childOf !== null && this.longRun) return this.runLongRunChildTurn(task, childOf)
    this.turnContext = null
    if (this.contextProbe) {
      try {
        this.turnContext = await this.contextProbe(task)
      } catch {
        this.turnContext = null
      }
    }
    await this.refreshStableCard()
    return super.handleTask(task)
  }

  /** No fresh probe on resume (see the option's doc); clear any stale stash so
   *  a previous turn's card can never leak into a resumed conversation. The
   *  STABLE card is the opposite: it re-reads (state reflects now — the frozen
   *  block after a restart behaves the same way). */
  protected override async handleResume(task: Task, state: unknown): Promise<unknown> {
    // LONG-M2 — detection order is load-bearing. (1) A RELAY suspend carries
    // only the long-run taskId (cold start between segments — relay ≠ replay);
    // it wins first because its state matches nothing else. (2) A segment task
    // that parked MID-segment (governed approval / provider quota gate) carries
    // butler gate state AND the payload marker → resume the segment body, then
    // run segment-end accounting. (3) A marker with any OTHER state shape falls
    // back to a fresh wake from the dossier — never to normal-chat resume,
    // which would capture the segment into episodic memory.
    const relayTask = readLongRunRelayState(state)
    if (relayTask !== null) return this.longRunSegmentEntry(task, relayTask)
    const segTask = readLongRunSegmentMarker(task.payload)
    if (segTask !== null) {
      if (this.longRun && readButlerGateState(state)) {
        return this.resumeLongRunSegment(task, segTask, state)
      }
      return this.longRunSegmentEntry(task, segTask)
    }
    // LONG-M3 — a child that parked mid-turn (governed approval) resumes in
    // the child lane so the resumed half re-meters into the parent budget.
    // Any other state shape re-runs the turn fresh from the payload prompt —
    // never normal-chat resume (episodic capture of a machine prompt).
    const childOf = readLongRunChildMarker(task.payload)
    if (childOf !== null && this.longRun) {
      return this.runLongRunChildTurn(task, childOf, readButlerGateState(state) ? state : undefined)
    }
    this.turnContext = null
    await this.refreshStableCard()
    return super.handleResume(task, state)
  }

  /**
   * Append the probe's card AFTER the base system prompt (frozen memory block
   * first, then persona, then the per-turn card). Tail position is deliberate:
   * the leading bytes stay identical across turns, so prompt caching keeps
   * working; only the variable tail changes when the probe has something.
   *
   * NA-M3 — the card rides `systemVolatile`, not `system`: providers send the
   * exact same concatenation (the `\n\n` separator travels WITH the volatile
   * part, so on-wire bytes are unchanged), but a cache-aware provider can now
   * stop its breakpoint before the card — the clock probe changes every
   * MESSAGE, and it must not drag the cached persona + frozen-block prefix
   * down with it across messages.
   */
  protected override buildRequest(task: Task): LlmRequest {
    const req = super.buildRequest(task)
    // LIB-M3 — the stable card joins `req.system` (frozen block, persona, then
    // this): same cached segment, so an unchanged INDEX costs 0.1× reads and an
    // edit breaks the cache exactly once. Appended BEFORE the volatile check so
    // the volatile separator decision sees the final stable text.
    if (this.stableCard) {
      req.system = req.system ? `${req.system}\n\n${this.stableCard}` : this.stableCard
    }
    if (this.turnContext) {
      req.systemVolatile = req.system ? `\n\n${this.turnContext}` : this.turnContext
    }
    // LONG-M4b — the role slot's model name rides the request at this ONE
    // place every segment / resume request is built (`resumeBody` rebuilds
    // through here too), so a wind-down segment that parked and resumed still
    // speaks to the slot's model. Model-only slots (no `provider`) are exactly
    // this line.
    const slot = this.longRunSlotOverride.get(task.id)
    if (slot) req.model = slot.model
    return req
  }

  /**
   * LONG-M2 — meter every provider response of an ACTIVE segment execution.
   * Sits on the one choke point every LLM call already flows through (fresh
   * rounds, resumed rounds, retries — all of them), so the segment's token
   * ledger can't miss a call and can't double-count one. Weighted by cost
   * (`weighLongRunUsage`) rather than summed 1:1 — see LONGRUN_TOKEN_WEIGHTS
   * for why the 1:1 version had to go.
   */
  protected override async streamWithAuthHook(req: LlmRequest, task: Task): Promise<LlmResponse> {
    const res = await super.streamWithAuthHook(req, task)
    if (this.longRunActive.has(task.id) && res.usage) {
      const weighted = weighLongRunUsage(res.usage)
      this.longRunUsage.set(task.id, (this.longRunUsage.get(task.id) ?? 0) + weighted)
    }
    return res
  }

  /**
   * LONG-M4b — route one execution's calls to its role-slot provider. Sits on
   * the llm `providerFor` seam, so the stream source, the usage-sink
   * attribution and the output's `by` follow the override TOGETHER: a segment
   * that ran on the synthesizer can never be billed or labelled as the
   * primary. No override ⇒ base behaviour, byte-identical.
   */
  protected override providerFor(task: Task): LlmProvider {
    return this.longRunSlotOverride.get(task.id)?.provider ?? super.providerFor(task)
  }

  /** The first governed gate that governs `name`, or `undefined` if none does
   *  (benign). With one gate this is just "the gate iff it governs"; with several
   *  (steward + MCP writes) it resolves which gate owns a tool. Names are disjoint
   *  across gates (ComposedToolset enforces it), so "first" is unambiguous. */
  private governedFor(name: string): GovernedActionToolset | undefined {
    return this.governedGates.find((g) => g.governs(name))
  }

  /**
   * Bounded, governance-gated tool-loop. Same shape as `LlmAgent.runToolLoop`
   * with one addition: before executing a round's tool calls, classify every
   * governed one. If any needs approval, park the WHOLE round (don't run benign
   * siblings first — the model's plan may hinge on the governed step). Refused
   * governed calls become `isError` results inline; allowed ones run.
   */
  protected override async runToolLoop(task: Task, initialReq: LlmRequest): Promise<unknown> {
    const tools = await this.listToolsForLlm()
    let req: LlmRequest = tools.length > 0 ? { ...initialReq, tools } : { ...initialReq }
    let rounds = 0

    while (true) {
      let res: LlmResponse
      try {
        if (this.preCallHook) await this.preCallHook(task)
        res = await this.streamWithAuthHook(req, task)
      } catch (err) {
        // A pre-call hook / provider park (e.g. a quota gate) → wrap in butler
        // state (no `pending`) so resume continues the loop from here. The
        // suspender's own state is preserved under `user`.
        if (isSuspendTaskError(err)) {
          throw new SuspendTaskError({
            resumeAt: err.resumeAt,
            state: butlerGateState({ messages: req.messages, user: err.state }),
          })
        }
        throw err
      }

      const wantsTool =
        res.stopReason === 'tool_use' && res.toolUses !== undefined && res.toolUses.length > 0
      if (!wantsTool) return this.parseResponse(res, task, rounds)

      rounds++
      if (rounds > this.maxToolRounds) {
        return this.parseResponse(
          {
            ...res,
            stopReason: 'error',
            text:
              (res.text ? res.text + '\n\n' : '') +
              `[butler: aborted after ${this.maxToolRounds} tool-use rounds]`,
          },
          task,
          rounds,
        )
      }

      const toolUses = res.toolUses as LlmToolUseBlock[]
      const assistantBlocks: LlmContentBlock[] = []
      if (res.text) assistantBlocks.push({ type: 'text', text: res.text })
      assistantBlocks.push(...toolUses)

      // Classify every governed tool in this round ONCE (classify may be async
      // / side-effecting — don't double-call it across the park scan and the
      // execution pass).
      const verdicts = new Map<string, GovernedVerdict>()
      for (const tu of toolUses) {
        // No governed gate owns this tool → benign → no verdict → never parks.
        const gate = this.governedFor(tu.name)
        if (gate) verdicts.set(tu.id, await gate.classify(tu.name, tu.input))
      }

      const park = toolUses.find((tu) => verdicts.get(tu.id)?.decision === 'approve')
      if (park) {
        const v = verdicts.get(park.id) as { decision: 'approve'; reason: string }
        const messages: LlmMessage[] = [
          ...req.messages,
          { role: 'assistant', content: assistantBlocks },
        ]
        // Snapshot EVERY governed tool's verdict so resume can honour them
        // individually. Without this, resume would re-run every deferred
        // governed call on a single approval — laundering a `refuse` sibling
        // (server-denied) or a SECOND `approve` the human never saw.
        const persistedVerdicts: Record<string, PersistedVerdict> = {}
        for (const [id, verdict] of verdicts) {
          persistedVerdicts[id] =
            verdict.decision === 'allow'
              ? { decision: 'allow' }
              : { decision: verdict.decision, reason: verdict.reason }
        }
        throw new SuspendTaskError({
          resumeAt: BUTLER_NEVER_RESUME_AT,
          state: butlerGateState({
            messages,
            pending: {
              toolUses,
              approvedId: park.id,
              verdicts: persistedVerdicts,
              approval: {
                toolName: park.name,
                // A park implies a governed 'approve' verdict, so a gate governs
                // `park.name` (the verdict could only be set when one does).
                title: this.governedFor(park.name)!.describe(park.name, park.input),
                reason: v.reason,
              },
            },
          }),
        })
      }

      // No approval needed → execute. Refused governed calls fail closed inline.
      const toolResultBlocks: LlmToolResultBlock[] = []
      for (const tu of toolUses) {
        const v = verdicts.get(tu.id)
        if (v?.decision === 'refuse') {
          toolResultBlocks.push({
            type: 'tool_result',
            toolUseId: tu.id,
            content: `Refused (not run): ${v.reason}`,
            isError: true,
          })
          continue
        }
        toolResultBlocks.push(await this.callOne(tu))
      }

      req = {
        ...req,
        messages: [
          ...req.messages,
          { role: 'assistant', content: assistantBlocks },
          { role: 'user', content: toolResultBlocks },
        ],
      }
    }
  }

  /**
   * Resume after a governed-action park: inject the human's decision. The base
   * `LlmAgent.handleResume` (reached via `super.resumeBody`) handles non-butler
   * state; here we own the case where the carried state is a `ButlerGateState`.
   *
   * The human decides ONE action (`pending.approvedId`). Resume answers every
   * deferred block from its snapshotted verdict, so the decision's scope stays
   * exactly what the human saw:
   *   - benign sibling (no gate) → run (it was only deferred by the park)
   *   - governed `allow` → run (auto-cleared)
   *   - the approved id → run iff approved, else fail-closed
   *   - governed `refuse` → NEVER runs (approval of a sibling can't launder it)
   *   - a SECOND `approve` the human never saw → fail-closed; the model must
   *     request it again so it gets its own review
   * Every `tool_use` still gets exactly one matching `tool_result` so the
   * provider stays happy and the loop continues coherently.
   */
  protected override async resumeBody(task: Task, state: unknown): Promise<unknown> {
    const gate = readButlerGateState(state)
    if (!gate) return super.resumeBody(task, state)

    const baseReq = this.buildRequest(task)
    if (!gate.pending) {
      // Non-governed park (quota gate) — nothing to approve; continue the loop.
      return this.runToolLoop(task, { ...baseReq, messages: gate.messages })
    }

    // Fail closed: a missing / malformed decision is treated as a denial, never
    // an implicit approval.
    const decision = readButlerDecision(state) ?? {
      approved: false,
      note: 'no decision recorded — failing closed',
    }
    const { approvedId, verdicts = {} } = gate.pending

    const toolResultBlocks: LlmToolResultBlock[] = []
    for (const tu of gate.pending.toolUses) {
      // A pure-memory butler never reaches a governed park, but guard anyway:
      // no gate governs → the tool runs inline as benign.
      if (!this.governedFor(tu.name)) {
        toolResultBlocks.push(await this.callOne(tu))
        continue
      }
      const verdict = verdicts[tu.id]
      if (verdict?.decision === 'allow') {
        toolResultBlocks.push(await this.callOne(tu)) // governed but auto-cleared
        continue
      }
      if (verdict?.decision === 'approve' && tu.id === approvedId) {
        if (decision.approved) {
          toolResultBlocks.push(await this.callOne(tu)) // cleared by a human → execute
        } else {
          toolResultBlocks.push({
            type: 'tool_result',
            toolUseId: tu.id,
            content:
              `Not executed — you declined this action (fail-closed)` +
              (decision.note ? `: ${decision.note}` : '') + '.',
            isError: true,
          })
        }
        continue
      }
      // Everything else fails closed and NEVER runs: a `refuse` (server-denied,
      // which approving a sibling must not launder), a second `approve` the
      // human never saw, or a missing verdict (defensive).
      const why =
        verdict?.decision === 'refuse'
          ? `Refused (not run): ${verdict.reason ?? 'server policy'}.`
          : verdict?.decision === 'approve'
            ? `Not executed — this action needs its own approval; ask again so it can be reviewed.`
            : `Not executed — no approval on record (fail-closed).`
      toolResultBlocks.push({ type: 'tool_result', toolUseId: tu.id, content: why, isError: true })
    }

    const messages: LlmMessage[] = [
      ...gate.messages,
      { role: 'user', content: toolResultBlocks },
    ]
    return this.runToolLoop(task, { ...baseReq, messages })
  }

  /**
   * Run one cleared tool call through the composed toolset and shape the result.
   * A throw becomes an `isError` result — same recovery contract as the base
   * loop: a flaky tool never crashes the task.
   */
  private async callOne(tu: LlmToolUseBlock): Promise<LlmToolResultBlock> {
    try {
      // `this.toolset` is the composed (memory + benign + governed) toolset,
      // non-null because the butler always constructs one.
      const out = await this.toolset!.callTool(tu.name, tu.input)
      const block: LlmToolResultBlock = {
        type: 'tool_result',
        toolUseId: tu.id,
        content: this.flattenToolResult(out.content),
      }
      if (out.isError) block.isError = true
      return block
    } catch (err) {
      return {
        type: 'tool_result',
        toolUseId: tu.id,
        content: err instanceof Error ? err.message : `tool '${tu.name}' threw: ${String(err)}`,
        isError: true,
      }
    }
  }

  // ─── LONG-M2 — segmented long-run driver ────────────────────────────────────
  //
  // The chain: start (host toolset self-dispatch) → segment runs → segment end
  // throws a RELAY SuspendTaskError carrying ONLY the long-run taskId → the
  // resume sweep wakes it → the next segment COLD-STARTS from the on-disk
  // dossier. Two suspend kinds share the one `suspended_tasks` substrate: a
  // governed PARK packs `messages` (the same conversation resumes); a relay
  // deliberately does not (segments hand over via the dossier — relay ≠
  // replay). Segment wall-time = active execution only: the meter starts at
  // segment entry and flushes at park/finish, so hours parked in an inbox or
  // sleeping between segments never count against the time budget.

  /** Shared entry for a fresh wake (dispatch or relay resume). */
  private async longRunSegmentEntry(task: Task, lrTaskId: string): Promise<unknown> {
    if (!this.longRun) {
      return {
        text: `[长期任务 ${lrTaskId}] 这台管家没有接长期任务驱动器,段无法执行;盘上档案(若有)原样保留。`,
      }
    }
    return this.runLongRunSegment(task, lrTaskId)
  }

  /** One full segment: terminal guard → zero-LLM precheck → render → arm → run. */
  private async runLongRunSegment(task: Task, lrTaskId: string): Promise<unknown> {
    const lr = this.longRun!
    const loaded = await lr.store.load(lrTaskId)
    if (loaded.kind !== 'ok') return this.longRunUnreadable(lrTaskId, loaded.kind)
    const d = loaded.dossier

    // Terminal pre-guard: a settled task's chain stops HERE, quietly. This is
    // also what makes member-driven chat verbs safe — complete / cancel while
    // a relay sleeps means the next wake sees the terminal status and stands
    // down instead of running a segment against a task nobody wants anymore.
    if (d.status === 'done' || d.status === 'blocked' || d.status === 'cancelled') {
      return { text: this.longRunTerminalLine(d) }
    }

    // Zero-LLM wake precheck: waiting on children with nothing new settled, or
    // standing by with the member still quiet → straight back to sleep. No
    // model call, no render.
    //
    // Only the children arm writes (a field-level `waitStreak` bump — never a
    // wholesale write of the stale snapshot, since a child could have settled
    // since `load`). The standby arm writes NOTHING: its wake is a pure
    // function of the dossier already on disk plus the member's last-seen
    // stamp, so a task that stands by for a week costs zero tokens AND zero
    // writes. That is the whole point of M6.2 — the relay arm it displaces
    // was spending a model call every five seconds to discover there was
    // nothing to do.
    const pre = precheckLongRunWake(d, lr.now(), await this.readMemberLastSeen(lrTaskId))
    if (pre.action === 'resuspend') {
      if (pre.reason === 'children') {
        try {
          await lr.store.mutate(lrTaskId, (draft) => {
            draft.waitStreak = draft.waitStreak + 1
          })
        } catch (err) {
          lr.logger?.warn('[longrun] waitStreak bump failed', { taskId: lrTaskId, err: String(err) })
        }
      }
      throw new SuspendTaskError({ resumeAt: pre.resumeAtMs, state: longRunRelayState(lrTaskId) })
    }

    const budget = checkLongRunBudget(d)
    const windDown = d.status === 'winding_down' || budget.exhausted
    const tail = await lr.store.readJournalTail(lrTaskId)

    // RENDER BEFORE ARM (load-bearing order): the prompt must show the
    // PREVIOUS segment's true `interrupted` flag — arming first would show the
    // ⚠-crash line on every single segment. `renderedSettled` is snapshotted
    // from the SAME dossier the prompt rendered, so segment-end bookkeeping
    // marks exactly what the model saw and nothing that settled later.
    // 段里的钟(见 `clockLabel` 注释)。这一行是装饰性的,所以它自己的失败
    // 绝不能顶掉一整段活——抛了就当没有钟,提示逐字节退回 M4b 形态。
    let nowLabel: string | undefined
    try {
      nowLabel = lr.clockLabel?.()
    } catch (err) {
      lr.logger?.warn('[longrun] clock label failed', { taskId: lrTaskId, err: String(err) })
    }

    const prompt = windDown
      ? renderWindDownPrompt(d, tail, budget.exhausted ? budget.reason : 'time', nowLabel)
      : renderRelayPrompt(d, tail, nowLabel)
    const renderedSettled = countSettledChildren(d)

    try {
      await lr.store.mutate(lrTaskId, (draft) => {
        draft.interrupted = true
        draft.waitStreak = 0
        draft.lastRenderSettled = renderedSettled
        // M6.2 — standby is consumed HERE, in the same mutate that arms the
        // segment: the flag survives exactly long enough for the render above
        // to show it, then it is gone. A segment that still has nothing to do
        // must say so again. (Contrast `waitingForChildren`, which is sticky
        // because the verdict's own `pending > 0` guard makes a stale flag
        // harmless — standby has no such second guard, and a stale one would
        // park a task that DOES have work.)
        draft.standby = undefined
        if (windDown && draft.status === 'active') draft.status = 'winding_down'
      })
    } catch (err) {
      // Can't arm ⇒ don't run: an unarmed crash would masquerade as a clean
      // finish, and "interrupted" exists precisely to make crashes visible.
      return {
        text: `[长期任务 ${lrTaskId}] 档案写入失败,本段没有执行:${err instanceof Error ? err.message : String(err)}`,
      }
    }

    // M4b — 收尾段走 synthesizer 槽(低频×高杠杆 → 组合里最强的模型)。Resolved
    // ONCE per segment, AFTER the arm (a resolver hiccup must never leave the
    // dossier unarmed) and BEFORE the work; installed inside the work so
    // `runSegmentWork`'s finally always clears it. Null (unconfigured or
    // unbuildable) ⇒ main chain, byte-identical to M2.
    const synth = windDown ? await this.resolveLongRunSlot('synthesizer', lrTaskId) : null

    return this.runSegmentWork(task, lrTaskId, async () => {
      if (synth) this.longRunSlotOverride.set(task.id, synth)
      await this.warmLongRunContext()
      const base = this.buildRequest(task)
      const req: LlmRequest = { ...base, messages: [{ role: 'user', content: prompt }] }
      return this.runToolLoop(task, req)
    })
  }

  /**
   * Resume a segment that parked MID-segment (governed approval / quota gate).
   * The gate state carries the conversation; the dossier only gets a terminal
   * re-check — a member who cancelled while the approval sat in the inbox must
   * win over the approval (the approved action is NOT executed).
   */
  private async resumeLongRunSegment(task: Task, lrTaskId: string, state: unknown): Promise<unknown> {
    const lr = this.longRun!
    const loaded = await lr.store.load(lrTaskId)
    if (loaded.kind !== 'ok') return this.longRunUnreadable(lrTaskId, loaded.kind)
    const d = loaded.dossier
    if (d.status === 'done' || d.status === 'blocked' || d.status === 'cancelled') {
      return { text: `${this.longRunTerminalLine(d)} 批准前任务已收束,这次批准的动作没有执行。` }
    }
    // M4b — a wind-down segment that parked mid-segment resumes on the SAME
    // synthesizer slot it started on: `winding_down` is only ever set at a
    // wind-down arm or a wind-down verdict (whose relay re-enters through the
    // fresh-wake path), so at THIS entry the status names the segment's own
    // kind. `resumeBody` rebuilds its request through `buildRequest`, which
    // reads the override — the resumed rounds keep the slot's model.
    const synth = d.status === 'winding_down' ? await this.resolveLongRunSlot('synthesizer', lrTaskId) : null
    return this.runSegmentWork(task, lrTaskId, async () => {
      if (synth) this.longRunSlotOverride.set(task.id, synth)
      await this.warmLongRunContext()
      return this.resumeBody(task, state)
    })
  }

  /**
   * LONG-M3 — one bounded CHILD turn spawned by a segment. Child ≠ segment:
   * no dossier of its own, no relay, no verdict — just the butler's normal
   * governed tool-loop over the spawn-rendered prompt, with two lane
   * properties: (1) spend meters into the PARENT dossier's budget(预算一等
   * 公民 — an unmetered child would be a silent budget hole); the flush sits
   * in `finally` so a mid-turn park still bills what ran, and the resumed
   * half re-meters itself (each flush CONSUMES the accumulator — no double
   * bill). (2) no episodic capture / per-turn probe (machine prompt, same as
   * segments). Governance is untouched: a governed tool inside a child parks
   * the child itself(分解≠授权).
   */
  private async runLongRunChildTurn(
    task: Task,
    parentId: string,
    resumeState?: unknown,
  ): Promise<unknown> {
    const startMs = this.longRun!.now()
    this.longRunActive.add(task.id)
    this.longRunUsage.set(task.id, 0)
    try {
      const work = async (): Promise<unknown> => {
        await this.warmLongRunContext()
        if (resumeState !== undefined) return this.resumeBody(task, resumeState)
        return this.runToolLoop(task, this.buildRequest(task))
      }
      if (this.toolset?.runForTask) {
        return await this.toolset.runForTask(
          { id: task.id, from: task.from, ancestry: task.ancestry },
          work,
        )
      }
      return await work()
    } finally {
      // Never throws over the turn's own outcome (store errors are warned away
      // inside); consumes the meter so `finally`'s delete loses nothing.
      await this.flushLongRunSpend(parentId, task.id, startMs)
      this.longRunActive.delete(task.id)
      this.longRunUsage.delete(task.id)
      this.longRunSlotOverride.delete(task.id)
    }
  }

  /** Accumulator scope + park-flush + settle, shared by fresh and resumed
   *  segments. The catch wraps ONLY `body` — `finishLongRunSegment`'s own
   *  relay throw must pass through untouched (its meter is already consumed;
   *  catching it here would double-flush). */
  private async runSegmentWork(
    task: Task,
    lrTaskId: string,
    body: () => Promise<unknown>,
  ): Promise<unknown> {
    const lr = this.longRun!
    const startMs = lr.now()
    this.longRunActive.add(task.id)
    this.longRunUsage.set(task.id, 0)
    try {
      const work = async (): Promise<unknown> => {
        let out: unknown
        try {
          out = await body()
        } catch (err) {
          if (isSuspendTaskError(err)) {
            // Mid-segment park: flush what the segment already spent (tokens +
            // active seconds) into the ledger NOW — the parked wait can last
            // hours and is deliberately not billed; the resume restarts its
            // own clock. No segments+1: parked, not finished.
            await this.flushLongRunSpend(lrTaskId, task.id, startMs)
          } else {
            await this.recordLongRunFailure(lrTaskId, task.id, startMs, err)
          }
          throw err
        }
        return this.finishLongRunSegment(task, lrTaskId, out, startMs)
      }
      if (this.toolset?.runForTask) {
        return await this.toolset.runForTask(
          { id: task.id, from: task.from, ancestry: task.ancestry },
          work,
        )
      }
      return await work()
    } finally {
      this.longRunActive.delete(task.id)
      this.longRunUsage.delete(task.id)
      this.longRunSlotOverride.delete(task.id)
    }
  }

  /** Segment-entry memory warm-up. The normal path's warm-up lives in
   *  `MemoryAugmentedAgent.handleTask`, which segments bypass (no episodic
   *  capture of machine prompts) — so the driver warms the same seams itself:
   *  fresh frozen block, fresh stable card, NO per-turn probe. */
  private async warmLongRunContext(): Promise<void> {
    this.memorySession.refresh()
    await this.memorySession.ensureFrozenBlock()
    await this.refreshStableCard()
    this.turnContext = null
  }

  /**
   * Segment end: consume the meter, guarantee a journal line, settle the
   * dossier in ONE mutate, then act on the zero-LLM verdict. Every mutate here
   * is field-level / clone-based on the CURRENT draft — never a write-back of
   * this method's own stale reads.
   */
  private async finishLongRunSegment(
    task: Task,
    lrTaskId: string,
    out: unknown,
    startMs: number,
  ): Promise<unknown> {
    const lr = this.longRun!
    // Read-then-zero the meter IMMEDIATELY: the verdict below can throw a
    // relay suspend, and `runSegmentWork`'s finally only deletes entries —
    // consuming here is what makes a double flush structurally impossible.
    const tokens = this.longRunUsage.get(task.id) ?? 0
    this.longRunUsage.set(task.id, 0)
    const rawSec = (lr.now() - startMs) / 1000
    const seconds = Number.isFinite(rawSec) && rawSec > 0 ? rawSec : 0

    const loaded = await lr.store.load(lrTaskId)
    if (loaded.kind !== 'ok') {
      lr.logger?.warn('[longrun] dossier unreadable at segment end — chain stops', {
        taskId: lrTaskId,
        kind: loaded.kind,
      })
      return out
    }

    // Journal fallback: a segment that never called record_longrun_progress
    // still leaves ONE mechanical line — the next segment must never cold-start
    // from an empty handoff just because the model forgot to write one.
    const running = loaded.dossier.segments + 1
    try {
      const tail = await lr.store.readJournalTail(lrTaskId)
      if (!tail.some((e) => e.seg === running)) {
        const fallback = this.longRunTextOf(out) ?? '本段结束,模型没有留下进展记录。'
        await lr.store.appendJournal(lrTaskId, {
          seg: running,
          did: clipLongRunText(`(自动记录) ${fallback}`, LONGRUN_LIMITS.maxJournalDidChars),
        })
      }
    } catch (err) {
      lr.logger?.warn('[longrun] fallback journal failed', { taskId: lrTaskId, err: String(err) })
    }

    let final: LongRunDossier
    try {
      final = await lr.store.mutate(lrTaskId, (draft) => {
        const withUsage = recordSegmentUsage(draft, { tokens, seconds })
        // Feed the RENDER-time snapshot, not a re-count: a child that settled
        // mid-segment was never shown to the model, and must stay "unseen" so
        // the next wake renders it instead of swallowing it.
        const seen = markChildResultsSeen(withUsage, draft.lastRenderSettled ?? 0)
        seen.interrupted = false
        return seen
      })
    } catch (err) {
      lr.logger?.warn('[longrun] settle mutate failed — chain stops', {
        taskId: lrTaskId,
        err: String(err),
      })
      return out
    }

    const verdict = decideSegmentVerdict(final, lr.now())
    // M4b — on every CONTINUING verdict the compactor slot writes the next
    // segment's handover. Terminal verdicts (done / blocked / cancelled /
    // deliver_partial) get none: there is no next segment to hand over to,
    // and a model call that nobody will read is budget burned for nothing.
    //
    // M6.2 — `standby` is a continuing verdict that is ALSO left out, for the
    // symmetric reason: a segment that concluded "nothing advanced" has
    // nothing new to distil, the previous handover is untouched on disk and
    // still stands, and the one thing that did change (the standby note) gets
    // its own rendered block. A standing task can poll for months; paying the
    // strongest configured model per poll to re-summarize an unchanged dossier
    // is the same silent waste the weighted-budget fix just removed.
    if (verdict.kind === 'relay' || verdict.kind === 'wait_children' || verdict.kind === 'wind_down') {
      await this.compactLongRunHandover(task, lrTaskId, final)
    }
    switch (verdict.kind) {
      case 'done': {
        await this.longRunPush(
          `[长期任务 ${lrTaskId}] 完成 ✓` +
            String.fromCharCode(0x0a) +
            (final.doneSummary ?? '(模型没有留下总结)'),
        )
        return out
      }
      case 'blocked': {
        await this.longRunPush(
          `[长期任务 ${lrTaskId}] 需要你的输入才能继续:` +
            String.fromCharCode(0x0a) +
            (final.blockedQuestion ?? '(模型没有写清要问什么)') +
            String.fromCharCode(0x0a) +
            '回复我之后,可以让我重新开一项长期任务接着做。',
        )
        return out
      }
      case 'cancelled':
        // The member already asked for silence; the cancel verb answered them.
        return out
      case 'deliver_partial': {
        // The wind-down segment ran and the model STILL didn't complete —
        // force an honest partial close so an exhausted task can never relay
        // forever. The model's final text is the best summary available.
        const summary = clipLongRunText(
          `(预算用尽,自动收尾) ${this.longRunTextOf(out) ?? '模型没有提交收尾总结。'}`,
          LONGRUN_LIMITS.maxObjectiveChars,
        )
        try {
          await lr.store.mutate(lrTaskId, (draft) => {
            if (draft.status === 'winding_down') {
              draft.status = 'done'
              draft.doneSummary = summary
              draft.waitingForChildren = false
            }
          })
        } catch (err) {
          lr.logger?.warn('[longrun] partial close failed', { taskId: lrTaskId, err: String(err) })
        }
        await this.longRunPush(
          `[长期任务 ${lrTaskId}] 预算用尽,已收尾(部分交付):` + String.fromCharCode(0x0a) + summary,
        )
        return out
      }
      case 'wind_down': {
        // Budget just crossed the line: mark it and relay ONCE more — the next
        // wake renders the wind-down prompt and closes honestly. If the mark
        // fails, the next wake still recomputes exhaustion from the (monotonic)
        // ledger, so the transition cannot be lost.
        try {
          await lr.store.mutate(lrTaskId, (draft) => {
            if (draft.status === 'active') draft.status = 'winding_down'
          })
        } catch (err) {
          lr.logger?.warn('[longrun] wind-down mark failed', { taskId: lrTaskId, err: String(err) })
        }
        throw new SuspendTaskError({
          resumeAt: lr.now() + LONGRUN_LIMITS.relayDelayMs,
          state: longRunRelayState(lrTaskId),
        })
      }
      case 'wait_children':
      case 'standby':
      case 'relay':
        // All three park the same way — the difference is only WHEN they wake
        // and what it costs to find out. Standby is deliberately SILENT: not
        // having anything to do is not news, and pushing it would erase the
        // one distinction that matters between standby and `blocked`.
        throw new SuspendTaskError({
          resumeAt: verdict.resumeAtMs,
          state: longRunRelayState(lrTaskId),
        })
    }
  }

  /**
   * M6.2 — the member-activity stamp for the standby wake check, with the
   * never-throws contract enforced HERE rather than trusted: a reader that
   * throws or answers with a non-finite number degrades to "member silent".
   * A presence file that can't be read must cost latency, never a segment.
   */
  private async readMemberLastSeen(lrTaskId: string): Promise<number | null> {
    const read = this.longRun?.memberLastSeenMs
    if (!read) return null
    try {
      const at = await read()
      return typeof at === 'number' && Number.isFinite(at) ? at : null
    } catch (err) {
      this.longRun?.logger?.warn('[longrun] member last-seen read failed', {
        taskId: lrTaskId,
        err: String(err),
      })
      return null
    }
  }

  /**
   * LONG-M4b — ask the host's slot resolver, enforcing its never-throws
   * contract here: a throw or a malformed answer is warned and read as
   * "unconfigured". A slot may only ever improve a segment; it must never be
   * able to strand one.
   */
  private async resolveLongRunSlot(
    slot: LongRunSlotName,
    lrTaskId: string,
  ): Promise<LongRunSlotResolution | null> {
    const lr = this.longRun
    if (!lr?.slotProvider) return null
    try {
      const r = await lr.slotProvider(slot)
      if (!r || typeof r.model !== 'string' || r.model.trim() === '') return null
      return r
    } catch (err) {
      lr.logger?.warn('[longrun] slot resolver failed — falling back to the main chain', {
        taskId: lrTaskId,
        slot,
        err: String(err),
      })
      return null
    }
  }

  /**
   * LONG-M4b — ONE bounded, tool-less call on the compactor slot that distills
   * the dossier into the next segment's handover(随档刻度:「压缩记忆这种核心
   * 工作值得用强模型」). Never throws and never blocks the chain: resolver
   * null, provider error, empty text, store error — each ⇒ warn + the
   * mechanical journal floor stands. Its spend is billed into the SAME dossier
   * budget in the SAME mutate as the handover(边界⑥ 预算一等公民): the meter
   * accumulator (already consumed by the segment's own settle) collects this
   * call's usage through the metering override, and is read-then-zeroed here
   * the same way. The slot override is installed for the call and restored
   * after it, so the ledger names the compactor for exactly this call.
   */
  private async compactLongRunHandover(task: Task, lrTaskId: string, d: LongRunDossier): Promise<void> {
    const lr = this.longRun!
    const slot = await this.resolveLongRunSlot('compactor', lrTaskId)
    if (!slot) return
    const startMs = lr.now()
    const prev = this.longRunSlotOverride.get(task.id)
    let text: string | undefined
    try {
      const tail = await lr.store.readJournalTail(lrTaskId)
      this.longRunSlotOverride.set(task.id, slot)
      const res = await this.streamWithAuthHook(
        {
          system: LONGRUN_COMPACTOR_SYSTEM,
          messages: [{ role: 'user', content: renderCompactorInput(d, tail) }],
          model: slot.model,
          maxTokens: LONGRUN_LIMITS.compactorMaxTokens,
        },
        task,
      )
      if (res.stopReason === 'error') {
        lr.logger?.warn('[longrun] compactor returned an error — journal floor stands', {
          taskId: lrTaskId,
        })
      } else {
        const cleaned = cleanLongRunText(res.text ?? '', { multiline: true }).trim()
        if (cleaned) text = clipLongRunText(cleaned, LONGRUN_LIMITS.maxHandoverChars)
      }
    } catch (err) {
      lr.logger?.warn('[longrun] compactor call failed — journal floor stands', {
        taskId: lrTaskId,
        err: String(err),
      })
    } finally {
      if (prev) this.longRunSlotOverride.set(task.id, prev)
      else this.longRunSlotOverride.delete(task.id)
    }
    // Consume the meter (this call's usage landed in it — the execution is
    // still active) and bill it WITH the handover, one mutate, field-level.
    const tokens = this.longRunUsage.get(task.id) ?? 0
    this.longRunUsage.set(task.id, 0)
    const rawSec = (lr.now() - startMs) / 1000
    const seconds = Number.isFinite(rawSec) && rawSec > 0 ? rawSec : 0
    if (!text && tokens <= 0 && seconds <= 0) return
    const seg = d.segments
    const at = lr.now()
    try {
      await lr.store.mutate(lrTaskId, (draft) => {
        draft.budget.tokensUsed += tokens
        draft.budget.timeUsedSec += seconds
        if (text) draft.handover = { text, seg, at }
      })
    } catch (err) {
      lr.logger?.warn('[longrun] handover write failed — journal floor stands', {
        taskId: lrTaskId,
        err: String(err),
      })
    }
  }

  /** Flush the meter mid-flight (park / failure): tokens + active seconds into
   *  the ledger, NO segments+1 — the segment isn't finished. Consumes the
   *  accumulator so a later settle can't re-bill the same spend. */
  private async flushLongRunSpend(lrTaskId: string, execId: string, startMs: number): Promise<void> {
    const lr = this.longRun
    if (!lr) return
    const tokens = this.longRunUsage.get(execId) ?? 0
    this.longRunUsage.set(execId, 0)
    const rawSec = (lr.now() - startMs) / 1000
    const seconds = Number.isFinite(rawSec) && rawSec > 0 ? rawSec : 0
    if (tokens <= 0 && seconds <= 0) return
    try {
      await lr.store.mutate(lrTaskId, (draft) => {
        draft.budget.tokensUsed += tokens
        draft.budget.timeUsedSec += seconds
      })
    } catch (err) {
      lr.logger?.warn('[longrun] spend flush failed', { taskId: lrTaskId, err: String(err) })
    }
  }

  /** A segment threw a NON-suspend error: flush spend, journal a mechanical
   *  failure line, tell the member the chain stopped. Caller rethrows — the
   *  dispatch fails honestly; the dossier stays on disk (documented residual:
   *  its status remains `active` with no chain — cancel + restart to resume). */
  private async recordLongRunFailure(
    lrTaskId: string,
    execId: string,
    startMs: number,
    err: unknown,
  ): Promise<void> {
    await this.flushLongRunSpend(lrTaskId, execId, startMs)
    const lr = this.longRun
    if (!lr) return
    const msg = err instanceof Error ? err.message : String(err)
    try {
      const loaded = await lr.store.load(lrTaskId)
      if (loaded.kind === 'ok') {
        await lr.store.appendJournal(lrTaskId, {
          seg: loaded.dossier.segments + 1,
          did: clipLongRunText(`(段执行失败,接力停止) ${msg}`, LONGRUN_LIMITS.maxJournalDidChars),
        })
      }
    } catch (jErr) {
      lr.logger?.warn('[longrun] failure journal failed', { taskId: lrTaskId, err: String(jErr) })
    }
    await this.longRunPush(
      `[长期任务 ${lrTaskId}] 本段执行失败,后台接力就此停止:${clipLongRunText(msg, 200)}` +
        String.fromCharCode(0x0a) +
        '档案仍在盘上;要继续可以先取消这项任务再重新开一项,或直接问我它的进展。',
    )
  }

  private longRunTerminalLine(d: LongRunDossier): string {
    const label =
      d.status === 'done' ? '已完成' : d.status === 'cancelled' ? '已取消' : '挂起等成员输入中'
    return `[长期任务 ${d.taskId}] ${label},本段不再执行。`
  }

  private longRunUnreadable(lrTaskId: string, kind: 'missing' | 'corrupt'): { text: string } {
    return {
      text:
        kind === 'missing'
          ? `[长期任务 ${lrTaskId}] 档案不存在(可能已被清理),后台接力就此停止。`
          : `[长期任务 ${lrTaskId}] 档案损坏(坏件已隔离在原目录),后台接力就此停止,请人工检查。`,
    }
  }

  /** Best-effort member push — delivery must never decide a segment's fate. */
  private async longRunPush(text: string): Promise<void> {
    const lr = this.longRun
    if (!lr?.push) return
    try {
      await lr.push(text)
    } catch (err) {
      lr.logger?.warn('[longrun] member push failed', { err: String(err) })
    }
  }

  /** Duck-read a task output's text (LlmTaskOutput / plain string), else null. */
  private longRunTextOf(out: unknown): string | null {
    if (typeof out === 'string') return out.trim() || null
    if (out && typeof out === 'object') {
      const t = (out as { text?: unknown }).text
      if (typeof t === 'string' && t.trim()) return t.trim()
    }
    return null
  }
}
