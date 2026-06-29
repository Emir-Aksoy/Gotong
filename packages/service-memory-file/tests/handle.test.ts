import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { createLogger } from '@aipehub/core'
import { MemoryFileHandle } from '../src/handle.js'
import type { MemoryFileConfig } from '../src/config.js'
import { kindFile } from '../src/paths.js'

const logger = createLogger('memory-file-handle-test', { disabled: true })
const allKinds: MemoryFileConfig = {
  kinds: ['episodic', 'semantic', 'working'],
}
const owner = { kind: 'agent', id: 'writer-zh' } as const

let rootDir: string
beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'aipe-mem-handle-'))
})
afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true })
})

function newHandle(cfg: MemoryFileConfig = allKinds): MemoryFileHandle {
  return new MemoryFileHandle({ rootDir, owner, config: cfg, logger })
}

describe('remember / list / recall', () => {
  it('remember returns the entry with id + ts filled', async () => {
    const h = newHandle()
    const e = await h.remember({ kind: 'episodic', text: 'asked about coffee' })
    expect(e.id).toMatch(/^[a-z0-9]+-[a-z0-9]+$/)
    expect(e.ts).toBeGreaterThan(0)
    expect(e.text).toBe('asked about coffee')
  })

  it('persists to the right jsonl file', async () => {
    const h = newHandle()
    await h.remember({ kind: 'episodic', text: 'asked about coffee' })
    const raw = await readFile(kindFile(rootDir, owner, 'episodic'), 'utf8')
    const lines = raw.split('\n').filter((l) => l.length > 0)
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]!).text).toBe('asked about coffee')
  })

  it('list returns newest first', async () => {
    const h = newHandle()
    await h.remember({ kind: 'episodic', text: 'first' })
    // Force monotonic ts so we don't depend on sub-ms ordering.
    await new Promise((r) => setTimeout(r, 5))
    await h.remember({ kind: 'episodic', text: 'second' })
    const items = await h.list({ kind: 'episodic' })
    expect(items.map((x) => x.text)).toEqual(['second', 'first'])
  })

  it('list across kinds', async () => {
    const h = newHandle()
    await h.remember({ kind: 'episodic', text: 'e1' })
    await h.remember({ kind: 'semantic', text: 's1' })
    await h.remember({ kind: 'working', text: 'w1' })
    const items = await h.list({})
    expect(items.map((x) => x.text).sort()).toEqual(['e1', 's1', 'w1'])
  })

  it('recall filters by case-insensitive substring', async () => {
    const h = newHandle()
    await h.remember({ kind: 'episodic', text: 'GrabPay reconciliation' })
    await h.remember({ kind: 'episodic', text: '客户复购' })
    const matches = await h.recall({ text: 'grabpay' })
    expect(matches).toHaveLength(1)
    expect(matches[0]!.text).toMatch(/GrabPay/)
  })

  it('recall filters by since', async () => {
    const h = newHandle()
    const a = await h.remember({ kind: 'episodic', text: 'old' })
    await new Promise((r) => setTimeout(r, 5))
    const b = await h.remember({ kind: 'episodic', text: 'new' })
    const matches = await h.recall({ since: b.ts })
    expect(matches).toHaveLength(1)
    expect(matches[0]!.id).toBe(b.id)
    expect(matches[0]!.id).not.toBe(a.id)
  })

  it('recall caps k', async () => {
    const h = newHandle()
    for (let i = 0; i < 10; i++) {
      await h.remember({ kind: 'episodic', text: `entry-${i}` })
    }
    const matches = await h.recall({ k: 3 })
    expect(matches).toHaveLength(3)
  })

  it('recall enforces config.kinds (intersect with query.kinds)', async () => {
    const h = newHandle({ kinds: ['episodic'] })
    // remember on disallowed kind throws
    await expect(h.remember({ kind: 'semantic', text: 'x' })).rejects.toThrow(/not allowed/)
    await h.remember({ kind: 'episodic', text: 'e' })
    // recall asking for semantic returns nothing (it's not in config.kinds)
    const matches = await h.recall({ kinds: ['semantic'] })
    expect(matches).toHaveLength(0)
  })

  it('recall preserves meta when present', async () => {
    const h = newHandle()
    await h.remember({ kind: 'episodic', text: 'x', meta: { taskId: 't1' } })
    const [got] = await h.recall({ k: 1 })
    expect(got?.meta).toEqual({ taskId: 't1' })
  })

  it('forget removes the entry by id', async () => {
    const h = newHandle()
    const a = await h.remember({ kind: 'episodic', text: 'a' })
    await h.remember({ kind: 'episodic', text: 'b' })
    await h.forget(a.id)
    const items = await h.list({ kind: 'episodic' })
    expect(items.map((x) => x.text)).toEqual(['b'])
  })

  it('forget is a no-op when id is unknown', async () => {
    const h = newHandle()
    await h.remember({ kind: 'episodic', text: 'a' })
    await expect(h.forget('nonexistent')).resolves.not.toThrow()
  })

  it('clear() removes all kinds', async () => {
    const h = newHandle()
    await h.remember({ kind: 'episodic', text: 'e' })
    await h.remember({ kind: 'semantic', text: 's' })
    await h.clear()
    const items = await h.list({})
    expect(items).toHaveLength(0)
  })

  it('clear(kind) removes one kind only', async () => {
    const h = newHandle()
    await h.remember({ kind: 'episodic', text: 'e' })
    await h.remember({ kind: 'semantic', text: 's' })
    await h.clear('working')   // working is empty — no error
    await h.clear('episodic')
    const items = await h.list({})
    expect(items.map((x) => x.text)).toEqual(['s'])
  })
})

