/**
 * `personal-growth-agent.ts` — LlmAgent subclass for the
 * `personal-growth-flow` workflow. Adds:
 *
 *   1. **Recall before each step**: pulls this agent's own past
 *      growth-history entries from `services.memory`, formats them
 *      as a markdown context block, prepends to the task prompt.
 *
 *   2. **Write after each step**: persists the LLM's response as a
 *      new memory entry, tagged with `topic = <step kind>` so future
 *      runs can filter / format it.
 *
 *   3. **Capability → topic mapping**: each agent is dispatched
 *      against one capability (e.g. `analyze-body`); the topic is
 *      derived from that. Falls back to plain LlmAgent behaviour
 *      if the dispatch is for an unknown capability (defensive —
 *      lets the same class handle ad-hoc dispatches without crashing).
 *
 *   4. **Graceful degradation**: when `services.memory` is undefined
 *      (e.g. agent declared no `uses:` in agents.json), behaviour
 *      collapses to base LlmAgent's. The class is safe to use even
 *      without service plumbing.
 *
 * # Why a subclass and not a hook
 *
 * The recall/write pattern is fundamentally a "wrap the LLM call"
 * pattern: prepend context, call LLM, append output. AipeLAgent base
 * exposes `handleTask` as the override point for exactly this kind
 * of customization. We override it once, call back into the base's
 * `buildRequest` / `provider.complete` / `parseResponse` so we get
 * all the base-class behaviours (tool-use loop, parser, etc.) for
 * free — we just bracket them with the memory operations.
 *
 * # M2 (auto-compaction) — stubbed
 *
 * The recall step ends with a `shouldCompact()` predicate check.
 * When it returns true today, we just log a warning. M2 will turn
 * this into a real compaction (dispatch to a summarizer agent →
 * write `kind: semantic, topic: compacted-summary` → soft-delete old
 * episodic). Stubbing here keeps the integration point obvious.
 *
 * # M3 (artifact + datastore) — stubbed in synthesis
 *
 * When the synthesist step finishes, M3 will additionally:
 *   - artifact.write(`reports/<caseId>/<YYYYMMDD-HHmm>.md`, fullReport)
 *   - datastore.sql.exec("INSERT INTO growth_runs ...")
 * For now we only do the memory write (same path as other steps).
 */

import { createLogger, type Task } from '@aipehub/core'
import { LlmAgent } from '@aipehub/llm'
import type { LlmAgentOptions } from '@aipehub/llm'

import {
  type GrowthBinding,
  type GrowthTopic,
  formatGrowthContextBlock,
  maybeCompactMemory,
  recallGrowthHistory,
  recordGrowthOutput,
  topicForCapability,
} from '../services/personal-growth-context.js'

const log = createLogger('host:personal-growth-agent')

/**
 * caseId scope. Default `'self'` matches the "you for yourself" UX —
 * re-runs by the same agent accumulate into one memory timeline so
 * the next run sees "what we talked about last time."
 *
 * When the workflow trigger payload (or any intermediate step
 * payload) carries `case_id: '<id>'`, that overrides — the same admin
 * can coach multiple coachees by passing a different case_id per
 * dispatch. The string is the only filter key inside the agent's
 * private memory namespace; agent-level isolation already comes from
 * the per-agent owner.
 *
 * `case_id` only flows through the agent's read of `task.payload`
 * (see `pickCaseId` below). The workflow yaml is expected to thread
 * it from `$trigger.payload.case_id` through to every step's payload
 * — see `templates/workflows/personal-growth-flow.yaml`.
 */
const DEFAULT_CASE_ID = 'self'

/**
 * Allowed `case_id` regex: letters / digits / `_` / `-` / `.`. Keeps
 * it filename-safe (it appears in `reports/<caseId>/<date>.md`) and
 * URL-safe (some future endpoint may need to take it in a path).
 */
const CASE_ID_RE = /^[A-Za-z0-9_.-]{1,64}$/

export class PersonalGrowthAgent extends LlmAgent {
  constructor(opts: LlmAgentOptions) {
    super(opts)
  }

