import { dirname } from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'

import { createLogger } from '../logger.js'
import { normalizeNamespace } from '../tenant.js'
import type { TranscriptEntry } from '../types.js'
import type { Storage } from './index.js'

const log = createLogger('storage/sqlite')

// In an ESM build, `require` is not in scope. `createRequire` gives us a CJS
// require resolver rooted at this module's URL so we can synchronously load
// the native `better-sqlite3` peer dep without paying the cost of a dynamic
// import (and without making `new SqliteStorage(...)` async).
const cjsRequire = createRequire(import.meta.url)

/**
 * Minimal structural shape of the better-sqlite3 client we touch. Declared
 * locally so the import is `import type` only — the package is an optional
 * peer dep and we never type-pin to a specific version.
 */
interface SqliteDatabase {
  prepare(sql: string): SqliteStatement
  exec(sql: string): void
  pragma(s: string): unknown
  close(): void
}
interface SqliteStatement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint }
  all(...params: unknown[]): unknown[]
}

export interface SqliteStorageOptions {
  /**
   * Path to the SQLite database file. Use `':memory:'` for a private in-process DB
   * (useful in tests). Parent directories are created if missing.
   */
  path: string
  /**
   * Disable WAL mode. Default: WAL is on for better concurrent reads. Turn off
   * if you're using a network filesystem that doesn't support WAL semantics.
   */
  noWAL?: boolean
  /**
   * Inject a pre-constructed better-sqlite3 Database. Used by tests and by
   * callers who need to share a connection. When set, `path` is ignored.
   */
  db?: SqliteDatabase
  /**
   * Tenant/namespace this storage belongs to (Route B P0-M1). Defaults to
   * `DEFAULT_TENANT`. Metadata only — the `path`/`db` is already
   * tenant-resolved by the caller.
   */
  namespace?: string
}

/**
 * SQLite-backed Storage. Persists the transcript in a single table:
 *
 *   transcript(seq INTEGER PRIMARY KEY, ts INTEGER NOT NULL,
 *              kind TEXT NOT NULL, data TEXT NOT NULL)
 *
 * `data` is the JSON-encoded `TranscriptEntry.data`. `seq` is the Hub's
 * monotonic sequence number; we make it the primary key so duplicate appends
 * with the same seq fail loudly rather than silently overwriting.
 *
 * Compared to FileStorage:
 * - Writes are durable on `appendTranscriptEntry()` resolve (WAL fsync).
 * - Loading is one indexed SELECT instead of streaming a possibly-huge JSONL.
 * - Crash recovery is whatever SQLite gives you, which is much stronger than
 *   the "skip the trailing corrupt line" guarantee FileStorage offers.
 *
 * Requires `better-sqlite3` (declared as an optional peer dependency on
 * `@gotong/core`). If you import this class without installing it, the
 * constructor throws a clear error.
 */
export class SqliteStorage implements Storage {
  private readonly db: SqliteDatabase
  private readonly insertStmt: SqliteStatement
  private readonly loadStmt: SqliteStatement
  private readonly ownsDb: boolean
  private writeQueue: Promise<void> = Promise.resolve()

  /** Tenant this transcript DB belongs to (Route B P0-M1). */
  readonly namespace: string

  constructor(opts: SqliteStorageOptions) {
    this.namespace = normalizeNamespace(opts.namespace)
    if (opts.db) {
      this.db = opts.db
      this.ownsDb = false
    } else {
      const dir = dirname(opts.path)
      if (dir && dir !== '.' && opts.path !== ':memory:' && !existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
      }
      this.db = loadBetterSqlite3(opts.path)
      this.ownsDb = true
    }

    if (!opts.noWAL && this.ownsDb) {
      try {
        this.db.pragma('journal_mode = WAL')
        // synchronous=NORMAL is a reasonable WAL pairing — full ACID on commit
        // boundaries, but fsync is deferred so per-row appends are not flushed
        // synchronously. Equivalent to FileStorage's fire-and-forget semantics.
        this.db.pragma('synchronous = NORMAL')
      } catch {
        // some filesystems (network mounts) reject WAL; fall back silently
      }
    }

    this.db.exec(
      `CREATE TABLE IF NOT EXISTS transcript (
         seq  INTEGER PRIMARY KEY,
         ts   INTEGER NOT NULL,
         kind TEXT NOT NULL,
         data TEXT NOT NULL
       )`,
    )
    // Read path will sort by seq; PK is already indexed but explicit ordering
    // protects against subtle storage-engine surprises.
    this.insertStmt = this.db.prepare(
      'INSERT INTO transcript (seq, ts, kind, data) VALUES (?, ?, ?, ?)',
    )
    this.loadStmt = this.db.prepare(
      'SELECT seq, ts, kind, data FROM transcript ORDER BY seq ASC',
    )
  }

  async loadTranscript(): Promise<TranscriptEntry[]> {
    const rows = this.loadStmt.all() as ReadonlyArray<{
      seq: number
      ts: number
      kind: string
      data: string
    }>
    const out: TranscriptEntry[] = []
    for (const row of rows) {
      try {
        const data = JSON.parse(row.data) as TranscriptEntry['data']
        out.push({
          seq: row.seq,
          ts: row.ts,
          kind: row.kind as TranscriptEntry['kind'],
          data,
        } as TranscriptEntry)
      } catch {
        // Corrupt row — log and skip. Should not happen via normal writes.
        log.warn('skipping malformed row', { seq: row.seq })
      }
    }
    return out
  }

  appendTranscriptEntry(entry: TranscriptEntry): Promise<void> {
    // Mirror FileStorage's serialized-write semantics. better-sqlite3 is
    // synchronous, so the queue is more about a stable promise chain (so
    // callers can await close()) than about avoiding interleaved bytes.
    const next = this.writeQueue.then(() => {
      this.insertStmt.run(entry.seq, entry.ts, entry.kind, JSON.stringify(entry.data))
    })
    this.writeQueue = next.catch(() => undefined)
    return next
  }

  async close(): Promise<void> {
    await this.writeQueue
    if (this.ownsDb) {
      try {
        this.db.close()
      } catch {
        // already closed — ignore
      }
    }
  }
}

/**
 * Lazy-require `better-sqlite3`. Kept behind a function so that importing
 * the class doesn't fail at module-load time for users who never construct
 * a `SqliteStorage` (e.g. they only use `FileStorage`).
 */
function loadBetterSqlite3(path: string): SqliteDatabase {
  let mod: unknown
  try {
    mod = cjsRequire('better-sqlite3')
  } catch (err) {
    const msg =
      'SqliteStorage requires the `better-sqlite3` package. ' +
      'Install it with `npm install better-sqlite3` (or `pnpm add better-sqlite3`). ' +
      'Original error: ' +
      (err instanceof Error ? err.message : String(err))
    throw new Error(msg)
  }
  // CommonJS (default export wrapped) vs ESM transpile — handle both shapes.
  const Ctor =
    (mod as { default?: new (p: string) => SqliteDatabase }).default ??
    (mod as new (p: string) => SqliteDatabase)
  return new Ctor(path)
}
