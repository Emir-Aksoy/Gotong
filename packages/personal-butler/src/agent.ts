/**
 * `PersonalButlerAgent` — the resident butler.
 *
 * A `MemoryAugmentedAgent` (frozen-block memory + turn capture, from
 * `@aipehub/personal-memory`) with ONE addition: a bounded tool-loop whose
 * SENSITIVE tool calls are approval-gated (decision D2). Everything else —
 * memory, capture, suspend/resume working memory, usage sink — is inherited.
 *
 * The loop is the steward's governance path turned inside-out: instead of a
 * separate "propose → apply" engine, the butler runs ONE tool-loop where the
 * dangerous tools simply park the task (`SuspendTaskError` → `/me` inbox) until
 * a human approves. Benign tools (recall / dispatch / workflow-start / mcp) run
 * inline. This is the same mechanism `@aipehub/acp-agent`'s permission gate uses,
 * adapted from a live subprocess to a re-runnable conversation.
 *
 * Why override `runToolLoop` (rather than seam into the base loop): the base
 * `LlmAgent` loop deliberately maps EVERY `callTool` throw to an `isError` tool
 * result (so `DispatchToolset` can surface a child-suspend without parking the
 * parent). The butler needs the opposite for governed tools — park the parent —
 * so it owns its own loop + a bespoke checkpoint state. Blast radius stays in
 * this package; the shared base loop is untouched.
 */

import { SuspendTaskError, isSuspendTaskError, type Task } from '@aipehub/core'
import {
  ComposedToolset,
  type LlmAgentToolset,
  type LlmContentBlock,
  type LlmMessage,
  type LlmRequest,
  type LlmResponse,
  type LlmToolResultBlock,
  type LlmToolUseBlock,
} from '@aipehub/llm'
import {
  DEFAULT_TIERS,
  MemoryAugmentedAgent,
  type MemoryAugmentedAgentOptions,
} from '@aipehub/personal-memory'

import {
  BUTLER_NEVER_RESUME_AT,
  butlerGateState,
  readButlerDecision,
  readButlerGateState,
} from './checkpoint.js'
import { GovernedActionToolset, type GovernedVerdict } from './governed-toolset.js'

export interface PersonalButlerAgentOptions
  extends Omit<MemoryAugmentedAgentOptions, 'tools'> {
  /** The approval-gated sensitive-action toolset (change hub / spend / send / delete). */
  governed: GovernedActionToolset
  /**
   * Benign toolsets composed alongside memory + governed — e.g. a
   * `DispatchToolset` (sub-agents), a workflow-start toolset, an `McpToolset`.
   * These run inline; only `governed` tools can park the task.
   */
  benign?: LlmAgentToolset | LlmAgentToolset[]
}

export class PersonalButlerAgent extends MemoryAugmentedAgent {
  /** Held for GATING (governs / classify / describe). Execution routes through
   *  the composed `this.toolset`, which already includes this. */
  private readonly governed: GovernedActionToolset

  constructor(opts: PersonalButlerAgentOptions) {
    const benignList = opts.benign
      ? Array.isArray(opts.benign)
        ? opts.benign
        : [opts.benign]
      : []
    // Benign first, governed last — distinct names, so this is just a stable
    // ordering. `MemoryAugmentedAgent` further composes memory tools in front.
    const composed = ComposedToolset.of(...benignList, opts.governed)
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
      tools: composed,
      tierConfig: opts.tierConfig ?? DEFAULT_TIERS,
      frozenActiveOnly: opts.frozenActiveOnly ?? true,
      frozenShowLinks: opts.frozenShowLinks ?? true,
      frozenShowProcedures: opts.frozenShowProcedures ?? true,
    })
    this.governed = opts.governed
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
        if (this.governed.governs(tu.name)) {
          verdicts.set(tu.id, await this.governed.classify(tu.name, tu.input))
        }
      }

      const park = toolUses.find((tu) => verdicts.get(tu.id)?.decision === 'approve')
      if (park) {
        const v = verdicts.get(park.id) as { decision: 'approve'; reason: string }
        const messages: LlmMessage[] = [
          ...req.messages,
          { role: 'assistant', content: assistantBlocks },
        ]
        throw new SuspendTaskError({
          resumeAt: BUTLER_NEVER_RESUME_AT,
          state: butlerGateState({
            messages,
            pending: {
              toolUses,
              approval: {
                toolName: park.name,
                title: this.governed.describe(park.name, park.input),
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
   * On approval we run the deferred tool call (the very same `callOne` the loop
   * would have run inline); on denial the governed tool gets a fail-closed
   * `isError` result — the model is told it was declined and adapts. Either way
   * we append the round's `tool_result`s and continue the loop, so the
   * conversation stays coherent.
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

    const toolResultBlocks: LlmToolResultBlock[] = []
    for (const tu of gate.pending.toolUses) {
      if (this.governed.governs(tu.name)) {
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
      } else {
        // A benign sibling in the same round runs now (it was deferred so we
        // wouldn't act before the human decided).
        toolResultBlocks.push(await this.callOne(tu))
      }
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
