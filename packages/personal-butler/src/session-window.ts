/**
 * session-window.ts — the butler's per-member rolling conversation window.
 *
 * # Why this exists (the "查一下 → 查什么?" bug)
 *
 * Every IM message (and every /me quick-chat line) dispatches as a FRESH task:
 * the model's `messages` array held only the current sentence. Continuity
 * leaned entirely on retrieval-style memory (episodic capture → frozen-block
 * re-recall), which answers "what do I know about this member" — not "what did
 * I just say and what am I waiting for". A member answering "查一下" to a
 * question the butler asked one turn ago hit a model with zero structural
 * signal that this replies to its own question.
 *
 * The fix mirrors the industry split (Hermes sessions, and our own
 * `MemoryAugmentedAgent` doc: "a bounded conversation rides recent turns on
 * its in-context history"): IN-conversation continuity = a small rolling
 * transcript that rides `payload.history` (a seam `LlmAgent.buildRequest`
 * has always had); CROSS-conversation continuity stays with the memory
 * system (captureTurn + 6h distillation), unchanged.
 *
 * # Boundaries
 *
 * - BUTLER-LAYER, not framework: pure fs + types — no hub, no host import.
 * - Window ≠ memory: entries here are a short-lived rendering aid; the
 *   long-term record is still episodic capture + distillation. Nothing reads
 *   this file except the dispatch path that feeds the next turn.
 * - Window ≠ authorization: history in the prompt grants nothing; governed
 *   actions still park.
 * - All thresholds are constants (no knobs): an hour of silence starts a
 *   fresh conversation; the window keeps the last {@link SESSION_MAX_TURNS}
 *   entries, each clipped to {@link SESSION_TURN_MAX_CHARS} chars.
 *
 * # File discipline
 *
 * One JSON file per member under the host-passed root
 * (`<space>/butler/sessions/<userId>.json`). Single process, single writer
 * per user (writes serialize on a per-user promise chain — the IM bridge,
 * the /me chat route and the push-back seam all live in the host process).
 * Writes land via tmp+rename. A corrupt file is QUARANTINED
 * (`.corrupt-<ts>`), never silently destroyed, and the window restarts empty
 * — losing a window is cheap (memory still has the turns); losing the turn
 * you are ABOUT to send is not, so append never throws on a bad prior file.
 */

import { mkdir, readFile, rename } from 'node:fs/promises'
import { join } from 'node:path'

import { writeFileAtomic } from '@gotong/core'

/** A conversation goes stale after an hour of silence — the next message
 *  starts a fresh window (the old turns are already in episodic memory). */
export const SESSION_IDLE_MS = 60 * 60 * 1000
/** Max entries kept (user + assistant each count as one). Oldest drop first. */
export const SESSION_MAX_TURNS = 12
/** Per-entry char clip — a pasted wall of text must not crowd out the rest. */
export const SESSION_TURN_MAX_CHARS = 2000

export type SessionRole = 'user' | 'assistant'

/**
 * One rendered history message. Deliberately NARROWER than `LlmMessage`
 * (content is always plain text) so it stays assignable both to
 * `payload.history` (llm's builder) and to the web /me duck surface without
 * either side importing the other.
 */
export interface SessionMessage {
  role: SessionRole
  content: string
}

interface SessionTurnRecord {
  role: SessionRole
  text: string
  at: number
}

interface SessionFileShape {
  v: 1
  turns: SessionTurnRecord[]
}

export interface SessionWindowLogger {
  warn(msg: string, meta?: Record<string, unknown>): void
}

export interface ButlerSessionWindowOptions {
  /** Directory holding one `<userId>.json` per member; created on demand. */
  rootDir: string
  /** Injectable clock (tests). */
  now?: () => number
  logger?: SessionWindowLogger
}

export class ButlerSessionWindow {
  private readonly rootDir: string
  private readonly now: () => number
  private readonly logger: SessionWindowLogger | undefined
  /** Per-user write serialization — same discipline as TaskNotebook. */
  private readonly chains = new Map<string, Promise<void>>()

  constructor(opts: ButlerSessionWindowOptions) {
    this.rootDir = opts.rootDir
    this.now = opts.now ?? Date.now
    this.logger = opts.logger
  }

