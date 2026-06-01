/**
 * File-first persistence for inbox items.
 *
 * Layout (under the space root, alongside `transcript.jsonl` / `workflows/`):
 *
 *   .aipehub/
 *     inbox/
 *       <itemId>.json     — one item per file, written atomically
 *       …
 *
 * Mirrors `@aipehub/workflow`'s `RunStore`: atomic `<file>.tmp` + rename so a
 * `kill -9` mid-write can never leave a half-formed item, and zero deps on the
 * Hub — only paths + file IO. Drop the directory → drop the inbox.
 */

import { existsSync, mkdirSync } from 'node:fs'
import { readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

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
   * @param spaceRoot The space root directory (e.g. `.aipehub`).
   *                  The store keeps items under `inbox/` beneath it.
   */
  constructor(spaceRoot: string) {
    this.root = join(spaceRoot, 'inbox')
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
    const file = this.pathFor(item.itemId)
    const tmp = `${file}.tmp`
    await writeFile(tmp, JSON.stringify(item, null, 2), 'utf8')
    await rename(tmp, file)
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
}
