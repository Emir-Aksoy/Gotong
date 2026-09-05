/** Personal procedure versions and sandbox evidence, stored in the existing memory entry.
 * Only trusted host code may call approveTests; it is deliberately not a memory tool.
 * Versions/suites are append-only snapshots. Publication is a separate reversible pointer.
 */
import { createHash, randomUUID } from 'node:crypto'
import type { MemoryEntry, MemoryHandle } from '@gotong/services-sdk'
import { PersonalMemoryError } from './errors.js'
import { cleanSteps, isProcedure, stepsOf } from './procedure.js'
import type { MemoryLinkLookup } from './toolset.js'

export const SKILL_LIMITS = { versions: 16, suites: 8, evidence: 16, stateBytes: 512 * 1024 } as const
// File handles can be reopened by multiple services. Serialize by durable skill id,
// not service object identity; no user data or authorization travels through this map.
const pending = new Map<string, Promise<unknown>>()

export interface SkillDraft {
  name: string
  steps: readonly string[]
  sources: readonly string[]
  conditions: readonly string[]
  counterexamples: readonly string[]
}
export interface SkillVersion extends SkillDraft { id: string; fingerprint: string }
export interface SkillTestCase { input: string; expected: string }
interface SkillTestSuite { id: string; fingerprint: string; approvedBy: string; cases: SkillTestCase[] }
export type SkillRunner = (input: {
  input: string; steps: readonly string[]; conditions: readonly string[]; counterexamples: readonly string[]
}) => Promise<{ output: string; model: string }>
export interface SkillEvidence {
  id: string
  version: string
  fingerprint: string
  suite: string
  suiteFingerprint: string
  baseline: string | null
  baselineFingerprint: string | null
  model: string
  status: 'passed' | 'failed'
  scope: 'sandbox-output-only'
  results: Array<{ baselineOutput: string; candidateOutput: string; baselinePassed: boolean; candidatePassed: boolean }>
  error?: string
}
export interface SkillState {
  versions: SkillVersion[]
  suites: SkillTestSuite[]
  evidence: SkillEvidence[]
  /** Each publication locks the exact evidence and suite, not a mutable status. */
  publications: Array<{ version: string; evidence: string }>
}

