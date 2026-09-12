import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import type { MemoryEntry, MemoryKind, NewMemoryEntry, Owner } from '@gotong/services-sdk'
import { ownerKey } from '@gotong/services-sdk'
import type { MemoryFileConfig } from './config.js'
import { generateEntryId } from './id.js'
import { kindFile, ownerDir } from './paths.js'
import { inspectScope, parseEntries, readKind, readMemoryFileState, readMemoryFileSnapshot } from './snapshot.js'
import {
  MemoryFileMutationError, assertNoPending, cleanPending, cleanTemps, fail, isGeneration,
  mutationPaths, mutationTemp, preflightTemps, readGeneration, replaceFile, syncDirectory, writeExclusive,
} from './mutation-io.js'

export interface MemoryFileSnapshotMutation {
  expectedRevision: string
  remove: readonly { id: string; kind: MemoryKind }[]
  rewrite: readonly MemoryEntry[]
  append: readonly NewMemoryEntry[]
  maxEntryBytes: number
}

interface Scope { rootDir: string; owner: Owner; config: MemoryFileConfig }
interface Change { kind: MemoryKind; before: string | null; after: string; content: string }
interface Journal {
  schema: 1
  owner: string
  kinds: MemoryKind[]
  beforeGeneration: string | null
  afterGeneration: string
  changes: Change[]
}
const digest = (raw: Buffer | undefined): string | null => raw === undefined ? null
  : createHash('sha256').update(raw).digest('hex')
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
const hex = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)
const exact = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).every((k) => keys.includes(k))

/** Detach synchronously before entering the queue; reject lossy/non-JSON input. */
export function copyMutation(input: MemoryFileSnapshotMutation): MemoryFileSnapshotMutation {
  try {
    const copy = structuredClone(input)
    assertJson(copy)
    if (!object(copy) || !exact(copy, ['expectedRevision', 'remove', 'rewrite', 'append', 'maxEntryBytes'])
      || !hex(copy.expectedRevision) || !Array.isArray(copy.remove) || !Array.isArray(copy.rewrite)
      || !Array.isArray(copy.append) || !Number.isSafeInteger(copy.maxEntryBytes) || copy.maxEntryBytes <= 0) fail('MUTATION_INVALID')
    return copy
  } catch { fail('MUTATION_INVALID') }
}

function assertJson(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number' && Number.isFinite(value)) return
  if (typeof value !== 'object' || seen.has(value)) fail('MUTATION_INVALID')
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) fail('MUTATION_INVALID')
  seen.add(value)
  for (const item of Object.values(value)) assertJson(item, seen)
  seen.delete(value)
}

function checkedEntry(value: unknown, kinds: readonly MemoryKind[], maxBytes: number): MemoryEntry {
  if (!object(value) || !kinds.includes(value.kind as MemoryKind)) fail('MUTATION_INVALID')
  const raw = Buffer.from(JSON.stringify(value))
  try { parseEntries(raw, value.kind as MemoryKind) } catch { fail('MUTATION_INVALID') }
  if (raw.byteLength > maxBytes) fail('MUTATION_OVERFLOW')
  return value as unknown as MemoryEntry
}

