/**
 * Deterministic GATE participants for family-learning-hub — the production-correct
 * core. Every cross-boundary decision the framework makes about a child's lesson is a
 * DETERMINISTIC participant returning STRUCTURED output, never an LLM. This module is
 * shared by the hermetic demo (`index.ts`) AND real mode (`index.real.ts`): in real
 * mode only the TUTOR is swapped for an LlmAgent; these gates stay deterministic.
 *
 * ★ Why the topic screen MUST be a deterministic participant, not the LLM tutor ★
 *
 * The 家长-hub `tutor-teach` workflow gates parent approval on a predicate:
 *     guardian-approval.when = "$screen.output.allowed == false"
 * If `topic.screen` were served by the LLM tutor it would return free text `{text}`
 * with NO `allowed` field. Trace the real evaluator (packages/workflow/src/predicate.ts):
 *   - `$screen.output.allowed` → lookupRef throws "cannot read" → caught → `undefined`;
 *   - `strictEqual(undefined, false)` → different types → `false`;
 *   - the approval step's `when` is false → the step is SILENTLY SKIPPED → an
 *     off-whitelist topic reaches the tutor with ZERO parent approval.
 * That is a fail-OPEN safety hole: the whitelist gate quietly does nothing. The fix is
 * the design intent (FAMILY-LEARNING-HUB-DESIGN.md §七 "确定性查表"): a deterministic
 * checker returns a real boolean the predicate can read — AND can't be prompt-injected
 * into `allowed: true`. The FL-M1 demo's TopicWhitelistGate already proved this logic;
 * here it becomes a first-class participant the real workflow dispatches to.
 *
 * Capabilities (production model — the 家长 runs the `tutor-teach` WORKFLOW):
 *   topic.screen       (家长 hub) deterministic whitelist          → {allowed, reason}
 *   teach.lesson       (家长 hub) the /teach tutor — LLM in real mode, stand-in here
 *   content.moderate   (家长 hub) deterministic OPTIONAL rule engine → {flagged, reasons}
 *   records.append     (孩子 hub) write the learning-records MASTER copy
 *   report.to-guardian (家长 hub) receive the forked oversight copy
 * The cross-hub capability the child calls — `tutor.teach` — is the 家长 workflow's
 * TRIGGER, served by the WorkflowController, not by any participant here.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { AgentParticipant, type Task } from '@aipehub/core'

import {
  planTeach,
  type TeachCitation,
  type TeachGlossaryTerm,
  type TeachInsight,
  type TeachQuiz,
} from './teach.js'

// --- shapes flowing between the steps --------------------------------------------

/**
 * One lesson the tutor produced — the `teach.lesson` output. The first six fields are the
 * original contract (still what every consumer + the safety gate read). The rest are the
 * `/teach` methodology fields (see teach.ts): they are OPTIONAL on the type so a consumer or
 * test that only needs the safety surface (e.g. a moderation input) can construct a `Lesson`
 * without them, but the real tutor (deterministic stand-in AND the LLM via `coerceLesson`)
 * ALWAYS populates them — an actual lesson is always a complete `/teach` lesson.
 */
export interface Lesson {
  learnerId: string
  topic: string
  /** The /teach "where is the learner" clock — advances by one each invocation. */
  lessonNo: number
  title: string
  body: string
  /** 决策 1.a — the tutor SELF-FLAGS content a 家长 may want to review (layer 1). */
  flagged: boolean
  flagReason?: string

  // --- /teach methodology (always set by a real lesson; optional for terse consumers) ---
  /** True when this lesson established the mission (first lesson, no MISSION.md yet). */
  missionEstablished?: boolean
  /** The reason-to-learn this lesson serves — grounds everything (/teach MISSION). */
  missionWhy?: string
  /** Where the learner is → what this advances to (/teach Zone of Proximal Development). */
  zpd?: string
  /** The ONE tightly-scoped concept (knowledge) — difficulty is the enemy here. */
  concept?: string
  /** Citation(s) for the concept — cite a primary source every lesson. */
  citations?: TeachCitation[]
  /** The retrieval-practice exercise (skill) — difficulty is the TOOL here. */
  practice?: string
  /** Equal-length-option quiz with instant feedback. */
  quiz?: TeachQuiz
  /** The recommended high-trust source to go deeper (/teach RESOURCES). */
  primarySource?: string
  /** Canonical terms this lesson introduced. */
  glossary?: TeachGlossaryTerm[]
  /** ADR-grade insight captured when the learner showed evidence of understanding. */
  insight?: TeachInsight
  /** Reminder to come back / ask the tutor — spacing. */
  followUp?: string
}

