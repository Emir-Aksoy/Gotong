import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createLogger } from '@gotong/core'
import { buildTurnCapture, consolidate, prepareEvidenceCorrection, type EvidenceCorrectionOptions } from '@gotong/personal-memory'
import { MemoryFileHandle, ownerDir } from '@gotong/service-memory-file'
import type { MemoryEntry } from '@gotong/services-sdk'
import { openButlerMemory } from '../src/personal-butler-memory.js'
import { correctButlerMemoryFiles } from '../src/butler-memory-correction.js'

const logger = createLogger('butler-memory-correction-test', { disabled: true })
const time = { v: 1 as const, observedAt: Date.parse('2026-09-01T06:00:00Z'), timeZone: 'America/Los_Angeles', basis: 'turn-start' as const }
const now = () => Date.parse('2026-09-12T07:00:00Z')
const oldQuote = '昨天我吃了烤肉'
const newQuote = '2026-08-29我吃了烤肉'
function correction(): Omit<EvidenceCorrectionOptions, 'userId'> {
  return { target: { quote: oldQuote }, replacement: { sourceId: 'new-turn', text: newQuote, temporal: { ...time, observedAt: now() } }, maxEntryBytes: 4096 }
}
async function setup() {
  const rootDir = await mkdtemp(join(tmpdir(), 'gotong-correction-files-'))
  let tick = 1
  const memory = openButlerMemory({ rootDir, userId: 'alice', logger, now: () => tick++ })
  const old = await memory.remember({ ...buildTurnCapture({ userText: oldQuote, replyText: '旧错误回答', temporal: time, meta: { userId: 'alice' } })!, id: 'old-turn' })
  const opts = { rootDir, userId: 'alice', logger, correction: correction(), now }
  return { rootDir, memory, old, opts }
}
async function files(rootDir: string, userId = 'alice'): Promise<Record<string, string>> {
  const dir = ownerDir(rootDir, { kind: 'user', id: userId })
  const out: Record<string, string> = {}
  for (const name of (await readdir(dir)).sort()) out[name] = await readFile(join(dir, name), 'utf8')
  return out
}
function source(entry: MemoryEntry, sourceId: string) {
  const envelope = entry.meta!.evidence as { sources: { sourceId: string; start: number; end: number; temporal: unknown; calendar?: unknown }[] }
  const s = envelope.sources.find(s => s.sourceId === sourceId)!
  return { text: entry.text.slice(s.start, s.end), temporal: s.temporal, calendar: s.calendar }
}

