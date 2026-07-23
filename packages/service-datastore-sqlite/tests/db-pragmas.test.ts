/**
 * Perf audit A① regression — datastore connections run WAL + synchronous=NORMAL.
 * Mirrors @gotong/identity: FULL (the SQLite default) fsyncs the WAL on every
 * commit, and better-sqlite3 executes synchronously on the event loop.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openDb } from '../src/sqlite-driver.js'

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
  const row = (result as Array<Record<string, unknown>>)[0]
  return row?.[key]
}

describe('datastore sqlite pragmas (perf audit A①)', () => {
  it('uses WAL + synchronous=NORMAL', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gotong-ds-pragma-'))
    tmpDirs.push(dir)
    const db = openDb(join(dir, 'data.sqlite'))
    try {
      expect(pragmaValue(db.pragma('journal_mode'), 'journal_mode')).toBe('wal')
      expect(pragmaValue(db.pragma('synchronous'), 'synchronous')).toBe(1)
    } finally {
      db.close()
    }
  })
})