/** A learning-records entry — the `records.append` output (the MASTER copy on 孩子 hub). */
export interface LearningRecord {
  learnerId: string
  topic: string
  lessonNo: number
  /** Absolute path of the master record file on the 孩子 hub's disk. */
  recordPath: string
  totalRecords: number
  note: string
}

/** The `topic.screen` output — a real boolean the workflow predicate can read. */
export interface ScreenResult {
  topic: string
  allowed: boolean
  reason: string
}

/** The `content.moderate` output — the optional rule-engine layer's verdict (layer 2). */
export interface ModerationResult {
  flagged: boolean
  reasons: string[]
}

/**
 * One 家长-configured moderation rule. `pattern` is matched case-insensitively as a
 * plain substring of the lesson text — deterministic, auditable, no regex surprises.
 * The 家长 owns this list; an EMPTY list means the rule-engine layer is OFF (opt-out).
 */
export interface ModerationRule {
  id: string
  pattern: string
  label: string
}

function capOf(task: Task): string | undefined {
  return task.strategy?.kind === 'capability' ? task.strategy.capabilities?.[0] : undefined
}

// --- 家长's policy (defaults; both are 家长-editable per-link config) ----------------

/**
 * The 家长's topic whitelist (keywords). A topic is on-whitelist if it CONTAINS any
 * keyword (so "数学" clears "数学应用题"). Conservative by construction: a non-match
 * only triggers parent approval (safe), never silent teaching.
 */
export const DEFAULT_TOPIC_WHITELIST: readonly string[] = [
  '分数运算',
  '数学',
  '英语阅读',
  '科学常识',
  '编程基础',
  '自然拼读',
]

/**
 * Illustrative default moderation rules — real child-safety concerns a 家长 might
 * screen lesson CONTENT for, distinct from the topic whitelist. These are samples;
 * the 家长 edits the list. Pass `[]` to turn the whole rule-engine layer off.
 */
export const DEFAULT_MODERATION_RULES: readonly ModerationRule[] = [
  { id: 'game-cheat', pattern: '外挂', label: '游戏作弊/外挂' },
  { id: 'pay-pressure', pattern: '充值', label: '诱导充值消费' },
  { id: 'stranger-contact', pattern: '私聊', label: '诱导私下联系陌生人' },
]

// --- 家长 hub: deterministic topic screen (★ the fail-open fix) ---------------------

/**
 * Serves `topic.screen`. Returns a REAL `{allowed, reason}` so the 家长-approval
 * predicate `$screen.output.allowed == false` evaluates correctly — never the LLM.
 */
export class TopicScreenParticipant extends AgentParticipant {
  constructor(private readonly whitelist: readonly string[] = DEFAULT_TOPIC_WHITELIST) {
    super({ id: 'topic-screen', capabilities: ['topic.screen'] })
  }

  protected async handleTask(task: Task): Promise<ScreenResult> {
    const topic = String((task.payload as { topic?: string } | undefined)?.topic ?? '').trim()
    const hit = topic ? this.whitelist.find((w) => topic.includes(w)) : undefined
    if (hit !== undefined) {
      return { topic, allowed: true, reason: `主题「${topic}」命中白名单关键词「${hit}」, 可直接上课` }
    }
    return { topic, allowed: false, reason: `主题「${topic || '(未填)'}」不在白名单, 需家长批准` }
  }
}

// --- 家长 hub: OPTIONAL deterministic content moderation (layer 2) ------------------

/**
 * Serves `content.moderate`. Scans the tutor's lesson against the 家长's rule list and
 * returns `{flagged, reasons}`. This is the OPTIONAL second layer on top of the tutor's
 * own self-flag (layer 1, decision 1.a): an empty rule list means it NEVER flags
 * (opt-out); a populated list opts the 家长 into deterministic pre-screening of lesson
 * content before it reaches the child. Both layers feed ONE approval gate (the
 * workflow's `when: $teach.output.flagged == true || $moderate.output.flagged == true`),
 * so turning the rule engine off leaves the self-flag floor intact.
 */
export class ModerationParticipant extends AgentParticipant {
  constructor(private readonly rules: readonly ModerationRule[] = DEFAULT_MODERATION_RULES) {
    super({ id: 'content-moderation', capabilities: ['content.moderate'] })
  }

