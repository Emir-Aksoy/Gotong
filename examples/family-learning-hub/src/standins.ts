/**
 * Deterministic stand-in participants for the family-learning-hub demo.
 *
 * Two SOVEREIGN hubs (北极星 第 1 层「我的 AI 桌面」× 第 2 层「跨组织协作」的交点):
 *   - 孩子 hub (child)    — owns the learning-records MASTER copy. Serves the LOCAL
 *     capability `records.append` (write this lesson onto the child's OWN disk).
 *   - 家长 hub (guardian) — holds the AI subscription. Serves the two capabilities
 *     the child reaches across the federation boundary: `tutor.teach` (the /teach
 *     tutor — the model runs HERE, so it's billed to the 家长) and
 *     `report.to-guardian` (receive the forked oversight copy).
 *
 * In the loadable template (FL-M2) the tutor is a KB-backed LlmAgent (a /teach
 * mentor on DeepSeek + mcp-obsidian over a learning_records KB). Here we substitute
 * deterministic stand-ins that serve the SAME capabilities with real, assertable
 * logic — so the demo runs with NO API key and the hub wiring is identical to
 * production. The 家长 lives on a SEPARATE hub; in production that's the parent's
 * own AipeHub, reached over a federation link — and the link (who the peer is, its
 * outbound capability allowlist, its data-class contract, its approval policy) is
 * RUNTIME peer config, never part of the template (the tea-supply-link teaching
 * point).
 *
 * Progress and the content flag are computed DETERMINISTICALLY (the lesson number,
 * the self-flag) — never by an LLM, same discipline as cafe-ops's overtime math and
 * tea-supply-link's pricing. The framework never runs an LLM: the tutor only
 * PROPOSES the next lesson; whether an off-whitelist topic may run is the 家长's call.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { AgentParticipant, type Task } from '@aipehub/core'

// --- shapes flowing between the steps --------------------------------------------

/** One lesson the tutor produced — the `tutor.teach` output. */
export interface Lesson {
  learnerId: string
  topic: string
  /** The /teach "where is the learner" clock — advances by one each invocation. */
  lessonNo: number
  title: string
  body: string
  /** 决策 1.a — the tutor SELF-FLAGS content a 家长 may want to review. */
  flagged: boolean
  flagReason?: string
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

function capOf(task: Task): string | undefined {
  return task.strategy?.kind === 'capability' ? task.strategy.capabilities?.[0] : undefined
}

// --- 家长 hub: the /teach tutor (the model lives here, billed to the 家长) ---------

/**
 * Topics whose generated content the tutor self-flags for 家长 review (决策 1.a).
 * Self-flagging is the WEAKEST safety tier — the AI judging its own output — and is
 * deliberately backed by the topic whitelist (a hard boundary in the gate) + the
 * full lesson transcript landing NATIVELY on the 家长 hub. This deterministic
 * keyword match stands in for the real model's self-assessment.
 */
const SELF_FLAG_KEYWORDS = ['投资', '理财', '股票', '加密货币', '赌', '贷款']

/**
 * 家长 hub tutor. Serves the ONE capability the child reaches across the boundary
 * to LEARN: `tutor.teach`. Reads where the learner is (the per-learner counter
 * stands in for reading `learning-records/`), advances by one lesson, and
 * self-flags potentially sensitive content. Synchronous + deterministic.
 */
export class TutorStandin extends AgentParticipant {
  /** Per-learner lesson counter — stands in for reading learning-records/ to continue. */
  private readonly progress = new Map<string, number>()
  /** Tasks that ACTUALLY reached the tutor — so the demo can assert "0 before approval". */
  readonly taught: Task[] = []

  constructor() {
    super({ id: 'family-tutor', capabilities: ['tutor.teach'] })
  }

  protected async handleTask(task: Task): Promise<unknown> {
    this.taught.push(task)
    const { topic, learner_id } = (task.payload ?? {}) as { topic?: string; learner_id?: string }
    const learnerId = String(learner_id ?? 'learner')
    const t = String(topic ?? '').trim() || '自由探索'
    const lessonNo = (this.progress.get(learnerId) ?? 0) + 1
    this.progress.set(learnerId, lessonNo)

    const hit = SELF_FLAG_KEYWORDS.find((k) => t.includes(k))
    const lesson: Lesson = {
      learnerId,
      topic: t,
      lessonNo,
      title: `第 ${lessonNo} 课 · ${t}`,
      body: `导师按你的学习档案续上第 ${lessonNo} 课:${t} 的入门讲解 + 一个小练习。`,
      flagged: hit !== undefined,
      ...(hit !== undefined ? { flagReason: `内容涉及「${hit}」, 建议家长留意` } : {}),
    }
    return lesson
  }
}

/**
 * 家长 hub inbox for the forked oversight copy (`report.to-guardian`). Records every
 * fork the 家长 receives so the demo can assert oversight actually happened — the
 * "数据传输时从家长这里也发一份" the user asked for (孩子 keeps the original, 家长
 * gets the copy).
 */
export class GuardianInboxStandin extends AgentParticipant {
  readonly received: Array<{ learnerId: string; summary: unknown }> = []

  constructor() {
    super({ id: 'guardian-inbox', capabilities: ['report.to-guardian'] })
  }

  protected async handleTask(task: Task): Promise<unknown> {
    const { learner_id, summary } = (task.payload ?? {}) as {
      learner_id?: string
      summary?: unknown
    }
    const learnerId = String(learner_id ?? 'learner')
    this.received.push({ learnerId, summary })
    return { forked: true, learnerId, note: `家长已收到 ${learnerId} 的学习小结副本。` }
  }
}

// --- 孩子 hub: the learning-records MASTER copy (local, never leaves this hub) ------

/**
 * 孩子 hub front desk. Serves the LOCAL capability `records.append`: write this
 * lesson into the child's OWN learning-records (the MASTER copy, 决策 6). The fork
 * to the 家长 is a SEPARATE cross-hub step; this one never leaves the 孩子 hub.
 */
export class ChildDeskStandin extends AgentParticipant {
  private count = 0

  constructor(private readonly recordsRoot: string) {
    super({ id: 'child-desk', capabilities: ['records.append'] })
  }

  protected async handleTask(task: Task): Promise<unknown> {
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
    const record: LearningRecord = {
      learnerId,
      topic: String(topic ?? lesson?.topic ?? ''),
      lessonNo,
      recordPath,
      totalRecords: this.count,
      note: `已记入本地学习档案 (主副本) 第 ${lessonNo} 课, 累计 ${this.count} 条。`,
    }
    return record
  }
}

// --- third-party hub (only here to PROVE the data-class confinement) --------------

/**
 * A SECOND peer the 孩子 hub also connects to — stands in for "some other service".
 * The 孩子→third-party link's contract does NOT clear `child-learning`, so a
 * child-learning task is fail-closed at the link BEFORE it ever reaches here. This
 * participant exists only so the demo can assert `received.length === 0`: the
 * child's learning data flows ONLY to the 家长, never to a third party (决策 6 / §六).
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