describe('internal correction of memory files, not a user-facing forget-complete endpoint', () => {
  it('commits a replacement without retaining the old captured user or assistant text', async () => {
    const { rootDir, memory, old, opts } = await setup()
    const before = await memory.snapshot()
    const result = await correctButlerMemoryFiles(opts)
    expect(result.status).toBe('memory_files_updated')
    if (result.status !== 'memory_files_updated') throw new Error('expected file update')
    const fresh = openButlerMemory({ rootDir, userId: 'alice', logger })
    const after = await fresh.snapshot()
    expect(result.revision).toBe(after.revision)
    expect(result.revision).not.toBe(before.revision)
    expect(after.entries).toHaveLength(1)
    expect(after.entries[0]).toMatchObject({ kind: 'semantic', text: newQuote, ts: now() })
    expect(source(after.entries[0]!, 'new-turn').temporal).toEqual(opts.correction.replacement.temporal)
    expect(JSON.stringify(await files(rootDir))).not.toContain(oldQuote)
    expect(JSON.stringify(await files(rootDir))).not.toContain('旧错误回答')
    await expect(memory.remember(old)).rejects.toMatchObject({ code: 'MUTATION_STALE_HANDLE' })
    await expect(memory.list()).rejects.toMatchObject({ code: 'MUTATION_STALE_HANDLE' })
  })

  it('updates every traced copy and preserves unrelated source evidence and the other owner', async () => {
    const { rootDir, memory, old, opts } = await setup()
    const other = await memory.remember({ ...buildTurnCapture({ userText: '上周我买了咖啡', replyText: '', temporal: time, meta: { userId: 'alice' } })!, id: 'other-turn' })
    const recent = await memory.remember({ ...buildTurnCapture({ userText: '我今天读了书', replyText: '', temporal: time, meta: { userId: 'alice' } })!, id: 'recent-turn' })
    const summarize = vi.fn(async () => 'must not rewrite user evidence')
    const folded = await consolidate({ memory, summarize, force: true, keepRecent: 1, profileHardCap: 4096 })
    expect(folded!.consolidatedCount).toBe(2)
    expect(summarize).not.toHaveBeenCalled()
    const profile = folded!.profile
    const preserved = source(profile, other.id)
    await memory.remember(old)
    const copy = await memory.remember({ ...profile, id: 'copy' })
    const bob = openButlerMemory({ rootDir, userId: 'bob', logger })
    await bob.remember({ kind: 'semantic', text: 'Bob private data' })
    const bobBefore = await files(rootDir, 'bob')
    await correctButlerMemoryFiles(opts)
    const entries = (await openButlerMemory({ rootDir, userId: 'alice', logger }).snapshot()).entries
    expect(entries.find(e => e.id === recent.id)).toEqual(recent)
    expect(entries.some(e => e.id === old.id)).toBe(false)
    for (const id of [profile.id, copy.id]) {
      const updated = entries.find(e => e.id === id)!
      expect(source(updated, other.id)).toEqual(preserved)
      expect(updated.meta).not.toHaveProperty('profile')
      expect(updated.text).not.toContain(oldQuote)
    }
    expect(await files(rootDir, 'bob')).toEqual(bobBefore)
    expect(JSON.stringify(await files(rootDir))).not.toContain(oldQuote)
  })

  it('does not write for ambiguity or a missing exact quote', async () => {
    const { rootDir, memory, old, opts } = await setup()
    await memory.remember({ ...old, id: 'another-turn' })
    const before = await files(rootDir)
    expect(await correctButlerMemoryFiles(opts)).toEqual({ status: 'ambiguous', sourceIds: expect.arrayContaining(['old-turn', 'another-turn']) })
    opts.correction.target.quote = 'I do not match any evidence'
    expect(await correctButlerMemoryFiles(opts)).toEqual({ status: 'not_found', sourceIds: [] })
    expect(await files(rootDir)).toEqual(before)
  })

  it('can disambiguate with an exact original source ID without deleting the other occurrence', async () => {
    const { rootDir, memory, old, opts } = await setup()
    await memory.remember({ ...old, id: 'another-turn' })
    opts.correction.target.sourceId = old.id
    await correctButlerMemoryFiles(opts)
    const after = (await openButlerMemory({ rootDir, userId: 'alice', logger }).snapshot()).entries
    expect(after.some(e => e.id === old.id)).toBe(false)
    expect(after.find(e => e.id === 'another-turn')!.text).toBe(old.text)
  })

  it.each(['legacy', 'assistant-only'])('refuses untraced %s records rather than pretending derived copies are gone', async type => {
    const { rootDir, memory, opts } = await setup()
    await memory.remember(type === 'legacy' ? { kind: 'semantic', text: 'unknown provenance' }
      : buildTurnCapture({ userText: '', replyText: 'untraced assistant output', temporal: time })!)
    const before = await files(rootDir)
    await expect(correctButlerMemoryFiles(opts)).rejects.toMatchObject({ code: 'CORRECTION_UNTRACED' })
    expect(await files(rootDir)).toEqual(before)
  })

  it('refuses broken evidence and mismatched stored ownership before modifying files', async () => {
    const { rootDir, memory, opts } = await setup()
    await memory.patchMeta('old-turn', { userId: 'bob' })
    const before = await files(rootDir)
    await expect(correctButlerMemoryFiles(opts)).rejects.toMatchObject({ code: 'correction_invalid' })
    expect(await files(rootDir)).toEqual(before)
  })

  it('checks the new entry budget after the file backend adds ID and timestamp', async () => {
    const { rootDir, memory, opts } = await setup()
    const plan = prepareEvidenceCorrection((await memory.snapshot()).entries, { ...opts.correction, userId: 'alice' })
    if (plan.status !== 'ready') throw new Error('expected ready')
    opts.correction.maxEntryBytes = Buffer.byteLength(JSON.stringify(plan.replacement), 'utf8')
    const before = await files(rootDir)
    await expect(correctButlerMemoryFiles(opts)).rejects.toMatchObject({ code: 'MUTATION_OVERFLOW' })
    expect(await files(rootDir)).toEqual(before)
  })

  it('does not let a concurrent write get erased by an outdated snapshot', async () => {
    const { rootDir, memory, opts } = await setup()
    const original = MemoryFileHandle.prototype.snapshot
    const snapshot = vi.spyOn(MemoryFileHandle.prototype, 'snapshot').mockImplementationOnce(async function (this: MemoryFileHandle) {
      const out = await original.call(this)
      await memory.remember({ ...buildTurnCapture({ userText: 'concurrent user statement', replyText: '', temporal: time, meta: { userId: 'alice' } })!, id: 'concurrent' })
      return out
    })
    try { await expect(correctButlerMemoryFiles(opts)).rejects.toMatchObject({ code: 'MUTATION_CONFLICT' }) }
    finally { snapshot.mockRestore() }
    const after = await memory.snapshot()
    expect(after.entries.some(e => e.id === 'old-turn')).toBe(true)
    expect(after.entries.some(e => e.id === 'concurrent')).toBe(true)
    expect(after.entries.some(e => e.text === newQuote)).toBe(false)
    expect(Object.keys(await files(rootDir)).every(name => name.endsWith('.jsonl'))).toBe(true)
  })

  it('copies correction arguments before awaiting a snapshot and binds the trusted userId last', async () => {
    const { rootDir, opts } = await setup()
    Object.assign(opts.correction, { userId: 'bob' })
    const original = MemoryFileHandle.prototype.snapshot
    const snapshot = vi.spyOn(MemoryFileHandle.prototype, 'snapshot').mockImplementationOnce(async function (this: MemoryFileHandle) {
      const out = await original.call(this)
      opts.correction.replacement.text = 'mutated after dispatch'
      opts.correction.target.quote = 'different'
      return out
    })
    try { expect((await correctButlerMemoryFiles(opts)).status).toBe('memory_files_updated') }
    finally { snapshot.mockRestore() }
    const after = await openButlerMemory({ rootDir, userId: 'alice', logger }).snapshot()
    expect(after.entries[0]!.text).toBe(newQuote)
    expect(after.entries[0]!.meta!.userId).toBe('alice')
  })
})