/** The caller owns the process-wide owner queue for this entire operation. */
export async function applyMutation(scope: Scope, input: MemoryFileSnapshotMutation, generation: string | null, now: () => number) {
  try {
    const { rootDir, owner, config } = scope
    const dir = ownerDir(rootDir, owner)
    const { snapshot, files } = await readMemoryFileState(rootDir, owner, config.kinds, generation)
    if (snapshot.revision !== input.expectedRevision) fail('MUTATION_CONFLICT')
    const existing = new Map<string, MemoryEntry>()
    for (const entry of snapshot.entries) {
      if (existing.has(entry.id)) fail('MUTATION_INVALID')
      existing.set(entry.id, entry)
    }
    const touched = new Set<string>()
    const rewrites = new Map<string, MemoryEntry>()
    for (const target of [...input.remove, ...input.rewrite]) {
      if (!object(target) || typeof target.id !== 'string' || !config.kinds.includes(target.kind as MemoryKind)
        || !existing.has(target.id) || existing.get(target.id)!.kind !== target.kind || touched.has(target.id)) fail('MUTATION_INVALID')
      touched.add(target.id)
    }
    for (const target of input.remove) if (!exact(target, ['id', 'kind'])) fail('MUTATION_INVALID')
    for (const entry of input.rewrite) rewrites.set(entry.id, checkedEntry(entry, config.kinds, input.maxEntryBytes))
    const appended: MemoryEntry[] = []
    for (const entry of input.append) {
      if (!object(entry) || !exact(entry, ['id', 'kind', 'text', 'meta'])) fail('MUTATION_INVALID')
      const ts = now()
      const persisted = checkedEntry({ ...entry, id: entry.id ?? generateEntryId(ts), ts }, config.kinds, input.maxEntryBytes)
      if (existing.has(persisted.id)) fail('MUTATION_INVALID')
      existing.set(persisted.id, persisted)
      appended.push(persisted)
    }
    const changes: Change[] = []
    for (const [kind, raw] of files) {
      const rows = raw?.toString('utf8').match(/[^\n]*\n|[^\n]+$/g) ?? []
      let affected = false
      let content = ''
      for (const row of rows) {
        const entry = JSON.parse(row) as MemoryEntry
        if (!touched.has(entry.id)) content += row
        else {
          affected = true
          const next = rewrites.get(entry.id)
          if (next) content += JSON.stringify(next) + '\n'
        }
      }
      for (const entry of appended.filter((e) => e.kind === kind)) {
        affected = true
        if (content && !content.endsWith('\n')) content += '\n'
        content += JSON.stringify(entry) + '\n'
      }
      if (!affected) continue
      const cap = kind === 'episodic' ? config.maxEpisodicBytes : kind === 'semantic' ? config.maxSemanticBytes : undefined
      if (cap !== undefined && Buffer.byteLength(content) > cap) fail('MUTATION_OVERFLOW')
      changes.push({ kind, before: digest(raw), after: digest(Buffer.from(content))!, content })
    }
    if (changes.length === 0) return { snapshot, generation }
    const journal: Journal = { schema: 1, owner: ownerKey(owner), kinds: [...files.keys()],
      beforeGeneration: generation, afterGeneration: randomUUID(), changes }
    const encoded = Buffer.from(JSON.stringify(journal))
    await fs.mkdir(dir, { recursive: true })
    await assertNoPending(dir)
    await preflightTemps(dir, new Map())
    const paths = mutationPaths(dir)
    await writeExclusive(paths.prepare, encoded)
    await fs.rename(paths.prepare, paths.pending)
    await syncDirectory(dir)
    return await redo(scope, journal)
  } catch (error) {
    if (error instanceof MemoryFileMutationError) throw error
    fail('MUTATION_IO_ERROR')
  }
}

function parseJournal(raw: Buffer, scope: Scope): Journal {
  try {
    const j: unknown = JSON.parse(raw.toString('utf8'))
    if (!object(j) || !exact(j, ['schema', 'owner', 'kinds', 'beforeGeneration', 'afterGeneration', 'changes'])
      || j.schema !== 1 || j.owner !== ownerKey(scope.owner)
      || JSON.stringify(j.kinds) !== JSON.stringify([...new Set(scope.config.kinds)].sort())
      || !(j.beforeGeneration === null || isGeneration(j.beforeGeneration)) || !isGeneration(j.afterGeneration)
      || j.beforeGeneration === j.afterGeneration || !Array.isArray(j.changes) || j.changes.length === 0) fail('MUTATION_RECOVERY_CONFLICT')
    const seen = new Set<MemoryKind>()
    for (const c of j.changes) {
      if (!object(c) || !exact(c, ['kind', 'before', 'after', 'content'])
        || !scope.config.kinds.includes(c.kind as MemoryKind) || seen.has(c.kind as MemoryKind)
        || !(c.before === null || hex(c.before)) || !hex(c.after) || typeof c.content !== 'string'
        || digest(Buffer.from(c.content)) !== c.after) fail('MUTATION_RECOVERY_CONFLICT')
      seen.add(c.kind as MemoryKind)
      parseEntries(Buffer.from(c.content), c.kind as MemoryKind)
    }
    return j as unknown as Journal
  } catch { fail('MUTATION_RECOVERY_CONFLICT') }
}