  protected override async handleTask(task: Task): Promise<unknown> {
    const capability = pickCapability(task)
    const topic = capability ? topicForCapability(capability) : null

    // Defensive: dispatched against a capability we don't know how to
    // map to a topic? Fall through to base behaviour so we don't crash
    // on a future ad-hoc dispatch the workflow doesn't model.
    if (!topic) {
      log.warn('unmapped capability — falling through to base LlmAgent', {
        id: this.id,
        capability,
      })
      return super.handleTask(task)
    }

    const memory = this.services.memory
    if (!memory) {
      // Agent declared no memory in agents.json. Behaviour collapses
      // to base. Still works for the workflow — just no recall/write.
      log.debug('no memory handle attached — running stateless', {
        id: this.id,
        topic,
      })
      return super.handleTask(task)
    }

    const caseId = pickCaseId(task)
    const binding: GrowthBinding = { caseId, memory }

    // ────────────────────────────────────────────────────────────────
    // 0. Maybe compact prior history before we recall it. Running
    //    compaction first means the upcoming recall + prompt see the
    //    post-compaction state — no entry shows up both verbatim and
    //    inside the summary. Failures are non-fatal: a flaky LLM hop
    //    on the compactor shouldn't block the actual workflow step.
    // ────────────────────────────────────────────────────────────────
    try {
      const compacted = await maybeCompactMemory(binding, async ({ system, user }) => {
        const res = await this.provider.complete({
          system,
          messages: [{ role: 'user', content: user }],
          maxTokens: 800,
          temperature: 0.3,
        })
        return res.text
      })
      if (compacted) {
        log.info('memory compaction completed', {
          id: this.id,
          caseId: binding.caseId,
          compactedCount: compacted.compactedCount,
          absorbedSummaries: compacted.absorbedSummaries,
        })
      }
    } catch (err) {
      log.error('memory compaction failed (non-fatal, continuing)', {
        id: this.id,
        caseId: binding.caseId,
        err,
      })
    }

    // ────────────────────────────────────────────────────────────────
    // 1. Recall this agent's prior history for this case.
    //
    // For the interviewer (portrait step) we recall **all** topics
    // (so it can say "last time you said X about your relationships,
    // has that changed?"). For each per-dimension coach, we recall
    // only that coach's own past outputs (body-coach reads past body
    // analyses, etc.). For the synthesist we recall only past
    // synthesis outputs (to track "how has your plan evolved over
    // the last 6 / 12 weeks?"); the within-run dimension outputs
    // arrive via task.payload, not via memory.
    //
    // `recallGrowthHistory` always surfaces compacted-summary entries
    // (regardless of topic filter) so a dimension coach still sees
    // the cross-topic context that a prior compaction folded together.
    // ────────────────────────────────────────────────────────────────
    const recallTopics: GrowthTopic[] | undefined =
      topic === 'portrait'
        ? undefined  // see all past history for the human as a whole
        : [topic]    // see only this dimension's history (+ summaries)

    const history = await recallGrowthHistory(binding, {
      topics: recallTopics,
      limit: 20,
    })

    // ────────────────────────────────────────────────────────────────
    // 2. Prepend the formatted context to the prompt. We rewrite
    // `task.payload.prompt` so base buildRequest sees the augmented
    // prompt. For other payload shapes (string, {topic}, etc.) we
    // wrap into a {prompt} object with the context block + original
    // payload serialized.
    // ────────────────────────────────────────────────────────────────
    const ctxBlock = formatGrowthContextBlock({ history })
    const augmentedTask = ctxBlock
      ? withAugmentedPrompt(task, ctxBlock)
      : task

    // ────────────────────────────────────────────────────────────────
    // 3. Run the actual LLM call via base behaviour (preserves tool-use
    // loop, system prompt defaults, parseResponse, etc.).
    // ────────────────────────────────────────────────────────────────
    let out = await super.handleTask(augmentedTask)

    // ────────────────────────────────────────────────────────────────
    // 3b. (v2.5, HITL) Interviewer-only: detect a `<NEED_INPUT>{...}
    //     </NEED_INPUT>` marker in the first LLM response, dispatch a
    //     human follow-up question, then re-run the LLM with the
    //     answers stitched in.
    //
    //     Scope is intentionally limited to topic === 'portrait' (the
    //     access point for user info). 5 dimension coaches and the
    //     synthesist keep the old "list questions at end of report"
    //     iteration model so a single run can't snowball into 7 nested
    //     question rounds. Hard 1-round budget per portrait step.
    //
    //     Graceful degradation: if any precondition isn't met (no
    //     dispatch surface; bad marker JSON; no admin to ask; cancel
    //     / timeout from the human) we silently fall through to the
    //     original output — the marker just leaks into the report as
    //     text, which is recoverable on a v2 run.
    // ────────────────────────────────────────────────────────────────
    if (topic === 'portrait') {
      const followUp = await this.maybeAskFollowUp({
        task,
        firstOutput: out,
      })
      if (followUp) {
        out = followUp
      }
    }

    // ────────────────────────────────────────────────────────────────
    // 4. Extract the text from the LLM's output and persist it as a
    // new growth-history entry. Defensive: out may be a custom shape
    // if a future subclass changes parseResponse — fall back to
    // JSON.stringify for the persisted text.
    // ────────────────────────────────────────────────────────────────
    const text = extractTextFromOutput(out)
    try {
      await recordGrowthOutput(binding, { topic, text })
    } catch (err) {
      // Persisting context shouldn't block the agent's response. Log
      // and continue — the LLM result still goes back to the workflow.
      log.error('failed to persist growth history entry', {
        id: this.id,
        topic,
        err,
      })
    }

    // ────────────────────────────────────────────────────────────────
    // 5. (Synthesist only, M3) Assemble + persist the full 7-section
    //    markdown report and the sqlite metadata row. The synthesist
    //    is the only step that has artifact + datastore in `uses:`,
    //    so the helper is a no-op for the other six agents even
    //    though `topic === 'synthesis'` is the only gate.
    //
    //    Failures are logged and swallowed: the user still gets the
    //    synthesist's text back through the workflow output, even if
    //    flushing to disk hits an I/O error.
    // ────────────────────────────────────────────────────────────────
    if (topic === 'synthesis') {
      try {
        await this.writeSynthesisReport(task, binding, text)
      } catch (err) {
        log.error('synthesis report write failed (non-fatal)', {
          id: this.id,
          err,
        })
      }
    }

    return out
  }

