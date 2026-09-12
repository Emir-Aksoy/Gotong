import type { Logger } from '@gotong/core'
import { PersonalMemoryError, prepareEvidenceCorrection, type EvidenceCorrectionOptions } from '@gotong/personal-memory'
import { openButlerMemory } from './personal-butler-memory.js'

export interface ButlerMemoryCorrectionOptions {
  rootDir: string
  /** Resolved by the trusted host membership boundary, not supplied by a model tool. */
  userId: string
  logger: Logger
  correction: Omit<EvidenceCorrectionOptions, 'userId'>
  now?: () => number
}
export type ButlerMemoryCorrectionResult =
  | { status: 'not_found' | 'ambiguous'; sourceIds: string[] }
  | { status: 'memory_files_updated'; revision: string }

export class ButlerMemoryCorrectionError extends Error {
  readonly code = 'CORRECTION_UNTRACED'
  constructor() {
    super('Untraced memory remains; file correction refused')
    this.name = 'ButlerMemoryCorrectionError'
  }
}

/**
 * Internal file operation only, deliberately NOT attached to a route or LLM tool.
 * The eventual coordinator must retire old tasks/contexts and clear derived caches
 * and history before claiming completion or reopening user-facing memory access.
 */
export async function correctButlerMemoryFiles(opts: ButlerMemoryCorrectionOptions): Promise<ButlerMemoryCorrectionResult> {
  const { rootDir, userId, logger, now } = opts
  let correction: ButlerMemoryCorrectionOptions['correction']
  try { correction = structuredClone(opts.correction) }
  catch { throw new PersonalMemoryError('correction_invalid', 'Invalid correction request') }
  const memory = openButlerMemory({ rootDir, userId, logger, now })
  const snapshot = await memory.snapshot()
  const plan = prepareEvidenceCorrection(snapshot.entries, { ...correction, userId })
  if (plan.status !== 'ready') return plan
  // Absence of structured provenance is not proof that no old derivative survives.
  if (plan.untraced.length) throw new ButlerMemoryCorrectionError()
  const updated = await memory.applySnapshotMutation({
    expectedRevision: snapshot.revision, remove: plan.remove, rewrite: plan.rewrite,
    append: [plan.replacement], maxEntryBytes: correction.maxEntryBytes,
  })
  logger.info('butler memory: source correction committed to memory files', {
    userId, removed: plan.remove.length, rewritten: plan.rewrite.length,
  })
  return { status: 'memory_files_updated', revision: updated.revision }
}