function journalTemps(dir: string, journal: Journal): Map<string, Buffer> {
  const expected = new Map<string, Buffer>()
  for (const change of journal.changes) {
    expected.set(mutationTemp(dir, journal.afterGeneration, change.kind), Buffer.from(change.content))
  }
  expected.set(mutationTemp(dir, journal.afterGeneration, 'generation'), Buffer.from(journal.afterGeneration))
  return expected
}

async function redo(scope: Scope, journal: Journal) {
  const dir = ownerDir(scope.rootDir, scope.owner)
  for (const change of journal.changes) {
    await replaceFile(kindFile(scope.rootDir, scope.owner, change.kind), change.content,
      mutationTemp(dir, journal.afterGeneration, change.kind))
  }
  await replaceFile(mutationPaths(dir).generation, journal.afterGeneration,
    mutationTemp(dir, journal.afterGeneration, 'generation'))
  // Verification is still inside the pending barrier. No fallible reads follow
  // cleanup, otherwise a failed return could leave an apparently healthy store.
  const snapshot = await readMemoryFileSnapshot(scope.rootDir, scope.owner, scope.config.kinds, journal.afterGeneration)
  await cleanTemps(dir, await preflightTemps(dir, journalTemps(dir, journal)))
  await cleanPending(dir)
  return { generation: journal.afterGeneration, snapshot }
}

/** Trusted host only. No cross-process locking and never rolls old text back. */
export async function recoverMutation(scope: Scope) {
  try {
    const { rootDir, owner, config } = scope
    const { exists } = await inspectScope(rootDir, owner, config.kinds)
    const dir = ownerDir(rootDir, owner)
    const paths = mutationPaths(dir)
    const pending = exists ? await readKind(paths.pending) : undefined
    const prepare = exists ? await readKind(paths.prepare) : undefined
    if (pending && prepare) fail('MUTATION_RECOVERY_CONFLICT')
    const generation = exists ? await readGeneration(dir) : null
    const raw = pending ?? prepare
    if (raw !== undefined) {
      const journal = parseJournal(raw, scope)
      if (generation !== journal.beforeGeneration && (prepare !== undefined || generation !== journal.afterGeneration)) fail('MUTATION_RECOVERY_CONFLICT')
      // Validate the COMPLETE state before the first overwrite, including kinds
      // that already reached their after-image before the original crash.
      const state = await readMemoryFileState(rootDir, owner, config.kinds, generation)
      for (const change of journal.changes) {
        const current = digest(state.files.get(change.kind))
        // After-generation proves all kinds were committed. A before-image at
        // this point may be a later legitimate edit plus a resurrected marker.
        const valid = generation === journal.afterGeneration ? current === change.after
          : prepare !== undefined ? current === change.before
          : current === change.before || current === change.after
        if (!valid) fail('MUTATION_RECOVERY_CONFLICT')
      }
      const temps = await preflightTemps(dir, journalTemps(dir, journal))
      await cleanTemps(dir, temps)
      if (prepare !== undefined) {
        await syncDirectory(dir)
        await fs.unlink(paths.prepare)
        return { generation, snapshot: state.snapshot }
      } else return await redo(scope, journal)
    }
    if (exists) await preflightTemps(dir, new Map())
    const currentGeneration = await readGeneration(dir)
    return { generation: currentGeneration,
      snapshot: await readMemoryFileSnapshot(rootDir, owner, config.kinds, currentGeneration) }
  } catch (error) {
    if (error instanceof MemoryFileMutationError) throw error
    // Invalid scope/data and foreign files must not become permission to overwrite.
    if (object(error) && typeof error.code === 'string' && error.code.startsWith('SNAPSHOT_')) fail('MUTATION_RECOVERY_CONFLICT')
    fail('MUTATION_IO_ERROR')
  }
}
