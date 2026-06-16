/**
 * teach-workspace.ts — the file-first `/teach` per-learner WORKSPACE on the 孩子 hub disk.
 *
 * `/teach` is stateful and file-first: a mentor keeps a per-learner workspace directory and
 * decides the next lesson by READING it. teach.ts encodes the methodology (mission → ZPD →
 * concept+citation → practice → quiz → primary source → insight); THIS module lays those
 * structured fields down as the durable artifacts a real mentor (or a parent) can open:
 *
 *   learning-records/                 ← the master-copy container on the 孩子 hub (decision 6)
 *     <learnerId>/                    ← one workspace per learner (the /teach workspace)
 *       MISSION.md                    ← 为什么学 — established on the FIRST lesson, then persists
 *       RESOURCES.md                  ← 推荐的一手来源 — accumulates (dedup), never trust parametric
 *       GLOSSARY.md                   ← 术语表 — canonical terms accumulate (dedup by term)
 *       lessons/
 *         0001-<slug>.md              ← EVERY lesson is written out
 *         0002-<slug>.md
 *       records/
 *         0002-<slug>.md              ← ADR-grade insight, written ONLY on evidence (not a journal)
 *
 * This layout matches what the real LLM tutor's prompt already reads (real-agents.ts:
 * "learning-records/<learnerId>/ 的 MISSION.md 和已有的 records") — so the deterministic writer
 * here and the mcp-obsidian reader there agree on one shape. Pure + deterministic (filesystem
 * side effects only); teach-workspace.selfcheck.ts pins the invariants.
 *
 * Faithfulness ceiling (design §九): we replicate the methodology + the file artifacts and STOP
 * there — HTML / audio / browser-rendered lessons stay deferred to the consumer-app layer.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { dashCase } from './teach.js'
import type { Lesson } from './participants.js'

/** What a single `writeTeachWorkspace` call wrote / updated — the projection summary. */
export interface TeachWorkspaceWrite {
  /** The learner's workspace dir (`<container>/<learnerId>`). */
  workspaceDir: string
  /** MISSION.md path when this lesson established / first-wrote it (else omitted). */
  missionPath?: string
  /** lessons/NNNN-slug.md — every lesson is written; always present. */
  lessonPath: string
  /** records/NNNN-slug.md — present ONLY when the lesson captured an ADR-grade insight. */
  insightPath?: string
  /** RESOURCES.md path (always exists after a write). */
  resourcesPath: string
  /** GLOSSARY.md path (always exists after a write). */
  glossaryPath: string
  /** Total lesson files for this learner (every lesson). */
  totalLessons: number
  /** Total ADR-grade learning-records for this learner (evidence only). */
  totalInsights: number
  /** Distinct recommended sources accumulated in RESOURCES.md. */
  totalResources: number
  /** Distinct glossary terms accumulated in GLOSSARY.md. */
  totalTerms: number
}

/** Zero-padded lesson number for the `NNNN-<slug>.md` filename — /teach convention. */
const PAD = 4

/**
 * Filesystem-safe slug: reuse teach.ts `dashCase` (keeps CJK, collapses whitespace/separators),
 * then defensively strip the few chars dashCase leaves that are awkward in filenames (middot,
 * colons, shell-glob). Never touches teach.ts so M1's committed planner stays byte-for-byte.
 */
