/**
 * teach.ts — Matt Pocock's `/teach` methodology as PURE, unit-testable functions: the
 * heart of family-learning-hub's "专门的导师". This is the piece that makes the family
 * tutor a faithful `/teach` mentor rather than a "give the next lesson" stub.
 *
 * We replicate the METHODOLOGY and FILE STRUCTURE of `/teach`
 * (github.com/mattpocock/skills, skills/productivity/teach) — an original implementation,
 * not a verbatim copy of its text — and STOP at the methodology+artifacts ceiling: HTML /
 * audio / browser-rendered lessons stay deferred to the consumer-app layer (design §九).
 *
 * The `/teach` ideas this planner encodes, one structured field each:
 *   - MISSION grounding  — every lesson serves a stated reason-to-learn; if no mission has
 *                          been established yet, the FIRST lesson establishes it (the skill's
 *                          "interview the user first if MISSION.md is unpopulated").
 *   - Zone of Proximal Development — read where the learner IS (prior records) and advance
 *                          exactly one small step, no further.
 *   - Knowledge vs Skill — teach ONE tightly-scoped concept (difficulty is the enemy), then
 *                          a retrieval-practice exercise (difficulty is the TOOL).
 *   - Cite a primary source — "never trust your parametric knowledge"; every lesson carries
 *                          a citation + recommends a high-trust source to go deeper.
 *   - Desirable difficulty quiz — options of EQUAL length so length leaks no answer clue,
 *                          with the correct position varying so position leaks none either.
 *   - GLOSSARY — canonical terms the lesson introduces.
 *   - Learning-record — an ADR-grade insight captured ONLY when there's evidence the learner
 *                          understood (drives the next lesson's ZPD). Not a journal.
 *
 * The PURE planner here is shared three ways (mirrors the house pattern
 * planConsult/planRoute/planSession): the deterministic `LessonTutorStandin` drives its
 * lessons through it, the hermetic demo asserts its output, and the real LLM tutor's system
 * prompt asks the model for the SAME structured shape (so a sparse/malformed model reply
 * degrades to this planner's baseline via `coerceLesson`). Safety (`flagged`) is NOT here —
 * that stays a separate self-assessment in the stand-in / real prompt, so pedagogy and the
 * safety gate never entangle.
 */

/** A citation to a trusted source — /teach "never trust parametric knowledge". */
export interface TeachCitation {
  title: string
  /** Where it comes from (book / official docs / site) — the source to recommend. */
  source: string
}

/** A retrieval-practice quiz — desirable difficulty, equal-length options (no length clue). */
export interface TeachQuiz {
  question: string
  /** Options of equal codepoint length so length reveals nothing; see {@link equalizeOptionLengths}. */
  options: string[]
  /** Index into {@link options} of the correct answer. */
  answer: number
}

/** A canonical term the lesson introduces — /teach GLOSSARY. */
export interface TeachGlossaryTerm {
  term: string
  definition: string
}

/** An ADR-grade insight the tutor captures when there's evidence — /teach learning-record. */
export interface TeachInsight {
  /** dash-case slug for the `NNNN-<slug>.md` filename. */
  slug: string
  title: string
  /** The non-obvious thing learned — drives the next lesson's ZPD. */
  insight: string
}

/** What the planner reads about a learner's workspace to decide the next lesson. */
export interface TeachWorkspaceState {
  /** The learner this lesson is for (grounds the mission default). */
  learnerId: string
  /** Has a MISSION been established for this learner+topic yet? */
  missionPresent: boolean
  /** The established reason-to-learn, if any (carried forward to keep grounding stable). */
  missionWhy?: string
  /** How many lessons already taught — the /teach "where is the learner" clock. */
  priorLessons: number
  /** Prior insights captured (ADR-grade); the newest drives this lesson's ZPD. */
  priorInsights: TeachInsight[]
}

/** A complete, structured `/teach` lesson plan — every methodology field populated. */
export interface TeachPlan {
  /** True when THIS turn established the mission (first lesson, no MISSION.md yet). */
  missionEstablished: boolean
  /** The /teach "where is the learner" clock (1-based). */
  lessonNo: number
  title: string
  /** The reason-to-learn this lesson serves — grounds everything (/teach MISSION). */
  missionWhy: string
  /** Where the learner is → what this advances to (/teach Zone of Proximal Development). */
  zpd: string
  /** The ONE tightly-scoped concept (knowledge) — difficulty is the enemy here. */
  concept: string
  /** Citation(s) for the concept — cite a primary source every lesson. */
  citations: TeachCitation[]
  /** The retrieval-practice exercise (skill) — difficulty is the TOOL here. */
  practice: string
  /** Equal-length-option quiz with an instant correct answer. */
  quiz: TeachQuiz
  /** The recommended high-trust source to go deeper (/teach RESOURCES). */
  primarySource: string
  /** Canonical terms this lesson introduced (may be empty). */
  glossary: TeachGlossaryTerm[]
  /** Insight to record when the learner showed evidence of understanding (optional). */
  insight?: TeachInsight
  /** Reminder to come back / ask the tutor — spacing. */
  followUp: string
  /** A human-readable rendering composed from the structured fields (back-compat `body`). */
  body: string
}

/**
 * Plan one `/teach` lesson, deterministically, from where the learner is. The FIRST lesson
 * (no mission yet) establishes the mission inline and teaches the first step; later lessons
 * advance one ZPD step from the newest captured insight and themselves capture a new insight
 * (there's now evidence — at least one practice round happened).
 */
