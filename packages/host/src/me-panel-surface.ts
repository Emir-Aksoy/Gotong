/**
 * me-panel-surface.ts — SDUI-M2/M3. Host adapter behind web's `/api/me/panel*`
 * (the `MePanelSurface` duck in `@gotong/web` panel-routes.ts) plus the
 * template-import sink for gallery panel presets (`PanelLibrarySink` duck in
 * agents-routes.ts). One object serves both faces so there is exactly ONE
 * validation choke point: every write path — member「换形态」, admin install,
 * template import, and the M4 butler `set_panel_layout` — lands in
 * {@link setPanel}, which runs the same `validatePanelConfig` (one validator,
 * no drift; web itself never imports personal-butler).
 *
 * File-first layout (memory-tree SIBLINGS, so MU-M5 git snapshots and the
 * butler's own knowledge tree never sweep panel configs):
 *
 *   <space>/butler/ui/user/<userId>/panel.json   per-member config
 *   <space>/butler/ui/library/<id>.json          installed preset shapes
 *
 * Failure posture:
 *  - READERS never quarantine. A corrupt/invalid member file degrades to the
 *    default panel with `source:'fallback'` (the SPA shows a loud notice);
 *    the evidence stays on disk for the next writer.
 *  - The WRITER quarantines: setPanel renames an unparseable predecessor to
 *    `panel.json.corrupt-<ts>` before writing (never destroys, never blocks).
 *  - Library entries are advisory: a corrupt/mismatched file is skipped with
 *    a warn — one bad preset must not sink the list.
 *  - Per-user writes are serialized on a promise chain (task-notebook
 *    discipline); `installPanels` is best-effort and never throws into the
 *    template import that called it.
 */

import { readdir, readFile, rename, rm, mkdir, stat } from 'node:fs/promises'
import { join, dirname } from 'node:path'

import { createLogger, writeFileAtomic, writeJsonAtomic } from '@gotong/core'
import {
  DEFAULT_PANEL,
  PANEL_ID_RE,
  PANEL_LIMITS,
  PANEL_SCHEMA_VERSION,
  validatePanelConfig,
  type PanelConfig,
} from '@gotong/personal-butler'
import { ownerDir } from '@gotong/service-memory-file'

const log = createLogger('me-panel')

/** Same charset as a KB slot / MCP server name — a library id IS a filename. */
// 64-char cap: the id becomes a FILENAME — an uncapped id reaches the fs and
// dies as ENAMETOOLONG mid-install instead of being skipped up front.
const LIBRARY_ID_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/

/** Who performed a panel mutation. 'human' = the member or an admin (fork D:
 * humans get no AI-change gate); 'butler' drives the loud SPA banner. */
export type PanelActor = 'butler' | 'human'

export interface MePanelResult {
  schemaVersion: number
  config: unknown
  source: 'default' | 'member' | 'fallback'
  /** Attribution of the LAST mutation (from the undo slot). The SPA shows the
   * 「阿同调整了你的面板 [撤销]」 banner iff `by === 'butler'` — the loud half
   * of the E1 safety net; absent until the first mutation ever happens. */
  lastChange?: { by: PanelActor; at: string }
}

export interface PanelLibraryEntry {
  id: string
  title: string
  description?: string
}

/** One preset as handed over by the template import (web-parsed shape). */
export interface InstallablePanel {
  id: string
  title: string
  description?: string
  config: unknown
}

/** C1-c — one butler-written display-content file (listing row). */
export interface PanelContentEntry {
  id: string
  updatedAt: string
  bytes: number
}

/** C1-c — content file body + freshness (the card's provenance stamp). */
export interface PanelContentDoc {
  markdown: string
  updatedAt: string
}

/** Typed store error; web routes branch on `code` via duck (never import). */
export class PanelStoreError extends Error {
  constructor(
    readonly code: 'invalid' | 'not_found' | 'too_large',
    message: string,
  ) {
    super(message)
    this.name = 'PanelStoreError'
  }
}

