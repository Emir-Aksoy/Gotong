/**
 * `WorkflowAssistantAgent` — natural-language → `gotong.workflow/v1` YAML.
 *
 * Phase 13 M1. The user describes what they want in plain language
 * (English / 中文 / mixed); the agent produces a YAML draft + short
 * explanation. The YAML is then handed to `parseWorkflow` for validation
 * (M2 wires that into an HTTP route). If validation fails, the caller
 * can re-invoke with the errors appended to the description — we do not
 * loop internally to keep the agent stateless and avoid the failure
 * modes of self-correcting LLM loops (cost / latency / convergence).
 *
 * Design notes:
 *
 *   1. Subclass of `LlmAgent` so it lives in the hub like any other
 *      capability. Admins dispatch to `capability=workflow:assist`; the
 *      web UI (M3) does the same internally.
 *
 *   2. The system prompt is internal — callers cannot override it via
 *      `payload.system`, because the prompt IS the schema knowledge and
 *      an override would corrupt the contract. (Override `system` at
 *      construction if you really need a different prompt.)
 *
 *   3. `contextHints` lets the host pre-load what agents / capabilities
 *      / MCP servers are actually available in this hub, so the
 *      assistant uses real capability names instead of inventing
 *      plausible-but-nonexistent ones.
 *
 *   4. Output extraction looks for a ```yaml ... ``` fence first, then
 *      any ``` ... ``` fence, then falls back to the raw text. We don't
 *      validate the YAML here — `validateWorkflowYaml` (M2) is the
 *      validator. Keeping the agent extraction-only means the test
 *      surface is tiny (mock provider returns a fixed string → assert
 *      what we extract).
 */

import {
  LlmAgent,
  type LlmAgentOptions,
  type LlmRequest,
  type LlmResponse,
  type LlmTaskOutput,
} from '@gotong/llm'
import type { Task } from '@gotong/core'

import {
  parseWorkflow,
  projectWorkflowGraph,
  WORKFLOW_SCHEMA_V1,
  WorkflowSchemaError,
  type WorkflowGraphView,
} from '@gotong/workflow'
import {
  checkWorkflowStructure,
  type WorkflowInventory,
  type WorkflowStructureCheckResult,
  type WorkflowStructureViolation,
} from '@gotong/evals/checkers/workflow-structure'

// ---------------------------------------------------------------------------
// Public payload / output shapes — exported so callers and HTTP routes can
// agree on what they're sending / receiving.
// ---------------------------------------------------------------------------

/**
 * Which job the architect is doing on this call.
 *
 *   - `'author'`  (default) — turn `description` into a brand-new workflow YAML.
 *   - `'explain'` — describe an EXISTING workflow given in `subjectYaml`; the
 *     YAML is NOT regenerated (the LLM only writes prose), so what comes back
 *     is the same workflow, just narrated.
 */
export type WorkflowAssistMode = 'author' | 'explain'

/**
 * How deep the natural-language explanation should be. Affects ONLY the
 * prose — the YAML and the DAG graph are identical at every depth.
 *
 *   - `'oneliner'` — a single sentence: what it does, nothing else.
 *   - `'brief'`    — 2-4 sentences (the historical default).
 *   - `'detailed'` — step-by-step walk-through with data flow + gates.
 */
export type WorkflowDetailLevel = 'oneliner' | 'brief' | 'detailed'

/** What you put in `Task.payload` when dispatching to a `workflow:assist` agent. */
export interface WorkflowAssistantPayload {
  /**
   * Required. In `author` mode: the natural-language description of the
   * workflow the user wants. In `explain` mode: an optional question /
   * focus for the explanation (may be empty — `subjectYaml` is the subject).
   */
  description: string
  /**
   * Optional. `'author'` (default) produces a new workflow from `description`;
   * `'explain'` narrates the existing workflow in `subjectYaml` without
   * regenerating it. Existing callers (WFEDIT / steward / admin dialog) omit
   * this and get the historical author behavior.
   */
  mode?: WorkflowAssistMode
  /**
   * Optional. Depth of the prose explanation — `'oneliner'` / `'brief'`
   * (default) / `'detailed'`. When omitted the user message is left exactly
   * as before (no depth instruction injected), so author-mode behavior is
   * byte-for-byte unchanged for callers that don't ask for a depth.
   */
  detail?: WorkflowDetailLevel
  /**
   * Required when `mode === 'explain'`: the existing workflow's YAML. The
   * output's `yaml` and `graph` are derived deterministically from THIS
   * string (never from the LLM's echo, which can't be trusted to be
   * faithful). Ignored in author mode.
   */
  subjectYaml?: string
  /**
   * Optional. What's actually available in the hub right now. The
   * assistant will prefer these over making up capability names.
   *
   * If omitted, the assistant guesses based on common patterns
   * (capability=draft / review / summarize / etc.). With it, the
   * generated YAML is usable on first try in this hub.
   */
  contextHints?: {
    /** Agents the user has spawned. */
    agents?: ReadonlyArray<{
      id: string
      capabilities: ReadonlyArray<string>
      description?: string
    }>
    /** MCP servers configured on the host. */
    mcpServers?: ReadonlyArray<string>
    /** Existing workflow ids — assistant should pick a new id that doesn't collide. */
    existingWorkflowIds?: ReadonlyArray<string>
  }
}

