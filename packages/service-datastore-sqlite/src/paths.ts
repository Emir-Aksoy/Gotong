/**
 * On-disk layout helpers for `datastore:sqlite`.
 *
 *   <rootDir>/                                  ← Hub Services dir for this plugin
 *     <ownerKind>/                              ← 'agent' | 'workflow-run' | 'shared'
 *       <ownerId>/                              ← e.g. 'industry-coach'
 *         <datastoreName>.sqlite                ← the .sqlite file
 *     .trash/
 *       <trashId>/
 *         meta.json
 *         payload/                              ← copy of the owner directory
 *
 * One owner can have N datastores by different `config.name`s — each
 * lands in its own `.sqlite` so a `DROP TABLE` in one doesn't touch
 * another. Soft-deleting an owner moves the entire owner directory
 * (i.e. every datastore that owner had) into .trash atomically.
 */

import { join } from 'node:path'
import type { Owner } from '@gotong/services-sdk'
import { assertSafeOwnerId } from '@gotong/services-sdk'

/**
 * Absolute path to an owner's directory under `<rootDir>`.
 *
 * `assertSafeOwnerId` runs first — defense-in-depth against a hostile
 * Owner.id like `../shared/group-x` that would let an agent open
 * another owner's `.sqlite` file. `name` is already validated upstream
 * for the `<name>.sqlite` segment.
 */
export function ownerDir(rootDir: string, owner: Owner): string {
  assertSafeOwnerId(owner.id)
  return join(rootDir, owner.kind, owner.id)
}

export function dbFile(rootDir: string, owner: Owner, name: string): string {
  return join(ownerDir(rootDir, owner), `${name}.sqlite`)
}

export function trashRoot(rootDir: string): string {
  return join(rootDir, '.trash')
}

export function trashEntryDir(rootDir: string, refId: string): string {
  return join(trashRoot(rootDir), refId)
}

export function trashMetaFile(rootDir: string, refId: string): string {
  return join(trashEntryDir(rootDir, refId), 'meta.json')
}

export function trashPayloadDir(rootDir: string, refId: string): string {
  return join(trashEntryDir(rootDir, refId), 'payload')
}