/** Mutation options: attribution defaults to 'human' — web faces stay 2-arg,
 * ONLY the butler toolset passes { by: 'butler' } (which arms the banner). */
export interface PanelWriteOpts {
  by?: PanelActor
}

export interface MePanelSurfaceHost {
  panel(userId: string): Promise<MePanelResult>
  /** THE validation choke point — every write path funnels through here. */
  setPanel(userId: string, value: unknown, opts?: PanelWriteOpts): Promise<MePanelResult>
  resetPanel(userId: string, opts?: PanelWriteOpts): Promise<void>
  listLibrary(): Promise<PanelLibraryEntry[]>
  applyLibrary(userId: string, libraryId: string, opts?: PanelWriteOpts): Promise<MePanelResult>
  /** Template-import sink (PanelLibrarySink duck). Best-effort, never throws. */
  installPanels(pack: string, panels: readonly InstallablePanel[]): Promise<void>
  /**
   * SDUI-M4 one-slot undo: swap the panel back to the state recorded before
   * the LAST mutation (member「换上」, admin install, or the butler's
   * `set_panel_layout` — every mutation snapshots first). Swap semantics:
   * restoring twice toggles back — no state is ever lost. Throws
   * `not_found` when nothing has ever been changed.
   */
  restoreSnapshot(userId: string, opts?: PanelWriteOpts): Promise<MePanelResult>
  /** C1-c content read (panel data route + butler tools). null = never
   * written / invalid id — the renderer's honest cold-start state. */
  readContent(userId: string, fileId: string): Promise<PanelContentDoc | null>
  listContent(userId: string): Promise<PanelContentEntry[]>
  /** markdown null = delete. The butler toolset is the only writer in v1
   * (userId closed over there); every write runs the per-user serial chain. */
  writeContent(userId: string, fileId: string, markdown: string | null): Promise<void>
}

