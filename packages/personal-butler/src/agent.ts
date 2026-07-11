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
}

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
  }

  /**
   * CARE-M4 — run the context probe before the base task path (which calls our
   * `buildRequest`). Stash-then-super keeps the injection point single: the
   * probe RESULT travels via `turnContext`, never by mutating options. A throw
   * degrades to "no injection" — chat must survive a sick probe.
   */
  protected override async handleTask(task: Task): Promise<unknown> {
    this.turnContext = null
    if (this.contextProbe) {
      try {
        this.turnContext = await this.contextProbe(task)
      } catch {
        this.turnContext = null
      }
    }
    return super.handleTask(task)
  }

  /** No fresh probe on resume (see the option's doc); clear any stale stash so
   *  a previous turn's card can never leak into a resumed conversation. */
  protected override async handleResume(task: Task, state: unknown): Promise<unknown> {
    this.turnContext = null
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
    if (this.turnContext) {
      req.systemVolatile = req.system ? `\n\n${this.turnContext}` : this.turnContext
    }
    return req
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
}
