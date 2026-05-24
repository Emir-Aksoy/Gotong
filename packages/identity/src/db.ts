/**
 * better-sqlite3 thin wrapper for @aipehub/identity.
 *
 * Mirrors the loader strategy used in `@aipehub/service-datastore-sqlite`:
 * `createRequire` so we can synchronously load the native CJS binding
 * from an ESM module without an `await import` hop. better-sqlite3 is
 * declared as a peer dependency — install fails loudly when missing.
 *
 * The structural types (`SqliteDb` / `SqliteStmt`) intentionally
 * mirror only the surface we touch; we do NOT type-pin to a specific
 * better-sqlite3 version so a peer-dep major bump doesn't break our
 * tsc.
 */

import { createRequire } from 'node:module'
import { mkdirSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'

export interface SqliteDb {
  prepare(sql: string): SqliteStmt
  exec(sql: string): void
  pragma(s: string): unknown
  close(): void
  readonly open: boolean
}
export interface SqliteStmt {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint }
  all(...params: unknown[]): unknown[]
  get(...params: unknown[]): unknown
}

const cjsRequire = createRequire(import.meta.url)

/**
 * Open (or create) the identity database. Special-cases ':memory:' for
 * tests — mkdir would barf on the literal string otherwise.
 */
export function openDb(path: string): SqliteDb {
  let Ctor: new (p: string) => SqliteDb
  try {
    Ctor = cjsRequire('better-sqlite3') as new (p: string) => SqliteDb
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err)
    throw new Error(
      `@aipehub/identity requires the 'better-sqlite3' peer dependency.\n  ${cause}`,
    )
  }
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true })
  }
  const db = new Ctor(path)
  // V4-AUDIT-02: harden file mode to 0o600 before the first write —
  // contains password scrypt hashes, sha256-hashed API tokens, and live
  // session tokens (those are the most sensitive: leaking them = direct
  // account takeover). Better-sqlite3 creates the file with the process
  // umask (typically 022 → 0o644 world-readable). chmod ASAP closes
  // the window between create and harden. POSIX only — Windows uses
  // ACLs, and exFAT / SMB sometimes refuse chmod (tolerate).
  if (path !== ':memory:' && process.platform !== 'win32') {
    try {
      chmodSync(path, 0o600)
    } catch {
      /* tolerate exFAT / SMB / sandboxed fs that reject chmod */
    }
  }
  // WAL: concurrent readers + one writer. Same default as service-
  // datastore-sqlite for consistency.
  db.pragma('journal_mode = WAL')
  // FK enforcement is off by default in SQLite — turn it on so our
  // ON DELETE CASCADE rules actually fire.
  db.pragma('foreign_keys = ON')
  return db
}

/**
 * Run `cb` inside a SQLite transaction. Commits on success, rolls back
 * on any throw. Re-throws the original error.
 *
 * We don't use better-sqlite3's `db.transaction(fn)` wrapper because
 * it returns a callable — too magical for this codebase's preference
 * for explicit control flow.
 */
export function transaction<T>(db: SqliteDb, cb: () => T): T {
  db.exec('BEGIN')
  try {
    const out = cb()
    db.exec('COMMIT')
    return out
  } catch (err) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // ignore — rollback failure shouldn't mask the real error
    }
    throw err
  }
}
