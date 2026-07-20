import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  SECURE_FILE_MODE,
  uniqueTmpPath,
  writeFileAtomic,
  writeFileAtomicSync,
  writeJsonAtomic,
  writeJsonAtomicSync,
} from '../src/fs-atomic.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gotong-fsatomic-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Everything in `dir` that isn't the committed target — i.e. leaked temporaries. */
function strays(target: string): string[] {
  return readdirSync(dir).filter((f) => join(dir, f) !== target)
}

describe('uniqueTmpPath', () => {
  it('still ends in .tmp — the listing filters depend on that suffix', () => {
    // run-store / lifecycle-store / revision-store / file-inbox-store all scan
    // with `endsWith('.json') && !endsWith('.tmp')`. A name that stops ending
    // in `.tmp` silently disarms the second clause; pin it here, once.
    expect(uniqueTmpPath('/x/r_1.json').endsWith('.tmp')).toBe(true)
    expect(uniqueTmpPath('/x/r_1.json').startsWith('/x/r_1.json.')).toBe(true)
  })

  it('never repeats, even called back-to-back in one tick', () => {
    // The whole point of the H6 fix: two concurrent writers of the same target
    // must not land on one another's temporary.
    const names = new Set(Array.from({ length: 500 }, () => uniqueTmpPath('/x/a.json')))
    expect(names.size).toBe(500)
  })
})

describe('writeFileAtomic', () => {
  it('writes the bytes and leaves no temporary behind', async () => {
    const target = join(dir, 'a.txt')
    await writeFileAtomic(target, 'hello')
    expect(readFileSync(target, 'utf8')).toBe('hello')
    expect(strays(target)).toEqual([])
  })

  it('overwrites an existing file (last writer wins, never merges)', async () => {
    const target = join(dir, 'a.txt')
    await writeFileAtomic(target, 'first')
    await writeFileAtomic(target, 'second')
    expect(readFileSync(target, 'utf8')).toBe('second')
    expect(strays(target)).toEqual([])
  })

  it('applies the mode at creation, not after (no readable window)', async () => {
    const target = join(dir, 'secret.json')
    await writeFileAtomic(target, '{}', SECURE_FILE_MODE)
    // eslint-disable-next-line no-bitwise -- POSIX permission bits
    expect(statSync(target).mode & 0o777).toBe(SECURE_FILE_MODE)
  })

  it('concurrent writers of one target all commit, and none leak a temporary', async () => {
    const target = join(dir, 'hot.txt')
    const bodies = Array.from({ length: 40 }, (_, i) => `body-${i}`)
    await Promise.all(bodies.map((b) => writeFileAtomic(target, b)))
    // Whoever renamed last wins WHOLE — never a torn blend of two payloads.
    expect(bodies).toContain(readFileSync(target, 'utf8'))
    expect(strays(target)).toEqual([])
  })

  it('cleans up the temporary when the write fails, then rethrows', async () => {
    // Unique names removed the old self-healing property (a fixed `.tmp` got
    // overwritten next time). Without cleanup every failure would leak forever.
    const target = join(dir, 'nested', 'a.txt') // parent does not exist → ENOENT
    await expect(writeFileAtomic(target, 'x')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(readdirSync(dir)).toEqual([])
  })

  it('cleans up the temporary when the RENAME fails, then rethrows', async () => {
    // The nastier half: bytes landed, the commit didn't. Park a directory on
    // the target so rename can't replace it.
    const target = join(dir, 'busy')
    mkdirSync(join(target, 'child'), { recursive: true }) // non-empty ⇒ rename fails
    await expect(writeFileAtomic(target, 'x')).rejects.toBeTruthy()
    expect(strays(target)).toEqual([])
    expect(existsSync(join(target, 'child'))).toBe(true) // target untouched
  })

  it('leaves the previous content intact when the write fails', async () => {
    const target = join(dir, 'a.txt')
    await writeFileAtomic(target, 'good')
    // A directory squatting on the tmp path is impossible now (names are
    // unique), so induce failure the honest way: make the payload unwritable.
    await expect(writeFileAtomic(target, undefined as unknown as string)).rejects.toBeTruthy()
    expect(readFileSync(target, 'utf8')).toBe('good')
    expect(strays(target)).toEqual([])
  })
})

describe('writeFileAtomicSync', () => {
  it('writes, honours mode, and leaves no temporary', () => {
    const target = join(dir, 'a.txt')
    writeFileAtomicSync(target, 'sync-hello', SECURE_FILE_MODE)
    expect(readFileSync(target, 'utf8')).toBe('sync-hello')
    // eslint-disable-next-line no-bitwise -- POSIX permission bits
    expect(statSync(target).mode & 0o777).toBe(SECURE_FILE_MODE)
    expect(strays(target)).toEqual([])
  })

  it('cleans up the temporary on failure, then rethrows', () => {
    const target = join(dir, 'nested', 'a.txt')
    expect(() => writeFileAtomicSync(target, 'x')).toThrow()
    expect(readdirSync(dir)).toEqual([])
  })
})

describe('writeJsonAtomic', () => {
  // The 2-space + trailing-newline shape is the repo's existing on-disk format.
  // Changing it would produce a meaningless full-file diff in every state file.
  it('serialises as 2-space JSON with a trailing newline', async () => {
    const target = join(dir, 'a.json')
    await writeJsonAtomic(target, { b: 1 })
    expect(readFileSync(target, 'utf8')).toBe('{\n  "b": 1\n}\n')
  })

  it('sync variant produces byte-identical output', () => {
    const a = join(dir, 'a.json')
    const b = join(dir, 'b.json')
    writeJsonAtomicSync(a, { x: [1, 2], y: 'z' })
    writeFileSync(b, `${JSON.stringify({ x: [1, 2], y: 'z' }, null, 2)}\n`, 'utf8')
    expect(readFileSync(a, 'utf8')).toBe(readFileSync(b, 'utf8'))
  })
})
