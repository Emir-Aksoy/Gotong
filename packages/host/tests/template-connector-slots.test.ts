/**
 * FDE-M1b — tests for the installed-pack connector-slot registry
 * (`template-connector-slots.json`).
 *
 * What these pin:
 *   1. record → list round-trip preserves id/optional/hint/capability; the
 *      file is human-readable JSON with a top-level packs[].
 *   2. Install identity: re-recording the same pack REPLACES its entry (last
 *      install wins); recording ZERO connectors REMOVES the entry (a template
 *      that dropped its `requires` block stops nagging).
 *   3. Failure posture is advisory-grade: missing file → [], corrupt JSON /
 *      wrong shape → warn + [], a malformed pack entry is skipped while the
 *      rest survive, and the next record() rewrites (repairs) the file.
 *   4. A blank pack name is a silent no-op — no identity to record under.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  TEMPLATE_CONNECTOR_SLOTS_FILE,
  createConnectorSlotStore,
} from '../src/template-connector-slots.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gotong-slots-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const store = () => createConnectorSlotStore({ spaceDir: dir, now: () => Date.UTC(2026, 6, 4) })

describe('createConnectorSlotStore', () => {
  it('lists [] when no pack was ever recorded (no file)', async () => {
    expect(await store().list()).toEqual([])
  })

  it('round-trips a recorded pack with full slot fields', async () => {
    const s = store()
    await s.record('morning-brief-hub', [
      { id: 'calendar', optional: true, hint: '连接器目录「日历」组任选后端', capability: 'calendar.read' },
      { id: 'notes', optional: false },
    ])
    const rows = await s.list()
    expect(rows).toEqual([
      {
        pack: 'morning-brief-hub',
        installedAt: '2026-07-04T00:00:00.000Z',
        connectors: [
          {
            id: 'calendar',
            optional: true,
            hint: '连接器目录「日历」组任选后端',
            capability: 'calendar.read',
          },
          { id: 'notes', optional: false },
        ],
      },
    ])
    // The file itself is the durable artifact — human-readable, packs[] shape.
    const raw = JSON.parse(await readFile(join(dir, TEMPLATE_CONNECTOR_SLOTS_FILE), 'utf8'))
    expect(Array.isArray(raw.packs)).toBe(true)
  })

  it('replaces on re-record (last install wins) and keeps other packs', async () => {
    const s = store()
    await s.record('pack-a', [{ id: 'calendar', optional: true }])
    await s.record('pack-b', [{ id: 'notes', optional: false }])
    await s.record('pack-a', [{ id: 'weather', optional: false }])
    const rows = await s.list()
    expect(rows.map((r) => r.pack).sort()).toEqual(['pack-a', 'pack-b'])
    expect(rows.find((r) => r.pack === 'pack-a')?.connectors).toEqual([
      { id: 'weather', optional: false },
    ])
  })

  it('recording zero connectors removes the pack entry', async () => {
    const s = store()
    await s.record('pack-a', [{ id: 'calendar', optional: true }])
    await s.record('pack-a', [])
    expect(await s.list()).toEqual([])
  })

  it('a blank pack name is a no-op (nothing recorded, no file forced)', async () => {
    const s = store()
    await s.record('   ', [{ id: 'calendar', optional: true }])
    expect(await s.list()).toEqual([])
  })

  it('corrupt JSON → [] (advisory registry paints no red herrings)', async () => {
    await writeFile(join(dir, TEMPLATE_CONNECTOR_SLOTS_FILE), '{not json', 'utf8')
    expect(await store().list()).toEqual([])
  })

  it('wrong top-level shape → []', async () => {
    await writeFile(join(dir, TEMPLATE_CONNECTOR_SLOTS_FILE), JSON.stringify(['nope']), 'utf8')
    expect(await store().list()).toEqual([])
  })

  it('skips a malformed pack entry, the rest survive', async () => {
    await writeFile(
      join(dir, TEMPLATE_CONNECTOR_SLOTS_FILE),
      JSON.stringify({
        packs: [
          { pack: 'good', installedAt: 'x', connectors: [{ id: 'calendar', optional: true }] },
          { pack: '', connectors: [] }, // empty pack name
          { pack: 'no-connectors-array' },
          { pack: 'bad-slot', connectors: [{ optional: true }] }, // slot without id
        ],
      }),
      'utf8',
    )
    const rows = await store().list()
    expect(rows.map((r) => r.pack)).toEqual(['good'])
  })

  it('the next record() rewrites (repairs) a corrupt file', async () => {
    const file = join(dir, TEMPLATE_CONNECTOR_SLOTS_FILE)
    await writeFile(file, '{not json', 'utf8')
    const s = store()
    await s.record('pack-a', [{ id: 'calendar', optional: true }])
    const raw = JSON.parse(await readFile(file, 'utf8'))
    expect(raw.packs).toHaveLength(1)
    expect(await s.list()).toHaveLength(1)
  })
})