/**
 * Verdict on the YAML the assistant produced for THIS draft.
 *
 *   - `'valid'`   — yaml was extracted and `parseWorkflow(yaml)` succeeded.
 *                   Caller can hand it straight to `WorkflowRunner` or save
 *                   it as a workflow file. Most common happy-path outcome.
 *   - `'no_yaml'` — LLM didn't put a yaml fence in its reply (refused,
 *                   went off-topic, or asked a clarifying question). `yaml`
 *                   is `''`; the human-readable answer is in `explanation`.
 *                   Caller should re-prompt the user, not save anything.
 *   - `'invalid'` — yaml fence was extracted but `parseWorkflow` rejected it.
 *                   `validationError` carries the parser's message verbatim
 *                   (the same string admins see when uploading a bad YAML
 *                   file). Caller can show the error inline and let the
 *                   user re-prompt with hints (e.g. "the LLM forgot to
 *                   declare a unique step id").
 *
 * The three states let routes / UI / SDK callers distinguish "LLM
 * answered correctly", "LLM cooperated but the spec was wrong", and "LLM
 * refused / didn't try" without re-parsing the response themselves. This
 * is the Phase 13 M1 success-semantics fix flagged by
 * `audits/2026-05-27-codex/findings.md` (P2 — assistant success too loose).
 */
export type WorkflowDraftStatus = 'valid' | 'no_yaml' | 'invalid'

/**
 * What `WorkflowAssistantAgent` returns.
 *
 * Extends `LlmTaskOutput` so the agent is a well-behaved `LlmAgent`
 * subclass — `text` is the explanation (what a transcript reader
 * sees), `stopReason` / `usage` / `by` come from the base contract.
 * The workflow-specific fields (`yaml`, `explanation`, `raw`,
 * `draftStatus`, `validationError`) are additive.
 */
export interface WorkflowAssistantOutput extends LlmTaskOutput {
  /** The extracted YAML. Empty string if extraction failed (then `raw` has the answer). */
  yaml: string
  /** The plain-text portion of the response (everything that isn't the YAML fence). */
  explanation: string
  /** Full LLM response, before any extraction. Useful for debugging extraction failures. */
  raw: string
  /** Verdict on the produced yaml — see {@link WorkflowDraftStatus}. */
  draftStatus: WorkflowDraftStatus
  /**
   * Present iff `draftStatus === 'invalid'`. The exact `WorkflowSchemaError`
   * message the parser produced — safe to surface in admin UI verbatim.
   */
  validationError?: string
  /**
   * Phase 13 M4 — deep structural check against the inventory of agents /
   * workflow ids that were threaded in via `payload.contextHints`. Only
   * populated when:
   *   1. `draftStatus === 'valid'` (no point deep-checking unparseable YAML)
   *   2. The task payload carried `contextHints` (i.e. caller wanted the
   *      check; passing no hints means "portable / no hub context").
   *
   * The check surfaces things `parseWorkflow` can't see, like dispatching
   * to an agent id that doesn't exist on this hub, or to a capability no
   * registered agent satisfies, or `$stepId.output` refs to nonexistent
   * steps. See `@gotong/evals/checkers/workflow-structure` for the full
   * violation taxonomy.
   *
   * UI convention: when `deepCheck.ok === false` but `draftStatus ===
   * 'valid'`, treat as a "yellow / warnings" state — the YAML is
   * structurally fine and would import, but it references things this hub
   * doesn't actually have, so the workflow would fail at runtime. Caller
   * decides whether to let the admin save it anyway.
   */
  deepCheck?: WorkflowStructureCheckResult
  /**
   * The DAG projection of the produced (author mode) or subject (explain
   * mode) workflow — `nodes` + `edges`, computed by `projectWorkflowGraph`
   * (pure, no LLM). Present iff `draftStatus === 'valid'` (unparseable YAML
   * can't be projected). The UI renders this as an inline, downloadable SVG
   * flowchart — the "工作流图片介绍" the user asked for. Same shape the admin
   * DAG route returns, so the frontend reuses one renderer.
   */
  graph?: WorkflowGraphView
}

