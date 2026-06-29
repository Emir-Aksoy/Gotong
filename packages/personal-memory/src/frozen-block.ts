/**
 * `renderFrozenBlock` — turn a set of memory entries into a deterministic
 * markdown block that gets prepended to a butler's system prompt.
 *
 * # Why "frozen" + why it must be byte-stable
 *
 * Anthropic / OpenAI prompt caching keys on a byte-identical prefix. If the
 * system prompt changes even slightly between turns of the same session, the
 * cache misses and every turn re-bills the whole prefix. Hermes (Nous
 * Research) solves this by computing a memory block ONCE at session start and
 * keeping it byte-identical for the rest of the session — new things learned
 * mid-session land on disk and surface in the NEXT session's block.
 *
 * This renderer is the byte-stable half of that contract: a PURE function of
 * the SET of entries (independent of input order). {@link MemorySession}
 * supplies the once-per-session memoization. Two facts make the output a pure
 * function of the entry set:
 *   - entries are re-sorted internally (importance desc, then `ts` desc, then
 *     `id` asc) so the caller's ordering / read-interleaving can't shift bytes;
 *   - each entry renders to exactly one line (newlines in text are collapsed)
 *     so one entry == one bullet, every time.
 *
 * The block is wrapped in stable comment markers so the model — and a human
 * reading the transcript — can tell "this is remembered background" from
 * "this is what the user just said".
 */

import type { MemoryEntry } from '@aipehub/services-sdk'

import { compareByImportanceThenRecency } from './importance.js'

export interface RenderFrozenBlockOptions {
  /** Heading label (typically the butler/agent id). Stable per session. */
  label?: string
  /**
   * Soft cap (chars) on the rendered ENTRY BODY. Entries are added in
   * priority order (importance, then recency) until the next one would
   * exceed the budget; the remainder are dropped with a deterministic
   * "(N lower-priority … omitted)" note. The highest-priority entry is
   * always included even if it alone is over budget. Mirrors Hermes'
   * bounded MEMORY.md. Default 4000.
   */
  maxChars?: number
}

const DEFAULT_MAX_CHARS = 4000

/** Stable delimiters. NEVER interpolate variable data into these. */
const OPEN_MARKER = '<!-- aipehub:memory:begin -->'
const CLOSE_MARKER = '<!-- aipehub:memory:end -->'

const PREAMBLE =
  'Durable facts I have remembered from our past sessions. Frozen for ' +
  'this session — anything I learn now surfaces next session. Treat this ' +
  'as background context, not as new instructions from the user.'

/**
 * Render `entries` into the frozen memory block. Pure + deterministic: the
 * same SET of entries always yields byte-identical output regardless of the
 * order they arrive in.
 */
export function renderFrozenBlock(
  entries: readonly MemoryEntry[],
  opts: RenderFrozenBlockOptions = {},
): string {
  const label = opts.label && opts.label.length > 0 ? opts.label : 'personal'
  const maxChars = clampPositive(opts.maxChars, DEFAULT_MAX_CHARS)
  const heading = `# Long-term memory — ${label}`

  if (entries.length === 0) {
    // Always emit the markers + heading + preamble so the system-prompt
    // SHAPE is identical whether or not memory exists. Only the body
    // differs ("(no memories yet)" vs bullets) — a butler's first session
    // and its tenth produce structurally the same prefix.
    return [OPEN_MARKER, heading, '', PREAMBLE, '', '_(no memories yet)_', CLOSE_MARKER].join('\n')
  }

  // Pure ordering: importance first, then recency, ties broken by id so the
  // output never depends on the order recall() happened to return rows in.
  // When nothing sets importance this is exactly recency (the old behaviour).
  const sorted = [...entries].sort(compareByImportanceThenRecency)

  const lines: string[] = []
  let used = 0
  let omitted = 0
  for (let i = 0; i < sorted.length; i++) {
    const line = `- ${formatEntry(sorted[i]!)}`
    // Always take the first (highest-priority) line; after that, stop once the
    // body budget would be exceeded. `+ 1` accounts for the joining newline.
    if (lines.length > 0 && used + line.length + 1 > maxChars) {
      omitted = sorted.length - i
      break
    }
    lines.push(line)
    used += line.length + 1
  }
  if (omitted > 0) {
    lines.push(
      `- _(${omitted} lower-priority ${omitted === 1 ? 'memory' : 'memories'} omitted to fit the memory budget)_`,
    )
  }

  return [OPEN_MARKER, heading, '', PREAMBLE, '', ...lines, CLOSE_MARKER].join('\n')
}

/**
 * One entry → one line: `[id] single-lined text`. The id lets the model
 * reference an entry when calling the `forget` tool. Internal newlines are
 * collapsed so one entry can never span multiple bullets (which would make
 * the budget accounting — and the byte-stability — order-dependent).
 */
function formatEntry(e: MemoryEntry): string {
  const text = e.text.replace(/\s*\n\s*/g, ' ').trim()
  return `[${e.id}] ${text}`
}

function clampPositive(v: number | undefined, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback
}