  protected async handleTask(task: Task): Promise<ModerationResult> {
    const payload = (task.payload ?? {}) as { lesson?: Partial<Lesson> } & Partial<Lesson>
    // The moderate step's input is the tutor output; accept it nested (`{lesson}`) or flat.
    const lesson: Partial<Lesson> = payload.lesson ?? payload
    const haystack = [lesson.topic, lesson.title, lesson.body, lesson.flagReason]
      .filter((s): s is string => typeof s === 'string')
      .join('\n')
      .toLowerCase()
    const reasons: string[] = []
    for (const rule of this.rules) {
      if (rule.pattern && haystack.includes(rule.pattern.toLowerCase())) {
        reasons.push(`${rule.label} (规则 ${rule.id})`)
      }
    }
    return { flagged: reasons.length > 0, reasons }
  }
}

// --- 家长 hub: the /teach tutor stand-in (deterministic; real LLM in Phase B) -------

/**
 * Topics whose generated content the tutor self-flags for 家长 review (决策 1.a,
 * layer 1). Self-flagging is the WEAKEST tier — the AI judging its own output — and is
 * deliberately backed by the topic whitelist (a hard gate) + the optional rule engine +
 * the full transcript landing on the 家长 hub. This deterministic keyword match stands
 * in for the real model's self-assessment.
 */
export const SELF_FLAG_KEYWORDS: readonly string[] = ['投资', '理财', '股票', '加密货币', '赌', '贷款']

/**
 * Serves `teach.lesson` as a faithful `/teach` mentor stand-in. It reads where the learner
 * is (the per-learner memory below stands in for reading `learning-records/`), drives the
 * lesson through the PURE `planTeach` planner (mission grounding → ZPD → one concept with a
 * citation → retrieval practice → equal-length quiz → primary source → captured insight; see
 * teach.ts), and self-flags potentially sensitive content. Synchronous + deterministic — in
 * real mode this capability is served by an LlmAgent /teach mentor instead (real-agents.ts),
 * the gates above unchanged. Pedagogy (`planTeach`) and safety (`flagged`) stay separate.
 */
export class LessonTutorStandin extends AgentParticipant {
  /**
   * Per-learner workspace memory — stands in for reading the learner's `/teach` workspace
   * (MISSION.md + learning-records/) to decide the next lesson. Carries the lesson clock, the
   * established mission, and prior insights (the newest drives the next lesson's ZPD).
   */
  private readonly memory = new Map<string, { lessons: number; missionWhy?: string; insights: TeachInsight[] }>()
  /** Tasks that ACTUALLY reached the tutor — so the demo can assert "0 before approval". */
  readonly taught: Task[] = []

  /**
   * `capability` defaults to `teach.lesson` (the 家长-form `tutor-teach` workflow's `teach`
   * step — used by the hermetic demo + real mode). The federation demo (C-M1) passes
   * `tutor.teach` instead, because the CHILD-form `child-guided-lesson` workflow names that
   * cross-org capability. Same lesson logic, one cap label — additive, default unchanged.
   */
  constructor(capability: string = 'teach.lesson') {
    super({ id: 'family-tutor', capabilities: [capability] })
  }

  protected async handleTask(task: Task): Promise<Lesson> {
    this.taught.push(task)
    const { topic, learner_id } = (task.payload ?? {}) as { topic?: string; learner_id?: string }
    const learnerId = String(learner_id ?? 'learner')
    const t = String(topic ?? '').trim() || '自由探索'

    // Where is the learner? Drive the next /teach lesson off the per-learner workspace memory.
    const prev = this.memory.get(learnerId) ?? { lessons: 0, insights: [] as TeachInsight[] }
    const plan = planTeach(t, {
      learnerId,
      missionPresent: prev.lessons > 0,
      ...(prev.missionWhy ? { missionWhy: prev.missionWhy } : {}),
      priorLessons: prev.lessons,
      priorInsights: prev.insights,
    })

    // Safety self-flag (决策 1.a, layer 1) — a separate self-assessment from pedagogy; the
    // real model judges this itself. Deterministic keyword match here.
    const hit = SELF_FLAG_KEYWORDS.find((k) => t.includes(k))
    const lesson: Lesson = {
      learnerId,
      topic: t,
      lessonNo: plan.lessonNo,
      title: plan.title,
      body: plan.body,
      flagged: hit !== undefined,
      ...(hit !== undefined ? { flagReason: `内容涉及「${hit}」, 建议家长留意` } : {}),
      missionEstablished: plan.missionEstablished,
      missionWhy: plan.missionWhy,
      zpd: plan.zpd,
      concept: plan.concept,
      citations: plan.citations,
      practice: plan.practice,
      quiz: plan.quiz,
      primarySource: plan.primarySource,
      glossary: plan.glossary,
      ...(plan.insight ? { insight: plan.insight } : {}),
      followUp: plan.followUp,
    }

    // Advance the workspace memory — the mission sticks, a captured insight feeds next ZPD.
    this.memory.set(learnerId, {
      lessons: plan.lessonNo,
      missionWhy: plan.missionWhy,
      insights: plan.insight ? [...prev.insights, plan.insight] : prev.insights,
    })
    return lesson
  }
}

