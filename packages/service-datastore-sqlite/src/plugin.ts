/**
 * `DatastoreSqlitePlugin` — first-party `datastore:sqlite` plugin.
 *
 * Lifecycle (same shape as the other first-party plugins):
 *
 *   init     mkdir .trash, stash hub now()
 *   attach   open `<owner>/<name>.sqlite`, return a DatastoreSqliteHandle
 *   detach   close + drop the handle (data stays on disk)
 *   softDelete    rename owner dir into .trash
 *   restore  rename back, throw on collision
 *   hardDelete    rm -rf trash entry
 *   describe size + per-table row counts, preview of `_kv`
 *   shutdown close every open handle
 *
 * One subtlety: a single owner can have multiple datastores by
 * different `config.name` (yaml may declare both `cases` and
 * `sessions`). The plugin's `handles` map is keyed by
 * `(owner, name)` so each gets an independent `.sqlite` file with
 * its own prepared-statement cache. `detach(owner)` closes every
 * handle for that owner. `softDelete(owner)` moves the whole owner
 * dir, so both files travel together.
 */

import {
  access,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Logger } from '@aipehub/core'
import type {
  Owner,
  ServiceInitCtx,
  ServicePlugin,
  ServiceSnapshot,
  TrashRef,
} from '@aipehub/services-sdk'
import {
  assertSafeOwnerId,
  makeTrashRef,
  ownerKey,
  PREVIEW_MAX_BYTES,
  TrashRestoreConflictError,
} from '@aipehub/services-sdk'

import {
  validateDatastoreSqliteConfig,
  type DatastoreSqliteConfig,
} from './config.js'
import { DatastoreSqliteHandle } from './handle.js'
import {
  dbFile,
  ownerDir,
  trashEntryDir,
  trashMetaFile,
  trashPayloadDir,
  trashRoot,
} from './paths.js'

const PLUGIN_VERSION = '0.1.0'