function slugForFile(title: string, fallback: string): string {
  const safe = dashCase(title)
    .replace(/[·:：*?"<>|]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return safe || fallback
}

/** Count `.md` files in a dir (0 if it doesn't exist) — derives totals from the disk, no sidecar. */
function countMd(dir: string): number {
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.md')).length : 0
}

/** Count `- ` bullet lines in a markdown file (the accumulated entries). */
function countBullets(path: string): number {
  if (!existsSync(path)) return 0
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.startsWith('- ')).length
}

/**
 * Append one bullet line under a `# header`, but ONLY if that exact line isn't already present
 * (dedup) — so re-teaching the same lesson never duplicates a source/term. Creates the file with
 * the header when missing. Returns whether it appended.
 */
function appendUnique(path: string, header: string, line: string): boolean {
  let body = existsSync(path) ? readFileSync(path, 'utf8') : `# ${header}\n\n`
  if (body.includes(line)) return false
  if (!body.endsWith('\n')) body += '\n'
  writeFileSync(path, `${body}${line}\n`, 'utf8')
  return true
}

function renderMission(lesson: Lesson): string {
  return (
    `# ${lesson.learnerId} · 学习使命 (MISSION)\n\n` +
    `> /teach: 每一课都服务一个「为什么学」。第一课先和学习者一起把它定下来, 之后所有课都锚定它。\n\n` +
    `- 学习者: ${lesson.learnerId}\n` +
    `- 起始主题: ${lesson.topic}\n\n` +
    `## 为什么学\n\n${lesson.missionWhy ?? '(待和学习者一起确认)'}\n`
  )
}

function renderLesson(lesson: Lesson): string {
  const labels = 'ABCDEF'
  const quiz = lesson.quiz
  const quizBlock = quiz
    ? `## 小测 (选项等长, 长度不泄露答案)\n\n${quiz.question}\n\n` +
      quiz.options.map((o, i) => `${i === quiz.answer ? '✅' : '⬜'} ${labels[i] ?? '?'}. ${o}`).join('\n') +
      '\n'
    : ''
  const citeBlock = (lesson.citations ?? []).length
    ? `## 引用来源 (别只信记忆)\n\n${(lesson.citations ?? []).map((c) => `- ${c.title} — ${c.source}`).join('\n')}\n`
    : ''
  const glossaryBlock = (lesson.glossary ?? []).length
    ? `## 本课术语\n\n${(lesson.glossary ?? []).map((g) => `- **${g.term}** — ${g.definition}`).join('\n')}\n`
    : ''
  const flagBlock = lesson.flagged ? `\n> ⚑ 自评标记: ${lesson.flagReason ?? '建议家长留意'}\n` : ''
  return (
    `# ${lesson.title}\n\n` +
    `- 学习者: ${lesson.learnerId}\n` +
    `- 主题: ${lesson.topic}\n` +
    `- 第 ${lesson.lessonNo} 课\n` +
    (lesson.missionEstablished ? `- ⭑ 本课确立了学习使命\n` : '') +
    `\n## 这一课的定位 (最近发展区)\n\n${lesson.zpd ?? lesson.body}\n\n` +
    `## 讲解 · 一个要点 (难度是敌人)\n\n${lesson.concept ?? lesson.body}\n\n` +
    `## 动手练 · 回忆而非重读 (难度是工具)\n\n${lesson.practice ?? ''}\n\n` +
    quizBlock +
    (quizBlock ? '\n' : '') +
    citeBlock +
    (citeBlock ? '\n' : '') +
    (lesson.primarySource ? `## 去哪深入\n\n${lesson.primarySource}\n\n` : '') +
    glossaryBlock +
    (lesson.followUp ? `\n---\n${lesson.followUp}\n` : '') +
    flagBlock
  )
}

function renderRecord(lesson: Lesson): string {
  const insight = lesson.insight!
  return (
    `# 学习档案 · ${insight.title}\n\n` +
    `> /teach learning-record: 只在有「理解的证据」时才记 (不是流水账)。这条 ADR 式记录会驱动下一课的最近发展区。\n\n` +
    `- 学习者: ${lesson.learnerId}\n` +
    `- 主题: ${lesson.topic}\n` +
    `- 来自第 ${lesson.lessonNo} 课\n\n` +
    `## 学到了什么 (为什么重要)\n\n${insight.insight}\n`
  )
}

/**
 * Project one `Lesson` into the learner's file-first `/teach` workspace under `<container>`
 * (the 孩子 hub's `learning-records/` master-copy root). Writes the lesson always, the mission on
 * the first lesson, an ADR-grade learning-record ONLY when the lesson carries an insight, and
 * accumulates RESOURCES/GLOSSARY with dedup. Returns the projection summary (paths + totals).
 */
export function writeTeachWorkspace(container: string, lesson: Lesson): TeachWorkspaceWrite {
  const workspaceDir = join(container, lesson.learnerId)
  const lessonsDir = join(workspaceDir, 'lessons')
  const recordsDir = join(workspaceDir, 'records')
  mkdirSync(lessonsDir, { recursive: true })
  mkdirSync(recordsDir, { recursive: true })

  const no = String(lesson.lessonNo).padStart(PAD, '0')
  const slug = slugForFile(lesson.title, `lesson-${no}`)

  // MISSION.md — established on the FIRST lesson (mission grounding); then persists. Also (re)write
  // if missing, so a workspace seeded mid-stream still gets a mission rather than silently lacking one.
  const missionPath = join(workspaceDir, 'MISSION.md')
  let missionWritten: string | undefined
  if (lesson.missionEstablished || !existsSync(missionPath)) {
    writeFileSync(missionPath, renderMission(lesson), 'utf8')
    missionWritten = missionPath
  }

  // lessons/NNNN-slug.md — every lesson is written out.
  const lessonPath = join(lessonsDir, `${no}-${slug}.md`)
  writeFileSync(lessonPath, renderLesson(lesson), 'utf8')

  // records/NNNN-slug.md — an ADR-grade learning-record ONLY when there's evidence (an insight).
  let insightPath: string | undefined
  if (lesson.insight) {
    insightPath = join(recordsDir, `${no}-${slugForFile(lesson.insight.title, slug)}.md`)
    writeFileSync(insightPath, renderRecord(lesson), 'utf8')
  }

  // RESOURCES.md — accumulate the recommended primary source (dedup so re-teaching never duplicates).
  const resourcesPath = join(workspaceDir, 'RESOURCES.md')
  const resourcesHeader = `${lesson.learnerId} · 推荐的一手来源 (RESOURCES)`
  if (lesson.primarySource) appendUnique(resourcesPath, resourcesHeader, `- ${lesson.primarySource}`)
  else if (!existsSync(resourcesPath)) writeFileSync(resourcesPath, `# ${resourcesHeader}\n\n`, 'utf8')

  // GLOSSARY.md — merge the canonical terms this lesson introduced (dedup by exact line).
  const glossaryPath = join(workspaceDir, 'GLOSSARY.md')
  const glossaryHeader = `${lesson.learnerId} · 术语表 (GLOSSARY)`
  if (!existsSync(glossaryPath)) writeFileSync(glossaryPath, `# ${glossaryHeader}\n\n`, 'utf8')
  for (const term of lesson.glossary ?? []) {
    appendUnique(glossaryPath, glossaryHeader, `- **${term.term}** — ${term.definition}`)
  }

  return {
    workspaceDir,
    ...(missionWritten ? { missionPath: missionWritten } : {}),
    lessonPath,
    ...(insightPath ? { insightPath } : {}),
    resourcesPath,
    glossaryPath,
    totalLessons: countMd(lessonsDir),
    totalInsights: countMd(recordsDir),
    totalResources: countBullets(resourcesPath),
    totalTerms: countBullets(glossaryPath),
  }
}
