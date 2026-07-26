/**
 * SDUI-M3 — per-member panel store + preset library (me-panel-surface).
 *
 * Load-bearing claims:
 *  - readers never quarantine (corrupt file → 'fallback', evidence stays);
 *  - the WRITER quarantines an unparseable predecessor before rewriting;
 *  - every write path funnels through validatePanelConfig (invalid → typed
 *    error, nothing lands on disk);
 *  - library install is best-effort per entry (one bad preset skipped, the
 *    rest land) with connector-slot reinstall semantics (same pack clears);
 *  - hostile ids cannot traverse (userId via assertSafeOwnerId, libraryId via
 *    whitelist-before-path).
 *
 * Note: there is deliberately no `too_large` case — with PANEL_ID_RE capped at
 * 64 chars and PANEL_LIMITS (8 sections / 24 components / 120-char params), a
 * validator-passing config cannot structurally reach maxFileBytes=32KB. The
 * byte cap is defense-in-depth for future contract widening.
 */
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DEFAULT_PANEL } from '@gotong/personal-butler'

import { buildMePanelSurface, PanelStoreError } from '../src/me-panel-surface.js'

const CFG_A = {
  schemaVersion: 1,
  title: 'A 形态',
  sections: [{ components: [{ type: 'chat', params: { placeholder: '问我' } }] }],
}
const CFG_B = {
  schemaVersion: 1,
  title: 'B 形态',
  sections: [{ components: [{ type: 'divider' }] }],
}

let spaceDir: string

beforeEach(async () => {
  spaceDir = await mkdtemp(join(tmpdir(), 'gotong-me-panel-'))
})

afterEach(async () => {
  await rm(spaceDir, { recursive: true, force: true })
})

function surface() {
  return buildMePanelSurface({ spaceDir })
}

function memberPanelFile(userId: string): string {
  return join(spaceDir, 'butler', 'ui', 'user', userId, 'panel.json')
}

async function memberPanelDirEntries(userId: string): Promise<string[]> {
  return readdir(join(spaceDir, 'butler', 'ui', 'user', userId))
}

