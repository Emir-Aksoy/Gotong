/**
 * template-acceptance.ts — FDE-M2: golden-run acceptance for installed packs.
 *
 * A `gotong.template/v1` manifest may ship `acceptance[]` — golden cases
 * ("fire workflow X with these inputs; the output must contain 今日重点 and
 * must not contain 作为一个AI"). The web import route records them here (via
 * the injected sink, mirror of the M1b connector-slot sink); the admin
 * workflows page then offers 「跑验收」, which is what this service's `run()`
 * does. That answers FDE stage ④ (验收/试运行): "prove it runs on THEIR
 * cases", machine-checked instead of eyeballed.
 *
 * ── Same gate, not a new one ────────────────────────────────────────────────
 * A case fires through {@link evaluateRunnable} — the EXACT member gate behind
 * `/me` run, the butler's `run_my_workflow`, and the schedule sweeper. The
 * run executes as the CALLING admin (their userId is forced into the scope
 * key); acceptance can never do what the caller couldn't do by clicking
 * "run" themselves. Cases carry input fields only, never a member identity.
 *
 * ── Zero-LLM judging ────────────────────────────────────────────────────────
 * The verdict is `@gotong/evals`' `checkStructure` over the run's final
 * output text — substring/heading/length checks, no model in the loop. The
 * RUN itself may of course burn LLM tokens (it's a real run through real
 * agents); that is the point — golden cases certify the deployed thing, not
 * a mock of it.
 *
 * ── Waiting posture ─────────────────────────────────────────────────────────
 * Unlike every other dispatch path here (fire-and-forget), acceptance AWAITS
 * `hub.dispatch` — its promise resolves when the run finishes, which IS the
 * judging moment. A bounded race guards the wait: a case that outlives
 * `timeoutMs` reports red (`timeout`) while the underlying run keeps going
 * (visible in /me「最近运行」). Workflows with human/HITL steps will time out
 * by design — golden cases must run unattended; the timeout verdict says so.
 *
 * ── File posture (mirror of template-connector-slots.json) ─────────────────
 * `<space>/template-acceptance.json` stores INTENT only (the cases as
 * declared). Last-install-wins per pack; recording [] removes the pack;
 * corrupt file → warn + empty (advisory, never blocks installs); the next
 * record() rewrites it.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { createLogger } from '@gotong/core'
import { checkStructure, type StructureViolation } from '@gotong/evals/checkers/structure'

import {
  evaluateRunnable,
  type ButlerDispatchHub,
  type ButlerWorkflowSurface,
} from './personal-butler-workflows.js'

const log = createLogger('template-acceptance')

export const TEMPLATE_ACCEPTANCE_FILE = 'template-acceptance.json'

/** Default per-case wait — generous enough for a real LLM step chain. */
export const ACCEPTANCE_CASE_TIMEOUT_MS = 120_000

/** Mirror of the caller-side role default (see workflow-schedule-sweeper). */
const DEFAULT_ACCEPTANCE_ROLE = 'admin'

/** One golden case as recorded at install (mirrors the template block). */
export interface RecordedAcceptanceCase {
  id: string
  workflowId: string
  trigger: Record<string, unknown>
  assert: {
    sections?: string[]
    contains?: string[]
    forbid?: string[]
    maxBytes?: number
  }
  note?: string
}

/** One installed pack's recorded cases. */
export interface RecordedPackAcceptance {
  /** The template's `name` (install identity — last install wins). */
  pack: string
  installedAt: string
  cases: RecordedAcceptanceCase[]
}

/** One case's verdict on the green/red report. */
export interface AcceptanceCaseResult {
  caseId: string
  workflowId: string
  verdict: 'green' | 'red'
  /** Why a red is red (machine-readable; `message` is the human line). */
  reason?: 'unrunnable' | 'dispatch_failed' | 'timeout' | 'suspended' | 'assert_failed'
  message?: string
  /** Structure-checker violations when reason = assert_failed. */
  violations?: StructureViolation[]
  note?: string
  elapsedMs: number
}

export interface AcceptanceRunReport {
  pack: string
  /** The member identity the runs executed as (the caller). */
  ranBy: string
  results: AcceptanceCaseResult[]
  /** true iff every case is green. */
  allGreen: boolean
}

export interface TemplateAcceptanceService {
  /** Record (or replace) one pack's cases. [] removes the entry. */
  record(pack: string, cases: readonly RecordedAcceptanceCase[]): Promise<void>
  /** All recorded packs. Missing/corrupt file → []. */
  list(): Promise<readonly RecordedPackAcceptance[]>
  /**
   * Run one pack's cases (or a single case) as `userId`, sequentially —
   * parallel golden runs on one hub would contend for the same agents and
   * muddy timing. Unknown pack/caseId throws (route maps to 404).
   */
  run(pack: string, opts: { userId: string; caseId?: string }): Promise<AcceptanceRunReport>
}