describe('remember validation', () => {
  it('rejects empty text', async () => {
    const h = newHandle()
    await expect(h.remember({ kind: 'episodic', text: '' })).rejects.toThrow(/non-empty/)
  })
})

describe('concurrent writes are serialised (no jsonl corruption)', () => {
  it('appends 50 concurrent remembers without interleaving', async () => {
    const h = newHandle()
    const writes = Array.from({ length: 50 }, (_, i) =>
      h.remember({ kind: 'episodic', text: `parallel-${i}` }),
    )
    const results = await Promise.all(writes)
    expect(new Set(results.map((r) => r.id)).size).toBe(50)
    const raw = await readFile(kindFile(rootDir, owner, 'episodic'), 'utf8')
    const lines = raw.split('\n').filter((l) => l.length > 0)
    expect(lines).toHaveLength(50)
    // Each line must parse independently.
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow()
    }
  })
})

describe('owner isolation', () => {
  it('two owners do not see each other', async () => {
    const h1 = new MemoryFileHandle({
      rootDir, owner: { kind: 'agent', id: 'a-1' }, config: allKinds, logger,
    })
    const h2 = new MemoryFileHandle({
      rootDir, owner: { kind: 'agent', id: 'a-2' }, config: allKinds, logger,
    })
    await h1.remember({ kind: 'episodic', text: 'a1-data' })
    await h2.remember({ kind: 'episodic', text: 'a2-data' })
    expect((await h1.list({})).map((x) => x.text)).toEqual(['a1-data'])
    expect((await h2.list({})).map((x) => x.text)).toEqual(['a2-data'])
  })

  it('same id under different owner kinds is isolated', async () => {
    const agentHandle = new MemoryFileHandle({
      rootDir, owner: { kind: 'agent', id: 'same' }, config: allKinds, logger,
    })
    const sharedHandle = new MemoryFileHandle({
      rootDir, owner: { kind: 'shared', id: 'same' }, config: allKinds, logger,
    })
    await agentHandle.remember({ kind: 'episodic', text: 'agent-side' })
    expect((await sharedHandle.list({}))).toHaveLength(0)
  })
})

describe('truncation', () => {
  it('drops oldest ~50% when episodic exceeds maxEpisodicBytes', async () => {
    const cfg: MemoryFileConfig = {
      kinds: ['episodic'],
      // Each entry is a JSON of {"id","kind","text","ts"} ≈ 60-80 bytes.
      // 600 bytes ≈ ~8 entries; we'll write 10 and expect trim to ~5.
      maxEpisodicBytes: 600,
    }
    const h = new MemoryFileHandle({ rootDir, owner, config: cfg, logger })
    for (let i = 0; i < 10; i++) {
      await h.remember({ kind: 'episodic', text: `entry-${i}` })
    }
    const path = kindFile(rootDir, owner, 'episodic')
    const sizeAfter = (await stat(path)).size
    expect(sizeAfter).toBeLessThan(600 * 2)   // generous upper bound
    const items = await h.list({ kind: 'episodic', limit: 100 })
    // We kept the second half; oldest entries are dropped.
    expect(items.length).toBeGreaterThan(0)
    expect(items.length).toBeLessThan(10)
    // The most recent ones should still be there.
    expect(items.map((x) => x.text)).toContain('entry-9')
  })
})

describe('corrupt lines tolerated', () => {
  it('list skips a corrupt line and reads the rest', async () => {
    const h = newHandle()
    await h.remember({ kind: 'episodic', text: 'good-1' })
    // Inject a bad line in the middle.
    const path = kindFile(rootDir, owner, 'episodic')
    const before = await readFile(path, 'utf8')
    await writeFile(path, before + 'not-json{\n', 'utf8')
    await h.remember({ kind: 'episodic', text: 'good-2' })
    const items = await h.list({ kind: 'episodic' })
    expect(items.map((x) => x.text).sort()).toEqual(['good-1', 'good-2'])
  })
})

