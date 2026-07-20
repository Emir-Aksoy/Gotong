/**
 * File-first persistence for inbox items.
 *
 * Layout (under the space root, alongside `transcript.jsonl` / `workflows/`):
 *
 *   .gotong/
 *     inbox/
 *       <itemId>.json     — one item per file, written atomically
 *       …
 *
 * Mirrors `@gotong/workflow`'s `RunStore`: `writeFileAtomic` (tmp+rename) so a
 * `kill -9` mid-write can never leave a half-formed item, and zero deps on the
 * Hub — only paths + file IO. Drop the directory → drop the inbox.
 */

import { existsSync, mkdirSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { writeFileAtomic } from '@gotong/core'

import {
  InboxError,
  type InboxDecision,
  type InboxEvent,
  type InboxItem,
  type InboxStore,
} from './types.js'

/**
 * Make an item id safe as a filename. Item ids are Task ids (UUID-shaped, so
 * already safe), but `:` is legal in some id schemes and Windows rejects it —
 * replace it (and any stray slash) defensively. Idempotent.
 */
function sanitiseItemId(itemId: string): string {
  return itemId.replace(/[:/\\]/g, '__')
}

export class FileInboxStore implements InboxStore {
  readonly root: string

  /**
   * Per-item serialization (audit M5). `markResolved` / `delegate` are
   * read-check-write: `get()` the item, reject if not `pending`, then
   * `write()`. Two concurrent resolves (a double-click, or a request racing
   * a delegate) can BOTH read `pending` before either writes, both pass the
   * guard, and both go on to drive `hub.resumeTask` — a double resume. A
   * promise chain per item id makes the read-check-write atomic within this
   * process, so the second op sees the first's written `resolved`/reassigned
   * state and is rejected by the guard. Single-process best-effort (a SQLite
   * store would use `UPDATE … WHERE status='pending'`); the host inbox is
   * single-process, so this closes the real window.
   */
  private readonly itemLocks = new Map<string, Promise<unknown>>()

  /**
   * @param spaceRoot The space root directory (e.g. `.gotong`).
   *                  The store keeps items under `inbox/` beneath it.
   */
  constructor(spaceRoot: string) {
    this.root = join(spaceRoot, 'inbox')
  }

  /** Run `fn` after any in-flight mutation of the same item id completes. */
  private serialize<T>(itemId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.itemLocks.get(itemId) ?? Promise.resolve()
    // Chain regardless of the previous op's outcome (settle, don't propagate).
    const next = prev.then(fn, fn)
    const tail = next.then(
      () => undefined,
      () => undefined,
    )
    this.itemLocks.set(itemId, tail)
    // Drop the entry once this is the trailing op, so the map can't grow
    // without bound across many distinct items.
    void tail.then(() => {
      if (this.itemLocks.get(itemId) === tail) this.itemLocks.delete(itemId)
    })
    return next
  }

  ensureDirs(): void {
    if (!existsSync(this.root)) {
      mkdirSync(this.root, { recursive: true })
    }
  }

  private pathFor(itemId: string): string {
    return join(this.root, `${sanitiseItemId(itemId)}.json`)
  }

  async write(item: InboxItem): Promise<void> {
    this.ensureDirs()
    await writeFileAtomic(this.pathFor(item.itemId), JSON.stringify(item, null, 2))
  }

  async get(itemId: string): Promise<InboxItem | null> {
    const file = this.pathFor(itemId)
    if (!existsSync(file)) return null
    const raw = await readFile(file, 'utf8')
    try {
      return JSON.parse(raw) as InboxItem
    } catch (err) {
      throw new InboxError(
        'not_found',
        `inbox item '${itemId}' is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  async listPending(userId: string): Promise<InboxItem[]> {
    if (!existsSync(this.root)) return []
    const files = await readdir(this.root)
    const out: InboxItem[] = []
    for (const f of files) {
      if (!f.endsWith('.json') || f.endsWith('.tmp')) continue
      let raw: string
      try {
        raw = await readFile(join(this.root, f), 'utf8')
      } catch {
        // File vanished between readdir and read (a concurrent resolve) — skip.
        continue
      }
      let item: InboxItem
      try {
        item = JSON.parse(raw) as InboxItem
      } catch {
        // A corrupt item shouldn't sink the whole list.
        continue
      }
      if (item.userId === userId && item.status === 'pending') out.push(item)
    }
    out.sort((a, b) => b.createdAt - a.createdAt)
    return out
  }

  async markResolved(
    itemId: string,
    decision: InboxDecision,
    now: number = Date.now(),
  ): Promise<InboxItem> {
    return this.serialize(itemId, () => this.resolveLocked(itemId, decision, now))
  }

  private async resolveLocked(
    itemId: string,
    decision: InboxDecision,
    now: number,
  ): Promise<InboxItem> {
    const item = await this.get(itemId)
    if (!item) {
      throw new InboxError('not_found', `inbox item '${itemId}' not found`)
    }
    // The guard: only a pending item can be resolved. A second resolve (double
    // click, or a sweep racing the request) hits this and is rejected BEFORE
    // any hub.resumeTask runs. Single-process best-effort — a SQLite store
    // would make this a real atomic `UPDATE … WHERE status = 'pending'`.
    if (item.status !== 'pending') {
      throw new InboxError(
        'already_resolved',
        `inbox item '${itemId}' is already ${item.status}`,
      )
    }
    // Seed the action trail (inbox-gov M1). The resolver is the assignee —
    // resolve() forces actor === item.userId before we get here. A `comment`
    // on an approval decision rides along as the note for a richer /me history.
    const event: InboxEvent = { type: 'resolved', actor: item.userId, at: now }
    if (decision.kind === 'approval' && typeof decision.comment === 'string') {
      event.note = decision.comment
    }
    const resolved: InboxItem = {
      ...item,
      status: 'resolved',
      decision,
      resolvedAt: now,
      history: [...(item.history ?? []), event],
    }
    await this.write(resolved)
    return resolved
  }

  async delegate(
    itemId: string,
    toUserId: string,
    opts: { actor: string; note?: string; now?: number },
  ): Promise<InboxItem> {
    return this.serialize(itemId, () => this.delegateLocked(itemId, toUserId, opts))
  }

  private async delegateLocked(
    itemId: string,
    toUserId: string,
    opts: { actor: string; note?: string; now?: number },
  ): Promise<InboxItem> {
    const now = opts.now ?? Date.now()
    const item = await this.get(itemId)
    if (!item) {
      throw new InboxError('not_found', `inbox item '${itemId}' not found`)
    }
    // Same guard as markResolved: only a pending item can be handed off.
    if (item.status !== 'pending') {
      throw new InboxError(
        'already_resolved',
        `inbox item '${itemId}' is already ${item.status}`,
      )
    }
    const event: InboxEvent = { type: 'delegated', actor: opts.actor, to: toUserId, at: now }
    if (typeof opts.note === 'string' && opts.note.length > 0) event.note = opts.note
    // Reassign + record the handoff. Stays pending; the parked task row is keyed
    // by item id, so resume after the new assignee acts is unchanged.
    const handed: InboxItem = {
      ...item,
      userId: toUserId,
      history: [...(item.history ?? []), event],
    }
    await this.write(handed)
    return handed
  }
}