/**
 * Constructor options. We accept everything `LlmAgent` accepts EXCEPT
 * `system` (the assistant manages its own system prompt) and `id` /
 * `capabilities` (defaulted; can override if hosting multiple assistants
 * on the same hub).
 */
export interface WorkflowAssistantOptions extends Omit<LlmAgentOptions, 'system' | 'id'> {
  /**
   * Optional override for the agent's id. Defaults to
   * `WORKFLOW_ASSISTANT_DEFAULT_ID` (`'workflow-assistant'`). Override
   * when hosting multiple assistants on the same hub or in tests.
   */
  id?: string
  /**
   * Optional override for the built-in system prompt. **Only do this if
   * you know what you're doing** — the default prompt encodes the v1
   * schema contract, and a custom prompt that drops it will produce
   * invalid YAML.
   */
  systemOverride?: string
  /**
   * Few-shot examples appended to the system prompt. M4 will fill this
   * in by reading templates/workflows/*.yaml + their `assistant_hint`
   * comments. Empty for the basic agent.
   */
  examples?: ReadonlyArray<WorkflowExample>
}

/** A {natural-language, yaml} pair used as a few-shot demonstration. */
export interface WorkflowExample {
  description: string
  yaml: string
}

// ---------------------------------------------------------------------------
// Default system prompt — minimal-but-complete v1 schema doc, in the
// same `gotong.workflow/v1` voice users see in the YAML headers.
// ---------------------------------------------------------------------------

const BASE_SYSTEM_PROMPT = `You design Gotong workflows. The user describes what they want; you produce a YAML file matching the \`${WORKFLOW_SCHEMA_V1}\` schema.

# Schema

\`\`\`yaml
schema: gotong.workflow/v1

workflow:
  id: string                # required, [a-zA-Z0-9_.:-]{1,80}, unique
  name: string              # optional, human label
  description: string       # optional, one-line summary

  trigger:
    capability: string      # required — admins dispatch to this cap to start the flow

  steps:                    # required, non-empty, ordered
    - id: string            # required, unique within the workflow
      description: string   # optional
      dispatch:             # for a simple step
        strategy:           # one of:
          { kind: capability, capabilities: [cap1, cap2] }
          { kind: explicit, to: agentId }
          { kind: broadcast, capabilities: [cap1] }
        title: "..."        # optional, shown in transcript
        payload:            # object with $-ref substitutions (see below)
          field1: $trigger.payload.foo
          field2: $previousStepId.output.bar

    - id: parallelStepId    # for a parallel fan-out
      branches:
        - id: branchId
          dispatch: { ... } # same shape as simple step's dispatch

  output:                   # optional, default = last step's output
    field: $stepId.output.field
\`\`\`

# $-ref syntax

  $trigger.payload          — the entire inbound payload
  $trigger.payload.foo      — one field
  $stepId.output            — the entire output of an earlier step
  $stepId.output.bar        — one field
  $parallelId.branchId.output — branch output inside a parallel step

# Hard rules

  - Always emit the literal first line \`schema: gotong.workflow/v1\`.
  - \`workflow.id\` must be a slug ([a-zA-Z0-9_.:-]), no spaces.
  - Every step.id is unique. $-refs must point to earlier steps only.
  - When the host provides \`contextHints\`, USE the capability names listed
    there. Do NOT invent capabilities the host doesn't have.
  - When \`existingWorkflowIds\` is provided, pick a new id that doesn't collide.

# Output format

Respond with:

  1. A natural-language explanation in the user's language (English / 中文 /
     mixed follows the user's prompt). MATCH THE REQUESTED DEPTH — the user
     message may ask for a one-sentence, a brief, or a detailed explanation.
     Default to brief (2-4 sentences) when no depth is requested.
  2. One \`\`\`yaml ... \`\`\` code fence containing exactly the workflow YAML.

Do NOT include any other code fences. The first \`\`\`yaml block in your
response is treated as authoritative.

# Modes

By default you AUTHOR a new workflow: produce the explanation + one yaml
fence exactly as in "Output format" above.

If the user message instead asks you to EXPLAIN an existing workflow — it
shows you the YAML and says "respond with prose explanation ONLY, no code
fence" — then do NOT emit a yaml fence. The workflow is already decided; you
only describe it, in prose, at the requested depth.`

