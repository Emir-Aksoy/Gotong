/**
 * `datastore:sqlite` plugin config.
 *
 * Two fields the agent yaml typically sets:
 *
 *   uses:
 *     - type: datastore
 *       impl: sqlite
 *       config:
 *         name: cases             # required — also the .sqlite filename
 *         schema: |
 *           CREATE TABLE IF NOT EXISTS cases (
 *             id TEXT PRIMARY KEY, industry TEXT, ts INTEGER
 *           );
 *         scope: private          # optional; default 'private'
 *         maxBytes: 50_000_000    # optional admin guardrail
 *
 * Validation is strict — unknown keys throw. The `name` field doubles
 * as the file name on disk, so it has the same character set
 * restrictions as agent ids (URL- + filesystem-safe).
 */

import { ServiceConfigError } from '@aipehub/services-sdk'

export interface DatastoreSqliteConfig {
  /**
   * Human + filesystem name for this datastore. Becomes the file
   * stem under `<owner>/<name>.sqlite`. Two datastores attached on
   * the same owner with different names get isolated files. URL-safe
   * characters only (same set as agent ids).
   */
  readonly name: string
  /**
   * Optional `CREATE TABLE`-style DDL run at every `attach`. SQLite's
   * `IF NOT EXISTS` clauses make repeated runs idempotent, which is
   * what we want. Plugin authors that need migrations beyond this
   * should ship a richer plugin (e.g. `datastore:sqlite-versioned`).
   */
  readonly schema?: string
  /**
   * Soft cap on the .sqlite file size in bytes. The plugin checks
   * before every `exec` and refuses writes that would cross the
   * threshold. Reads are always allowed. Default: 50 MB.
   */
  readonly maxBytes: number
}

/** Default cap to keep a runaway INSERT loop from blowing the disk. */
export const DEFAULT_MAX_BYTES = 50 * 1024 * 1024

/** Validate + normalise a raw yaml config blob into a DatastoreSqliteConfig. */
export function validateDatastoreSqliteConfig(raw: unknown): DatastoreSqliteConfig {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ServiceConfigError('datastore', 'sqlite', `config must be an object (got ${typeKind(raw)})`)
  }
  const c = raw as Record<string, unknown>
  // Known + ignored keys: 'scope' is consumed by the Hub before the
  // plugin sees it — accept silently so a yaml that includes scope
  // round-trips through validateConfig cleanly.
  const allowed = new Set(['name', 'schema', 'maxBytes', 'scope'])
  for (const k of Object.keys(c)) {
    if (!allowed.has(k)) {
      throw new ServiceConfigError('datastore', 'sqlite', `unknown config keys: ${k}`)
    }
  }
  if (typeof c.name !== 'string' || c.name.length === 0) {
    throw new ServiceConfigError('datastore', 'sqlite', `name is required (non-empty string)`)
  }
  if (!/^[A-Za-z0-9._-]+$/.test(c.name)) {
    throw new ServiceConfigError(
      'datastore', 'sqlite',
      `name must match [A-Za-z0-9._-]+ — got '${c.name}'`,
    )
  }
  if (c.schema !== undefined && typeof c.schema !== 'string') {
    throw new ServiceConfigError('datastore', 'sqlite', `schema must be a string when present`)
  }
  let maxBytes = DEFAULT_MAX_BYTES
  if (c.maxBytes !== undefined) {
    if (
      typeof c.maxBytes !== 'number' ||
      !Number.isFinite(c.maxBytes) ||
      !Number.isInteger(c.maxBytes) ||
      c.maxBytes <= 0
    ) {
      throw new ServiceConfigError('datastore', 'sqlite', `maxBytes must be a positive integer`)
    }
    maxBytes = c.maxBytes
  }
  const out: DatastoreSqliteConfig = {
    name: c.name,
    maxBytes,
    ...(typeof c.schema === 'string' ? { schema: c.schema } : {}),
  }
  return out
}

function typeKind(v: unknown): string {
  if (Array.isArray(v)) return 'array'
  if (v === null) return 'null'
  return typeof v
}
