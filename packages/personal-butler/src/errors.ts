/**
 * Typed errors for `@aipehub/personal-butler`.
 *
 * Project rule (CLAUDE.md §4.2): throw a typed error with a code, not a bare
 * `Error`. Callers switch on `.code` rather than string-matching a message.
 */

export type ButlerErrorCode =
  /** A `GovernedActionToolset` was built with no tool specs. */
  | 'no_governed_tools'
  /** Two governed tool specs share a name — `callTool` would mis-route. */
  | 'duplicate_governed_tool'

export class ButlerError extends Error {
  readonly code: ButlerErrorCode

  constructor(code: ButlerErrorCode, message: string) {
    super(message)
    this.name = 'ButlerError'
    this.code = code
  }
}