function fail(message: string): never { throw new PersonalMemoryError('skill_invalid', message) }
function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }
function body(v: SkillDraft): SkillDraft {
  return { name: v.name, steps: [...v.steps], sources: [...v.sources], conditions: [...v.conditions], counterexamples: [...v.counterexamples] }
}
function version(draft: SkillDraft): SkillVersion {
  if (typeof draft.name !== 'string' || !draft.name.trim() || draft.name.length > 200
    || !strings(draft.steps, 32, 1000) || !draft.steps.length
    || !strings(draft.sources, 200, 200) || !draft.sources.length
    || !strings(draft.conditions, 16, 1000) || !strings(draft.counterexamples, 16, 1000)) fail('Skill content limit or shape is invalid.')
  const content = body(draft)
  return { ...content, id: randomUUID(), fingerprint: hash(content) }
}
export function candidateSkillMeta(draft: SkillDraft): Record<string, unknown> {
  return { form: 'procedure', steps: [...draft.steps], skill: {
    versions: [version(draft)], suites: [], evidence: [], publications: [],
  } satisfies SkillState }
}
export function skillState(e: MemoryEntry): SkillState | null {
  const s = e.meta?.skill as SkillState | undefined
  if (!s || !Array.isArray(s.versions) || !s.versions.length || !Array.isArray(s.suites)
    || !Array.isArray(s.evidence) || !Array.isArray(s.publications)) return null
  try {
    if (s.versions.length > SKILL_LIMITS.versions || s.suites.length > SKILL_LIMITS.suites
      || s.evidence.length > SKILL_LIMITS.evidence || s.publications.length > SKILL_LIMITS.evidence
      || !s.versions.every((v) => v && typeof v.id === 'string' && typeof v.fingerprint === 'string')
      || !s.suites.every((t) => t && typeof t.id === 'string' && typeof t.approvedBy === 'string'
        && typeof t.fingerprint === 'string' && Array.isArray(t.cases))
      || !s.evidence.every((r) => r && typeof r.id === 'string' && typeof r.version === 'string'
        && typeof r.model === 'string' && Array.isArray(r.results)
        && r.results.every((c) => c && typeof c.baselineOutput === 'string' && typeof c.candidateOutput === 'string'))
      || !s.publications.every((p) => p && typeof p.version === 'string' && typeof p.evidence === 'string')) return null
    return structuredClone(s)
  } catch { return null }
}
function strings(raw: unknown, count: number, length: number): raw is string[] {
  return Array.isArray(raw) && raw.length <= count && raw.every((s) => typeof s === 'string' && s.trim().length > 0 && s.length <= length)
}
function intact(e: MemoryEntry, s: SkillState): boolean {
  try {
    return s.versions.every((v) => v.fingerprint === hash(body(v)))
      && hash(stepsOf(e)) === hash(s.versions.at(-1)!.steps)
      && e.text === s.versions.at(-1)!.name
  } catch { return false }
}
function passing(s: SkillState, v: SkillVersion, evidenceId?: string): SkillEvidence | undefined {
  const evidence = s.evidence.filter((e) => e.version === v.id && (!evidenceId || e.id === evidenceId)).at(-1)
  const suite = s.suites.find((t) => t.id === evidence?.suite)
  if (!evidence || !suite || evidence.status !== 'passed' || !evidence.model
    || evidence.scope !== 'sandbox-output-only' || evidence.fingerprint !== v.fingerprint
    || evidence.suiteFingerprint !== suite.fingerprint || suite.fingerprint !== hash(suite.cases)
    || !suite.approvedBy || !suite.cases.length || evidence.results.length !== suite.cases.length
    || !evidence.results.every((r, i) => typeof suite.cases[i]?.expected === 'string'
      && r.candidateOutput === suite.cases[i]!.expected && r.candidateOutput.trim().length > 0
      && r.baselineOutput.trim().length > 0)) return undefined
  return evidence
}
export function skillStatus(e: MemoryEntry): 'unverified' | 'untested' | 'failed' | 'passed' {
  const s = skillState(e)
  if (!s) return 'unverified'
  if (!intact(e, s)) return 'untested'
  const v = s.versions.at(-1)!
  if (passing(s, v)?.suite === s.suites.at(-1)?.id && s.suites.length) return 'passed'
  return s.evidence.filter((r) => r.version === v.id && r.suite === s.suites.at(-1)?.id).at(-1)?.status === 'failed'
    ? 'failed' : 'untested'
}
/** The only projection allowed to supply published steps to a prompt. */
export function publishedProcedure(e: MemoryEntry): MemoryEntry | null {
  const s = skillState(e)
  if (!s || !intact(e, s)) return null
  const publication = s.publications.at(-1)
  const v = s.versions.find((v) => v.id === publication?.version)
  if (!v || !publication || !passing(s, v, publication.evidence)) return null
  return { ...e, text: v.name, meta: { ...e.meta, steps: v.steps, conditions: v.conditions,
    counterexamples: v.counterexamples, publishedVersion: v.id, publishedEvidence: publication.evidence } }
}
export function parseSkillTests(raw: unknown): SkillTestCase[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 8) fail('Provide 1-8 user-approved held-out cases.')
  return raw.map((c: unknown) => {
    if (!c || typeof c !== 'object') fail('Invalid test case.')
    const r = c as Record<string, unknown>
    if (Object.keys(r).some((k) => k !== 'input' && k !== 'expected') || typeof r.input !== 'string'
      || !r.input.trim() || r.input.length > 4000 || typeof r.expected !== 'string' || r.expected.length > 4000) fail('Each test needs input and explicit expected (max 4000 chars).')
    return { input: r.input, expected: r.expected }
  })
}

export class VerifiedSkills {
  constructor(private readonly opts: { memory: MemoryHandle; runner?: SkillRunner; userId?: string; lookup?: MemoryLinkLookup }) {}
  get userId(): string | undefined { return this.opts.userId }

