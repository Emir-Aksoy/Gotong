/**
 * real-agents.ts — the REAL (non-hermetic) tutor wiring for family-learning-hub.
 *
 * The hermetic demo (`index.ts`) serves `teach.lesson` with the deterministic
 * `LessonTutorStandin`. Real mode swaps in a genuine LLM tutor — and ONLY the tutor:
 * the four safety GATES (topic.screen / content.moderate / records.append /
 * report.to-guardian) stay deterministic participants (see participants.ts). That
 * separation is the whole point — the framework never lets an LLM make a gate
 * decision; the model only produces the lesson the gates wrap.
 *
 * ★ Why the tutor must return STRUCTURED output (not plain text) ★
 *
 * The 家长 workflow's content-review gate is a predicate on the tutor's OWN self-flag
 * (决策 1.a, layer 1):
 *     mod-approval.when = "$teach.output.flagged == true || $moderate.output.flagged == true"
 * A plain-text LlmAgent returns `{text}` with NO `flagged` field → `$teach.output.flagged`
 * resolves to `undefined` → `strictEqual(undefined, true)` → false → the self-flag layer
 * silently does nothing. That is the SAME fail-open class the deterministic gates exist to
 * fix — so in real mode the tutor must emit a real boolean `flagged`. `FamilyTutorAgent`
 * subclasses `LlmAgent` and parses the model's JSON into the `Lesson` shape (a real
 * `flagged`), so the self-flag predicate stays honest. The rule-engine layer
 * (`content.moderate`) is deterministic regardless and remains the stronger floor.
 *
 * opt-in: needs a DeepSeek (or other OpenAI-compatible) key. The mcp-obsidian toolset is
 * ALSO opt-in (needs OBSIDIAN_API_KEY) — without it the tutor still runs, it just can't
 * read the learning-records vault to find where the learner is (starts at lesson 1).
 * B-M2 (`index.real.ts`) decides real-vs-stand-in based on whether a key is present.
 *
 * Precedent: examples/codex-deepseek-hub/src/real-agents.ts (LlmAgent + OpenAIProvider
 * DeepSeek) and examples/obsidian-kb/agents/obsidian-researcher.yaml (mcp-obsidian wiring).
 */

import type { Task } from '@aipehub/core'
import { LlmAgent, type LlmRequest, type LlmResponse, type LlmTaskOutput } from '@aipehub/llm'
import { OpenAIProvider } from '@aipehub/llm-openai'
import { McpToolset } from '@aipehub/mcp-client'

import type { Lesson } from './participants.js'
import {
  planTeach,
  type TeachCitation,
  type TeachGlossaryTerm,
  type TeachInsight,
  type TeachQuiz,
} from './teach.js'

// DeepSeek is OpenAI-compatible — point OpenAIProvider at its base URL (mirrors the
// codex-deepseek-hub sibling; both `…/chat/completions` and `…/v1/chat/completions` work).
export const DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com'
export const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL ?? 'deepseek-chat'

export const TUTOR_ID = 'family-tutor'
export const TUTOR_CAP = 'teach.lesson'

/**
 * The /teach methodology system prompt. This is what makes the tutor a faithful `/teach`
 * mentor (github.com/mattpocock/skills) rather than a "next lesson" stub: ground every
 * lesson in a MISSION (establish it on the first lesson), advance ONE step along the
 * learner's zone of proximal development, teach ONE concept (difficulty is the enemy) then
 * a retrieval-practice exercise (difficulty is the tool), cite a primary source, quiz with
 * equal-length options, and capture an ADR-grade insight when there's evidence. The model
 * emits a STRICT structured JSON the workflow + the safety gate read directly. The obsidian
 * tools are only present when a vault is wired (otherwise the tutor starts at lesson 1).
 */