  /**
   * The prior turns of the CURRENT conversation, rendered ready for
   * `payload.history`. Returns `[]` when there is no live conversation
   * (no file, corrupt file, or idle past {@link SESSION_IDLE_MS}).
   *
   * Rendering guarantees a provider-safe shape:
   * - consecutive same-role entries merge into one message (strict-alternation
   *   providers reject back-to-back same-role turns);
   * - a trailing `user` entry is DROPPED — the current sentence is appended by
   *   `LlmAgent.buildRequest` right after this history, and two user messages
   *   in a row would break alternation. (A trailing user entry only exists
   *   when the previous turn produced no reply at all — rare, and that text
   *   is already in episodic memory.)
   */
  async history(userId: string): Promise<SessionMessage[]> {
    const turns = await this.readTurns(userId)
    if (turns.length === 0) return []
    if (this.isStale(turns)) return []

    const merged: { role: SessionRole; parts: string[] }[] = []
    for (const t of turns) {
      const last = merged[merged.length - 1]
      if (last && last.role === t.role) last.parts.push(t.text)
      else merged.push({ role: t.role, parts: [t.text] })
    }
    if (merged.length > 0 && merged[merged.length - 1]!.role === 'user') merged.pop()
    return merged.map((m) => ({ role: m.role, content: m.parts.join('\n\n') }))
  }

  /**
   * Record one said thing. `user` entries land BEFORE dispatch (said is said,
   * even if the model then fails); `assistant` entries are whatever actually
   * went back to the member — the direct reply, or an async push-back
   * (escalation result, run broadcast), which is exactly what the next turn
   * must know the butler already said. Empty/whitespace text is a no-op.
   * Never throws: losing a window entry must not fail the turn.
   */
  append(userId: string, role: SessionRole, text: string): Promise<void> {
    const clipped = clip(text)
    if (clipped.length === 0) return Promise.resolve()
    const prev = this.chains.get(userId) ?? Promise.resolve()
    const next = prev.then(async () => {
      try {
        const turns = await this.readTurns(userId)
        const at = this.now()
        const live = this.isStale(turns) ? [] : turns
        live.push({ role, text: clipped, at })
        const trimmed = live.slice(-SESSION_MAX_TURNS)
        await mkdir(this.rootDir, { recursive: true })
        const shape: SessionFileShape = { v: 1, turns: trimmed }
        await writeFileAtomic(this.fileFor(userId), JSON.stringify(shape))
      } catch (err) {
        this.logger?.warn('session window: append failed', { userId, err: String(err) })
      }
    })
    // Keep the chain alive even after a swallowed failure.
    this.chains.set(userId, next)
    return next
  }

  private isStale(turns: SessionTurnRecord[]): boolean {
    const last = turns[turns.length - 1]
    if (!last) return false
    return this.now() - last.at > SESSION_IDLE_MS
  }

  private fileFor(userId: string): string {
    // userIds are already filesystem-safe in this repo; encode defensively so
    // a hostile id can never traverse out of rootDir.
    return join(this.rootDir, `${encodeURIComponent(userId)}.json`)
  }

  private async readTurns(userId: string): Promise<SessionTurnRecord[]> {
    const file = this.fileFor(userId)
    let raw: string
    try {
      raw = await readFile(file, 'utf8')
    } catch {
      return [] // no window yet
    }
    try {
      const parsed = JSON.parse(raw) as Partial<SessionFileShape>
      if (parsed.v !== 1 || !Array.isArray(parsed.turns)) throw new Error('bad shape')
      return parsed.turns.filter(
        (t): t is SessionTurnRecord =>
          !!t &&
          (t.role === 'user' || t.role === 'assistant') &&
          typeof t.text === 'string' &&
          typeof t.at === 'number',
      )
    } catch (err) {
      // Quarantine, never destroy — same posture as TaskNotebook.
      const quarantine = `${file}.corrupt-${this.now()}`
      try {
        await rename(file, quarantine)
        this.logger?.warn('session window: corrupt file quarantined', { userId, quarantine })
      } catch {
        this.logger?.warn('session window: corrupt file unreadable', { userId, err: String(err) })
      }
      return []
    }
  }
}

function clip(text: string): string {
  const t = text.trim()
  if (t.length <= SESSION_TURN_MAX_CHARS) return t
  return t.slice(0, SESSION_TURN_MAX_CHARS - 1) + '…'
}