// --- 孩子 hub: the learning-records MASTER copy (local, never leaves this hub) ------

/**
 * Serves the LOCAL capability `records.append`: write this lesson into the child's OWN
 * learning-records (the MASTER copy, 决策 6). The fork to the 家长 is a SEPARATE
 * cross-hub step; this one never leaves the 孩子 hub.
 */
export class RecordsAppendParticipant extends AgentParticipant {
  private count = 0

  constructor(private readonly recordsRoot: string) {
    super({ id: 'child-desk', capabilities: ['records.append'] })
  }

  protected async handleTask(task: Task): Promise<LearningRecord> {
    const { learner_id, topic, lesson } = (task.payload ?? {}) as {
      learner_id?: string
      topic?: string
      lesson?: Lesson
    }
    const learnerId = String(learner_id ?? 'learner')
    const lessonNo = lesson?.lessonNo ?? 0
    const dir = join(this.recordsRoot, 'learning-records', learnerId)
    mkdirSync(dir, { recursive: true })
    const recordPath = join(dir, `${String(lessonNo).padStart(3, '0')}.md`)
    const flagLine = lesson?.flagged ? `\n> ⚑ 自评标记: ${lesson.flagReason ?? '建议家长留意'}` : ''
    writeFileSync(
      recordPath,
      `# ${lesson?.title ?? `第 ${lessonNo} 课`}\n\n` +
        `- 学习者: ${learnerId}\n` +
        `- 主题: ${topic ?? lesson?.topic ?? ''}\n\n` +
        `${lesson?.body ?? ''}${flagLine}\n`,
      'utf8',
    )
    this.count += 1
    return {
      learnerId,
      topic: String(topic ?? lesson?.topic ?? ''),
      lessonNo,
      recordPath,
      totalRecords: this.count,
      note: `已记入本地学习档案 (主副本) 第 ${lessonNo} 课, 累计 ${this.count} 条。`,
    }
  }
}

// --- 家长 hub: the oversight fork sink ---------------------------------------------

/**
 * Serves `report.to-guardian`. Records every fork the 家长 receives — the "数据传输
 * 时从家长这里也发一份" the user asked for (孩子 keeps the original, 家长 gets a copy).
 */
export class ReportToGuardianParticipant extends AgentParticipant {
  readonly received: Array<{ learnerId: string; summary: unknown }> = []

  constructor() {
    super({ id: 'guardian-inbox', capabilities: ['report.to-guardian'] })
  }

  protected async handleTask(task: Task): Promise<unknown> {
    const { learner_id, summary } = (task.payload ?? {}) as { learner_id?: string; summary?: unknown }
    const learnerId = String(learner_id ?? 'learner')
    this.received.push({ learnerId, summary })
    return { forked: true, learnerId, note: `家长已收到 ${learnerId} 的学习小结副本。` }
  }
}

// --- third-party hub (only here to PROVE the data-class confinement) ----------------

/**
 * A SECOND peer the 孩子 hub also links to — stands in for "some other service". The
 * 孩子→third-party link's contract does NOT clear `child-learning`, so a child-learning
 * task is fail-closed at the link BEFORE it ever reaches here. Exists only so the demo
 * can assert `received.length === 0`: child data flows ONLY to the 家长 (决策 6 / §六).
 */
export class ThirdPartyStandin extends AgentParticipant {
  readonly received: Task[] = []

  constructor() {
    super({ id: 'third-party', capabilities: ['thirdparty.ingest'] })
  }

  protected async handleTask(task: Task): Promise<unknown> {
    // Should NEVER run for a child-learning task — the link gate fails closed first.
    this.received.push(task)
    return { ingested: true, cap: capOf(task) }
  }
}
