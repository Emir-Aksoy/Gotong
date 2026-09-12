import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { dirname } from 'node:path'
import { TextDecoder } from 'node:util'
import { ownerKey, parseOwnerKey, type MemoryEntry, type MemoryKind, type Owner } from '@gotong/services-sdk'
import { kindFile, ownerDir } from './paths.js'

export interface MemoryFileSnapshot {
  /** Complete configured-kind contents, newest first; detached for planning. */
  entries: MemoryEntry[]
  /** Opaque SHA256 bound to owner, generation, kinds and full raw bytes. */
  revision: string
}

export type MemoryFileSnapshotErrorCode =
  | 'SNAPSHOT_INVALID_DATA'
  | 'SNAPSHOT_IO_ERROR'
  | 'SNAPSHOT_INVALID_SCOPE'

const messages: Record<MemoryFileSnapshotErrorCode, string> = {
  SNAPSHOT_INVALID_DATA: 'Memory snapshot contains invalid data.',
  SNAPSHOT_IO_ERROR: 'Memory snapshot could not be read completely.',
  SNAPSHOT_INVALID_SCOPE: 'Memory snapshot scope is invalid.',
}

/** No raw row, path, owner, or underlying error is attached. */
export class MemoryFileSnapshotError extends Error {
  constructor(readonly code: MemoryFileSnapshotErrorCode) {
    super(messages[code])
  }
}

/** Internal reader: the handle MUST hold its process-wide owner queue throughout. */
export async function readMemoryFileSnapshot(
  rootDir: string,
  owner: Owner,
  configuredKinds: ReadonlyArray<MemoryKind>,
  generation: string | null = null,
): Promise<MemoryFileSnapshot> {
  return (await readMemoryFileState(rootDir, owner, configuredKinds, generation)).snapshot
}

/** Cheap derived-cache freshness only; never use this instead of the mutation CAS. */
export async function readMemoryFileWatermark(
  rootDir: string, owner: Owner, configuredKinds: ReadonlyArray<MemoryKind>, generation: string | null,
): Promise<string> {
  const { kinds, exists } = await inspectScope(rootDir, owner, configuredKinds)
  try {
    const hash = createHash('sha256').update('memory-file-watermark:v1\n')
      .update(JSON.stringify([ownerKey(owner), generation]) + '\n')
    for (const kind of kinds) {
      let attributes: string[] | null = null
      if (exists) {
        try {
          const s = await lstat(kindFile(rootDir, owner, kind), { bigint: true })
          if (s.isSymbolicLink()) throw new MemoryFileSnapshotError('SNAPSHOT_INVALID_SCOPE')
          if (!s.isFile()) throw new MemoryFileSnapshotError('SNAPSHOT_IO_ERROR')
          attributes = [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].map(String)
        } catch (error) {
          if (!isMissing(error)) throw error
        }
      }
      hash.update(JSON.stringify([kind, attributes]) + '\n')
    }
    return hash.digest('hex')
  } catch (error) {
    if (error instanceof MemoryFileSnapshotError) throw error
    throw new MemoryFileSnapshotError('SNAPSHOT_IO_ERROR')
  }
}

/** Internal only: raw bytes never escape through the public snapshot. */
export async function readMemoryFileState(
  rootDir: string, owner: Owner, configuredKinds: ReadonlyArray<MemoryKind>, generation: string | null,
): Promise<{ snapshot: MemoryFileSnapshot; files: Map<MemoryKind, Buffer | undefined> }> {
  const { kinds, exists } = await inspectScope(rootDir, owner, configuredKinds)
  try {
    const hash = createHash('sha256').update('memory-file-snapshot:v2\n')
      .update(JSON.stringify([ownerKey(owner), generation]) + '\n')
    const entries: MemoryEntry[] = []
    const files = new Map<MemoryKind, Buffer | undefined>()
    for (const kind of kinds) {
      const raw = exists ? await readKind(kindFile(rootDir, owner, kind)) : undefined
      files.set(kind, raw)
      hash.update(JSON.stringify([kind, raw?.byteLength ?? null]) + '\n')
      if (raw === undefined) continue
      hash.update(raw)
      for (const entry of parseEntries(raw, kind)) entries.push(entry)
    }
    return { files, snapshot: { entries: entries.sort((a, b) => b.ts - a.ts), revision: hash.digest('hex') } }
  } catch (error) {
    if (error instanceof MemoryFileSnapshotError) throw error
    throw new MemoryFileSnapshotError('SNAPSHOT_IO_ERROR')
  }
}