export class DatastoreSqlitePlugin
  implements ServicePlugin<DatastoreSqliteConfig, DatastoreSqliteHandle>
{
  readonly type = 'datastore'
  readonly impl = 'sqlite'
  readonly version = PLUGIN_VERSION
  readonly description = 'SQLite-backed datastore (kv + sql) — first-party'

  private rootDir = ''
  private logger!: Logger
  private now: () => number = Date.now
  /** Keyed by `${ownerKey}::${config.name}`. */
  private readonly handles = new Map<string, DatastoreSqliteHandle>()
  /**
   * In-flight attach promises, keyed the same way as `handles`. Two
   * concurrent `attach()` calls for the same (owner, name) used to
   * race past the cache check, both `await mkdir()`, both open their
   * own SQLite connection, and the second `handles.set()` would
   * orphan the first handle — connection leaked permanently.
   * Sharing the promise means the second caller gets back the same
   * handle the first one constructed.
   */
  private readonly attaching = new Map<string, Promise<DatastoreSqliteHandle>>()

  async validateConfig(raw: unknown): Promise<DatastoreSqliteConfig> {
    return validateDatastoreSqliteConfig(raw)
  }

  async init(ctx: ServiceInitCtx): Promise<void> {
    this.rootDir = ctx.rootDir
    this.logger = ctx.logger
    this.now = () => ctx.hub.now()
    await mkdir(this.rootDir, { recursive: true })
    await mkdir(trashRoot(this.rootDir), { recursive: true })
    this.logger.debug('datastore:sqlite initialised', { rootDir: this.rootDir })
  }

  async attach(
    owner: Owner,
    config: DatastoreSqliteConfig,
  ): Promise<DatastoreSqliteHandle> {
    // Fail fast on a malicious / buggy Owner.id (`../foo`, `\0`, etc.)
    // — defense-in-depth alongside the same check inside `ownerDir`.
    assertSafeOwnerId(owner.id)
    const key = handleKey(owner, config.name)
    const existing = this.handles.get(key)
    if (existing) return existing
    // Dedupe concurrent attaches: if another caller is already mid-
    // attach for the same key, await their promise instead of opening
    // a second SQLite connection. See `attaching` docs above.
    const inFlight = this.attaching.get(key)
    if (inFlight) return inFlight
    const promise = (async () => {
      try {
        await mkdir(ownerDir(this.rootDir, owner), { recursive: true })
        const handle = new DatastoreSqliteHandle({
          dbPath: dbFile(this.rootDir, owner, config.name),
          config,
          logger: this.logger,
        })
        this.handles.set(key, handle)
        return handle
      } finally {
        this.attaching.delete(key)
      }
    })()
    this.attaching.set(key, promise)
    return promise
  }

  async detach(owner: Owner): Promise<void> {
    // Close every datastore this owner had — the same owner can have
    // multiple databases under different config.name keys.
    const prefix = `${ownerKey(owner)}::`
    for (const [k, h] of [...this.handles]) {
      if (k.startsWith(prefix)) {
        h.close()
        this.handles.delete(k)
      }
    }
  }

  async softDelete(owner: Owner): Promise<TrashRef> {
    const deletedAt = this.now()
    const ref = await makeTrashRef({
      type: this.type, impl: this.impl, owner, deletedAt,
    })
    const trashDir = trashEntryDir(this.rootDir, ref.id)
    const metaPath = trashMetaFile(this.rootDir, ref.id)
    const payloadPath = trashPayloadDir(this.rootDir, ref.id)
    const srcDir = ownerDir(this.rootDir, owner)

    // Drop any open handles for this owner before moving the files —
    // a half-renamed db with an open handle is unsafe.
    await this.detach(owner)

    await mkdir(trashDir, { recursive: true })
    if (!await exists(metaPath)) {
      await writeFile(metaPath, JSON.stringify(ref, null, 2), 'utf8')
    }

    if (await exists(srcDir)) {
      if (await exists(payloadPath)) {
        // Same-day re-delete after the owner re-attached + wrote new
        // data — stash the new payload alongside without losing
        // either copy.
        const siblingPath = join(trashDir, `payload-${deletedAt}`)
        await rename(srcDir, siblingPath)
        this.logger.warn('soft-delete merged into existing trash entry', {
          owner: ownerKey(owner), trashId: ref.id, sibling: siblingPath,
        })
      } else {
        await rename(srcDir, payloadPath)
      }
    }

    return ref
  }

  async restore(ref: TrashRef): Promise<void> {
    const owner: Owner = { kind: ref.ownerKind, id: ref.ownerId }
    const dstDir = ownerDir(this.rootDir, owner)
    const trashDir = trashEntryDir(this.rootDir, ref.id)
    const payloadPath = trashPayloadDir(this.rootDir, ref.id)

    if (await exists(dstDir)) {
      throw new TrashRestoreConflictError(ref.id)
    }

    if (await exists(payloadPath)) {
      await mkdir(dirname(dstDir), { recursive: true })
      await rename(payloadPath, dstDir)
    }
    // Same-day re-deletes stash extra user data in `payload-<ts>/`
    // siblings. Pre-3.1 the unconditional `rm -rf trashDir` wiped
    // them out on the first restore — irrecoverable .sqlite files.
    // Now we keep the trash entry alive so the siblings remain
    // visible to listTrash + retrievable by an operator.
    const siblings = (await readdir(trashDir).catch(() => []))
      .filter((e) => e.startsWith('payload-'))
    if (siblings.length > 0) {
      this.logger.warn('restore left sibling payloads in trash', {
        trashId: ref.id, siblings,
      })
      return
    }
    await rm(trashDir, { recursive: true, force: true })
  }

  async hardDelete(ref: TrashRef): Promise<void> {
    const trashDir = trashEntryDir(this.rootDir, ref.id)
    await rm(trashDir, { recursive: true, force: true })
  }

  async describe(owner: Owner): Promise<ServiceSnapshot> {
    const dir = ownerDir(this.rootDir, owner)
    if (!await exists(dir)) {
      return { sizeBytes: 0, itemCount: 0 }
    }
    let sizeBytes = 0
    let itemCount = 0
    let lastAccess: number | undefined
    const files = await readdir(dir)
    const sqliteFiles = files.filter((f) => f.endsWith('.sqlite'))
    for (const f of sqliteFiles) {
      const path = join(dir, f)
      const st = await stat(path)
      sizeBytes += st.size
      if (!lastAccess || st.mtimeMs > lastAccess) lastAccess = st.mtimeMs
    }
    // itemCount = number of distinct datastore files. Cheaper +
    // more useful than walking SQL row counts.
    itemCount = sqliteFiles.length
    const preview = await this.buildPreview(owner, sqliteFiles)
    const snap: ServiceSnapshot = { sizeBytes, itemCount }
    if (lastAccess !== undefined) snap.lastAccess = lastAccess
    if (preview) snap.preview = preview
    return snap
  }

  async shutdown(): Promise<void> {
    for (const [, h] of this.handles) {
      try { h.close() } catch { /* best-effort */ }
    }
    this.handles.clear()
  }

  /**
   * Walk the local .trash/ and report every well-formed entry. Used
   * by the host's PR-10 cron sweep + the admin UI trash tab.
   */
  async listTrash(): Promise<TrashRef[]> {
    const root = trashRoot(this.rootDir)
    if (!await exists(root)) return []
    const out: TrashRef[] = []
    for (const id of await readdir(root)) {
      const metaPath = trashMetaFile(this.rootDir, id)
      if (!await exists(metaPath)) continue
      try {
        const ref = JSON.parse(await readFile(metaPath, 'utf8')) as TrashRef
        out.push(ref)
      } catch (err) {
        this.logger.warn('skipping corrupt trash meta', { id, err: String(err) })
      }
    }
    return out
  }

  /**
   * Build a preview blob: dump up to PREVIEW_MAX_BYTES of the first
   * `.sqlite` file's `_kv` rows as a tiny tab-separated text block.
   * Plain text means the admin UI can render with a <pre> — no
   * special-casing required.
   */
  private async buildPreview(
    owner: Owner,
    sqliteFiles: string[],
  ): Promise<ServiceSnapshot['preview']> {
    if (sqliteFiles.length === 0) return undefined
    // We need to open a fresh handle here just to read; we never
    // mutate. Use the regular handle to get the cached prepared
    // statements, then immediately close.
    const first = sqliteFiles[0]!
    const path = join(ownerDir(this.rootDir, owner), first)
    let handle: DatastoreSqliteHandle | undefined
    try {
      handle = new DatastoreSqliteHandle({
        dbPath: path,
        config: { name: first.replace(/\.sqlite$/, ''), maxBytes: Number.MAX_SAFE_INTEGER },
        logger: this.logger,
      })
      const rows = await handle.sql.query<{ k: string; v: string }>(
        'SELECT k, v FROM _kv LIMIT 50',
      ).catch(() => [])
      const lines = rows.map((r) => `${r.k}\t${r.v}`)
      let text = lines.join('\n')
      let truncated = false
      if (Buffer.byteLength(text, 'utf8') > PREVIEW_MAX_BYTES) {
        text = text.slice(0, PREVIEW_MAX_BYTES)
        truncated = true
      }
      return {
        mime: 'text/plain',
        text: text || `(empty _kv in ${first})`,
        ...(truncated ? { truncated: true } : {}),
      }
    } finally {
      handle?.close()
    }
  }
}

function handleKey(owner: Owner, name: string): string {
  return `${ownerKey(owner)}::${name}`
}

async function exists(p: string): Promise<boolean> {
  try { await access(p); return true } catch { return false }
}
