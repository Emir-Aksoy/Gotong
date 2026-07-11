/**
 * Pure-function parser: raw IM message text → `ImCommand` discriminated union.
 *
 * Recognised forms (case-insensitive on the verb; payload preserved
 * verbatim where it matters):
 *
 *   `/help` `/?` `/h`         → { kind: 'help' }
 *   `/bind 123456`            → { kind: 'bind', code: '123456' }
 *   `/unbind` `/disconnect`   → { kind: 'unbind' }
 *   `/agents` `/who`          → { kind: 'agents' }
 *   `/workflow <name> <args>` → { kind: 'workflow', name, args }
 *   `/wf <name> <args>`       (alias)
 *   `/inbox` `/pending`       → { kind: 'inbox' }            (IMA-M1)
 *   `/approve <shortId>`      → { kind: 'approve', shortId }
 *   `/deny <shortId>`         → { kind: 'deny', shortId }    (`/reject` alias)
 *
 * Anything else (including leading-`/` text whose verb we don't
 * recognise) falls through to `{ kind: 'free', text }` with the
 * ORIGINAL text preserved. That way an unknown slash isn't silently
 * dropped — the bridge can echo it into the Hub and let an agent
 * decide how to handle it (LlmAgent prompts often handle natural-
 * language commands fine).
 *
 * Why a pure function (not a class or registry):
 *   - Concrete bridges are tiny processes; one regex + switch is
 *     cheaper than instantiating a parser per platform.
 *   - The command vocabulary is global across bridges (consistent UX:
 *     `/bind` works the same on Telegram and Slack). A registry would
 *     tempt per-bridge dialect drift.
 *   - Unit-testable in isolation; no setup.
 *
 * Bot-mention prefixes are NOT stripped here — the concrete bridge
 * peels them (e.g. Slack `<@U123>` mention, Telegram `/bind@MyBot`)
 * before calling us. Keeping that out of this parser means it stays
 * platform-agnostic.
 */

import type { ImCommand } from './types.js'

/**
 * Strip the platform-specific `/cmd@BotName` suffix that some IM
 * clients append when the same command is enabled in multiple bots.
 * Idempotent on inputs that don't have one.
 */
function stripBotMentionSuffix(token: string): string {
  const at = token.indexOf('@')
  return at === -1 ? token : token.slice(0, at)
}

export function parseImCommand(raw: string): ImCommand {
  // Defensive: bridges should not pass non-strings, but tests inject
  // weird values. Return the canonical free-text fallback.
  if (typeof raw !== 'string') return { kind: 'free', text: '' }
  const trimmed = raw.trim()
  if (trimmed.length === 0) return { kind: 'free', text: '' }

  // Anything not starting with `/` is free-text.
  if (trimmed[0] !== '/') return { kind: 'free', text: trimmed }

  // Split on whitespace; keep the rest as a single rest-string so
  // workflow args carry their original spacing.
  // `/foo bar baz` → cmd='foo', rest='bar baz'
  const spaceAt = trimmed.search(/\s/)
  const rawCmd = spaceAt === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceAt)
  const rest = spaceAt === -1 ? '' : trimmed.slice(spaceAt + 1).trim()
  const verb = stripBotMentionSuffix(rawCmd).toLowerCase()

  switch (verb) {
    case 'help':
    case 'h':
    case '?': // some clients let users type `/?`; we accept it
      return { kind: 'help' }

    case 'bind': {
      const code = rest.split(/\s+/)[0] ?? ''
      // Empty / whitespace-only code → "free" with the original text
      // so the bridge can render the help reply. We could return
      // `{ kind: 'bind', code: '' }` and force the bridge to handle,
      // but having a dedicated "show help" branch on empty is more
      // self-evident for bridge authors.
      if (code.length === 0) return { kind: 'free', text: trimmed }
      return { kind: 'bind', code }
    }

    case 'unbind':
    case 'disconnect':
      return { kind: 'unbind' }

    case 'agents':
    case 'who':
      return { kind: 'agents' }

    // IMA-M1 — the approval loop. `/inbox` lists; `/approve`+`/deny` act on an
    // itemId prefix. A missing prefix falls through to `free` (like `/bind`
    // with no code) so the bridge renders the help reply instead of guessing.
    case 'inbox':
    case 'pending':
      return { kind: 'inbox' }

    case 'approve': {
      const shortId = rest.split(/\s+/)[0] ?? ''
      if (shortId.length === 0) return { kind: 'free', text: trimmed }
      return { kind: 'approve', shortId }
    }

    case 'deny':
    case 'reject': {
      const shortId = rest.split(/\s+/)[0] ?? ''
      if (shortId.length === 0) return { kind: 'free', text: trimmed }
      return { kind: 'deny', shortId }
    }

    case 'workflow':
    case 'wf': {
      const restTrim = rest.trim()
      if (restTrim.length === 0) {
        // `/workflow` alone is ambiguous; punt to free so the bridge
        // can echo a hint.
        return { kind: 'free', text: trimmed }
      }
      const firstSpace = restTrim.search(/\s/)
      if (firstSpace === -1) {
        return { kind: 'workflow', name: restTrim, args: '' }
      }
      return {
        kind: 'workflow',
        name: restTrim.slice(0, firstSpace),
        args: restTrim.slice(firstSpace + 1).trim(),
      }
    }

    default:
      // Unknown slash-command — keep the original text so an LLM-
      // backed default agent can still try to make sense of it.
      return { kind: 'free', text: trimmed }
  }
}