describe('me-panel-surface (SDUI-M3)', () => {
  it('serves the built-in default when no file exists', async () => {
    const s = surface()
    const res = await s.panel('u1')
    expect(res.source).toBe('default')
    expect(res.schemaVersion).toBe(1)
    expect(res.config).toEqual(DEFAULT_PANEL)
  })

  it('setPanel persists a valid config and serves it back as member', async () => {
    const s = surface()
    const res = await s.setPanel('u1', CFG_A)
    expect(res.source).toBe('member')
    expect((res.config as { title?: string }).title).toBe('A 形态')

    const onDisk = JSON.parse(await readFile(memberPanelFile('u1'), 'utf8'))
    expect(onDisk).toEqual(CFG_A)

    const read = await s.panel('u1')
    expect(read.source).toBe('member')
    expect(read.config).toEqual(CFG_A)
  })

  it('setPanel rejects an invalid config with a typed error and writes nothing', async () => {
    const s = surface()
    await expect(
      s.setPanel('u1', { schemaVersion: 1, sections: [{ components: [{ type: 'nope' }] }] }),
    ).rejects.toMatchObject({ code: 'invalid' })
    await expect(s.setPanel('u1', 'not an object')).rejects.toBeInstanceOf(PanelStoreError)
    // Nothing landed — the member still gets the default panel.
    expect((await s.panel('u1')).source).toBe('default')
  })

  it('reader degrades a corrupt file to fallback and PRESERVES the evidence', async () => {
    const s = surface()
    await s.setPanel('u1', CFG_A)
    await writeFile(memberPanelFile('u1'), '{ not json', 'utf8')

    const res = await s.panel('u1')
    expect(res.source).toBe('fallback')
    expect(res.config).toEqual(DEFAULT_PANEL)
    // The reader did NOT rename/delete the corrupt file.
    expect(await readFile(memberPanelFile('u1'), 'utf8')).toBe('{ not json')
  })

  it('reader degrades a valid-JSON-but-invalid config to fallback', async () => {
    const s = surface()
    await s.setPanel('u1', CFG_A)
    await writeFile(
      memberPanelFile('u1'),
      JSON.stringify({ schemaVersion: 99, sections: [] }),
      'utf8',
    )
    const res = await s.panel('u1')
    expect(res.source).toBe('fallback')
  })

  it('writer quarantines an unparseable predecessor before rewriting', async () => {
    const s = surface()
    await s.setPanel('u1', CFG_A)
    await writeFile(memberPanelFile('u1'), '{ broken!!', 'utf8')

    await s.setPanel('u1', CFG_B)

    const entries = await memberPanelDirEntries('u1')
    const quarantined = entries.filter((n) => n.startsWith('panel.json.corrupt-'))
    expect(quarantined.length).toBe(1)
    expect(
      await readFile(join(spaceDir, 'butler', 'ui', 'user', 'u1', quarantined[0]), 'utf8'),
    ).toBe('{ broken!!')
    expect((await s.panel('u1')).config).toEqual(CFG_B)
  })

  it('resetPanel returns to default and is idempotent', async () => {
    const s = surface()
    await s.setPanel('u1', CFG_A)
    await s.resetPanel('u1')
    expect((await s.panel('u1')).source).toBe('default')
    await s.resetPanel('u1') // no file — must not throw
    expect((await s.panel('u1')).source).toBe('default')
  })

  it('installPanels lands presets; listLibrary returns them sorted with descriptions', async () => {
    const s = surface()
    await s.installPanels('pack-x', [
      { id: 'zeta', title: 'Z 面', config: CFG_A },
      { id: 'alpha', title: 'A 面', description: '给父亲', config: CFG_B },
    ])
    const lib = await s.listLibrary()
    expect(lib.map((e) => e.id)).toEqual(['alpha', 'zeta'])
    expect(lib[0]).toEqual({ id: 'alpha', title: 'A 面', description: '给父亲' })
    expect(lib[1]).toEqual({ id: 'zeta', title: 'Z 面' })
  })

  it('installPanels skips a bad preset (id or config) without sinking the rest', async () => {
    const s = surface()
    await s.installPanels('pack-x', [
      { id: '../evil', title: '穿越', config: CFG_A },
      { id: 'bad-config', title: '坏形态', config: { schemaVersion: 1 } },
      { id: 'good', title: '好形态', config: CFG_A },
    ])
    const lib = await s.listLibrary()
    expect(lib.map((e) => e.id)).toEqual(['good'])
    // The traversal id never became a path.
    const entries = await readdir(join(spaceDir, 'butler', 'ui', 'library'))
    expect(entries).toEqual(['good.json'])
  })

  it('reinstalling a pack clears its old entries; other packs untouched', async () => {
    const s = surface()
    await s.installPanels('pack-x', [
      { id: 'old-a', title: 'Old A', config: CFG_A },
      { id: 'old-b', title: 'Old B', config: CFG_B },
    ])
    await s.installPanels('pack-y', [{ id: 'other', title: 'Other', config: CFG_A }])
    await s.installPanels('pack-x', [{ id: 'new-a', title: 'New A', config: CFG_B }])

    const lib = await s.listLibrary()
    expect(lib.map((e) => e.id)).toEqual(['new-a', 'other'])
  })

  it('applyLibrary switches the member to the preset via the same choke point', async () => {
    const s = surface()
    await s.installPanels('pack-x', [{ id: 'farm', title: '农事面', config: CFG_A }])
    const res = await s.applyLibrary('u1', 'farm')
    expect(res.source).toBe('member')
    expect(res.config).toEqual(CFG_A)
    expect((await s.panel('u1')).config).toEqual(CFG_A)
  })

  it('applyLibrary threads attribution opts through to the snapshot (M4)', async () => {
    const s = surface()
    await s.installPanels('pack-x', [{ id: 'farm', title: '农事面', config: CFG_A }])
    await s.applyLibrary('u1', 'farm', { by: 'butler' })
    expect((await s.panel('u1')).lastChange?.by).toBe('butler')
  })

  it('applyLibrary rejects unknown and hostile ids as not_found (whitelist before path)', async () => {
    const s = surface()
    await expect(s.applyLibrary('u1', 'missing')).rejects.toMatchObject({ code: 'not_found' })
    await expect(s.applyLibrary('u1', '../escape')).rejects.toMatchObject({ code: 'not_found' })
    await expect(s.applyLibrary('u1', 'a/b')).rejects.toMatchObject({ code: 'not_found' })
  })

  it('skips a library file whose embedded id does not match its filename', async () => {
    const s = surface()
    const libDir = join(spaceDir, 'butler', 'ui', 'library')
    await mkdir(libDir, { recursive: true })
    await writeFile(
      join(libDir, 'renamed.json'),
      JSON.stringify({ id: 'original', title: '错位', pack: 'p', config: CFG_A }),
      'utf8',
    )
    expect(await s.listLibrary()).toEqual([])
    await expect(s.applyLibrary('u1', 'renamed')).rejects.toMatchObject({ code: 'not_found' })
  })

  it('rejects a traversal userId before any path is assembled', async () => {
    const s = surface()
    await expect(s.setPanel('../evil', CFG_A)).rejects.toThrow()
  })

  it('serializes concurrent writes for one member (last call wins on disk)', async () => {
    const s = surface()
    await Promise.all([s.setPanel('u1', CFG_A), s.setPanel('u1', CFG_B)])
    const onDisk = JSON.parse(await readFile(memberPanelFile('u1'), 'utf8'))
    expect(onDisk).toEqual(CFG_B)
    expect((await s.panel('u1')).config).toEqual(CFG_B)
  })
})