export const TUTOR_SYSTEM = [
  '你是一个家庭学习 hub 里的 AI 导师, 面向儿童, 严格按 Matt Pocock 的 /teach 方法论上课:',
  '',
  '工具 (via MCP, 命名空间 `obsidian__`, 仅在接了档案库时可用):',
  '- obsidian__search: 全文搜索整个档案库',
  '- obsidian__list_files_in_dir: 浏览某目录下的笔记 (学习者工作区在 learning-records/<learnerId>/)',
  '- obsidian__get_file_contents: 按路径读一篇笔记',
  '',
  '每节课你必须:',
  '1. (有工具时) 先读 learning-records/<learnerId>/: 看 MISSION.md (为什么学) 与已有的',
  '   learning-records/ 笔记 (上到第几课、掌握了什么); 没有档案就从第 1 课开始。',
  '2. 使命锚定: 若还没有 MISSION (第一课), 先和学习者一起定下「为什么学」并把 missionEstablished',
  '   设为 true; 之后每节课都要服务这个使命。',
  '3. 最近发展区 (ZPD): 只在 TA 已掌握的基础上推进一小步, 不贪多 (zpd 字段一句话说明定位)。',
  '4. 先知识后技能: concept 只讲清「一个」要点 (难度在知识里是敌人); practice 给一个回忆练习',
  '   (让 TA 复述/举例, 不是重读 — 难度在技能里是工具)。',
  '5. 引用来源: citations 至少一条权威来源, primarySource 推荐一个高可信的深入读物',
  '   (绝不只凭脑子里的印象)。',
  '6. 小测: quiz 出一道选择题, options 各项「长度尽量一致」(长度不能泄露答案), answer 是正确项下标。',
  '7. 术语表: glossary 收本课引入的关键术语 (可为空数组)。',
  '8. 学习档案: 当这节课有证据表明 TA 真的懂了, 在 insight 里写一条 ADR 式要点 (供下一课接续);',
  '   没有就省略 insight (它不是流水账)。',
  '9. 内容自评打标 (决策 1.a — 最弱一层, 背后还有主题白名单 + 家长审核 + 全程转录给家长):',
  '   若涉及投资/理财/赌博/诱导充值消费/联系陌生人等对儿童敏感的主题, flagged=true 并在',
  '   flagReason 一句话说明; 否则 flagged=false。',
  '',
  '输出契约 (硬性): 只输出一个 JSON 对象, 不要任何解释或代码块外的文字。形如:',
  '{"lessonNo": 数字, "missionEstablished": false, "missionWhy": "为什么学",',
  ' "zpd": "这一课的定位", "title": "标题", "concept": "一个要点的讲解",',
  ' "citations": [{"title": "来源名", "source": "出处"}], "practice": "回忆练习",',
  ' "quiz": {"question": "题干", "options": ["A","B","C"], "answer": 0},',
  ' "primarySource": "推荐深入读物", "glossary": [{"term": "术语", "definition": "定义"}],',
  ' "insight": {"slug": "dash-case", "title": "掌握了什么", "insight": "ADR 式要点"},',
  ' "body": "可读的整课汇总", "flagged": false, "flagReason": ""}',
].join('\n')

/** Options for {@link makeTutor}. */
export interface TutorOptions {
  /** A connected (or to-be-connected) mcp-obsidian toolset for learning-records. */
  toolset?: McpToolset
  /** Override the provider base URL (e.g. Anthropic-compatible, Qwen, Ollama). */
  baseURL?: string
  /** Override the model id. */
  model?: string
  /** Output cap. */
  maxTokens?: number
}

/**
 * Build the mcp-obsidian toolset for the learning-records vault, or `undefined` when no
 * OBSIDIAN_API_KEY is set (opt-in — the tutor then runs without vault access). The caller
 * owns the lifecycle: `await toolset.connect()` before dispatching, `disconnect()` at
 * teardown (the LlmAgent never connects its own toolset — see agent.ts).
 *
 * NOTE on env: mcp-client passes ONLY the keys we list here to the child process (the
 * default-inherited set is dropped when `env` is set at all), so PATH/HOME must be spelled
 * out or `uvx` can't find its python env.
 */
export function makeTutorToolset(): McpToolset | undefined {
  const apiKey = process.env.OBSIDIAN_API_KEY
  if (!apiKey) return undefined
  const env: Record<string, string> = { OBSIDIAN_API_KEY: apiKey }
  if (process.env.OBSIDIAN_HOST) env.OBSIDIAN_HOST = process.env.OBSIDIAN_HOST
  if (process.env.OBSIDIAN_PORT) env.OBSIDIAN_PORT = process.env.OBSIDIAN_PORT
  if (process.env.PATH) env.PATH = process.env.PATH
  if (process.env.HOME) env.HOME = process.env.HOME
  return new McpToolset({ servers: [{ name: 'obsidian', command: 'uvx', args: ['mcp-obsidian'], env }] })
}

/**
 * The real /teach tutor — DeepSeek (default) + an optional mcp-obsidian toolset. The key is
 * passed EXPLICITLY to the provider (the agent doesn't own credentials). When a toolset is
 * supplied the base LlmAgent runs a tool-use loop (read records → produce lesson); either
 * way the FINAL response is parsed into a structured `Lesson`.
 */
