/**
 * personal-butler-memory.ts — per-user memory namespace for the resident butler.
 *
 * The butler's memory is PER MEMBER: each user gets their own jsonl tree so one
 * member's butler can never recall another's facts (the §七 "no-leak" claim).
 * The `memory-file` backend already gives us this for free — an `Owner` of
 * `{ kind: 'user', id: userId }` resolves to `<rootDir>/user/<userId>/`, and
 * `assertSafeOwnerId` (run on every path op) blocks traversal — so this helper
 * is a thin, single-seam factory: the one place that turns a user id into a
 * scoped `MemoryHandle`.
 *
 * Both the butler agent (capture + frozen block) and the `/me` privacy view
 * (read profile / forget / export) open the SAME per-user handle through here,
 * so "what the butler remembers" and "what the member can see/erase" are the
 * exact same bytes — no second source of truth.
 *
 * The butler uses `episodic` (auto-captured turns) + `semantic` (the
 * consolidated profile); `working` is omitted by default since the butler
 * carries its in-flight loop state on the suspend, not in memory.
 */

import type { Logger } from '@aipehub/core'
import { MemoryFileHandle, type MemoryFileConfig } from '@aipehub/service-memory-file'
import type { MemoryHandle, Owner } from '@aipehub/services-sdk'

/** Default memory kinds for a butler: captured turns + the distilled profile. */
export const BUTLER_MEMORY_KINDS: MemoryFileConfig['kinds'] = ['episodic', 'semantic']

export interface OpenButlerMemoryOptions {
  /** Memory root dir (the host's memory service rootDir, or a butler subtree). */
  rootDir: string
  /** The member whose butler memory this is — the namespace boundary. */
  userId: string
  /** Backend config (kinds + optional byte caps). Defaults to {@link BUTLER_MEMORY_KINDS}. */
  config?: MemoryFileConfig
  logger: Logger
  /** Injectable clock (deterministic tests). */
  now?: () => number
}

/**
 * Open a butler memory handle scoped to one user. Throws on an empty user id —
 * a butler with no member to scope by is a wiring bug, fail visible rather than
 * silently sharing one tree (the no-leak invariant must not depend on luck).
 */
export function openButlerMemory(opts: OpenButlerMemoryOptions): MemoryHandle {
  if (typeof opts.userId !== 'string' || opts.userId.length === 0) {
    throw new Error('openButlerMemory: a non-empty userId is required (per-user namespace)')
  }
  const owner: Owner = { kind: 'user', id: opts.userId }
  const config: MemoryFileConfig = opts.config ?? { kinds: BUTLER_MEMORY_KINDS }
  return new MemoryFileHandle({
    rootDir: opts.rootDir,
    owner,
    config,
    logger: opts.logger,
    ...(opts.now ? { now: opts.now } : {}),
  })
}
