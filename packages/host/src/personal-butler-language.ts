/**
 * A3 成员语言偏好 — let a member pin the language the butler replies in, so a
 * trilingual user (中文 / English / Türkçe …) isn't left to the model's guess
 * every turn. Two halves, both zero-LLM:
 *
 *  - a benign `set_reply_language` tool the butler calls when the member says
 *    "以后都用中文" / "reply in English" / "Türkçe konuş" — it writes a tiny
 *    per-user preference file (empty value clears it);
 *  - a per-turn probe that injects "用<语言>回复" into the contextProbe tail
 *    while a preference is set, and NOTHING when it isn't (no preference → the
 *    butler keeps matching the member's input language, byte-identical prompt).
 *
 * State lives in a `prefs/` SIBLING of the memory tree (like A2's presence),
 * NOT under butler/memory/…, so the opt-in memory git snapshot (MU-M5) stays
 * clean. Setting a preference affects nobody else, so the tool is benign (same
 * class as `set_reminder`), never gated. The framework runs no model here — the
 * card is a fixed template around the stored string.
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { LlmAgentToolset, LlmToolCallResult, LlmToolDefinition } from '@gotong/llm'

/** A stored language label is free text (any language) but length-capped so a
 *  runaway value can't bloat every prompt tail. */
const MAX_LANG_LEN = 40

export interface ButlerLanguageDeps {
  /** Per-user `reply-language.json` path (a `prefs/` sibling of the memory tree). */
  file: string
  logger?: { warn(msg: string, meta?: Record<string, unknown>): void }
}

// ── preference file I/O ──────────────────────────────────────────────────────

/** Read the pinned language; missing / corrupt / empty → null (no preference). */
export async function readReplyLanguage(file: string): Promise<string | null> {
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch {
    return null
  }
  try {
    const v = JSON.parse(raw) as { language?: unknown } | null
    if (v && typeof v.language === 'string') {
      const lang = v.language.trim()
      return lang.length > 0 ? lang : null
    }
    return null
  } catch {
    return null
  }
}

/** Persist the pinned language atomically (tmp+rename). */
export async function writeReplyLanguage(file: string, language: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  await writeFile(tmp, `${JSON.stringify({ language })}\n`, 'utf8')
  await rename(tmp, file)
}

/** Remove the preference (best-effort — a missing file is already "cleared"). */
export async function clearReplyLanguage(file: string): Promise<void> {
  await rm(file, { force: true })
}

// ── the injected card ────────────────────────────────────────────────────────

/** Render the language-preference card (never called with an empty language). */
export function buildLanguageCard(language: string): string {
  return (
    `【语言偏好 · 系统注入】用户希望你用「${language}」回复。` +
    `请始终用这个语言回应,除非用户在当前这条消息里明确改用别的语言。这是系统提示,别复述给用户。`
  )
}

// ── the per-turn probe ───────────────────────────────────────────────────────

/** Build the probe: inject the card while a preference is set, else null. */
export function buildButlerLanguageProbe(deps: ButlerLanguageDeps): () => Promise<string | null> {
  return async () => {
    const lang = await readReplyLanguage(deps.file)
    return lang ? buildLanguageCard(lang) : null
  }
}

// ── the benign `set_reply_language` tool ─────────────────────────────────────

const SET_LANGUAGE_TOOL: LlmToolDefinition = {
  name: 'set_reply_language',
  description:
    '用户明确表示希望你以后用某种语言回复(如「以后都用中文」「reply in English」「Türkçe konuş」)时调用,把偏好记下来——之后每轮我都会提醒你用这个语言。用户说「不用固定了/随我说的语言来」时,用空字符串调用来清除。不确定就先问,别自作主张。',
  inputSchema: {
    type: 'object',
    properties: {
      language: {
        type: 'string',
        description: '偏好的回复语言,用用户听得懂的写法(如 "中文"、"English"、"Türkçe")。空字符串 = 清除偏好。',
      },
    },
    required: ['language'],
    additionalProperties: false,
  },
}

class ButlerLanguageToolset implements LlmAgentToolset {
  constructor(private readonly deps: ButlerLanguageDeps) {}

  listTools(): LlmToolDefinition[] {
    return [SET_LANGUAGE_TOOL]
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<LlmToolCallResult> {
    if (name !== 'set_reply_language') return text(`未知工具:${name}`, true)
    const raw = typeof args.language === 'string' ? args.language.trim() : ''
    try {
      if (raw.length === 0) {
        await clearReplyLanguage(this.deps.file)
        return text('好,以后不固定语言了,我会随你当下说的语言来。')
      }
      const lang = raw.length > MAX_LANG_LEN ? raw.slice(0, MAX_LANG_LEN) : raw
      await writeReplyLanguage(this.deps.file, lang)
      return text(`好,记下了:以后我都用「${lang}」回复你。`)
    } catch (err) {
      this.deps.logger?.warn('butler language: write failed', { err })
      return text('没记上(写入失败),待会儿再试一次吧。', true)
    }
  }
}

/** Build the benign language-preference toolset (always offered — setting your
 *  own reply language consequences nobody else). */
export function buildButlerLanguageToolset(deps: ButlerLanguageDeps): LlmAgentToolset {
  return new ButlerLanguageToolset(deps)
}

function text(t: string, isError = false): LlmToolCallResult {
  return isError
    ? { content: [{ type: 'text', text: t }], isError: true }
    : { content: [{ type: 'text', text: t }] }
}