export function planTeach(topic: string, state: TeachWorkspaceState): TeachPlan {
  const t = topic.trim() || '自由探索'
  const establishing = !state.missionPresent
  const lessonNo = establishing ? 1 : state.priorLessons + 1
  const missionWhy =
    nonEmpty(state.missionWhy) ??
    `让「${state.learnerId}」把「${t}」用到自己真正在意的事情上 (而不是只为考试或打发时间)`

  // Zone of Proximal Development — where the learner is → the one step this advances to.
  const lastInsight = state.priorInsights.at(-1)
  const zpd = establishing
    ? '还没有学习档案 — 这一课先和你一起定下「为什么学」, 再迈出第一小步。'
    : lastInsight
      ? `档案显示你已经掌握「${lastInsight.title}」; 这一课只在它之上推进一步 (最近发展区)。`
      : `这是「${t}」的第 ${lessonNo} 课, 在前一课基础上只多迈一小步, 不贪多。`

  // Knowledge — teach ONE tightly-scoped point (difficulty is the enemy). The deterministic
  // stand-in can't know a real curriculum, so it produces a well-FORMED, advancing focus that
  // exercises the methodology shape; the real LLM tutor replaces it with genuine content
  // (it reads the vault for where the learner is). The SHAPE + the ADVANCEMENT are the point.
  const focus = focusPoint(t, lessonNo)
  const concept = `这一课只讲清一个点:${focus}。先把这一个点弄懂, 不贪多 — 难度在「知识」里是敌人。`

  // Cite a primary source every lesson — never trust parametric knowledge.
  const primarySource = `《${t}》入门权威读物 / 官方文档 (家长可在 RESOURCES.md 换成自己信任的来源)`
  const citations: TeachCitation[] = [{ title: `${t} 的权威入门资料`, source: primarySource }]

  // Skill — retrieval practice (difficulty is the TOOL): recall, don't reread.
  const practice = `合上讲解, 用你自己的话把「${focus}」复述一遍, 再举一个生活里的例子 — 这是回忆练习, 不是重读。`

  // Desirable-difficulty quiz: equal-length options + a varying correct position.
  const quiz = makeStudyQuiz(t, lessonNo)

  const glossary: TeachGlossaryTerm[] = [
    { term: focus, definition: `本课语境里「${focus}」就是你这一步要弄懂的那一个点。` },
  ]

  // Capture an ADR-grade insight ONLY when there's evidence (a prior practice round happened,
  // i.e. not the mission-establishing first lesson). Not a journal — a record of understanding.
  const insight: TeachInsight | undefined =
    establishing || lessonNo < 2
      ? undefined
      : {
          slug: dashCase(`${t}-lesson-${lessonNo}`),
          title: `${t}:第 ${lessonNo} 课掌握了「${focus}」`,
          insight: `学习者在第 ${lessonNo} 课能用自己的话复述「${focus}」并举例, 说明已内化; 下一课可在此之上推进。`,
        }

  const followUp = `下次想继续, 直接跟导师说「继续学${t}」, 导师会从这一课往后接 (间隔复习)。`
  const title = establishing ? `第 1 课 · ${t} — 先立下学习使命` : `第 ${lessonNo} 课 · ${t}`
  const body = renderBody({ establishing, missionWhy, zpd, concept, practice, quiz, primarySource })

  return {
    missionEstablished: establishing,
    lessonNo,
    title,
    missionWhy,
    zpd,
    concept,
    citations,
    practice,
    quiz,
    primarySource,
    glossary,
    ...(insight ? { insight } : {}),
    followUp,
    body,
  }
}

/**
 * Pad every option to equal CODEPOINT length with U+3000 (ideographic space) so the options
 * render equal-width and length leaks no clue to the answer — /teach's "quiz options of
 * exactly equal length". Deterministic; the self-check asserts equality.
 */
export function equalizeOptionLengths(options: string[]): string[] {
  const max = Math.max(0, ...options.map((o) => [...o].length))
  return options.map((o) => {
    const pad = max - [...o].length
    return pad > 0 ? o + '　'.repeat(pad) : o
  })
}

/** Slugify for an `NNNN-<slug>.md` filename — keeps CJK, collapses whitespace/separators. */
export function dashCase(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[\s/\\.,，。]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

// --- internals ----------------------------------------------------------------------

/**
 * A study-method quiz (genuinely on-message for /teach: how to learn is itself the skill).
 * The correct option's POSITION varies by lessonNo so "always pick A" never works, and all
 * three options are equalized to the same length so length never hints at the answer.
 */
function makeStudyQuiz(topic: string, lessonNo: number): TeachQuiz {
  const correct = '先理解再练习' // 6
  const distractors = ['背下答案就行', '多刷题不理解'] // 6, 6
  const answer = lessonNo % 3
  const options: string[] = []
  let di = 0
  for (let i = 0; i < 3; i += 1) options.push(i === answer ? correct : (distractors[di++] ?? '蒙一个碰运气'))
  return {
    question: `学「${topic}」这一小步, 最该怎么做?`,
    options: equalizeOptionLengths(options),
    answer,
  }
}

function focusPoint(topic: string, lessonNo: number): string {
  return `「${topic}」的第 ${lessonNo} 个基础要点`
}

function renderBody(p: {
  establishing: boolean
  missionWhy: string
  zpd: string
  concept: string
  practice: string
  quiz: TeachQuiz
  primarySource: string
}): string {
  const labels = 'ABC'
  const quizLine = `${p.quiz.question} ${p.quiz.options.map((o, i) => `${labels[i] ?? '?'}. ${o}`).join('  ')}`
  return [
    p.establishing ? `【为什么学】${p.missionWhy}` : `【这一课的定位】${p.zpd}`,
    `【讲解 · 一个要点】${p.concept}`,
    `【动手练 · 回忆而非重读】${p.practice}`,
    `【小测 · 选一个】${quizLine}`,
    `【去哪深入】${p.primarySource}`,
  ].join('\n')
}

function nonEmpty(v: string | undefined): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}