// ---------------------------------------------------------------------------
// Class
// ---------------------------------------------------------------------------

const DEFAULT_ID = 'workflow-assistant'
const DEFAULT_CAPABILITIES = ['workflow:assist']

/**
 * LlmAgent subclass that turns a natural-language description into a
 * draft `gotong.workflow/v1` YAML.
 *
 * Construction:
 *
 *   const agent = new WorkflowAssistantAgent({
 *     provider: anthropic,
 *     model: 'claude-3-5-sonnet-latest',
 *   })
 *   hub.register(agent)
 *
 * Dispatch:
 *
 *   const r = await hub.dispatch({
 *     from: 'admin',
 *     strategy: { kind: 'capability', capabilities: ['workflow:assist'] },
 *     payload: {
 *       description: '每周一爬 5 个新闻源 → DeepSeek 总结 → Telegram 群',
 *       contextHints: { agents: [...], mcpServers: [...] },
 *     },
 *   })
 *   // r.output: WorkflowAssistantOutput
 */
export class WorkflowAssistantAgent extends LlmAgent {
  private readonly examples: ReadonlyArray<WorkflowExample>
  private readonly assistantSystem: string

  constructor(opts: WorkflowAssistantOptions) {
    const { examples, systemOverride, id, capabilities, ...rest } = opts
    super({
      ...rest,
      id: id ?? DEFAULT_ID,
      capabilities: capabilities ?? DEFAULT_CAPABILITIES,
      // We hand the LlmAgent base class a system prompt that already
      // includes the schema doc + examples. Per-task `system` override
      // is intentionally NOT honored (see class doc).
      system: buildSystemPrompt(systemOverride ?? BASE_SYSTEM_PROMPT, examples ?? []),
    })
    this.examples = examples ?? []
    this.assistantSystem = this.defaults.system ?? ''
  }

  /**
   * Convert the user's `{description, contextHints}` payload into the
   * LLM request. The system prompt is set at construction; here we
   * just build the user message.
   */
  protected override buildRequest(task: Task): LlmRequest {
    const payload = task.payload as WorkflowAssistantPayload | undefined
    if (!payload || typeof payload !== 'object') {
      throw new Error(
        'workflow:assist payload must be { description: string, contextHints?: {...} }',
      )
    }

    // Explain mode: narrate an EXISTING workflow. `subjectYaml` is the
    // subject (required); `description` is just an optional focus question.
    if (payload.mode === 'explain') {
      if (typeof payload.subjectYaml !== 'string' || payload.subjectYaml.trim().length === 0) {
        throw new Error('workflow:assist explain mode requires a non-empty subjectYaml')
      }
      return this.buildLlmRequest(renderExplainMessage(payload))
    }

    // Author mode (default): produce a new workflow from `description`.
    if (typeof payload.description !== 'string') {
      throw new Error(
        'workflow:assist payload must be { description: string, contextHints?: {...} }',
      )
    }
    if (payload.description.trim().length === 0) {
      throw new Error('workflow:assist payload.description must be non-empty')
    }
    return this.buildLlmRequest(renderUserMessage(payload))
  }

  /**
   * Wrap a rendered user message into the `LlmRequest` with the assistant's
   * pinned system prompt + construction-time defaults. Shared by author and
   * explain modes so the two paths can't drift on request shape.
   */
  private buildLlmRequest(userMessage: string): LlmRequest {
    const req: LlmRequest = {
      messages: [{ role: 'user', content: userMessage }],
      // Always re-attach the assistant's system prompt. The base class
      // would do this anyway from `this.defaults.system`, but we wire it
      // explicitly so subclasses don't accidentally drop it.
      system: this.assistantSystem,
    }
    if (this.defaults.maxTokens !== undefined) req.maxTokens = this.defaults.maxTokens
    if (this.defaults.temperature !== undefined) req.temperature = this.defaults.temperature
    if (this.defaults.model !== undefined) req.model = this.defaults.model
    return req
  }

