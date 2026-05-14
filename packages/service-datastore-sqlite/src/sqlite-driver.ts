/**
 * better-sqlite3 thin wrapper.
 *
 * Mirrors the strategy in `@aipehub/core/storage/sqlite.ts`:
 * `createRequire` for synchronous CJS loading so the constructor stays
 * sync (no `await import('better-sqlite3')`). The native bindings are
 * declared as a required peer dep — install fails fast if missing.
 *
 * Why hand-roll a wrapper instead of re-using `SqliteStorage`:
 *   - `SqliteStorage` is shaped for the Hub transcript (one append-
 *     only `transcript` table). We need a free-form KV + arbitrary
 *     SQL surface that doesn't pre-declare schema.
 *   - The driver here is intentionally untyped beyond the structural
 *     shape we touch; we don't want to type-pin to a specific
 *     better-sqlite3 version.
 */

import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

interface RawDb {
  prepare(sql: string): RawStmt
  exec(sql: string): void
  pragma(s: string): unknown
  close(): void
  readonly open: boolean
}
interface RawStmt {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint }
  all(...params: unknown[]): unknown[]
  get(...params: unknown[]): unknown
}

const cjsRequire = createRequire(import.meta.url)

/**
 * Open a better-sqlite3 database. Throws a friendly error when the
 * native peer dep isn't installed. Parent directories are created
 * automatically — agent yaml authors don't need to mkdir by hand.
 */
export function openDb(path: string): RawDb {
  let Ctor: new (p: string) => RawDb
  try {
    Ctor = cjsRequire('better-sqlite3') as new (p: string) => RawDb
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err)
    throw new Error(
      `datastore:sqlite requires the 'better-sqlite3' package — install it in the host workspace.\n  ${cause}`,
    )
  }
  mkdirSync(dirname(path), { recursive: true })
  const db = new Ctor(path)
  // WAL mode is the right default for our access pattern: agents
  // write infrequently, the admin UI reads concurrently. WAL trades a
  // bit of disk for concurrent reader-writer with zero locks.
  db.pragma('journal_mode = WAL')
  // Foreign keys off by default in SQLite; turn on so agent-authored
  // schemas with FK constraints actually enforce them.
  db.pragma('foreign_keys = ON')
  return db
}

/**
 * Convenience holder for a few prepared statements we re-use on every
 * KV op. better-sqlite3 caches at the statement level too, but caching
 * by hand here means a hot kv.get path makes one map lookup, not a
 * `db.prepare(...)` call (which still does some work even when warm).
 */
export class PreparedKv {
  private readonly getStmt: RawStmt
  private readonly setStmt: RawStmt
  private readonly delStmt: RawStmt
  private readonly keysAllStmt: RawStmt
  private readonly keysPrefixStmt: RawStmt

  constructor(db: RawDb) {
    // The single _kv table that backs the KV surface. Defined here
    // rather than in `config.schema` so an agent that wants to use
    // KV doesn't need to remember the magic words. Note: schema-name
    // collision with an agent-authored `_kv` is rejected at schema
    // run-time by SQLite itself (`already exists`); we don't try to
    // detect it ourselves.
    db.exec(`
      CREATE TABLE IF NOT EXISTS _kv (
        k TEXT PRIMARY KEY,
        v TEXT NOT NULL
      )
    `)
    this.getStmt = db.prepare('SELECT v FROM _kv WHERE k = ?')
    this.setStmt = db.prepare(
      'INSERT INTO _kv(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v',
    )
    this.delStmt = db.prepare('DELETE FROM _kv WHERE k = ?')
    this.keysAllStmt = db.prepare('SELECT k FROM _kv ORDER BY k')
    this.keysPrefixStmt = db.prepare(
      `SELECT k FROM _kv WHERE k LIKE ? ESCAPE '\\' ORDER BY k`,
    )
  }

  get(key: string): unknown {
    const row = this.getStmt.get(key) as { v: string } | undefined
    if (!row) return undefined
    try {
      return JSON.parse(row.v)
    } catch {
      // Should never happen — we only write JSON-encoded values. Keep
      // the row visible to KV consumers so a manual SQL fix can recover.
      return row.v
    }
  }

  set(key: string, value: unknown): void {
    this.setStmt.run(key, JSON.stringify(value))
  }

  del(key: string): void {
    this.delStmt.run(key)
  }

  keys(prefix: string | undefined): string[] {
    let rows: { k: string }[]
    if (!prefix) {
      rows = this.keysAllStmt.all() as { k: string }[]
    } else {
      // Escape SQL LIKE metacharacters in the prefix so an agent can
      // safely pass a literal string. We use `\` as the escape char
      // (declared in the prepared statement above).
      const escaped = prefix.replace(/[\\%_]/g, (m) => `\\${m}`)
      rows = this.keysPrefixStmt.all(`${escaped}%`) as { k: string }[]
    }
    return rows.map((r) => r.k)
  }
}

/** Re-export the structural types so consumers don't reach into this file. */
export type SqliteDb = RawDb
export type SqliteStmt = RawStmt