export function makeTutor(apiKey: string, opts: TutorOptions = {}): FamilyTutorAgent {
  return new FamilyTutorAgent({
    id: TUTOR_ID,
    capabilities: [TUTOR_CAP],
    provider: new OpenAIProvider({
      name: 'deepseek',
      apiKey,
      baseURL: opts.baseURL ?? DEEPSEEK_BASE_URL,
      defaultModel: opts.model ?? DEEPSEEK_MODEL,
      maxTokensField: 'max_tokens',
    }),
    system: TUTOR_SYSTEM,
    maxTokens: opts.maxTokens ?? 1024,
    ...(opts.toolset ? { tools: opts.toolset } : {}),
  })
}

/**
 * LlmAgent specialization that turns a `{topic, learner_id}` dispatch into a /teach request
 * and the model's final JSON into a structured `Lesson` (with a REAL `flagged` boolean).
 * We return `Lesson & LlmTaskOutput` so the override stays covariant with the base
 * `parseResponse` AND the workflow's downstream steps (`moderate` / `record` / the
 * self-flag predicate) read the Lesson fields directly off `$teach.output`.
 */
export class FamilyTutorAgent extends LlmAgent {
  /** Turn the workflow's `{topic, learner_id}` payload into the /teach user message. */
  protected override buildRequest(task: Task): LlmRequest {
    const { topic, learner_id } = (task.payload ?? {}) as { topic?: string; learner_id?: string }
    const learnerId = String(learner_id ?? 'learner')
    const t = String(topic ?? '').trim() || '自由探索'
    const hasVault = this.toolset !== undefined
    const userText = [
      `请按 /teach 方法论给学习者「${learnerId}」上一节关于「${t}」的课。`,
      '',
      '步骤:',
      hasVault
        ? `1. 先用 obsidian 工具读 learning-records/${learnerId}/ 的 MISSION.md 和已有 learning-records/ 笔记, 看 TA 上到第几课、学过什么 (没有就从第 1 课、先立使命开始)。`
        : '1. 这次没有接学习档案库, 就当作第 1 课从头开始, 先和 TA 立下学习使命 (missionEstablished=true)。',
      '2. 续上下一课 (lessonNo = 已有最大课号 + 1)。沿最近发展区只推进一小步: 讲清一个 concept,',
      '   配一个回忆 practice, 引用一条来源, 出一道等长选项的 quiz, 推荐一个 primarySource;',
      '   有证据 TA 懂了就在 insight 里记一条 (没有就省略)。',
      '3. 自评打标: 若内容涉及投资/理财/赌博/诱导充值消费/联系陌生人等对儿童敏感的主题,',
      '   把 flagged 设为 true 并在 flagReason 一句话说明; 否则 flagged 为 false。',
      '',
      '只输出 system 里约定的那个 JSON 对象 (不要任何解释或代码块外的文字)。',
    ].join('\n')

    const req: LlmRequest = { messages: [{ role: 'user', content: userText }] }
    if (this.defaults.system !== undefined) req.system = this.defaults.system
    if (this.defaults.maxTokens !== undefined) req.maxTokens = this.defaults.maxTokens
    if (this.defaults.temperature !== undefined) req.temperature = this.defaults.temperature
    if (this.defaults.model !== undefined) req.model = this.defaults.model
    return req
  }

  /** Parse the model's final JSON into a `Lesson`; keep the LlmTaskOutput fields too. */
  protected override parseResponse(
    response: LlmResponse,
    task: Task,
    toolRounds = 0,
  ): Lesson & LlmTaskOutput {
    const { topic, learner_id } = (task.payload ?? {}) as { topic?: string; learner_id?: string }
    const learnerId = String(learner_id ?? 'learner')
    const t = String(topic ?? '').trim() || '自由探索'
    const lesson = coerceLesson(response.text, learnerId, t)
    const out: Lesson & LlmTaskOutput = {
      ...lesson,
      text: response.text,
      stopReason: response.stopReason,
      by: this.provider.name,
    }
    if (response.usage) out.usage = response.usage
    if (toolRounds > 0) out.toolRounds = toolRounds
    return out
  }
}

// --- parsing helpers (deterministic; always yield a VALID Lesson) -------------------

/**
 * Build a valid `Lesson` from the model's text. The model is asked for the strict `/teach`
 * JSON, but we never let a malformed reply break the workflow: the SAFETY surface keeps its
 * original conservative defaults (lessonNo→1, body→the raw text, `flagged` true ONLY when the
 * model explicitly said so — a parse miss never silently clears a self-flag the model raised),
 * and every `/teach` METHODOLOGY field falls back to a deterministic `planTeach` baseline so a
 * sparse model reply still yields a complete, well-formed lesson. The rule-engine layer +
 * whitelist + transcript fork remain the stronger floor behind the self-flag regardless.
 */