  /**
   * Extract the YAML fence from the LLM response and produce a verdict.
   *
   * Three possible `draftStatus` outcomes:
   *
   *   - `'no_yaml'` — extraction returned `yaml === ''` (LLM refused or
   *     didn't put a fence in the reply).
   *   - `'invalid'` — yaml was extracted but `parseWorkflow` threw a
   *     `WorkflowSchemaError`. The error message is surfaced in
   *     `validationError`.
   *   - `'valid'` — yaml parsed cleanly.
   *
   * Per Phase 13 M1 design: we self-validate (single round, no loop) so
   * callers don't have to re-parse. M2's HTTP route can forward the
   * status verbatim; nothing else needs to call `parseWorkflow` first.
   * Self-correcting LLM loops are still out of scope — the caller decides
   * whether to re-prompt with the error appended.
   */
  protected override parseResponse(
    response: LlmResponse,
    task: Task,
    _toolRounds = 0,
  ): WorkflowAssistantOutput {
    const raw = response.text
    const payload = task.payload as WorkflowAssistantPayload | undefined
    const inventory = payload?.contextHints
      ? inventoryFromContextHints(payload.contextHints)
      : undefined

    // Explain mode: the subject YAML is authoritative — we do NOT trust the
    // LLM to echo it faithfully. `yaml` + `graph` are derived deterministically
    // from `payload.subjectYaml`; the LLM only produced the prose explanation.
    if (payload?.mode === 'explain') {
      const subject = typeof payload.subjectYaml === 'string' ? payload.subjectYaml : ''
      const verdict = verdictForYamlWithDeepCheck(subject, inventory)
      return this.finishOutput(response, subject, raw.trim(), verdict)
    }

    // Author mode (default): extract the YAML fence the LLM produced.
    const { yaml, explanation } = extractYamlAndExplanation(raw)
    const verdict = verdictForYamlWithDeepCheck(yaml, inventory)
    return this.finishOutput(response, yaml, explanation, verdict)
  }

  /**
   * Assemble a {@link WorkflowAssistantOutput} from the response + the
   * resolved yaml / explanation / verdict. Shared by author and explain
   * modes so the optional-field plumbing (validationError / deepCheck /
   * graph / usage) lives in exactly one place.
   */
  private finishOutput(
    response: LlmResponse,
    yaml: string,
    explanation: string,
    verdict: YamlVerdict,
  ): WorkflowAssistantOutput {
    const out: WorkflowAssistantOutput = {
      // LlmTaskOutput contract: `text` is what transcript / SDK
      // consumers see. We use the explanation (human-readable) rather
      // than the raw response so the transcript stays clean.
      text: explanation,
      stopReason: response.stopReason,
      by: this.provider.name,
      yaml,
      explanation,
      raw: response.text,
      draftStatus: verdict.status,
    }
    if (verdict.validationError !== undefined) out.validationError = verdict.validationError
    if (verdict.deepCheck !== undefined) out.deepCheck = verdict.deepCheck
    if (verdict.graph !== undefined) out.graph = verdict.graph
    if (response.usage) out.usage = response.usage
    return out
  }
}

/**
 * Determine the draft status for a freshly-extracted yaml string by
 * trying `parseWorkflow`. Exported so M2 route logic / unit tests can
 * reuse the exact same verdict function as the agent.
 *
 *   - empty string → `'no_yaml'`
 *   - parses cleanly → `'valid'`
 *   - throws `WorkflowSchemaError` → `'invalid'` with the message attached
 *   - throws any other error → `'invalid'` with the message attached
 *     (defensive — we never want to bubble an unexpected exception out
 *     of the verdict path; the caller still gets actionable output)
 */
export function verdictForYaml(yaml: string): {
  status: WorkflowDraftStatus
  validationError?: string
} {
  if (yaml.length === 0) return { status: 'no_yaml' }
  try {
    parseWorkflow(yaml)
    return { status: 'valid' }
  } catch (err) {
    const msg =
      err instanceof WorkflowSchemaError
        ? err.message
        : err instanceof Error
        ? err.message
        : String(err)
    return { status: 'invalid', validationError: msg }
  }
}