  private serial<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const next = (pending.get(id) ?? Promise.resolve()).then(fn, fn)
    const tail = next.catch(() => {})
    pending.set(id, tail)
    void tail.then(() => { if (pending.get(id) === tail) pending.delete(id) })
    return next
  }
  async get(id: string): Promise<MemoryEntry> {
    // File backend caps list at 500. Production injects its existing per-user
    // full-store by-id index; other backends fail honestly, never widen scope.
    const entries = this.opts.lookup ? await this.opts.lookup([id]) : await this.opts.memory.list({ kind: 'semantic', limit: 500 })
    const e = entries.find((e) => e.id === id)
    if (!e || !isProcedure(e)) fail('Personal procedure not found.')
    return e
  }
  private async save(e: MemoryEntry, s: SkillState): Promise<void> {
    if (Buffer.byteLength(JSON.stringify(s)) > SKILL_LIMITS.stateBytes) fail('Skill state byte limit reached; history was not discarded.')
    if (!this.opts.memory.patchMeta || !await this.opts.memory.patchMeta(e.id, { skill: s, steps: s.versions.at(-1)!.steps })) fail('Procedure metadata could not be saved.')
  }
  private state(e: MemoryEntry): SkillState {
    const s = skillState(e)
    if (!s) fail('Legacy skill is unverified; refine it into a candidate first.')
    if (!intact(e, s)) fail('Procedure fingerprint mismatch; verification is invalid.')
    return s
  }
  private async checkSources(sources: readonly string[]): Promise<void> {
    const entries = this.opts.lookup ? await this.opts.lookup(sources) : await this.opts.memory.list({ limit: 500 })
    if (!sources.length || sources.some((id) => !entries.some((e) => e.id === id))) fail('Every source must reference an entry in this personal memory.')
  }
  async create(draft: SkillDraft, extraMeta: Record<string, unknown> = {}): Promise<MemoryEntry> {
    if (!draft.name.trim() || !cleanSteps(draft.steps).length) fail('Name and steps are required.')
    await this.checkSources(draft.sources)
    if (!cleanSteps(draft.conditions).length || !cleanSteps(draft.counterexamples).length) fail('Conditions and counterexamples are required.')
    return this.opts.memory.remember({ kind: 'semantic', text: draft.name.trim(), meta: {
      ...extraMeta, ...candidateSkillMeta({ ...draft, name: draft.name.trim(), steps: cleanSteps(draft.steps) }),
    } })
  }
  async revise(id: string, steps: readonly string[], provenance?: Pick<SkillDraft, 'sources' | 'conditions' | 'counterexamples'>, append = false): Promise<void> {
    return this.serial(id, async () => {
      const e = await this.get(id)
      const s = skillState(e) ?? { versions: [version({ name: e.text, steps: stepsOf(e), sources: [id], conditions: [], counterexamples: [] })], suites: [], evidence: [], publications: [] }
      if (!intact(e, s)) fail('Procedure fingerprint mismatch.')
      if (s.versions.length >= SKILL_LIMITS.versions) fail('Skill version limit reached; history was not discarded.')
      if (!cleanSteps(steps).length) fail('Steps are required.')
      const v = version({ ...s.versions.at(-1)!, ...provenance,
        steps: append ? [...s.versions.at(-1)!.steps, ...cleanSteps(steps)] : cleanSteps(steps) })
      await this.checkSources(v.sources)
      s.versions.push(v)
      await this.save(e, s)
    })
  }
  /** Trusted host capability: ONLY execute after the owner approved these exact cases.
   * Do not expose this method through a benign tool, HTTP body flag, or model verdict.
   */
  async approveTests(id: string, raw: unknown): Promise<string> {
    return this.serial(id, async () => {
      const approvedBy = this.opts.userId
      if (!approvedBy?.trim()) fail('A trusted owner identity is required for user approval.')
      const cases = parseSkillTests(raw)
      const e = await this.get(id)
      const s = this.state(e)
      if (s.suites.length >= SKILL_LIMITS.suites) fail('Skill suite limit reached; history was not discarded.')
      const suite = { id: randomUUID(), fingerprint: hash(cases), approvedBy, cases }
      s.suites.push(suite)
      await this.save(e, s)
      return suite.id
    })
  }
  async verify(id: string): Promise<SkillEvidence> {
    return this.serial(id, async () => {
      const e = await this.get(id)
      const s = this.state(e)
      if (s.evidence.length >= SKILL_LIMITS.evidence) fail('Skill evidence limit reached; history was not discarded.')
      const v = s.versions.at(-1)!
      const suite = s.suites.at(-1)
      if (!suite) fail('User-approved held-out tests are required.')
      if (!this.opts.runner) fail('No sandbox evaluation runner is available.')
      if (!v.conditions.length || !v.counterexamples.length) fail('Add conditions and counterexamples before verification.')
      await this.checkSources(v.sources)
      const baseline = s.versions.find((v) => v.id === s.publications.at(-1)?.version)
      if (s.publications.length && !publishedProcedure(e)) fail('Published baseline evidence is invalid; refusing to fall back to an empty baseline.')
      const result: SkillEvidence = { id: randomUUID(), version: v.id, fingerprint: v.fingerprint, suite: suite.id,
        suiteFingerprint: suite.fingerprint, baseline: baseline?.id ?? null,
        baselineFingerprint: baseline?.fingerprint ?? null, model: '', status: 'failed',
        scope: 'sandbox-output-only', results: [] }
      try {
        for (const c of suite.cases) {
          // Expected never reaches the executor; both arms get the exact same task.
          const b = await this.opts.runner({ input: c.input, steps: baseline?.steps ?? [], conditions: baseline?.conditions ?? [], counterexamples: baseline?.counterexamples ?? [] })
          const a = await this.opts.runner({ input: c.input, steps: [...v.steps], conditions: [...v.conditions], counterexamples: [...v.counterexamples] })
          if (!a || !b || typeof a.output !== 'string' || !a.output.trim() || a.output.length > 16_000
            || typeof b.output !== 'string' || !b.output.trim() || b.output.length > 16_000) fail('Empty or invalid runner output.')
          if (!a.model || a.model !== b.model || (result.model && a.model !== result.model)) fail('Evaluation model identity changed between arms/cases.')
          result.model = a.model
          result.results.push({ baselineOutput: b.output, candidateOutput: a.output,
            baselinePassed: b.output === c.expected, candidatePassed: a.output === c.expected })
        }
        result.status = result.results.every((r) => r.candidatePassed) ? 'passed' : 'failed'
      } catch { result.error = 'Sandbox execution failed or model identity changed; no pass recorded.' }
      // A different writer may have changed metadata while the model was running.
      if (hash((await this.get(id)).meta?.skill) !== hash(e.meta?.skill)
        || hash(stepsOf(await this.get(id))) !== hash(stepsOf(e))) fail('Procedure changed during evaluation; retry.')
      s.evidence.push(result)
      await this.save(e, s)
      return result
    })
  }
  async publish(id: string): Promise<void> {
    return this.serial(id, async () => {
      const e = await this.get(id)
      const s = this.state(e)
      const v = s.versions.at(-1)!
      const evidence = passing(s, v)
      if (!evidence || skillStatus(e) !== 'passed') fail('Only a passed version can be published.')
      if ((s.publications.at(-1)?.version ?? null) !== evidence.baseline && s.publications.at(-1)?.version !== v.id) fail('Published baseline changed; verify again.')
      if (s.publications.at(-1)?.evidence !== evidence.id) {
        if (s.publications.length >= SKILL_LIMITS.evidence) fail('Skill publication limit reached; history was not discarded.')
        s.publications.push({ version: v.id, evidence: evidence.id })
      }
      await this.save(e, s)
    })
  }
  async rollback(id: string): Promise<void> {
    return this.serial(id, async () => {
      const e = await this.get(id)
      const s = this.state(e)
      let previousIndex = s.publications.length - 2
      while (previousIndex >= 0 && s.publications[previousIndex]!.version === s.publications.at(-1)?.version) previousIndex--
      const publication = s.publications[previousIndex]
      const previous = s.versions.find((v) => v.id === publication?.version)
      if (!previous || !publication || !passing(s, previous, publication.evidence)) fail('No previous passed publication to roll back to.')
      s.publications = s.publications.slice(0, previousIndex + 1)
      await this.save(e, s)
    })
  }
}
