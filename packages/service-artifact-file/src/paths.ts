/**
 * Path layout — same shape as memory-file but stores arbitrary
 * user-named files per owner.
 *
 *   <rootDir>/
 *   ├─ agent/<agentId>/                 ← user-named files live here
 *   │  ├─ <userPath>.md
 *   │  ├─ subdir/<userPath>.json
 *   │  └─ ...
 *   ├─ workflow-run/<runId>/
 *   ├─ shared/<groupId>/
 *   └─ .trash/<refId>/
 *      ├─ meta.json
 *      └─ payload/                       ← owner directory, moved
 *
 * Path safety: every user-supplied path goes through {@link sanitisePath}
 * before being joined to the owner dir. Defense-in-depth means we
 * also `resolve()` the final path and assert it's still inside the
 * owner dir — catches mistakes the regex didn't.
 */

import { isAbsolute, join, normalize, resolve, sep } from 'node:path'
import type { Owner } from '@gotong/services-sdk'
import { assertSafeOwnerId } from '@gotong/services-sdk'

/**
 * Absolute path to an owner's directory under `<rootDir>`.
 *
 * `assertSafeOwnerId` runs first — defense-in-depth against a hostile
 * Owner.id like `../shared/group-x` that would escape into another
 * tenant. `sanitisePath` further guards user-supplied artifact paths.
 */
export function ownerDir(rootDir: string, owner: Owner): string {
  assertSafeOwnerId(owner.id)
  return join(rootDir, owner.kind, owner.id)
}

export function trashRoot(rootDir: string): string {
  return join(rootDir, '.trash')
}

export function trashEntryDir(rootDir: string, trashId: string): string {
  return join(trashRoot(rootDir), trashId)
}

export function trashMetaFile(rootDir: string, trashId: string): string {
  return join(trashEntryDir(rootDir, trashId), 'meta.json')
}

export function trashPayloadDir(rootDir: string, trashId: string): string {
  return join(trashEntryDir(rootDir, trashId), 'payload')
}

/**
 * Validate a user-supplied path. Rejects:
 *   - absolute paths (`/foo`, `\\?\\foo` on win)
 *   - null bytes (`foo\0bar`)
 *   - `..` segments that escape upward
 *   - empty / whitespace-only paths
 *
 * Returns the normalised relative path. Callers MUST still verify
 * the resolved full path stays inside the owner dir — `sanitisePath`
 * alone is not enough on case-insensitive filesystems with symlinks.
 */
export function sanitisePath(userPath: string): string {
  if (typeof userPath !== 'string') {
    throw new Error('artifact path must be a string')
  }
  if (userPath.length === 0 || userPath.trim().length === 0) {
    throw new Error('artifact path must be non-empty')
  }
  if (userPath.includes('\0')) {
    throw new Error('artifact path contains a null byte')
  }
  if (isAbsolute(userPath)) {
    throw new Error('artifact path must be relative')
  }
  const norm = normalize(userPath)
  // After normalisation, anything escaping upward starts with '..' or '/'.
  if (norm === '..' || norm.startsWith(`..${sep}`) || norm.startsWith('/')) {
    throw new Error('artifact path traversal blocked')
  }
  // Return POSIX-separator form. `normalize()` emits the host OS's
  // separator (`\` on Windows), but the wire / on-disk ref policy is
  // "ref === sanitised relative path with `/`" (see `handle.list()`):
  // artifactIds round-trip through URLs and a `uploads/<date>/<rand>`
  // regex, so a Windows `uploads\2026-..\x.txt` would break callers.
  // The traversal checks above run on the OS-native `norm`; this only
  // changes the *string representation* of the safe path. Downstream
  // `join()`/`resolve()` accept `/` on Windows, so FS ops are unaffected.
  // On Linux/macOS `\` isn't a separator, so the replace is a no-op.
  return norm.replace(/\\/g, '/')
}

/**
 * Build the absolute file path for a (owner, userPath) pair AND
 * verify it's contained within `ownerDir`. Returns the absolute path.
 *
 * The containment check catches edge cases that `sanitisePath` alone
 * would miss — e.g. symlinks inside the owner dir pointing outside
 * (the link target gets resolved by `realpath` but we use
 * `resolve()` which is path-only; if a malicious file already
 * exists as a symlink we'd still write through it, but creating
 * such a symlink requires either prior compromise or a
 * separate-path bug — outside our threat model).
 */
export function resolveOwnerPath(rootDir: string, owner: Owner, userPath: string): string {
  const safeRelative = sanitisePath(userPath)
  const oDir = ownerDir(rootDir, owner)
  const full = resolve(join(oDir, safeRelative))
  if (!full.startsWith(resolve(oDir) + sep) && full !== resolve(oDir)) {
    throw new Error('artifact path traversal blocked (post-resolve)')
  }
  return full
}
