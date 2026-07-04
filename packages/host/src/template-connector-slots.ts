/**
 * template-connector-slots.ts — FDE-M1b: the installed-pack connector-slot
 * registry.
 *
 * A `gotong.template/v1` manifest may declare `requires.connectors[]` —
 * abstract needs like "this solution wants an MCP server named `calendar`"
 * (slot id = the server NAME that fulfils it; which backend is the
 * installer's runtime decision). The import route reports those slots in its
 * response, but a response scrolls away. This store is the durable half: the
 * import route records each installed template's declared slots here (via the
 * web-injected sink), and the admin 体检 reads them back to show "槽位
 * calendar: 未挂" until someone hangs a server with that name.
 *
 * File-first, one file: `<space>/template-connector-slots.json` — machine-
 * written at install, human-editable to prune a pack you no longer care
 * about (deleting a pack's entry is exactly "stop reminding me"). Unlike the
 * workflow-schedule pair there is no intent/fact split: this file IS only
 * intent ("pack X declared it needs Y"); the FACT (is a server named Y
 * present?) is computed live by the health check against the hub's actual
 * MCP wiring, so it can never go stale.
 *
 * Failure posture (mirrors the schedule state file): missing file → empty;
 * corrupt JSON / wrong shape → warn + empty (the registry is advisory — a
 * broken file must not paint red herrings, and the next install rewrites
 * it); a half-parsed entry is skipped, the rest survive. Recording a pack
 * with ZERO slots REMOVES its entry — a template that dropped its
 * `requires` block on reinstall stops nagging.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { createLogger } from '@gotong/core'

const log = createLogger('connector-slots')

export const TEMPLATE_CONNECTOR_SLOTS_FILE = 'template-connector-slots.json'

/** One declared slot, as recorded at install (mirrors the template block). */
export interface RecordedConnectorSlot {
  /** Slot name = the MCP server name that fulfils it. */
  id: string
  /** true = the solution degrades gracefully unfilled. */
  optional: boolean
  /** Installer-facing one-liner (what to hang, where to find backends). */
  hint?: string
  /** Doc-only capability tag (e.g. `calendar.read`). */
  capability?: string
}

/** One installed pack's declared slots. */
export interface RecordedPackSlots {
  /** The template's `name` (the install identity — last install wins). */
  pack: string
  /** ISO timestamp of the recording install. */
  installedAt: string
  connectors: RecordedConnectorSlot[]
}

export interface ConnectorSlotStore {
  /**
   * Record (or replace) one pack's declared slots. Empty `connectors` removes
   * the pack's entry. Never throws on a corrupt existing file — the rewrite
   * repairs it.
   */
  record(pack: string, connectors: readonly RecordedConnectorSlot[]): Promise<void>
  /** All recorded packs. Missing/corrupt file → []. */
  list(): Promise<readonly RecordedPackSlots[]>
}

export function createConnectorSlotStore(opts: {
  spaceDir: string
  /** Injected for tests; defaults to wall clock. */
  now?: () => number
}): ConnectorSlotStore {
  const file = join(opts.spaceDir, TEMPLATE_CONNECTOR_SLOTS_FILE)
  const now = opts.now ?? Date.now

  async function load(): Promise<RecordedPackSlots[]> {
    let raw: string
    try {
      raw = await readFile(file, 'utf8')
    } catch {
      return [] // never installed a slotted pack — free no-op
    }
    let doc: unknown
    try {
      doc = JSON.parse(raw)
    } catch (err) {
      log.warn('connector-slot registry unreadable — treating as empty', {
        file,
        err: err instanceof Error ? err.message : String(err),
      })
      return []
    }
    const packs = (doc as { packs?: unknown })?.packs
    if (!Array.isArray(packs)) {
      log.warn('connector-slot registry has no packs[] — treating as empty', { file })
      return []
    }
    const out: RecordedPackSlots[] = []
    for (const entry of packs) {
      const parsed = parsePack(entry)
      if (parsed) out.push(parsed)
      else log.warn('skipping malformed connector-slot pack entry', { file })
    }
    return out
  }

  return {
    async record(pack, connectors) {
      const trimmed = pack.trim()
      if (trimmed.length === 0) return // no identity to record under
      const rows = await load()
      const rest = rows.filter((r) => r.pack !== trimmed)
      if (connectors.length > 0) {
        rest.push({
          pack: trimmed,
          installedAt: new Date(now()).toISOString(),
          connectors: connectors.map((c) => ({
            id: c.id,
            optional: c.optional,
            ...(c.hint !== undefined ? { hint: c.hint } : {}),
            ...(c.capability !== undefined ? { capability: c.capability } : {}),
          })),
        })
      }
      await writeFile(file, JSON.stringify({ packs: rest }, null, 2) + '\n', 'utf8')
    },
    list: load,
  }
}

/** Validate one persisted pack entry; null (skip) on any shape violation. */
function parsePack(entry: unknown): RecordedPackSlots | null {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
  const e = entry as Record<string, unknown>
  if (typeof e.pack !== 'string' || e.pack.length === 0) return null
  if (!Array.isArray(e.connectors)) return null
  const connectors: RecordedConnectorSlot[] = []
  for (const c of e.connectors) {
    if (!c || typeof c !== 'object' || Array.isArray(c)) return null
    const s = c as Record<string, unknown>
    if (typeof s.id !== 'string' || s.id.length === 0) return null
    const slot: RecordedConnectorSlot = { id: s.id, optional: s.optional === true }
    if (typeof s.hint === 'string' && s.hint.length > 0) slot.hint = s.hint
    if (typeof s.capability === 'string' && s.capability.length > 0) slot.capability = s.capability
    connectors.push(slot)
  }
  return {
    pack: e.pack,
    installedAt: typeof e.installedAt === 'string' ? e.installedAt : '',
    connectors,
  }
}