export async function inspectScope(rootDir: string, owner: Owner, configuredKinds: ReadonlyArray<MemoryKind>) {
  let dir: string
  let kinds: MemoryKind[]
  try {
    if (parseOwnerKey(ownerKey(owner)).kind !== owner.kind) {
      throw new MemoryFileSnapshotError('SNAPSHOT_INVALID_SCOPE')
    }
    dir = ownerDir(rootDir, owner)
    kinds = [...new Set(configuredKinds)].sort()
    if (kinds.some((kind) => kind !== 'episodic' && kind !== 'semantic' && kind !== 'working')) {
      throw new MemoryFileSnapshotError('SNAPSHOT_INVALID_SCOPE')
    }
  } catch {
    throw new MemoryFileSnapshotError('SNAPSHOT_INVALID_SCOPE')
  }

  try {
    // rootDir is caller-configured; reject existing descendant symlink redirects.
    // Directory checks are not protection against hostile cross-process replacement.
    const exists = await directoryExists(dirname(dir)) && await directoryExists(dir)
    return { kinds, exists }
  } catch (error) {
    if (error instanceof MemoryFileSnapshotError) throw error
    throw new MemoryFileSnapshotError('SNAPSHOT_IO_ERROR')
  }
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    const info = await lstat(path)
    if (info.isSymbolicLink()) throw new MemoryFileSnapshotError('SNAPSHOT_INVALID_SCOPE')
    if (!info.isDirectory()) throw new MemoryFileSnapshotError('SNAPSHOT_IO_ERROR')
    return true
  } catch (error) {
    if (isMissing(error)) return false
    throw error
  }
}

export async function regularFileExists(path: string): Promise<boolean> {
  try {
    const info = await lstat(path)
    if (info.isSymbolicLink()) throw new MemoryFileSnapshotError('SNAPSHOT_INVALID_SCOPE')
    if (!info.isFile()) throw new MemoryFileSnapshotError('SNAPSHOT_IO_ERROR')
    return true
  } catch (error) {
    if (isMissing(error)) return false
    throw error
  }
}

export async function readKind(path: string): Promise<Buffer | undefined> {
  try {
    if (!await regularFileExists(path)) return undefined
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      if (!(await file.stat()).isFile()) throw new MemoryFileSnapshotError('SNAPSHOT_IO_ERROR')
      return await file.readFile()
    } finally {
      await file.close()
    }
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
}

export function parseEntries(raw: Buffer, kind: MemoryKind): MemoryEntry[] {
  const entries: MemoryEntry[] = []
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw)
  } catch {
    throw new MemoryFileSnapshotError('SNAPSHOT_INVALID_DATA')
  }
  const lines = text.split('\n')
  // A final newline terminates the last record; interior empty rows are corrupt.
  if (lines.at(-1) === '') lines.pop()
  for (const line of lines) {
    let entry: unknown
    try { entry = JSON.parse(line) } catch {
      throw new MemoryFileSnapshotError('SNAPSHOT_INVALID_DATA')
    }
    if (!isObject(entry)
      || typeof entry.id !== 'string' || entry.id.length === 0
      || typeof entry.text !== 'string' || entry.text.length === 0
      || entry.kind !== kind
      || typeof entry.ts !== 'number' || !Number.isFinite(entry.ts)
      || (entry.meta !== undefined && !isObject(entry.meta))) {
      throw new MemoryFileSnapshotError('SNAPSHOT_INVALID_DATA')
    }
    entries.push(entry as unknown as MemoryEntry)
  }
  return entries
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isMissing(error: unknown): boolean {
  return isObject(error) && error.code === 'ENOENT'
}