/**
 * Phase 13 M4 — same as `verdictForYaml` but, when status comes back
 * `'valid'` AND an `inventory` is supplied, runs the deep structural
 * check from `@gotong/evals` against the parsed workflow and returns the
 * result. Status itself is never downgraded by the deep check — caller
 * inspects `deepCheck.ok` and decides how to render (a typical UI: green
 * iff both `status==='valid'` and `deepCheck.ok`; yellow if valid but
 * deep-check-fail; red on invalid; gray on no_yaml).
 *
 * Exported so HTTP routes / SDK callers can reuse the same logic the
 * agent's `parseResponse` uses — keeping the verdict shape stable across
 * call sites avoids "agent says X, route says Y" drift.
 */
/**
 * What {@link verdictForYamlWithDeepCheck} returns: the draft status plus the
 * structural extras attached only when the YAML is valid. Named so the
 * agent's `finishOutput` helper and route / SDK callers share one type.
 */
export interface YamlVerdict {
  status: WorkflowDraftStatus
  validationError?: string
  deepCheck?: WorkflowStructureCheckResult
  /** DAG projection of the workflow. Present iff `status === 'valid'`. */
  graph?: WorkflowGraphView
}

export function verdictForYamlWithDeepCheck(
  yaml: string,
  inventory: WorkflowInventory | undefined,
): YamlVerdict {
  const base = verdictForYaml(yaml)
  if (base.status !== 'valid') return base
  // Valid YAML: parse once, then project the DAG graph (pure, no LLM, no
  // inventory needed — this is the "工作流图片介绍" payload) and, ONLY when an
  // inventory was supplied, run the deep structural check. We re-parse here
  // because verdictForYaml doesn't hand back the parsed definition; keeping
  // its signature byte-for-byte stable matters more than the microsecond.
  const parsed = parseWorkflow(yaml)
  const graph = projectWorkflowGraph(parsed)
  if (inventory === undefined) return { status: 'valid', graph }
  const deepCheck = checkWorkflowStructure(parsed, inventory)
  return { status: 'valid', deepCheck, graph }
}

/**
 * Translate a payload's `contextHints` into the `WorkflowInventory`
 * shape the deep checker wants. Both are intentionally similar — but
 * `contextHints` carries fields the LLM prompt cares about
 * (`description`, `mcpServers`) and the checker ignores those.
 *
 * Keeps the contextHints-vs-inventory mapping in one place so callers
 * (route handler, tests) don't reinvent it.
 */
export function inventoryFromContextHints(
  hints: NonNullable<WorkflowAssistantPayload['contextHints']>,
): WorkflowInventory {
  const inv: WorkflowInventory = {}
  if (hints.agents && hints.agents.length > 0) {
    inv.agents = hints.agents.map((a) => ({
      id: a.id,
      capabilities: a.capabilities,
    }))
  }
  if (hints.existingWorkflowIds && hints.existingWorkflowIds.length > 0) {
    inv.existingWorkflowIds = hints.existingWorkflowIds
  }
  return inv
}

// ---------------------------------------------------------------------------
// Pure helpers — exported so M2 / M3 / M5 can test extraction in isolation.
// ---------------------------------------------------------------------------

/**
 * Concatenate the base system prompt with few-shot examples.
 *
 * Each example is rendered as `--- example N ---\n<desc>\n\n\`\`\`yaml\n<yaml>\n\`\`\``
 * so the LLM sees the exact output format we want from it.
 */
export function buildSystemPrompt(
  base: string,
  examples: ReadonlyArray<WorkflowExample>,
): string {
  if (examples.length === 0) return base
  const parts: string[] = [base, '', '# Examples']
  examples.forEach((ex, i) => {
    parts.push('')
    parts.push(`--- example ${i + 1} ---`)
    parts.push(`User: ${ex.description}`)
    parts.push('')
    parts.push('Assistant:')
    parts.push('```yaml')
    parts.push(ex.yaml.trim())
    parts.push('```')
  })
  return parts.join('\n')
}

/**
 * Meta-instruction injected into the user message telling the LLM how deep
 * the prose explanation should be. Exported so routes / tests can assert the
 * exact depth wording without reaching into the agent.
 *
 * Note these constrain ONLY the explanation prose — the YAML and the DAG
 * graph are identical at every depth.
 */
