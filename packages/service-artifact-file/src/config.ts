/**
 * Config for `@aipehub/service-artifact-file`.
 *
 * yaml shape:
 *
 *   uses:
 *     - type: artifact
 *       impl: file
 *       config:
 *         name: diagnosis-reports     # optional logical name; used for admin UI
 *         maxBytesPerFile: 10485760   # default: 10 MB
 *         allowedMimePrefixes:        # default: ['text/', 'application/']
 *           - text/
 *           - application/json
 *
 * Same defensive shape as the memory plugin: strict keys, unknown
 * fields rejected, scope key tolerated and ignored (the registry
 * already resolved scope before the plugin sees the config).
 */

import { ServiceConfigError } from '@aipehub/services-sdk'

export interface ArtifactFileConfig {
  /** Logical display name shown in admin UI. Defaults to 'default'. */
  readonly name: string
  /** Per-file byte ceiling. Writes above this throw. */
  readonly maxBytesPerFile: number
  /**
   * Allowed mime prefixes (e.g. `text/`, `application/json`). A
   * write whose mime doesn't match any prefix is rejected. Set to
   * `['*']` to allow anything.
   */
  readonly allowedMimePrefixes: ReadonlyArray<string>
}

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024
const DEFAULT_PREFIXES: ReadonlyArray<string> = ['text/', 'application/']

export function validateArtifactFileConfig(raw: unknown): ArtifactFileConfig {
  if (raw != null && typeof raw !== 'object') {
    throw new ServiceConfigError('artifact', 'file', `config must be an object, got ${typeof raw}`)
  }
  const obj = (raw ?? {}) as Record<string, unknown>

  const name = obj.name !== undefined
    ? expectNonEmptyString(obj.name, 'name')
    : 'default'

  const maxBytesPerFile = obj.maxBytesPerFile !== undefined
    ? expectPositiveInt(obj.maxBytesPerFile, 'maxBytesPerFile')
    : DEFAULT_MAX_BYTES

  let allowedMimePrefixes: ReadonlyArray<string> = DEFAULT_PREFIXES
  if (obj.allowedMimePrefixes !== undefined) {
    if (!Array.isArray(obj.allowedMimePrefixes)) {
      throw new ServiceConfigError('artifact', 'file', 'allowedMimePrefixes must be an array')
    }
    const parsed: string[] = []
    for (const p of obj.allowedMimePrefixes) {
      if (typeof p !== 'string' || p.length === 0) {
        throw new ServiceConfigError(
          'artifact', 'file',
          'allowedMimePrefixes entries must be non-empty strings',
        )
      }
      parsed.push(p)
    }
    if (parsed.length === 0) {
      throw new ServiceConfigError(
        'artifact', 'file',
        'allowedMimePrefixes must not be empty when set',
      )
    }
    allowedMimePrefixes = parsed
  }

  const unknown = Object.keys(obj).filter(
    (k) => !['name', 'maxBytesPerFile', 'allowedMimePrefixes', 'scope'].includes(k),
  )
  if (unknown.length > 0) {
    throw new ServiceConfigError(
      'artifact', 'file',
      `unknown config keys: ${unknown.join(', ')}`,
    )
  }

  return { name, maxBytesPerFile, allowedMimePrefixes }
}

function expectNonEmptyString(v: unknown, name: string): string {
  if (typeof v !== 'string' || v.length === 0) {
    throw new ServiceConfigError(
      'artifact', 'file',
      `${name} must be a non-empty string (got ${JSON.stringify(v)})`,
    )
  }
  return v
}

function expectPositiveInt(v: unknown, name: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || Math.floor(v) !== v) {
    throw new ServiceConfigError(
      'artifact', 'file',
      `${name} must be a positive integer (got ${JSON.stringify(v)})`,
    )
  }
  return v
}

/** True iff `mime` matches any prefix in the allow-list. */
export function mimeAllowed(mime: string, prefixes: ReadonlyArray<string>): boolean {
  if (prefixes.includes('*')) return true
  for (const p of prefixes) {
    if (mime.startsWith(p)) return true
  }
  return false
}