  /**
   * Build the consolidated markdown report from the synthesist's task
   * payload (which carries each prior step's output verbatim via the
   * workflow's `$portrait.output` references) and the synthesist's own
   * text. Writes it as one artifact + one row of metadata.
   *
   * Path layout: `reports/<caseId>/<YYYY-MM-DDTHH-MM-SS>.md`. The
   * stamp comes from `toFilenameStamp(new Date())` so two reports
   * minted in the same second sort to neighbouring entries; if a
   * future second-resolution clash matters, the artifact plugin
   * overwrites — the datastore row keeps the unique `task.id`.
   */
  private async writeSynthesisReport(
    task: Task,
    binding: GrowthBinding,
    synthesisText: string,
  ): Promise<void> {
    const artifact = this.services.artifact
    if (!artifact) {
      log.debug('synthesis report skipped — no artifact handle', { id: this.id })
      return
    }

    const at = new Date()
    const stamp = toFilenameStamp(at)
    const reportPath = `reports/${binding.caseId}/${stamp}.md`

    const payload = (task.payload ?? {}) as Record<string, unknown>
    const fullReport = renderFullReport({
      caseId: binding.caseId,
      at,
      focus: stringField(payload, 'user_focus'),
      portrait: stringField(payload, 'portrait'),
      body: stringField(payload, 'body'),
      mind: stringField(payload, 'mind'),
      goal: stringField(payload, 'goal'),
      resource: stringField(payload, 'resource'),
      social: stringField(payload, 'social'),
      synthesis: synthesisText,
    })

    const ref = await artifact.write(reportPath, fullReport, { mime: 'text/markdown' })
    log.info('synthesis report written', {
      id: this.id,
      path: ref.path,
      size: ref.size,
    })

    const datastore = this.services.datastore?.['growth-runs']
    if (datastore) {
      try {
        await datastore.sql.exec(
          `INSERT OR REPLACE INTO growth_runs
             (run_id, case_id, started_at, focus_request, main_track, three_judgments)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            task.id,
            binding.caseId,
            at.getTime(),
            stringField(payload, 'user_focus') ?? null,
            // First 500 chars of the synthesis is "what's the main
            // track" — exact enough for an admin listing without
            // having to parse markdown sections.
            synthesisText.slice(0, 500),
            // three_judgments is a v0.3 column — the synthesist's
            // template names "权衡判断" but parsing it out of free-form
            // markdown isn't worth the brittleness today.
            null,
          ],
        )
      } catch (err) {
        log.error('synthesis metadata insert failed (non-fatal)', {
          id: this.id,
          err,
        })
      }
    }
  }

  /**
   * v2.5 — Human-in-the-loop hook (interviewer only).
   *
   * Inspect the first LLM output for a `<NEED_INPUT>{...}</NEED_INPUT>`
   * marker. When present:
   *   1. Parse the JSON payload (must have a `questions` array of
   *      `{id, label, hint?, type, required?}` items, ≤3 entries).
   *   2. Resolve the asking admin id from `task.payload.asking_admin`
   *      (threaded by the workflow yaml via `$trigger.from`).
   *   3. Dispatch a question task at that admin via the reverse-
   *      dispatch surface; await the human's answers.
   *   4. Re-run the LLM with the original prompt + an appended
   *      "user previously answered: ..." block and a hard directive
   *      not to emit another NEED_INPUT this round.
   *
   * Returns the second-round LLM output on success, or `null` to
   * signal "fall back to the first-round output." A null return is
   * the right thing in every degradation case (no marker, malformed
   * marker, no dispatch surface, no admin to ask, human cancelled
   * the question) — the interviewer's first output already contains
   * its raw read of the user's 4-段; merging questions in is upside,
   * not a requirement for the workflow to finish.
   */
  private async maybeAskFollowUp(args: {
    task: Task
    firstOutput: unknown
  }): Promise<unknown | null> {
    const firstText = extractTextFromOutput(args.firstOutput)
    const need = parseNeedInputMarker(firstText)
    if (!need) return null

    log.info('interviewer requested follow-up input', {
      id: this.id,
      questionCount: need.questions.length,
    })

    const dispatch = this.services.dispatch
    if (!dispatch) {
      log.warn('NEED_INPUT detected but no dispatch surface available', {
        id: this.id,
      })
      return null
    }

    const askingAdmin = pickAskingAdmin(args.task)
    if (!askingAdmin) {
      log.warn('NEED_INPUT detected but no asking_admin in payload — cannot route question', {
        id: this.id,
      })
      return null
    }

    // Dispatch the human-question task. The shape carried in payload
    // is intentionally documented — packages/web/static/admin.js
    // detects `kind === 'agent-question'` to render the form.
    let result
    try {
      result = await dispatch.dispatch({
        strategy: { kind: 'explicit', to: askingAdmin },
        title: need.title ?? '访谈师想再问你几个问题',
        payload: {
          kind: 'agent-question',
          fromAgent: this.id,
          context: need.context ?? undefined,
          questions: need.questions,
        },
      })
    } catch (err) {
      log.error('NEED_INPUT dispatch threw — falling back to first-round output', {
        id: this.id,
        err,
      })
      return null
    }

    if (result.kind !== 'ok') {
      log.warn('NEED_INPUT not answered — falling back to first-round output', {
        id: this.id,
        resultKind: result.kind,
      })
      return null
    }

    const answers = extractAnswersFromHumanResult(result.output)
    if (!answers || Object.keys(answers).length === 0) {
      log.warn('NEED_INPUT answered with empty payload — falling back to first-round output', {
        id: this.id,
      })
      return null
    }

    // Synthesize a second-round prompt. Preserves the original
    // payload (so case_id, present_state, etc. still feed in) and
    // augments the prompt field with the Q&A block + a hard "no
    // more NEED_INPUT this round" directive. The 1-round budget is
    // enforced here, not by the LLM — even if it tries to emit
    // another marker we ignore the second output's marker and use
    // the text as-is.
    const qaBlock = renderQaBlock(need.questions, answers)
    const augmented2 = withAugmentedPrompt(args.task, qaBlock)
    let second: unknown
    try {
      second = await super.handleTask(augmented2)
    } catch (err) {
      log.error('second-round LLM call failed — falling back to first-round output', {
        id: this.id,
        err,
      })
      return null
    }

    log.info('interviewer second-round completed with human input', {
      id: this.id,
      answeredCount: Object.keys(answers).length,
    })
    return second
  }
}

// ────────────────────────────────────────────────────────────────────
// helpers
// ────────────────────────────────────────────────────────────────────

/**
 * Pull `case_id` from `task.payload.case_id`. Falls back to
 * `DEFAULT_CASE_ID` ('self') when missing or malformed — same UX as
 * v0.2 for the typical "you for yourself" single-user case.
 *
 * The payload shape can be string / object / undefined depending on
 * the workflow step. We only look inside the object form because the
 * personal-growth workflow's steps always pass object payloads (with
 * portrait / body / mind / etc fields).
 *
 * Logs and ignores malformed values rather than throwing — a bad
 * case_id would otherwise crash the whole workflow on the very first
 * step, blocking the user from anything else.
 */
function pickCaseId(task: Task): string {
  const payload = task.payload
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return DEFAULT_CASE_ID
  }
  const raw = (payload as Record<string, unknown>).case_id
  if (raw === undefined || raw === null) return DEFAULT_CASE_ID
  if (typeof raw !== 'string') {
    log.warn('case_id ignored: not a string', { type: typeof raw })
    return DEFAULT_CASE_ID
  }
  const trimmed = raw.trim()
  if (trimmed.length === 0) return DEFAULT_CASE_ID
  if (!CASE_ID_RE.test(trimmed)) {
    log.warn('case_id ignored: contains unsafe characters', { value: trimmed })
    return DEFAULT_CASE_ID
  }
  return trimmed
}

/**
 * Pull the capability the task was dispatched against. The runtime
 * `Task` carries a `strategy` discriminated union; for capability
 * dispatches it's `{kind:'capability', capabilities:[…]}`. We use the
 * first capability listed — workflows in practice declare exactly one.
 */
function pickCapability(task: Task): string | null {
  const strategy = task.strategy
  if (!strategy || typeof strategy !== 'object') return null
  const s = strategy as { kind?: string; capabilities?: unknown }
  if (s.kind !== 'capability') return null
  if (!Array.isArray(s.capabilities) || s.capabilities.length === 0) return null
  const first = s.capabilities[0]
  return typeof first === 'string' ? first : null
}

/**
 * Return a new Task whose payload's `prompt` field has the context
 * block prepended. Handles three payload shapes:
 *   - object with `prompt` string → prepend to that prompt
 *   - string → wrap as `{prompt: ctx + original}`
 *   - anything else → wrap as `{prompt: ctx + JSON.stringify(original)}`
 *
 * Returns a shallow-cloned Task; the original is not mutated (the
 * Hub shares Task references across listeners, mutation would race).
 */
function withAugmentedPrompt(task: Task, contextBlock: string): Task {
  const payload = task.payload
  const sep = '\n\n---\n\n'

  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const p = payload as Record<string, unknown>
    const originalPrompt = typeof p.prompt === 'string' ? p.prompt : ''
    const original = originalPrompt
      ? originalPrompt
      : JSON.stringify(p, null, 2)
    return {
      ...task,
      payload: {
        ...p,
        prompt: contextBlock + sep + original,
      },
    }
  }

  if (typeof payload === 'string') {
    return {
      ...task,
      payload: { prompt: contextBlock + sep + payload },
    }
  }

  return {
    ...task,
    payload: {
      prompt: contextBlock + sep + JSON.stringify(payload, null, 2),
    },
  }
}

/**
 * Read a string field from a heterogeneous payload object. Returns
 * `undefined` (not `''`) when missing so callers can `??` cleanly.
 *
 * Unwrapping rules, in order:
 *   - missing / null / empty → undefined
 *   - plain string → that string
 *   - `{ text: string, ... }` (LLM agent's TaskResult envelope:
 *     `{ text, stopReason, by, usage }`) → just the `.text` field.
 *     Workflow steps that pipe `$portrait.output` into the next
 *     step's payload deliver the whole envelope verbatim; without
 *     this unwrap the report would render the synthesist inputs as
 *     `{"text":"...","stopReason":"end_turn","by":"DeepSeek","usage":{...}}`
 *     instead of the actual coach text.
 *   - `{ content: string }` (defensive: future provider may use a
 *     different name; falls through to text/JSON if absent)
 *   - any other object → `JSON.stringify` fallback so a shape change
 *     surfaces visibly rather than silently dropping data
 *
 * Caught by scripts/test-fresh-space-e2e.mjs — the generated report
 * for steps 1-6 was JSON-wrapped envelopes, not the coach prose.
 */
function stringField(payload: Record<string, unknown>, key: string): string | undefined {
  const v = payload[key]
  if (v === undefined || v === null) return undefined
  if (typeof v === 'string') return v.length === 0 ? undefined : v
  if (typeof v === 'object' && !Array.isArray(v)) {
    const obj = v as Record<string, unknown>
    if (typeof obj.text === 'string' && obj.text.length > 0) return obj.text
    if (typeof obj.content === 'string' && obj.content.length > 0) return obj.content
  }
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

/**
 * ISO timestamp safe for use as a filename component on every
 * filesystem we care about. Replaces `:` and `.` with `-` and
 * truncates after the seconds digit: `2026-05-22T14-30-45`.
 */
function toFilenameStamp(at: Date): string {
  return at.toISOString().replace(/[:.]/g, '-').slice(0, 19)
}

// ────────────────────────────────────────────────────────────────────
// HITL helpers (v2.5)
// ────────────────────────────────────────────────────────────────────

export interface NeedInputQuestion {
  /** Field id — used both as the form key and as the answers key. */
  id: string
  /** Human-readable label shown above the input. */
  label: string
  /** Optional sub-label / placeholder explanation. */
  hint?: string
  /** Field shape; matches workflow `PayloadFieldSpec.type`. */
  type: 'text' | 'textarea' | 'number' | 'select'
  /** Rows hint for textarea. */
  rows?: number
  /** Whether the form should require this field. */
  required?: boolean
}

interface ParsedNeedInput {
  questions: NeedInputQuestion[]
  /** Optional title override for the human task. */
  title?: string
  /** Optional context paragraph the agent gives to the user. */
  context?: string
}

const NEED_INPUT_RE = /<NEED_INPUT>\s*(\{[\s\S]*?\})\s*<\/NEED_INPUT>/

/**
 * Parse the `<NEED_INPUT>{...}</NEED_INPUT>` marker out of an LLM
 * response. Returns `null` when no marker is present OR when the
 * payload is malformed — in either case the caller falls back to
 * the original (markerless) output. We're aggressively defensive
 * here because a botched marker would otherwise block the workflow
 * on a human task that doesn't ask anything coherent.
 *
 * Validation:
 *   - JSON parses
 *   - `questions` is a non-empty array, ≤ 3 entries (matches the
 *     interviewer prompt's hard cap; over-cap suggests the LLM is
 *     drifting and we should fall through)
 *   - each question has a non-empty `id` and `label`; `type` defaults
 *     to `textarea`
 *
 * Exported for unit tests.
 */
export function parseNeedInputMarker(text: string): ParsedNeedInput | null {
  const m = text.match(NEED_INPUT_RE)
  if (!m || !m[1]) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(m[1])
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const obj = parsed as Record<string, unknown>
  const rawQs = obj.questions
  if (!Array.isArray(rawQs) || rawQs.length === 0 || rawQs.length > 3) return null

  const questions: NeedInputQuestion[] = []
  for (const q of rawQs) {
    if (!q || typeof q !== 'object' || Array.isArray(q)) return null
    const qo = q as Record<string, unknown>
    const id = typeof qo.id === 'string' ? qo.id.trim() : ''
    const label = typeof qo.label === 'string' ? qo.label.trim() : ''
    if (!id || !label) return null
    const type = qo.type === 'text' || qo.type === 'number' || qo.type === 'select'
      ? qo.type
      : 'textarea'
    const question: NeedInputQuestion = { id, label, type }
    if (typeof qo.hint === 'string') question.hint = qo.hint
    if (typeof qo.rows === 'number' && Number.isFinite(qo.rows) && qo.rows > 0) {
      question.rows = Math.min(20, Math.floor(qo.rows))
    }
    if (qo.required === true) question.required = true
    questions.push(question)
  }

  const result: ParsedNeedInput = { questions }
  if (typeof obj.title === 'string' && obj.title.trim()) result.title = obj.title.trim()
  if (typeof obj.context === 'string' && obj.context.trim()) result.context = obj.context.trim()
  return result
}

/**
 * Pull the `asking_admin` ParticipantId from `task.payload`. Set by
 * the workflow yaml via `$trigger.from`. Returns null when the field
 * is missing or malformed — caller bails to non-HITL path.
 */
function pickAskingAdmin(task: Task): string | null {
  const payload = task.payload
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const raw = (payload as Record<string, unknown>).asking_admin
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  return trimmed
}

/**
 * Read the human's reply from the task output. Expected shape:
 *   { answers: { <questionId>: <stringValue>, ... } }
 * — the admin UI's submit handler stamps this format. Defensive:
 * if the admin sent something looser (e.g. just the answers object
 * at the top level), accept that too.
 */
function extractAnswersFromHumanResult(out: unknown): Record<string, string> | null {
  if (!out || typeof out !== 'object' || Array.isArray(out)) return null
  const obj = out as Record<string, unknown>
  const candidate = obj.answers && typeof obj.answers === 'object' && !Array.isArray(obj.answers)
    ? (obj.answers as Record<string, unknown>)
    : obj
  const answers: Record<string, string> = {}
  for (const [k, v] of Object.entries(candidate)) {
    if (typeof v === 'string') answers[k] = v
    else if (typeof v === 'number' || typeof v === 'boolean') answers[k] = String(v)
  }
  return Object.keys(answers).length > 0 ? answers : null
}

/**
 * Format the Q&A pairs as a markdown block we splice back into the
 * second-round LLM prompt. The final paragraph carries the hard
 * "no more NEED_INPUT this round" directive so we don't loop again
 * (even if the LLM tries we ignore output 2's marker).
 *
 * Exported for unit tests.
 */
export function renderQaBlock(
  questions: NeedInputQuestion[],
  answers: Record<string, string>,
): string {
  const lines: string[] = []
  lines.push('# 用户对你刚才提的补充问题给出了答复')
  lines.push('')
  for (const q of questions) {
    const a = answers[q.id]
    if (!a) continue
    lines.push(`**Q: ${q.label}**`)
    lines.push(a)
    lines.push('')
  }
  lines.push('---')
  lines.push('')
  lines.push('现在请直接产出最终画像（按你原来的系统提示词的输出格式 ' +
    '"## 我读到的你 / ## 你在意的 3 件事 / ## 你没明说但似乎重要的 / ' +
    '## 我想跟你聊到深一点的 5 件事 / ## 接下来 5 位教练会怎么看你"）。' +
    '**不要再输出 `<NEED_INPUT>` 标记** — 本轮只允许一次,后续如果还有疑问' +
    '请放在 "## 我想跟你聊到深一点的 5 件事" 里让用户下一次跑 v2 时回答。')
  return lines.join('\n')
}

/**
 * Render the 7-section consolidated report. Empty sections are
 * elided (no `## 2. 身体维度\n\n_(无)_`) so a partial run — e.g.
 * one where a dimension failed and the workflow continued — still
 * produces a readable artifact.
 */
function renderFullReport(args: {
  caseId: string
  at: Date
  focus: string | undefined
  portrait: string | undefined
  body: string | undefined
  mind: string | undefined
  goal: string | undefined
  resource: string | undefined
  social: string | undefined
  synthesis: string
}): string {
  const lines: string[] = []
  lines.push(`# 个人成长发展路径`)
  lines.push('')
  lines.push(`- caseId: \`${args.caseId}\``)
  lines.push(`- 生成时间: ${args.at.toISOString()}`)
  if (args.focus) lines.push(`- 这次特别想想清楚: ${args.focus}`)
  lines.push('')
  lines.push('---')
  lines.push('')

  const sections: Array<[string, string | undefined]> = [
    ['1. 访谈与画像', args.portrait],
    ['2. 身体维度', args.body],
    ['3. 心理维度', args.mind],
    ['4. 目标维度', args.goal],
    ['5. 资源维度', args.resource],
    ['6. 关系维度', args.social],
    ['7. 综合发展路径', args.synthesis],
  ]
  for (const [title, text] of sections) {
    if (!text) continue
    lines.push(`## ${title}`)
    lines.push('')
    lines.push(text.trim())
    lines.push('')
  }
  return lines.join('\n')
}

/**
 * Pull the textual answer out of whatever shape `parseResponse`
 * returned. `LlmTaskOutput.text` is the standard field; we fall
 * back to JSON.stringify for non-standard shapes so that *some*
 * representation lands in memory rather than silently dropping
 * the entry.
 */
function extractTextFromOutput(out: unknown): string {
  if (typeof out === 'string') return out
  if (out && typeof out === 'object') {
    const o = out as { text?: unknown }
    if (typeof o.text === 'string') return o.text
    try {
      return JSON.stringify(out)
    } catch {
      return '<unserializable agent output>'
    }
  }
  return String(out)
}