describe('me-panel-surface — one-slot undo + attribution (SDUI-M4)', () => {
  it('restoreSnapshot with no history → typed not_found, nothing touched', async () => {
    const s = surface()
    await expect(s.restoreSnapshot('u1')).rejects.toMatchObject({ code: 'not_found' })
    expect((await s.panel('u1')).source).toBe('default')
  })

  it('undo after a change restores the previous config; undo again toggles back (swap)', async () => {
    const s = surface()
    await s.setPanel('u1', CFG_A)
    await s.setPanel('u1', CFG_B)
    const r1 = await s.restoreSnapshot('u1')
    expect(r1.config).toEqual(CFG_A)
    expect(JSON.parse(await readFile(memberPanelFile('u1'), 'utf8'))).toEqual(CFG_A)
    // Swap semantics: the slot now holds B — a second restore brings B back.
    const r2 = await s.restoreSnapshot('u1')
    expect(r2.config).toEqual(CFG_B)
  })

  it('undo of the FIRST ever change returns to the default (config:null snapshot)', async () => {
    const s = surface()
    await s.setPanel('u1', CFG_A)
    const r = await s.restoreSnapshot('u1')
    expect(r.source).toBe('default')
    await expect(readFile(memberPanelFile('u1'), 'utf8')).rejects.toThrow()
    // …and restoring again re-applies CFG_A (nothing was destroyed).
    expect((await s.restoreSnapshot('u1')).config).toEqual(CFG_A)
  })

  it("undo of a butler reset re-applies the pre-reset shape (banner's 撤销 path)", async () => {
    const s = surface()
    await s.setPanel('u1', CFG_A)
    await s.resetPanel('u1', { by: 'butler' })
    expect((await s.panel('u1')).source).toBe('default')
    const r = await s.restoreSnapshot('u1')
    expect(r.config).toEqual(CFG_A)
    expect(r.source).toBe('member')
  })

  it('a no-op reset (already default) does NOT clobber the undo slot', async () => {
    const s = surface()
    await s.setPanel('u1', CFG_A) // slot: null (was default)
    await s.restoreSnapshot('u1') // back to default; slot: CFG_A
    await s.resetPanel('u1') // already default — slot must stay CFG_A
    expect((await s.restoreSnapshot('u1')).config).toEqual(CFG_A)
  })

  it("lastChange attribution: butler write arms it, human write reads 'human'", async () => {
    const s = surface()
    expect((await s.panel('u1')).lastChange).toBeUndefined()
    await s.setPanel('u1', CFG_A, { by: 'butler' })
    const afterButler = await s.panel('u1')
    expect(afterButler.lastChange?.by).toBe('butler')
    expect(typeof afterButler.lastChange?.at).toBe('string')
    // Default attribution ('human') — the web faces never pass opts.
    await s.setPanel('u1', CFG_B)
    expect((await s.panel('u1')).lastChange?.by).toBe('human')
  })

  it("a butler RESET still surfaces lastChange on the default panel (banner on 'default')", async () => {
    const s = surface()
    await s.setPanel('u1', CFG_A)
    await s.resetPanel('u1', { by: 'butler' })
    const r = await s.panel('u1')
    expect(r.source).toBe('default')
    expect(r.lastChange?.by).toBe('butler')
  })

  it("member undo click records 'human' — the banner disarms after 撤销", async () => {
    const s = surface()
    await s.setPanel('u1', CFG_A, { by: 'butler' })
    await s.restoreSnapshot('u1') // no opts = the member clicked 撤销
    expect((await s.panel('u1')).lastChange?.by).toBe('human')
  })
})
