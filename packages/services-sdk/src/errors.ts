/**
 * Typed errors thrown by the SDK so callers can `instanceof` check
 * without parsing strings. Each error keeps a stable `code` for
 * structured logs.
 *
 * Why a custom hierarchy: plugin load failures are not the same shape
 * as agent yaml validation failures, and the admin UI wants to turn
 * each kind into a different HTTP status. Putting that distinction in
 * the type system means there's no "did I spell the error message
 * right" worry at the boundary.
 */

abstract class ServicesSdkError extends Error {
  abstract readonly code: string
  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}

/** A plugin module couldn't be loaded (missing package, bad export). */
export class PluginLoadError extends ServicesSdkError {
  readonly code = 'plugin_load_failed'
  /** The package name that failed to load. */
  readonly packageName: string
  /** The underlying error from `import()` or post-import validation. */
  readonly cause: unknown
  constructor(packageName: string, cause: unknown) {
    super(`failed to load service plugin '${packageName}': ${stringifyCause(cause)}`)
    this.packageName = packageName
    this.cause = cause
  }
}

/** A plugin's reported SDK major doesn't match the host. */
export class PluginVersionMismatchError extends ServicesSdkError {
  readonly code = 'plugin_version_mismatch'
  constructor(public readonly packageName: string, public readonly pluginVersion: string, public readonly hostMajor: number) {
    super(
      `plugin '${packageName}' is built for SDK major ${parseMajorOrDie(pluginVersion)} ` +
        `but host runs major ${hostMajor}`,
    )
  }
}

/** Two plugins claimed the same `(type, impl)` slot. */
export class PluginConflictError extends ServicesSdkError {
  readonly code = 'plugin_conflict'
  constructor(public readonly type: string, public readonly impl: string) {
    super(`a plugin for (type=${type}, impl=${impl}) is already registered`)
  }
}

/** A yaml `uses:` entry asked for an unloaded plugin. */
export class PluginNotFoundError extends ServicesSdkError {
  readonly code = 'plugin_not_found'
  constructor(public readonly type: string, public readonly impl: string) {
    super(`no service plugin registered for type='${type}' impl='${impl}'`)
  }
}

/** A plugin's `validateConfig` rejected the config block. */
export class ServiceConfigError extends ServicesSdkError {
  readonly code = 'service_config_invalid'
  constructor(public readonly type: string, public readonly impl: string, public readonly reason: string) {
    super(`config invalid for (type=${type}, impl=${impl}): ${reason}`)
  }
}

/** Attempted to restore a trash entry into a slot already in use. */
export class TrashRestoreConflictError extends ServicesSdkError {
  readonly code = 'trash_restore_conflict'
  constructor(public readonly trashId: string) {
    super(`cannot restore trash '${trashId}': owner slot is already taken`)
  }
}

// --- helpers ---------------------------------------------------------

function stringifyCause(c: unknown): string {
  if (c instanceof Error) return c.message
  if (typeof c === 'string') return c
  try {
    return JSON.stringify(c)
  } catch {
    return String(c)
  }
}

function parseMajorOrDie(v: string): string {
  const m = /^(\d+)\./.exec(v.trim())
  return m ? m[1]! : '?'
}
