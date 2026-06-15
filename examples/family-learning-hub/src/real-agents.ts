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

// DeepSeek is OpenAI-compatible — point OpenAIProvider at its base URL (mirrors the
// codex-deepseek-hub sibling; both `…/chat/completions` and `…/v1/chat/completions` work).
export const DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com'
export const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL ?? 'deepseek-chat'

export const TUTOR_ID = 'family-tutor'
export const TUTOR_CAP = 'teach.lesson'

/**
 * The /teach methodology system prompt: read where the learner IS first, advance one
 * small step, self-flag sensitive content, and emit a STRICT JSON contract the workflow
 * can read structurally. The obsidian tools are only present when a vault is wired.
 */
export const TUTOR_SYSTEM = [
  '你是一个家庭学习 hub 里的 AI 导师, 面向儿童, 风格参考 /teach: 先看学习者当前在哪',
  '(读 TA 的学习档案), 再续上下一小步, 讲解简短、适龄、循序渐进。',
  '',
  '工具 (via MCP, 命名空间 `obsidian__`, 仅在接了档案库时可用):',
  '- obsidian__search: 全文搜索整个档案库',
  '- obsidian__list_files_in_dir: 浏览某目录下的笔记 (学习档案在 learning-records/<learnerId>/)',
  '- obsidian__get_file_contents: 按路径读一篇笔记',
  '',
  '每节课你必须:',
  '1. (有工具时) 先 search / list learning-records/<learnerId>/ 看上到第几课, 决定下一课的课号;',
  '   没有档案就从第 1 课开始。',
  '2. 写一节简短、面向儿童的讲解 + 一个小练习。',
  '3. 内容自评打标 (决策 1.a — 这是最弱一层, 背后还有主题白名单 + 家长审核 + 全程转录给家长):',
  '   若涉及投资/理财/赌博/诱导充值消费/联系陌生人等对儿童敏感的主题, flagged=true 并在',
  '   flagReason 一句话说明; 否则 flagged=false。',
  '',
  '输出契约 (硬性): 只输出一个 JSON 对象, 不要任何解释或代码块外的文字:',
  '{"lessonNo": 数字, "title": "标题", "body": "讲解 + 小练习", "flagged": false, "flagReason": ""}',
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
      `请给学习者「${learnerId}」上一节关于「${t}」的课。`,
      '',
      '步骤:',
      hasVault
        ? `1. 先用 obsidian 工具读 learning-records/${learnerId}/ 看 TA 上到第几课、学过什么 (没有记录就从第 1 课开始)。`
        : '1. 这次没有接学习档案库, 就当作第 1 课从头开始。',
      '2. 续上下一课 (lessonNo = 已有最大课号 + 1), 写一节简短、适龄 (面向儿童) 的讲解 + 一个小练习。',
      '3. 自评打标: 若内容涉及投资/理财/赌博/诱导充值消费/联系陌生人等对儿童敏感的主题,',
      '   把 flagged 设为 true 并在 flagReason 一句话说明; 否则 flagged 为 false。',
      '',
      '只输出一个 JSON 对象 (不要任何解释或代码块外的文字):',
      '{"lessonNo": 数字, "title": "标题", "body": "讲解 + 小练习", "flagged": false, "flagReason": ""}',
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
 * Build a valid `Lesson` from the model's text. The model is asked for strict JSON, but we
 * never let a malformed reply break the workflow: missing fields fall back to safe defaults
 * (lessonNo→1, body→the raw text), and `flagged` is `true` ONLY when the model explicitly
 * said so (conservative — a parse miss never silently clears a self-flag the model raised,
 * because the rule-engine layer + whitelist + transcript fork still stand behind it).
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
  return { learnerId, topic, lessonNo, title, body, flagged, ...(flagReason ? { flagReason } : {}) }
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
