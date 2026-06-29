/**
 * `GovernedActionToolset` — the butler's SENSITIVE actions, exposed as LLM
 * tools but gated by a server-authoritative classifier.
 *
 * Decision D2: the butler is ONE bounded tool-loop, not two engines. Benign
 * tools (recall / dispatch / workflow-start / mcp) run inline; the dangerous
 * ones (change hub / spend / send outward / delete) live here. This toolset is
 * deliberately split into two concerns so the butler's loop owns the GATING and
 * this owns the EXECUTION:
 *
 *   - `classify(name, args)` → a three-way verdict (allow inline / escalate to a
 *     human / refuse fail-closed). Pure policy; injected by the host (which wires
 *     the hub-steward `classifyStewardAction` for real tiering) or defaulted to a
 *     conservative "everything governed needs approval".
 *   - `callTool(name, args)` → runs the action via the injected `execute`. The
 *     butler only calls this AFTER the loop (or a human, on resume) cleared the
 *     gate, so execution here is unconditional — never re-classify in `callTool`.
 *
 * Keeping the classifier out of `callTool` is what lets the butler park BEFORE
 * the side effect happens (`SuspendTaskError`), then run the very same
 * `callTool` on resume once approved.
 *
 * No host / identity dependency — the classifier and executor are injected
 * callbacks (same discipline as `MemorySummarizer` in `@aipehub/personal-memory`).
 */

import type {
  LlmAgentToolset,
  LlmToolCallResult,
  LlmToolDefinition,
} from '@aipehub/llm'

import { ButlerError } from './errors.js'

/**
 * A governed-tool verdict — three-way, mirroring the ACP permission gate:
 *   - `allow`   → run inline; no human.
 *   - `approve` → park for a human (the HANDOFF seam → `/me` inbox).
 *   - `refuse`  → fail-closed inline; the model gets an `isError` result and
 *                 must find another way (used for out-of-scope / forbidden asks).
 */
export type GovernedVerdict =
  | { decision: 'allow' }
  | { decision: 'approve'; reason: string }
  | { decision: 'refuse'; reason: string }

/**
 * Server-authoritative classifier. The butler NEVER trusts a tool's args to
 * tier themselves — the host injects this (typically backed by hub-steward's
 * `classifyStewardAction`) so the same risk policy governs the steward console
 * and the butler. May be async (a real classifier may consult live hub state,
 * e.g. "is this workflow cross-hub").
 */
export type GovernedClassifier = (
  name: string,
  args: Record<string, unknown>,
) => GovernedVerdict | Promise<GovernedVerdict>

/** The injected executor's result — flattened to text for the LLM. */
export interface GovernedExecResult {
  text: string
  isError?: boolean
}

/**
 * Runs a cleared governed action. Injected by the host (wires
 * `performStewardAction` / member services). Throwing is fine — the butler maps
 * a throw to an `isError` tool result, same as any other tool.
 */
export type GovernedExecutor = (
  name: string,
  args: Record<string, unknown>,
) => GovernedExecResult | Promise<GovernedExecResult>

/** One governed action the LLM may invoke. */
export interface GovernedToolSpec {
  /** Must match the LLM tool-name regex `^[a-zA-Z0-9_-]+$`. */
  name: string
  description?: string
  /** JSON Schema for the tool's input. */
  inputSchema: Record<string, unknown>
  /**
   * Static fallback verdict for this tool — used when no `classify` is injected
   * (or as the injected classifier's per-tool default). Omit → defaults to
   * `approve` (conservative: a governed tool with no policy still asks a human).
   */
  defaultVerdict?: GovernedVerdict
}

export interface GovernedActionToolsetOptions {
  tools: GovernedToolSpec[]
  /** Runs a cleared action. */
  execute: GovernedExecutor
  /** Server-authoritative tiering. Default → each tool's `defaultVerdict ?? approve`. */
  classify?: GovernedClassifier
  /** Human title for the inbox item. Default → `name(<args-json-slice>)`. */
  describe?: (name: string, args: Record<string, unknown>) => string
}

export class GovernedActionToolset implements LlmAgentToolset {
  private readonly specs: ReadonlyMap<string, GovernedToolSpec>
  private readonly execute: GovernedExecutor
  private readonly classifier: GovernedClassifier | undefined
  private readonly describeFn:
    | ((name: string, args: Record<string, unknown>) => string)
    | undefined

  constructor(opts: GovernedActionToolsetOptions) {
    if (opts.tools.length === 0) {
      throw new ButlerError('no_governed_tools', 'GovernedActionToolset requires at least one tool spec.')
    }
    const specs = new Map<string, GovernedToolSpec>()
    for (const t of opts.tools) {
      if (specs.has(t.name)) {
        throw new ButlerError(
          'duplicate_governed_tool',
          `GovernedActionToolset: tool '${t.name}' declared more than once — names must be unique.`,
        )
      }
      specs.set(t.name, t)
    }
    this.specs = specs
    this.execute = opts.execute
    this.classifier = opts.classify
    this.describeFn = opts.describe
  }

  listTools(): LlmToolDefinition[] {
    return [...this.specs.values()].map((t) => ({
      name: t.name,
      ...(t.description !== undefined ? { description: t.description } : {}),
      inputSchema: t.inputSchema,
    }))
  }

  /** Is `name` one of THIS toolset's governed tools? (The butler asks before gating.) */
  governs(name: string): boolean {
    return this.specs.has(name)
  }

  /**
   * Tier a governed tool call. Falls back to the spec's `defaultVerdict`, then to
   * `approve` — a governed tool with no policy at all still asks a human (the
   * conservative default; the host overrides with real tiering).
   */
  async classify(name: string, args: Record<string, unknown>): Promise<GovernedVerdict> {
    if (this.classifier) return this.classifier(name, args)
    return this.specs.get(name)?.defaultVerdict ?? { decision: 'approve', reason: `'${name}' has no risk policy — asking you first` }
  }

  /** Human title for the inbox item. */
  describe(name: string, args: Record<string, unknown>): string {
    if (this.describeFn) return this.describeFn(name, args)
    let argStr: string
    try {
      argStr = JSON.stringify(args)
    } catch {
      argStr = '…'
    }
    if (argStr.length > 120) argStr = argStr.slice(0, 119) + '…'
    return `${name}(${argStr})`
  }

  /**
   * Execute a CLEARED governed action. The butler calls this only after the gate
   * passed (inline `allow`, or a human approval on resume) — so we never
   * re-classify here; that would let an approved action be silently re-blocked.
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<LlmToolCallResult> {
    if (!this.specs.has(name)) {
      return { content: [{ type: 'text', text: `unknown governed tool: ${name}` }], isError: true }
    }
    const out = await this.execute(name, args)
    const result: LlmToolCallResult = { content: [{ type: 'text', text: out.text }] }
    if (out.isError) result.isError = true
    return result
  }
}