describe('patchMeta (Z-M1)', () => {
  it('shallow-merges patch over existing meta, preserving id/kind/text/ts', async () => {
    const h = newHandle()
    const e = await h.remember({ kind: 'semantic', text: 'lives in KL', meta: { importance: 4 } })
    const ok = await h.patchMeta(e.id, { validTo: 900 })
    expect(ok).toBe(true)
    const [got] = await h.recall({ kinds: ['semantic'], k: 1 })
    expect(got?.id).toBe(e.id)
    expect(got?.ts).toBe(e.ts)
    expect(got?.kind).toBe('semantic')
    expect(got?.text).toBe('lives in KL')
    // existing key kept, new key merged in
    expect(got?.meta).toEqual({ importance: 4, validTo: 900 })
  })

  it('overwrites only the keys in the patch, leaving the rest', async () => {
    const h = newHandle()
    const e = await h.remember({
      kind: 'semantic', text: 'x', meta: { recallCount: 2, lastRecalledTs: 100, links: ['a'] },
    })
    await h.patchMeta(e.id, { recallCount: 3, lastRecalledTs: 555 })
    const [got] = await h.recall({ kinds: ['semantic'], k: 1 })
    expect(got?.meta).toEqual({ recallCount: 3, lastRecalledTs: 555, links: ['a'] })
  })

  it('creates meta when the stored entry had none', async () => {
    const h = newHandle()
    const e = await h.remember({ kind: 'semantic', text: 'x' })
    await h.patchMeta(e.id, { links: ['b', 'c'] })
    const [got] = await h.recall({ kinds: ['semantic'], k: 1 })
    expect(got?.meta).toEqual({ links: ['b', 'c'] })
  })

  it('returns false for an unknown id and changes nothing', async () => {
    const h = newHandle()
    await h.remember({ kind: 'semantic', text: 'x', meta: { importance: 3 } })
    const ok = await h.patchMeta('nonexistent', { validTo: 1 })
    expect(ok).toBe(false)
    const [got] = await h.recall({ kinds: ['semantic'], k: 1 })
    expect(got?.meta).toEqual({ importance: 3 })
  })

  it('finds the entry across kinds (semantic patched while episodic exists)', async () => {
    const h = newHandle()
    await h.remember({ kind: 'episodic', text: 'turn' })
    const s = await h.remember({ kind: 'semantic', text: 'fact' })
    const ok = await h.patchMeta(s.id, { validTo: 42 })
    expect(ok).toBe(true)
    const [got] = await h.recall({ kinds: ['semantic'], k: 1 })
    expect(got?.meta).toEqual({ validTo: 42 })
    // the episodic line is untouched (still exactly one, no meta added)
    const ep = await h.list({ kind: 'episodic' })
    expect(ep).toHaveLength(1)
    expect(ep[0]!.meta).toBeUndefined()
  })

  it('rewrites only the matched line — untouched lines (incl. corrupt) survive verbatim', async () => {
    const h = newHandle()
    const a = await h.remember({ kind: 'semantic', text: 'good-a' })
    // Inject a corrupt line, then add a second good entry to patch.
    const path = kindFile(rootDir, owner, 'semantic')
    const before = await readFile(path, 'utf8')
    await writeFile(path, before + 'not-json{\n', 'utf8')
    const b = await h.remember({ kind: 'semantic', text: 'good-b' })

    const ok = await h.patchMeta(b.id, { validTo: 7 })
    expect(ok).toBe(true)

    // The corrupt line is still on disk verbatim (not dropped by the rewrite).
    const after = await readFile(path, 'utf8')
    expect(after).toContain('not-json{')

    // Both good entries readable; only b gained the meta, a is unchanged.
    const items = await h.list({ kind: 'semantic' })
    const byText = Object.fromEntries(items.map((x) => [x.text, x]))
    expect(byText['good-a']!.id).toBe(a.id)
    expect(byText['good-a']!.meta).toBeUndefined()
    expect(byText['good-b']!.meta).toEqual({ validTo: 7 })
  })

  it('serializes against concurrent remember (no jsonl corruption)', async () => {
    const h = newHandle()
    const e = await h.remember({ kind: 'semantic', text: 'base', meta: { importance: 3 } })
    // Fire a patch and a remember concurrently — the write chain must serialize them.
    await Promise.all([
      h.patchMeta(e.id, { validTo: 10 }),
      h.remember({ kind: 'semantic', text: 'also' }),
    ])
    const raw = await readFile(kindFile(rootDir, owner, 'semantic'), 'utf8')
    const lines = raw.split('\n').filter((l) => l.length > 0)
    expect(lines).toHaveLength(2)
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow()
    const items = await h.list({ kind: 'semantic' })
    expect(items.map((x) => x.text).sort()).toEqual(['also', 'base'])
    expect(items.find((x) => x.text === 'base')!.meta).toEqual({ importance: 3, validTo: 10 })
  })
})

describe('empty state', () => {
  it('list on empty owner returns []', async () => {
    const h = newHandle()
    expect(await h.list({})).toEqual([])
  })

  it('recall on empty owner returns []', async () => {
    const h = newHandle()
    expect(await h.recall({ text: 'anything' })).toEqual([])
  })

  it('clear on empty owner does not throw', async () => {
    const h = newHandle()
    await expect(h.clear()).resolves.not.toThrow()
  })
})