export function buildMePanelSurface(opts: { spaceDir: string }): MePanelSurfaceHost {
  const uiRoot = join(opts.spaceDir, 'butler', 'ui')
  const libraryDir = join(uiRoot, 'library')
  // ownerDir = <root>/<kind>/<id>, running assertSafeOwnerId first — hostile
  // userIds cannot traverse. Yields <space>/butler/ui/user/<userId>/panel.json.
  const memberFile = (userId: string): string =>
    join(ownerDir(uiRoot, { kind: 'user', id: userId }), 'panel.json')

  // Per-user serial write chains (task-notebook discipline): concurrent writes
  // for one member apply in order; different members never contend.
  const chains = new Map<string, Promise<unknown>>()
  function serialize<T>(userId: string, work: () => Promise<T>): Promise<T> {
    const prev = chains.get(userId) ?? Promise.resolve()
    const next = prev.then(work, work)
    chains.set(userId, next.catch(() => undefined))
    return next
  }

  function defaultResult(source: 'default' | 'fallback'): MePanelResult {
    return { schemaVersion: PANEL_SCHEMA_VERSION, config: DEFAULT_PANEL, source }
  }

  async function readMember(userId: string): Promise<MePanelResult> {
    const result = await (async (): Promise<MePanelResult> => {
      let raw: string
      try {
        raw = await readFile(memberFile(userId), 'utf8')
      } catch {
        return defaultResult('default') // no file — the built-in default panel
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        log.warn('member panel file unreadable — serving default (fallback)', { userId })
        return defaultResult('fallback')
      }
      const v = validatePanelConfig(parsed)
      if (!v.ok) {
        log.warn('member panel file invalid — serving default (fallback)', {
          userId,
          errors: v.errors.slice(0, 3),
        })
        return defaultResult('fallback')
      }
      return { schemaVersion: PANEL_SCHEMA_VERSION, config: v.config, source: 'member' }
    })()
    // Attach attribution on EVERY source — a butler reset serves 'default' yet
    // must still arm the banner (the member sees what changed and can undo).
    const snap = await readPrevSnapshot(userId)
    if (snap !== null && snap !== 'malformed') {
      // Suppress the banner when the recorded prior state equals what is being
      // served now: nothing visibly changed, so "阿同调整了你的面板" would be a
      // phantom (identical re-apply, or a crash between snapshot and write).
      const servedMember = result.source === 'member' ? result.config : null
      const noop = JSON.stringify(snap.config) === JSON.stringify(servedMember)
      if (!noop) result.lastChange = { by: snap.by, at: snap.at }
    }
    return result
  }

  async function writeMember(userId: string, config: PanelConfig): Promise<void> {
    const file = memberFile(userId)
    const bytes = Buffer.byteLength(JSON.stringify(config, null, 2) + '\n', 'utf8')
    if (bytes > PANEL_LIMITS.maxFileBytes) {
      throw new PanelStoreError('too_large', `panel config over ${PANEL_LIMITS.maxFileBytes} bytes`)
    }
    // Writer-side quarantine: a broken predecessor is EVIDENCE — move it aside
    // (never destroy) so the overwrite doesn't erase what went wrong. That
    // covers parseable-but-invalid too (a hand-edit the reader was already
    // falling back on), not just SyntaxError. ENOENT / other read faults:
    // nothing to quarantine, proceed to write.
    try {
      const prior = JSON.parse(await readFile(file, 'utf8'))
      if (!validatePanelConfig(prior).ok) {
        const quarantine = `${file}.corrupt-${Date.now()}`
        await rename(file, quarantine).catch(() => undefined)
        log.warn('quarantined invalid panel file before rewrite', { userId, quarantine })
      }
    } catch (err) {
      if (err instanceof SyntaxError) {
        const quarantine = `${file}.corrupt-${Date.now()}`
        await rename(file, quarantine).catch(() => undefined)
        log.warn('quarantined corrupt panel file before rewrite', { userId, quarantine })
      }
    }
    await mkdir(dirname(file), { recursive: true })
    await writeJsonAtomic(file, config)
  }

  async function readLibraryFile(
    id: string,
  ): Promise<{ entry: PanelLibraryEntry; config: PanelConfig } | null> {
    let raw: string
    try {
      raw = await readFile(join(libraryDir, `${id}.json`), 'utf8')
    } catch {
      return null
    }
    let doc: unknown
    try {
      doc = JSON.parse(raw)
    } catch {
      log.warn('library panel unreadable — skipped', { id })
      return null
    }
    const d = doc as Record<string, unknown>
    // The filename is the addressing key; a mismatched embedded id means the
    // file was hand-edited inconsistently — skip rather than guess.
    if (!d || typeof d !== 'object' || d.id !== id || typeof d.title !== 'string') {
      log.warn('library panel shape mismatch — skipped', { id })
      return null
    }
    const v = validatePanelConfig(d.config)
    if (!v.ok) {
      log.warn('library panel config invalid — skipped', { id, errors: v.errors.slice(0, 3) })
      return null
    }
    const entry: PanelLibraryEntry = { id, title: d.title }
    if (typeof d.description === 'string' && d.description.length > 0) {
      entry.description = d.description
    }
    return { entry, config: v.config }
  }

  async function libraryIds(): Promise<string[]> {
    let names: string[]
    try {
      names = await readdir(libraryDir)
    } catch {
      return []
    }
    return names
      .filter((n) => n.endsWith('.json'))
      .map((n) => n.slice(0, -'.json'.length))
      .filter((id) => LIBRARY_ID_RE.test(id))
      .sort()
  }

  // ── C1-c content files (butler-written display markdown) ─────────────────
  // <space>/butler/ui/user/<userId>/content/<fileId>.md — the fileId charset
  // is PANEL_ID_RE, the SAME rule the validator applies to `content:<fileId>`
  // sources: a validated config can never reference an unservable name, and a
  // hostile name never reaches path assembly. Relay convention: cards bound to
  // `connector:<slot>` read the content file `connector.<slot>` — the panel
  // never calls a connector itself (fork A); the butler curates on its own
  // cadence and the card honestly shows WHEN. Content writes deliberately do
  // NOT touch the M4 undo slot or the change banner — those guard LAYOUT;
  // content honesty is the card's fixed provenance badge + updatedAt stamp.
  const contentDir = (userId: string): string =>
    join(ownerDir(uiRoot, { kind: 'user', id: userId }), 'content')

  // Character-level (not a regex literal) so no escape can rot into raw bytes:
  // markdown keeps \n and \t; every other C0 control, DEL, and the bidi
  // override range is refused — display text must not smuggle spoofing marks.
  function hostileContentChar(code: number): boolean {
    if (code === 0x0a || code === 0x09) return false
    if (code < 0x20 || code === 0x7f) return true
    return (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)
  }

  async function readContent(userId: string, fileId: string): Promise<PanelContentDoc | null> {
    if (typeof fileId !== 'string' || !PANEL_ID_RE.test(fileId)) return null
    const file = join(contentDir(userId), `${fileId}.md`)
    try {
      const st = await stat(file)
      // A hand-placed oversized file must not be slurped into every panel
      // load — treat as absent, loudly (readers never quarantine).
      if (st.size > 8 * PANEL_LIMITS.maxContentBytes) {
        log.warn('panel content file oversized — ignored', { userId, fileId, bytes: st.size })
        return null
      }
      return { markdown: await readFile(file, 'utf8'), updatedAt: st.mtime.toISOString() }
    } catch {
      return null
    }
  }

  async function listContent(userId: string): Promise<PanelContentEntry[]> {
    let names: string[]
    try {
      names = await readdir(contentDir(userId))
    } catch {
      return []
    }
    const out: PanelContentEntry[] = []
    for (const n of names.filter((f) => f.endsWith('.md')).sort()) {
      const id = n.slice(0, -'.md'.length)
      if (!PANEL_ID_RE.test(id)) continue
      try {
        const st = await stat(join(contentDir(userId), n))
        out.push({ id, updatedAt: st.mtime.toISOString(), bytes: st.size })
      } catch {
        /* raced away — skip */
      }
    }
    return out
  }

  async function writeContent(
    userId: string,
    fileId: string,
    markdown: string | null,
  ): Promise<void> {
    if (typeof fileId !== 'string' || !PANEL_ID_RE.test(fileId)) {
      throw new PanelStoreError('invalid', 'content id must be a plain identifier (letters, digits, . _ -)')
    }
    const file = join(contentDir(userId), `${fileId}.md`)
    if (markdown === null) {
      await serialize(userId, () => rm(file, { force: true }))
      return
    }
    const text = markdown.replace(/\r\n?/g, '\n')
    for (let i = 0; i < text.length; i++) {
      if (hostileContentChar(text.charCodeAt(i))) {
        throw new PanelStoreError('invalid', 'content contains control or bidi-override characters')
      }
    }
    if (Buffer.byteLength(text, 'utf8') > PANEL_LIMITS.maxContentBytes) {
      throw new PanelStoreError('too_large', `content over ${PANEL_LIMITS.maxContentBytes} bytes`)
    }
    await serialize(userId, async () => {
      const dir = contentDir(userId)
      await mkdir(dir, { recursive: true })
      const exists = await stat(file).then(
        () => true,
        () => false,
      )
      if (!exists) {
        const count = (await readdir(dir)).filter((f) => f.endsWith('.md')).length
        if (count >= PANEL_LIMITS.maxContentFiles) {
          throw new PanelStoreError(
            'too_large',
            `content file cap reached (${PANEL_LIMITS.maxContentFiles}) — delete one first`,
          )
        }
      }
      await writeFileAtomic(file, text.endsWith('\n') ? text : text + '\n')
    })
  }

  // ── SDUI-M4 one-slot undo ──────────────────────────────────────────────────
  // `panel-prev.json` records the state BEFORE the last mutation — config (or
  // null meaning "no member file / default shape") + who mutated (`by`, the
  // banner's data source). Written inside the same per-user chain as the
  // mutation itself, so snapshot+write are never torn by a concurrent writer.
  // restoreSnapshot SWAPS (prev becomes what was current), so no state is ever
  // destroyed and restore-of-restore toggles back.
  const prevFile = (userId: string): string =>
    join(ownerDir(uiRoot, { kind: 'user', id: userId }), 'panel-prev.json')

  async function readCurrentConfig(userId: string): Promise<PanelConfig | null> {
    // Corrupt/invalid current file counts as null: the reader was already
    // serving the default, so "the state before the change" IS the default.
    try {
      const v = validatePanelConfig(JSON.parse(await readFile(memberFile(userId), 'utf8')))
      return v.ok ? v.config : null
    } catch {
      return null
    }
  }

  async function snapshotCurrent(userId: string, by: PanelActor): Promise<void> {
    const config = await readCurrentConfig(userId)
    const file = prevFile(userId)
    await mkdir(dirname(file), { recursive: true })
    await writeJsonAtomic(file, { savedAt: new Date().toISOString(), by, config })
  }

  // The ONE snapshot parser (banner + undo read the same truth). Strict shape:
  // `config` must be an OWN key — `{savedAt,by}` without it must not read as
  // "was default", or a foreign/hand-edited slot would make undo erase the
  // member's panel. null = no file; 'malformed' = present but unusable (no
  // banner, and undo refuses loudly instead of guessing).
  interface PrevSnapshot {
    by: PanelActor
    at: string
    config: unknown
  }
  async function readPrevSnapshot(userId: string): Promise<PrevSnapshot | null | 'malformed'> {
    let raw: string
    try {
      raw = await readFile(prevFile(userId), 'utf8')
    } catch {
      return null
    }
    let doc: unknown
    try {
      doc = JSON.parse(raw)
    } catch {
      return 'malformed'
    }
    if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return 'malformed'
    const d = doc as Record<string, unknown>
    if (typeof d.savedAt !== 'string' || !Object.hasOwn(d, 'config')) return 'malformed'
    // Unknown/missing attribution reads as 'human' — never a false banner.
    return { by: d.by === 'butler' ? 'butler' : 'human', at: d.savedAt, config: d.config }
  }

  async function setPanel(
    userId: string,
    value: unknown,
    opts?: PanelWriteOpts,
  ): Promise<MePanelResult> {
    const v = validatePanelConfig(value)
    if (!v.ok) {
      throw new PanelStoreError('invalid', `invalid panel config: ${v.errors.join('; ')}`)
    }
    await serialize(userId, async () => {
      await snapshotCurrent(userId, opts?.by ?? 'human')
      await writeMember(userId, v.config)
    })
    return { schemaVersion: PANEL_SCHEMA_VERSION, config: v.config, source: 'member' }
  }

  return {
    panel: readMember,
    setPanel,
    readContent,
    listContent,
    writeContent,

    async resetPanel(userId, opts) {
      await serialize(userId, async () => {
        // A no-op reset (already default) must NOT clobber a useful undo slot.
        const exists = await stat(memberFile(userId)).then(
          () => true,
          () => false,
        )
        if (exists) await snapshotCurrent(userId, opts?.by ?? 'human')
        await rm(memberFile(userId), { force: true })
      })
    },

    async restoreSnapshot(userId, opts) {
      return serialize(userId, async () => {
        const snap = await readPrevSnapshot(userId)
        if (snap === null) {
          throw new PanelStoreError('not_found', 'no panel snapshot to restore')
        }
        if (snap === 'malformed') {
          // A slot that lost its `config` key (or is garbage) must NOT read as
          // "was default" — undo would erase the member's panel. Refuse, touch
          // nothing; the evidence stays on disk.
          throw new PanelStoreError('invalid', 'panel snapshot malformed — nothing restored')
        }
        const recorded = snap.config ?? null
        let target: PanelConfig | null = null
        if (recorded !== null) {
          // Re-validate: the contract may have narrowed since the snapshot was
          // taken. Invalid ⇒ typed error, NOTHING touched (incl. the slot).
          const v = validatePanelConfig(recorded)
          if (!v.ok) {
            throw new PanelStoreError('invalid', `snapshot no longer valid: ${v.errors.join('; ')}`)
          }
          target = v.config
        }
        // Swap: the slot now records the pre-restore state, attributed to
        // whoever asked for the restore (member undo click disarms the banner;
        // a butler-driven undo honestly re-arms it).
        await snapshotCurrent(userId, opts?.by ?? 'human')
        if (target === null) {
          await rm(memberFile(userId), { force: true })
          return defaultResult('default')
        }
        await writeMember(userId, target)
        return { schemaVersion: PANEL_SCHEMA_VERSION, config: target, source: 'member' as const }
      })
    },

    async listLibrary() {
      const out: PanelLibraryEntry[] = []
      for (const id of await libraryIds()) {
        const hit = await readLibraryFile(id)
        if (hit) out.push(hit.entry)
      }
      return out
    },

    async applyLibrary(userId, libraryId, opts) {
      // The id becomes a filename — whitelist BEFORE any path assembly.
      if (typeof libraryId !== 'string' || !LIBRARY_ID_RE.test(libraryId)) {
        throw new PanelStoreError('not_found', 'unknown library panel')
      }
      const hit = await readLibraryFile(libraryId)
      if (!hit) throw new PanelStoreError('not_found', 'unknown library panel')
      // Thread attribution through — the butler's most common write mode is
      // exactly this one; dropping opts here silently disarms the banner.
      return setPanel(userId, hit.config, opts)
    },

    async installPanels(pack, panels) {
      try {
        await mkdir(libraryDir, { recursive: true })
        // Write the NEW entries first, each isolated — one bad write must not
        // abort the rest, and a crash midway leaves old+new side by side
        // (recoverable) instead of a cleared library.
        const written = new Set<string>()
        for (const p of panels) {
          if (!LIBRARY_ID_RE.test(p.id)) {
            log.warn('panel preset id rejected — skipped', { pack, id: p.id })
            continue
          }
          // Real validation happens HERE (the web parser only shape-checks —
          // it cannot import personal-butler). A bad preset is skipped loudly,
          // never installed half-broken.
          const v = validatePanelConfig(p.config)
          if (!v.ok) {
            log.warn('panel preset config invalid — skipped', {
              pack,
              id: p.id,
              errors: v.errors.slice(0, 3),
            })
            continue
          }
          try {
            await writeJsonAtomic(join(libraryDir, `${p.id}.json`), {
              id: p.id,
              title: p.title,
              ...(p.description !== undefined ? { description: p.description } : {}),
              pack,
              installedAt: new Date().toISOString(),
              config: v.config,
            })
            written.add(p.id)
          } catch (err) {
            log.warn('panel preset write failed — skipped', {
              pack,
              id: p.id,
              err: err instanceof Error ? err.message : String(err),
            })
          }
        }
        // Reinstall semantics (connector-slot mirror): NOW drop this pack's
        // stale ids the new template no longer ships. [] therefore clears.
        for (const id of await libraryIds()) {
          if (written.has(id)) continue
          try {
            const raw = JSON.parse(await readFile(join(libraryDir, `${id}.json`), 'utf8'))
            if (raw && typeof raw === 'object' && (raw as { pack?: unknown }).pack === pack) {
              await rm(join(libraryDir, `${id}.json`), { force: true })
            }
          } catch {
            /* unreadable entry — leave it; listLibrary already skips it */
          }
        }
      } catch (err) {
        // Best-effort sink: a panel fault must never fail the template import.
        log.warn('panel preset install failed (import unaffected)', {
          pack,
          err: err instanceof Error ? err.message : String(err),
        })
      }
    },
  }
}