export function detailInstruction(detail: WorkflowDetailLevel): string {
  switch (detail) {
    case 'oneliner':
      return 'Keep the explanation to exactly ONE concise sentence — what the workflow does, nothing else.'
    case 'detailed':
      return 'Make the explanation detailed: walk through every step in order, name the capability or agent each step dispatches to, describe how data flows between steps via $-refs, and call out any human-approval or cross-hub gates. Several short paragraphs are fine.'
    case 'brief':
    default:
      return 'Keep the explanation brief — 2-4 sentences covering the trigger and the main steps.'
  }
}

/**
 * Build the user-facing message for AUTHOR mode: description + contextHints
 * rendered as a compact list, with an optional depth instruction appended.
 *
 * Kept stable so test snapshots don't churn — the depth line is appended
 * ONLY when `payload.detail` is explicitly set, so callers that don't ask
 * for a depth get the exact same message as before.
 */
export function renderUserMessage(payload: WorkflowAssistantPayload): string {
  const lines: string[] = [payload.description.trim()]
  const hints = payload.contextHints
  if (hints) {
    const ctx: string[] = []
    if (hints.agents && hints.agents.length > 0) {
      ctx.push('Available agents:')
      for (const a of hints.agents) {
        const caps = a.capabilities.join(', ')
        const desc = a.description ? ` — ${a.description}` : ''
        ctx.push(`  - ${a.id} [${caps}]${desc}`)
      }
    }
    if (hints.mcpServers && hints.mcpServers.length > 0) {
      ctx.push('Available MCP servers:')
      for (const s of hints.mcpServers) ctx.push(`  - ${s}`)
    }
    if (hints.existingWorkflowIds && hints.existingWorkflowIds.length > 0) {
      ctx.push('Existing workflow ids (pick a new one that does not collide):')
      for (const id of hints.existingWorkflowIds) ctx.push(`  - ${id}`)
    }
    if (ctx.length > 0) {
      lines.push('')
      lines.push('---')
      lines.push(...ctx)
    }
  }
  if (payload.detail) {
    lines.push('')
    lines.push('---')
    lines.push(detailInstruction(payload.detail))
  }
  return lines.join('\n')
}

/**
 * Build the user-facing message for EXPLAIN mode: present the existing
 * workflow YAML and ask for prose only (no code fence), at the requested
 * depth. The agent ignores any YAML the LLM might echo and uses
 * `payload.subjectYaml` as the authoritative source.
 */
export function renderExplainMessage(payload: WorkflowAssistantPayload): string {
  const subject = (payload.subjectYaml ?? '').trim()
  const ask = payload.description?.trim()
  const lines: string[] = [
    ask && ask.length > 0 ? ask : 'Explain what the following Gotong workflow does.',
    '',
    'Explain the workflow below. Do NOT rewrite it and do NOT output any code fence — respond with the prose explanation ONLY.',
    detailInstruction(payload.detail ?? 'brief'),
    '',
    '```yaml',
    subject,
    '```',
  ]
  return lines.join('\n')
}

/**
 * Pull the first ```yaml fence out of an LLM response. Falls back to
 * any ``` ``` fence, then to the whole text. Returns `yaml=''` only
 * when there's literally nothing fence-like.
 */
export function extractYamlAndExplanation(raw: string): {
  yaml: string
  explanation: string
} {
  // Prefer ```yaml or ```yml fence.
  const yamlFence = /```(?:yaml|yml)\s*\n([\s\S]*?)```/i.exec(raw)
  if (yamlFence && yamlFence[1] !== undefined) {
    const yaml = yamlFence[1].trim()
    const explanation = (
      raw.slice(0, yamlFence.index) + raw.slice(yamlFence.index + yamlFence[0].length)
    ).trim()
    return { yaml, explanation }
  }
  // Fallback: any code fence.
  const anyFence = /```[^\n]*\n([\s\S]*?)```/.exec(raw)
  if (anyFence && anyFence[1] !== undefined) {
    const yaml = anyFence[1].trim()
    const explanation = (
      raw.slice(0, anyFence.index) + raw.slice(anyFence.index + anyFence[0].length)
    ).trim()
    return { yaml, explanation }
  }
  // No fence at all — the model probably refused or replied plain
  // text. Surface the raw text as explanation; yaml is empty so
  // callers can detect the failure.
  return { yaml: '', explanation: raw.trim() }
}

/** Convenience: default ids so tests / hosts can reference them in one place. */
export const WORKFLOW_ASSISTANT_CAPABILITY = 'workflow:assist'
export const WORKFLOW_ASSISTANT_DEFAULT_ID = DEFAULT_ID
