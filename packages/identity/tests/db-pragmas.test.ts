/**
 * Perf audit A① regression — identity connections run WAL + synchronous=NORMAL.
 *
 * Without the explicit `synchronous` pragma SQLite defaults to FULL, which
 * fsyncs the WAL on every commit. Identity writes sit on per-request hot
 * paths (session touch, usage ledger, quota) and better-sqlite3 executes
 * synchronously on the event loop — so each fsync stalls the whole hub.
 * NORMAL keeps corruption safety (a power cut can only lose the newest
 * transactions) while dropping the per-commit fsync.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openDb } from '../src/db.js'

const tmpDirs: string[] = []

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }
})

function pragmaValue(result: unknown, key: string): unknown {
  // better-sqlite3 returns e.g. [{ synchronous: 1 }]
  const row = (result as Array<Record<string, unknown>>)[0]
  return row?.[key]
}

describe('identity db pragmas (perf audit A①)', () => {
  it('file-backed db uses WAL + synchronous=NORMAL', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gotong-id-pragma-'))
    tmpDirs.push(dir)
    const db = openDb(join(dir, 'identity.sqlite'))
    try {
      expect(pragmaValue(db.pragma('journal_mode'), 'journal_mode')).toBe('wal')
      // 1 = NORMAL, 2 = FULL. Strictly 1 — FULL means the fsync-per-commit
      // regression is back.
      expect(pragmaValue(db.pragma('synchronous'), 'synchronous')).toBe(1)
    } finally {
      db.close()
    }
  })

  it(':memory: db still accepts the pragmas (no throw path)', () => {
    const db = openDb(':memory:')
    try {
      // WAL does not apply to :memory: (stays "memory") — assert only that
      // synchronous landed, proving openDb ran the pragma block unharmed.
      expect(pragmaValue(db.pragma('synchronous'), 'synchronous')).toBe(1)
    } finally {
      db.close()
    }
  })
})