export function createTemplateAcceptanceService(opts: {
  spaceDir: string
  workflows: ButlerWorkflowSurface
  hub: ButlerDispatchHub
  /** Role the member gate resolves with; defaults to `admin` (the caller). */
  role?: string
  /** Per-case wait cap; defaults to {@link ACCEPTANCE_CASE_TIMEOUT_MS}. */
  timeoutMs?: number
  /** Injected for tests; defaults to wall clock. */
  now?: () => number
}): TemplateAcceptanceService {
  const file = join(opts.spaceDir, TEMPLATE_ACCEPTANCE_FILE)
  const now = opts.now ?? Date.now
  const role = opts.role ?? DEFAULT_ACCEPTANCE_ROLE
  const timeoutMs = opts.timeoutMs ?? ACCEPTANCE_CASE_TIMEOUT_MS

  async function load(): Promise<RecordedPackAcceptance[]> {
    let raw: string
    try {
      raw = await readFile(file, 'utf8')
    } catch {
      return [] // never installed a pack with cases — free no-op
    }
    let doc: unknown
    try {
      doc = JSON.parse(raw)
    } catch (err) {
      log.warn('acceptance registry unreadable — treating as empty', {
        file,
        err: err instanceof Error ? err.message : String(err),
      })
      return []
    }
    const packs = (doc as { packs?: unknown })?.packs
    if (!Array.isArray(packs)) {
      log.warn('acceptance registry has no packs[] — treating as empty', { file })
      return []
    }
    const out: RecordedPackAcceptance[] = []
    for (const entry of packs) {
      const parsed = parsePack(entry)
      if (parsed) out.push(parsed)
      else log.warn('skipping malformed acceptance pack entry', { file })
    }
    return out
  }

  async function runCase(c: RecordedAcceptanceCase, userId: string): Promise<AcceptanceCaseResult> {
    const started = now()
    const base = {
      caseId: c.id,
      workflowId: c.workflowId,
      ...(c.note !== undefined ? { note: c.note } : {}),
    }
    const done = (
      verdict: 'green' | 'red',
      extra?: Partial<AcceptanceCaseResult>,
    ): AcceptanceCaseResult => ({
      ...base,
      verdict,
      ...extra,
      elapsedMs: now() - started,
    })

    // 1. The same member gate as /me · butler · sweeper — fail closed on a
    //    catalog read error (deny beats running on incomplete info).
    let summaries
    try {
      summaries = await opts.workflows.list()
    } catch (err) {
      return done('red', {
        reason: 'unrunnable',
        message: `workflow catalog unavailable: ${err instanceof Error ? err.message : String(err)}`,
      })
    }
    const summary = summaries.find((s) => s.id === c.workflowId)
    const runnable = summary ? evaluateRunnable(summary, role) : null
    if (!runnable) {
      return done('red', {
        reason: 'unrunnable',
        message: `workflow '${c.workflowId}' is not runnable for role '${role}' (missing, unpublished, or not member-facing)`,
      })
    }

    // 2. Declared-fields-only payload + the one security invariant: the scope
    //    key is forced to the caller — a case can't run as someone else.
    const payload: Record<string, unknown> = {}
    for (const field of runnable.inputFieldIds) {
      if (field in c.trigger) payload[field] = c.trigger[field]
    }
    payload[runnable.userScopeField] = userId

    // 3. Await the dispatch (its promise resolves when the run finishes),
    //    bounded by the timeout race. On timeout the run itself keeps going.
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<{ kind: 'acceptance_timeout' }>((resolve) => {
      timer = setTimeout(() => resolve({ kind: 'acceptance_timeout' }), timeoutMs)
    })
    let result: unknown
    try {
      result = await Promise.race([
        opts.hub.dispatch({
          from: userId,
          origin: { orgId: 'local', userId },
          strategy: { kind: 'capability', capabilities: [runnable.capability] },
          payload,
          title: `验收 ${c.id} — ${runnable.label}`,
        }),
        timeout,
      ])
    } catch (err) {
      return done('red', {
        reason: 'dispatch_failed',
        message: err instanceof Error ? err.message : String(err),
      })
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }

    const r = result as { kind?: string; output?: unknown; error?: string; reason?: string }
    if (r?.kind === 'acceptance_timeout') {
      return done('red', {
        reason: 'timeout',
        message: `case exceeded ${timeoutMs}ms — the run continues in the background (see /me 最近运行)`,
      })
    }
    if (r?.kind === 'suspended') {
      return done('red', {
        reason: 'suspended',
        message:
          'run suspended (workflow has a human/HITL step) — golden cases must run unattended',
      })
    }
    if (r?.kind !== 'ok') {
      return done('red', {
        reason: 'dispatch_failed',
        message: r?.error ?? r?.reason ?? `run ended with kind '${String(r?.kind)}'`,
      })
    }

    // 4. Zero-LLM judging over the extracted output text.
    const check = checkStructure(extractText(r.output), {
      requiredSections: c.assert.sections ?? [],
      ...(c.assert.contains ? { requiredPhrases: c.assert.contains } : {}),
      ...(c.assert.forbid ? { forbiddenPhrases: c.assert.forbid } : {}),
      ...(c.assert.maxBytes !== undefined ? { maxBytes: c.assert.maxBytes } : {}),
    })
    if (!check.ok) {
      return done('red', {
        reason: 'assert_failed',
        message: `${check.violations.length} assertion(s) failed`,
        violations: check.violations,
      })
    }
    return done('green')
  }

  return {
    async record(pack, cases) {
      const trimmed = pack.trim()
      if (trimmed.length === 0) return // no identity to record under
      const rows = await load()
      const rest = rows.filter((r) => r.pack !== trimmed)
      if (cases.length > 0) {
        rest.push({
          pack: trimmed,
          installedAt: new Date(now()).toISOString(),
          cases: cases.map((c) => ({
            id: c.id,
            workflowId: c.workflowId,
            trigger: c.trigger,
            assert: c.assert,
            ...(c.note !== undefined ? { note: c.note } : {}),
          })),
        })
      }
      await writeFile(file, JSON.stringify({ packs: rest }, null, 2) + '\n', 'utf8')
    },
    list: load,
    async run(pack, runOpts) {
      const rows = await load()
      const entry = rows.find((r) => r.pack === pack)
      if (!entry) throw new AcceptanceNotFoundError(`no acceptance cases recorded for pack '${pack}'`)
      let cases = entry.cases
      if (runOpts.caseId !== undefined) {
        cases = cases.filter((c) => c.id === runOpts.caseId)
        if (cases.length === 0) {
          throw new AcceptanceNotFoundError(
            `pack '${pack}' has no acceptance case '${runOpts.caseId}'`,
          )
        }
      }
      const results: AcceptanceCaseResult[] = []
      for (const c of cases) results.push(await runCase(c, runOpts.userId))
      return {
        pack,
        ranBy: runOpts.userId,
        results,
        allGreen: results.every((r) => r.verdict === 'green'),
      }
    },
  }
}

