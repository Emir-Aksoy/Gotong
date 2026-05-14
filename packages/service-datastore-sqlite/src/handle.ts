/**
 * `DatastoreSqliteHandle` — single-owner, single-name SQLite handle.
 *
 * One instance per `(owner, config.name)`. The KV surface caches a
 * tiny set of prepared statements on the `_kv` table; the SQL surface
 * caches arbitrary user-supplied prepared statements keyed by the
 * literal SQL text — that's the RFC §18 "prepared statement re-use"
 * requirement (same query text → same compiled plan).
 *
 * Concurrency: better-sqlite3 is synchronous; we wrap every method in
 * an async signature so the handle matches the (async) `DatastoreHandle`
 * contract. JS single-threaded execution means we don't need locks
 * inside this process. WAL mode (set at db open) handles concurrent
 * external readers; another host instance pointing at the same file
 * is unsupported and would corrupt data anyway.
 */

import type { Logger } from '@aipehub/core'
import type {
  DatastoreHandle,
  KvHandle,
  SqlHandle,
} from '@aipehub/services-sdk'

import { type DatastoreSqliteConfig } from './config.js'
import { openDb, PreparedKv, type SqliteDb, type SqliteStmt } from './sqlite-driver.js'
import { statSync } from 'node:fs'

export interface HandleOpts {
  dbPath: string
  config: DatastoreSqliteConfig
  logger: Logger
}

export class DatastoreSqliteHandle implements DatastoreHandle {
  readonly name: string
  readonly kv: KvHandle
  readonly sql: SqlHandle

  private readonly db: SqliteDb
  private readonly cfg: DatastoreSqliteConfig
  private readonly logger: Logger
  private readonly dbPath: string
  /** Cache of prepared SQL statements, keyed verbatim by SQL text. */
  private readonly stmtCache = new Map<string, SqliteStmt>()
  /** True iff close() has been called — read/writes after that throw. */
  private closed = false

  constructor(opts: HandleOpts) {
    this.dbPath = opts.dbPath
    this.cfg = opts.config
    this.logger = opts.logger
    this.name = opts.config.name
    this.db = openDb(opts.dbPath)
    // Run optional user-supplied DDL exactly once per attach. SQLite's
    // IDEMPOTENT-by-IF-NOT-EXISTS pattern makes this safe to repeat.
    if (this.cfg.schema) {
      try {
        this.db.exec(this.cfg.schema)
      } catch (err) {
        // Close on schema failure so the bad db isn't held open.
        this.db.close()
        throw new Error(
          `datastore:sqlite '${this.name}' schema rejected by SQLite: ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
      }
    }
    const preparedKv = new PreparedKv(this.db)
    this.kv = makeKvHandle(preparedKv)
    this.sql = makeSqlHandle({
      db: this.db,
      stmtCache: this.stmtCache,
      maxBytes: this.cfg.maxBytes,
      dbPath: this.dbPath,
      isClosed: () => this.closed,
    })
  }

  /** Close the underlying database. Idempotent. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.stmtCache.clear()
    if (this.db.open) this.db.close()
  }
}

function makeKvHandle(prep: PreparedKv): KvHandle {
  return {
    async get<T = unknown>(key: string): Promise<T | undefined> {
      return prep.get(key) as T | undefined
    },
    async set(key: string, value: unknown): Promise<void> {
      prep.set(key, value)
    },
    async del(key: string): Promise<void> {
      prep.del(key)
    },
    async keys(prefix?: string): Promise<string[]> {
      return prep.keys(prefix)
    },
  }
}

function makeSqlHandle(opts: {
  db: SqliteDb
  stmtCache: Map<string, SqliteStmt>
  maxBytes: number
  dbPath: string
  isClosed: () => boolean
}): SqlHandle {
  const prep = (sql: string): SqliteStmt => {
    const cached = opts.stmtCache.get(sql)
    if (cached) return cached
    const stmt = opts.db.prepare(sql)
    opts.stmtCache.set(sql, stmt)
    return stmt
  }
  // The size-cap guard: cheap stat before each write. The check is
  // best-effort; SQLite will keep growing during a single statement
  // if we already passed the gate. For interactive agent workloads
  // this is fine — they hit the threshold over many statements, not
  // one giant insert.
  const writeGuard = (): void => {
    if (opts.isClosed()) {
      throw new Error('datastore:sqlite handle is closed')
    }
    let size = 0
    try {
      size = statSync(opts.dbPath).size
    } catch {
      // Brand-new db: WAL not yet flushed, file may not be there.
      // Treat as 0 — first inserts are always allowed.
      size = 0
    }
    if (size > opts.maxBytes) {
      throw new Error(
        `datastore:sqlite write blocked: file ${opts.dbPath} is ${size} bytes, exceeds maxBytes=${opts.maxBytes}`,
      )
    }
  }
  return {
    async exec(sql: string, params?: unknown[]): Promise<{ changes: number }> {
      writeGuard()
      const stmt = prep(sql)
      const out = params && params.length > 0 ? stmt.run(...params) : stmt.run()
      return { changes: out.changes }
    },
    async query<T = Record<string, unknown>>(
      sql: string,
      params?: unknown[],
    ): Promise<T[]> {
      if (opts.isClosed()) {
        throw new Error('datastore:sqlite handle is closed')
      }
      const stmt = prep(sql)
      const rows = params && params.length > 0 ? stmt.all(...params) : stmt.all()
      return rows as T[]
    },
  }
}
