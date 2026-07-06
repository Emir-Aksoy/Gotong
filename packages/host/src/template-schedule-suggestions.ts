/**
 * template-schedule-suggestions.ts — FDE-M3: the installed-pack schedule-
 * suggestion registry (`<space>/template-schedule-suggestions.json`).
 *
 * A `gotong.template/v1` manifest may declare `schedules[]` — cadence
 * suggestions WITHOUT personnel ("this pack's morning-brief flow wants a
 * daily 08:00 run; whose, you decide"). The import route reports them, but a
 * response scrolls away; this store is the durable half the admin 定时卡
 * reads back to show "建议:morning-brief 每天 08:00 — 未补人" until someone
 * enables it for a member (which writes a REAL schedule row through the LIFE
 * M3 CRUD — this file never becomes a schedule by itself).
 *
 * Store posture is verbatim the M1b connector-slot registry: intent only,
 * last-install-wins by pack name, recording [] REMOVES the pack's entry
 * (a reinstall that dropped its `schedules` stops nagging), missing file →
 * empty, corrupt JSON / wrong shape → warn + empty, a half-parsed entry is
 * skipped. Advisory — a fault here never fails an install.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { createLogger } from '@gotong/core'
import { normalizeScheduleCadence, type ScheduleCadence } from '@gotong/workflow'

const log = createLogger('schedule-suggestions')

export const TEMPLATE_SCHEDULE_SUGGESTIONS_FILE = 'template-schedule-suggestions.json'

/** One recorded suggestion (mirrors the parsed template block — no userId). */
export interface RecordedScheduleSuggestion {
  workflowId: string
  cadence: ScheduleCadence
  inputs?: Record<string, unknown>
  note?: string
}

/** One installed pack's suggestions. */
export interface RecordedPackSchedules {
  /** The template's `name` (the install identity — last install wins). */
  pack: string
  /** ISO timestamp of the recording install. */
  installedAt: string
  schedules: RecordedScheduleSuggestion[]
}

export interface ScheduleSuggestionStore {
  /** Record (or replace) one pack's suggestions; [] removes the entry. */
  record(pack: string, schedules: readonly RecordedScheduleSuggestion[]): Promise<void>
  /** All recorded packs. Missing/corrupt file → []. */
  list(): Promise<readonly RecordedPackSchedules[]>
}

export function createScheduleSuggestionStore(opts: {
  spaceDir: string
  /** Injected for tests; defaults to wall clock. */
  now?: () => number
}): ScheduleSuggestionStore {
  const file = join(opts.spaceDir, TEMPLATE_SCHEDULE_SUGGESTIONS_FILE)
  const now = opts.now ?? Date.now

  async function load(): Promise<RecordedPackSchedules[]> {
    let raw: string
    try {
      raw = await readFile(file, 'utf8')
    } catch {
      return [] // never installed a scheduled pack — free no-op
    }
    let doc: unknown
    try {
      doc = JSON.parse(raw)
    } catch (err) {
      log.warn('schedule-suggestion registry unreadable — treating as empty', {
        file,
        err: err instanceof Error ? err.message : String(err),
      })
      return []
    }
    const packs = (doc as { packs?: unknown })?.packs
    if (!Array.isArray(packs)) {
      log.warn('schedule-suggestion registry has no packs[] — treating as empty', { file })
      return []
    }
    const out: RecordedPackSchedules[] = []
    for (const entry of packs) {
      const parsed = parsePack(entry)
      if (parsed) out.push(parsed)
      else log.warn('skipping malformed schedule-suggestion pack entry', { file })
    }
    return out
  }

  return {
    async record(pack, schedules) {
      const trimmed = pack.trim()
      if (trimmed.length === 0) return // no identity to record under
      const rows = await load()
      const rest = rows.filter((r) => r.pack !== trimmed)
      if (schedules.length > 0) {
        rest.push({
          pack: trimmed,
          installedAt: new Date(now()).toISOString(),
          schedules: schedules.map((s) => ({
            workflowId: s.workflowId,
            cadence: s.cadence,
            ...(s.inputs !== undefined ? { inputs: s.inputs } : {}),
            ...(s.note !== undefined ? { note: s.note } : {}),
          })),
        })
      }
      await writeFile(file, JSON.stringify({ packs: rest }, null, 2) + '\n', 'utf8')
    },
    list: load,
  }
}

/** Validate one persisted pack entry; null (skip) on any shape violation. The
 *  cadence re-runs the SAME normaliser as parse/fire — a hand-edited cadence
 *  that no longer parses drops the entry rather than surfacing a guess. */
function parsePack(entry: unknown): RecordedPackSchedules | null {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
  const e = entry as Record<string, unknown>
  if (typeof e.pack !== 'string' || e.pack.length === 0) return null
  if (!Array.isArray(e.schedules)) return null
  const schedules: RecordedScheduleSuggestion[] = []
  for (const s of e.schedules) {
    if (!s || typeof s !== 'object' || Array.isArray(s)) return null
    const r = s as Record<string, unknown>
    if (typeof r.workflowId !== 'string' || r.workflowId.length === 0) return null
    const cadence = normalizeScheduleCadence(r.cadence)
    if (!cadence) return null
    const row: RecordedScheduleSuggestion = { workflowId: r.workflowId, cadence }
    if (r.inputs && typeof r.inputs === 'object' && !Array.isArray(r.inputs)) {
      row.inputs = r.inputs as Record<string, unknown>
    }
    if (typeof r.note === 'string' && r.note.length > 0) row.note = r.note
    schedules.push(row)
  }
  return {
    pack: e.pack,
    installedAt: typeof e.installedAt === 'string' ? e.installedAt : '',
    schedules,
  }
}
