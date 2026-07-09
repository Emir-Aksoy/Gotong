/**
 * A4 来源渠道感知 — a zero-LLM per-turn card that tells the butler WHICH IM
 * channel the current message arrived on, so a weak model shapes its reply for
 * a chat bubble instead of dumping a Markdown wall.
 *
 * # Why this helps
 *
 * Every Gotong IM bridge (Telegram / 飞书 / Slack / Discord / Matrix / QQ) sends
 * the reply as PLAIN TEXT — Telegram `sendMessage` with no `parse_mode`, Lark's
 * plain-text msg_type, Matrix/Discord `m.text`, QQ `text/plain`, Slack mrkdwn
 * (which is NOT standard Markdown). So a reply full of tables, `**bold**`, `#`
 * headings, or fenced code blocks shows up as literal symbols in the chat app —
 * hard to read on a phone. A butler that knows "this came from Telegram" can
 * keep it short, spoken, and answer-first. When the SAME member chats through
 * the web /me console (which DOES render Markdown), no `im:` task arrives → no
 * card → full formatting is fine.
 *
 * # How — read the task, inject nothing new
 *
 * The platform is ALREADY on the task the butler handles: the IM router stamps
 * `from = im:<platform>:<platformUserId>` (universal to every IM dispatch) and
 * `title = im:<platform>` (butler free-text path). This probe just parses that —
 * no change to the protocol/core `TaskOrigin`, no change to `im-bridge.ts`. It
 * rides the same per-turn `contextProbe` tail as the clock / 语言 / 待办 cards,
 * so the byte-stable frozen block (cache prefix) is untouched, and it self-gates:
 * a non-IM turn (web console, reminder, proactive push) has no `im:` id → null →
 * byte-identical prompt. Pure string parsing; the framework runs no model here.
 */

import type { Task } from '@gotong/core'

import type { ButlerContextProbe } from '@gotong/personal-butler'

/** The IM router's id convention (see `makeFromId` / the free-text dispatch in
 *  `im-bridge.ts`): `im:<platform>:<rest>` on `from`, `im:<platform>` on `title`.
 *  One regex handles both — capture the platform, ignore any `:` tail. */
const IM_ID_RE = /^im:([a-z0-9_-]+)(?::|$)/

/** Friendly, member-facing names for the platforms we bridge. An unknown
 *  platform falls back to its raw id (never fabricate a prettier name). */
const PLATFORM_NAMES: Record<string, string> = {
  telegram: 'Telegram',
  lark: '飞书 (Lark)',
  slack: 'Slack',
  discord: 'Discord',
  matrix: 'Matrix',
  qq: 'QQ',
  wechat: '微信 (WeChat)',
}

/** Extract the IM platform from a task's `from` (preferred — universal to every
 *  IM dispatch) or `title` (butler free-text fallback); null when neither is an
 *  `im:` id (web console / reminder / proactive push → no source card). */
export function parseImPlatform(task: Pick<Task, 'from' | 'title'>): string | null {
  for (const candidate of [task.from, task.title]) {
    if (typeof candidate !== 'string') continue
    const m = IM_ID_RE.exec(candidate)
    if (m?.[1]) return m[1]
  }
  return null
}

/** Map a platform id to its member-facing name (raw id if unmapped). */
export function platformDisplayName(platform: string): string {
  return PLATFORM_NAMES[platform] ?? platform
}

/** Render the source-channel card (never called for a non-IM turn). */
export function buildSourceCard(platform: string): string {
  const name = platformDisplayName(platform)
  return (
    `【来源渠道 · 系统注入】这条消息来自「${name}」聊天窗，你的回复会以纯文本送达用户的聊天应用(多半在手机上)。` +
    `请保持简短、口语、要点先行；别用表格、堆叠的 Markdown(**、#、多层项目符号)或长代码块——它们在聊天气泡里会显示成原始符号,很难读。` +
    `这是系统提示,别复述给用户。`
  )
}

/**
 * Build the per-turn probe: inject the source card when the message arrived on a
 * known IM channel, else null. Unlike the clock / 语言 probes, this one READS the
 * task (the platform lives on `from` / `title`) — the first probe to use its
 * argument. Pure + synchronous work wrapped in the async probe contract.
 */
export function buildButlerSourceProbe(): ButlerContextProbe {
  return async (task: Task) => {
    const platform = parseImPlatform(task)
    return platform ? buildSourceCard(platform) : null
  }
}
