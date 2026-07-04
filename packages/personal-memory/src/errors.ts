/**
 * Typed errors for `@gotong/personal-memory`.
 *
 * Project rule (CLAUDE.md §4.2): throw a typed error with a code, not a
 * bare `Error`. Callers switch on `.code` rather than string-matching a
 * message.
 */

export type PersonalMemoryErrorCode =
  /** A memory-augmented agent was constructed with no memory handle —
   *  neither an explicit `memory` option nor a `services.memory`. */
  | 'memory_handle_required'
  /** Consolidation's summarizer returned empty text — better to abort than
   *  write a useless profile the next pass would absorb again. */
  | 'consolidate_empty'
  /** The distilled profile still exceeds the hard cap after a compression
   *  pass — refuse to write an unbounded profile (Hermes 报错逼蒸). */
  | 'semantic_overflow'

export class PersonalMemoryError extends Error {
  readonly code: PersonalMemoryErrorCode

  constructor(code: PersonalMemoryErrorCode, message: string) {
    super(message)
    this.name = 'PersonalMemoryError'
    this.code = code
  }
}