export function coerceLesson(text: string, learnerId: string, topic: string): Lesson {
  const parsed = extractJson(text)
  const lessonNo = toPositiveInt(parsed?.lessonNo) ?? 1
  const title = nonEmptyString(parsed?.title) ?? `第 ${lessonNo} 课 · ${topic}`
  const body = nonEmptyString(parsed?.body) ?? (text.trim() || '(导师未返回内容)')
  const flagged = parsed?.flagged === true
  const flagReason = flagged
    ? (nonEmptyString(parsed?.flagReason) ?? '导师自评: 内容可能需要家长留意')
    : undefined

  // A baseline /teach plan supplies safe defaults for any methodology field the model omitted
  // (we infer mission-established from the lessonNo since a single call has no workspace state).
  const base = planTeach(topic, {
    learnerId,
    missionPresent: lessonNo > 1,
    priorLessons: Math.max(0, lessonNo - 1),
    priorInsights: [],
  })
  const insight = coerceInsight(parsed?.insight) ?? base.insight

  return {
    learnerId,
    topic,
    lessonNo,
    title,
    body,
    flagged,
    ...(flagReason ? { flagReason } : {}),
    missionEstablished:
      typeof parsed?.missionEstablished === 'boolean'
        ? (parsed.missionEstablished as boolean)
        : base.missionEstablished,
    missionWhy: nonEmptyString(parsed?.missionWhy) ?? base.missionWhy,
    zpd: nonEmptyString(parsed?.zpd) ?? base.zpd,
    concept: nonEmptyString(parsed?.concept) ?? base.concept,
    citations: coerceCitations(parsed?.citations) ?? base.citations,
    practice: nonEmptyString(parsed?.practice) ?? base.practice,
    quiz: coerceQuiz(parsed?.quiz) ?? base.quiz,
    primarySource: nonEmptyString(parsed?.primarySource) ?? base.primarySource,
    glossary: coerceGlossary(parsed?.glossary) ?? base.glossary,
    ...(insight ? { insight } : {}),
    followUp: nonEmptyString(parsed?.followUp) ?? base.followUp,
  }
}

/** Parse the model's `citations` array; drop malformed entries; `undefined` if none usable. */
function coerceCitations(v: unknown): TeachCitation[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out: TeachCitation[] = []
  for (const e of v) {
    const title = nonEmptyString((e as { title?: unknown } | undefined)?.title)
    const source = nonEmptyString((e as { source?: unknown } | undefined)?.source)
    if (title && source) out.push({ title, source })
  }
  return out.length ? out : undefined
}

/** Parse the model's `quiz`; needs a question, ≥2 options, and an in-range answer index. */
function coerceQuiz(v: unknown): TeachQuiz | undefined {
  if (!v || typeof v !== 'object') return undefined
  const q = v as { question?: unknown; options?: unknown; answer?: unknown }
  const question = nonEmptyString(q.question)
  const options = Array.isArray(q.options)
    ? q.options.filter((o): o is string => typeof o === 'string' && o.trim().length > 0)
    : []
  const answer = typeof q.answer === 'number' ? Math.floor(q.answer) : Number(q.answer)
  if (!question || options.length < 2 || !Number.isInteger(answer) || answer < 0 || answer >= options.length) {
    return undefined
  }
  return { question, options, answer }
}

/** Parse the model's `glossary` array; drop malformed entries; `[]` (kept) if the array is empty. */
function coerceGlossary(v: unknown): TeachGlossaryTerm[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out: TeachGlossaryTerm[] = []
  for (const e of v) {
    const term = nonEmptyString((e as { term?: unknown } | undefined)?.term)
    const definition = nonEmptyString((e as { definition?: unknown } | undefined)?.definition)
    if (term && definition) out.push({ term, definition })
  }
  return out // [] is a valid "no terms this lesson"; only a non-array falls through to the base
}

/** Parse the model's `insight`; needs a title + insight body; synthesizes a slug if absent. */
function coerceInsight(v: unknown): TeachInsight | undefined {
  if (!v || typeof v !== 'object') return undefined
  const i = v as { slug?: unknown; title?: unknown; insight?: unknown }
  const title = nonEmptyString(i.title)
  const body = nonEmptyString(i.insight)
  if (!title || !body) return undefined
  const slug = nonEmptyString(i.slug) ?? title.toLowerCase().replace(/[\s/\\.,，。]+/g, '-').replace(/-+/g, '-')
  return { slug, title, insight: body }
}

/** Extract the first JSON object from text — fenced ```json``` first, then a bare {…}. */
function extractJson(text: string): Record<string, unknown> | undefined {
  if (!text) return undefined
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fenced ? fenced[1]! : text
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return undefined
  try {
    const obj = JSON.parse(candidate.slice(start, end + 1))
    return obj && typeof obj === 'object' ? (obj as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

function toPositiveInt(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : undefined
}

function nonEmptyString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}
