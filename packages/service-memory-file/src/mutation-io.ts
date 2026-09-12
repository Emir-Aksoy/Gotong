import { constants } from 'node:fs'
import fs from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { readKind, regularFileExists } from './snapshot.js'

export type MemoryFileMutationErrorCode =
  | 'MUTATION_CONFLICT' | 'MUTATION_STALE_HANDLE' | 'MUTATION_PENDING'
  | 'MUTATION_INVALID' | 'MUTATION_OVERFLOW' | 'MUTATION_IO_ERROR'
  | 'MUTATION_RECOVERY_CONFLICT'

const messages: Record<MemoryFileMutationErrorCode, string> = {
  MUTATION_CONFLICT: 'Memory revision changed.',
  MUTATION_STALE_HANDLE: 'Memory handle belongs to an older generation.',
  MUTATION_PENDING: 'Memory mutation requires explicit recovery.',
  MUTATION_INVALID: 'Memory mutation input is invalid.',
  MUTATION_OVERFLOW: 'Memory mutation exceeds the configured budget.',
  MUTATION_IO_ERROR: 'Memory mutation could not be completed.',
  MUTATION_RECOVERY_CONFLICT: 'Memory mutation recovery cannot verify the current state.',
}

/** Intentionally excludes paths, row contents and the underlying cause. */
export class MemoryFileMutationError extends Error {
  constructor(readonly code: MemoryFileMutationErrorCode) { super(messages[code]) }
}
export function fail(code: MemoryFileMutationErrorCode): never { throw new MemoryFileMutationError(code) }
export const isGeneration = (v: unknown): v is string => typeof v === 'string'
  && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v)
export const mutationPaths = (dir: string) => ({
  prepare: join(dir, '.mutation.prepare'), pending: join(dir, '.mutation.pending'),
  generation: join(dir, '.mutation.generation'),
})

export async function readGeneration(dir: string): Promise<string | null> {
  const raw = await readKind(mutationPaths(dir).generation)
  if (raw === undefined) return null
  const value = raw.toString('utf8')
  if (!isGeneration(value)) fail('MUTATION_RECOVERY_CONFLICT')
  return value
}

export async function assertNoPending(dir: string): Promise<void> {
  const paths = mutationPaths(dir)
  // Prepare also blocks: a process may have stopped before its rename completed.
  if (await regularFileExists(paths.pending) || await regularFileExists(paths.prepare)) fail('MUTATION_PENDING')
}

export async function syncDirectory(dir: string): Promise<void> {
  const fd = await fs.open(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { await fd.sync() } finally { await fd.close() }
}

/** Exclusive creation never takes ownership of a pre-existing unknown file. */
export async function writeExclusive(path: string, raw: Buffer | string): Promise<void> {
  const fd = await fs.open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try {
    await fd.writeFile(raw)
    await fd.sync()
  } catch (error) {
    // This invocation created the file, so an incomplete pre-publish write is ours.
    await fs.unlink(path).catch(() => undefined)
    throw error
  } finally { await fd.close() }
}

/** Names derive only from the validated journal generation and configured kinds. */
export function mutationTemp(dir: string, generation: string, kind: string): string {
  return join(dir, `.mutation-${generation}-${kind}.tmp`)
}

/** Validate the complete temp set before deleting any file or replaying any kind. */
export async function preflightTemps(dir: string, expected: ReadonlyMap<string, Buffer>): Promise<string[]> {
  const present: string[] = []
  for (const name of await fs.readdir(dir)) {
    if (!name.startsWith('.mutation-') || !name.endsWith('.tmp')) continue
    const path = join(dir, name)
    const after = expected.get(path)
    if (after === undefined) fail('MUTATION_RECOVERY_CONFLICT')
    const raw = await readKind(path)
    if (raw === undefined || !raw.equals(after)) fail('MUTATION_RECOVERY_CONFLICT')
    present.push(path)
  }
  return present
}

export async function cleanTemps(dir: string, paths: readonly string[]): Promise<void> {
  for (const path of paths) await fs.unlink(path)
  if (paths.length > 0) await syncDirectory(dir)
}

/** Writes only after-images; never creates a backup copy of the old file. */
export async function replaceFile(path: string, raw: Buffer | string, tmp: string): Promise<void> {
  await regularFileExists(path)
  await writeExclusive(tmp, raw)
  try {
    await fs.rename(tmp, path)
    await syncDirectory(dirname(path))
  } catch (error) {
    await fs.unlink(tmp).catch(() => undefined)
    throw error
  }
}

export async function cleanPending(dir: string): Promise<void> {
  // Release is the last fallible operation. We deliberately do NOT promise a
  // durable marker deletion: power loss may resurrect it, requiring recovery.
  // Syncing after unlink would require recreating the sole barrier on failure.
  await syncDirectory(dir)
  await fs.unlink(mutationPaths(dir).pending)
}
