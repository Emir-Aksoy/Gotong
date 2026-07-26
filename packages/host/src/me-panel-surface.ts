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

import { readdir, readFile, rename, rm, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'

import { createLogger, writeJsonAtomic } from '@gotong/core'
import {
  DEFAULT_PANEL,
  PANEL_LIMITS,
  PANEL_SCHEMA_VERSION,
  validatePanelConfig,
  type PanelConfig,
} from '@gotong/personal-butler'
import { ownerDir } from '@gotong/service-memory-file'

const log = createLogger('me-panel')

/** Same charset as a KB slot / MCP server name — a library id IS a filename. */
const LIBRARY_ID_RE = /^[a-zA-Z][a-zA-Z0-9_-]*$/

export interface MePanelResult {
  schemaVersion: number
  config: unknown
  source: 'default' | 'member' | 'fallback'
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

export interface MePanelSurfaceHost {
  panel(userId: string): Promise<MePanelResult>
  /** THE validation choke point — every write path funnels through here. */
  setPanel(userId: string, value: unknown): Promise<MePanelResult>
  resetPanel(userId: string): Promise<void>
  listLibrary(): Promise<PanelLibraryEntry[]>
  applyLibrary(userId: string, libraryId: string): Promise<MePanelResult>
  /** Template-import sink (PanelLibrarySink duck). Best-effort, never throws. */
  installPanels(pack: string, panels: readonly InstallablePanel[]): Promise<void>
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
  }

  async function writeMember(userId: string, config: PanelConfig): Promise<void> {
    const file = memberFile(userId)
    const bytes = Buffer.byteLength(JSON.stringify(config, null, 2) + '\n', 'utf8')
    if (bytes > PANEL_LIMITS.maxFileBytes) {
      throw new PanelStoreError('too_large', `panel config over ${PANEL_LIMITS.maxFileBytes} bytes`)
    }
    // Writer-side quarantine: an unparseable predecessor is EVIDENCE — move it
    // aside (never destroy) so the overwrite doesn't erase what went wrong.
    // ENOENT / other read faults: nothing to quarantine, proceed to write.
    try {
      JSON.parse(await readFile(file, 'utf8'))
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

  async function setPanel(userId: string, value: unknown): Promise<MePanelResult> {
    const v = validatePanelConfig(value)
    if (!v.ok) {
      throw new PanelStoreError('invalid', `invalid panel config: ${v.errors.join('; ')}`)
    }
    await serialize(userId, () => writeMember(userId, v.config))
    return { schemaVersion: PANEL_SCHEMA_VERSION, config: v.config, source: 'member' }
  }

  return {
    panel: readMember,
    setPanel,

    async resetPanel(userId) {
      await serialize(userId, () => rm(memberFile(userId), { force: true }))
    },

    async listLibrary() {
      const out: PanelLibraryEntry[] = []
      for (const id of await libraryIds()) {
        const hit = await readLibraryFile(id)
        if (hit) out.push(hit.entry)
      }
      return out
    },

    async applyLibrary(userId, libraryId) {
      // The id becomes a filename — whitelist BEFORE any path assembly.
      if (typeof libraryId !== 'string' || !LIBRARY_ID_RE.test(libraryId)) {
        throw new PanelStoreError('not_found', 'unknown library panel')
      }
      const hit = await readLibraryFile(libraryId)
      if (!hit) throw new PanelStoreError('not_found', 'unknown library panel')
      return setPanel(userId, hit.config)
    },

    async installPanels(pack, panels) {
      try {
        await mkdir(libraryDir, { recursive: true })
        // Reinstall semantics (connector-slot mirror): drop this pack's old
        // entries first, so a template that renamed/removed a preset doesn't
        // leave stale shapes behind. [] therefore just clears.
        for (const id of await libraryIds()) {
          try {
            const raw = JSON.parse(await readFile(join(libraryDir, `${id}.json`), 'utf8'))
            if (raw && typeof raw === 'object' && (raw as { pack?: unknown }).pack === pack) {
              await rm(join(libraryDir, `${id}.json`), { force: true })
            }
          } catch {
            /* unreadable entry — leave it; listLibrary already skips it */
          }
        }
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
          await writeJsonAtomic(join(libraryDir, `${p.id}.json`), {
            id: p.id,
            title: p.title,
            ...(p.description !== undefined ? { description: p.description } : {}),
            pack,
            installedAt: new Date().toISOString(),
            config: v.config,
          })
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
