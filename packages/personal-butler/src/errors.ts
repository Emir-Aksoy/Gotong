/**
 * Typed errors for `@gotong/personal-butler`.
 *
 * Project rule (CLAUDE.md §4.2): throw a typed error with a code, not a bare
 * `Error`. Callers switch on `.code` rather than string-matching a message.
 */

export type ButlerErrorCode =
  /** A `GovernedActionToolset` was built with no tool specs. */
  | 'no_governed_tools'
  /** Two governed tool specs share a name — `callTool` would mis-route. */
  | 'duplicate_governed_tool'
  /** Task notebook (TN-M1): the referenced task doesn't exist or is closed. */
  | 'task_note_not_found'
  /** Task notebook (TN-M1): bad input (empty / too long / bad step index). */
  | 'task_note_invalid'
  /** Task notebook (TN-M1): an explicit cap refused the op (no silent caps). */
  | 'task_note_limit'
  /** Knowledge library (LIB-M2): bad path / bad content / wrong area. */
  | 'knowledge_invalid'
  /** Knowledge library (LIB-M2): the referenced file doesn't exist. */
  | 'knowledge_not_found'
  /** Knowledge library (LIB-M2): an explicit cap refused the op (no silent caps). */
  | 'knowledge_limit'

export class ButlerError extends Error {
  readonly code: ButlerErrorCode

  constructor(code: ButlerErrorCode, message: string) {
    super(message)
    this.name = 'ButlerError'
    this.code = code
  }
}