/** Thrown by run() for unknown pack/case — the route maps it to 404. */
export class AcceptanceNotFoundError extends Error {
  readonly code = 'acceptance_not_found'
}

/**
 * Deterministic output-text extraction (documented, no heuristics beyond
 * these three rules):
 *   1. a string is itself;
 *   2. an object with a string `.text` is that text (`LlmTaskOutput` shape);
 *   3. an object with exactly ONE key recurses into its value (the
 *      `output: {brief: $step.output}` single-key idiom);
 *   otherwise JSON.stringify — the checkers still scan the serialized form.
 */
export function extractText(output: unknown): string {
  if (typeof output === 'string') return output
  if (output && typeof output === 'object' && !Array.isArray(output)) {
    const o = output as Record<string, unknown>
    if (typeof o.text === 'string') return o.text
    const keys = Object.keys(o)
    if (keys.length === 1) return extractText(o[keys[0]!])
  }
  if (output === undefined) return ''
  try {
    return JSON.stringify(output) ?? ''
  } catch {
    return String(output)
  }
}

/** Validate one persisted pack entry; null (skip) on any shape violation. */
function parsePack(entry: unknown): RecordedPackAcceptance | null {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
  const e = entry as Record<string, unknown>
  if (typeof e.pack !== 'string' || e.pack.length === 0) return null
  if (!Array.isArray(e.cases)) return null
  const cases: RecordedAcceptanceCase[] = []
  for (const c of e.cases) {
    if (!c || typeof c !== 'object' || Array.isArray(c)) return null
    const s = c as Record<string, unknown>
    if (typeof s.id !== 'string' || s.id.length === 0) return null
    if (typeof s.workflowId !== 'string' || s.workflowId.length === 0) return null
    const trigger =
      s.trigger && typeof s.trigger === 'object' && !Array.isArray(s.trigger)
        ? (s.trigger as Record<string, unknown>)
        : {}
    const assertRaw =
      s.assert && typeof s.assert === 'object' && !Array.isArray(s.assert)
        ? (s.assert as Record<string, unknown>)
        : null
    if (!assertRaw) return null
    const assert: RecordedAcceptanceCase['assert'] = {}
    for (const key of ['sections', 'contains', 'forbid'] as const) {
      const v = assertRaw[key]
      if (v === undefined) continue
      if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) return null
      if (v.length > 0) assert[key] = v as string[]
    }
    if (assertRaw.maxBytes !== undefined) {
      if (typeof assertRaw.maxBytes !== 'number') return null
      assert.maxBytes = assertRaw.maxBytes
    }
    const rc: RecordedAcceptanceCase = { id: s.id, workflowId: s.workflowId, trigger, assert }
    if (typeof s.note === 'string' && s.note.length > 0) rc.note = s.note
    cases.push(rc)
  }
  return {
    pack: e.pack,
    installedAt: typeof e.installedAt === 'string' ? e.installedAt : '',
    cases,
  }
}
