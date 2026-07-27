/**
 * SDUI-M4 — butler panel tools against the REAL store (buildMePanelSurface),
 * because the acceptance claims are about the store contract, not a stub:
 *
 *  - a hallucinated component name is rejected by the validator AND the
 *    on-disk file stays byte-identical (改不坏);
 *  - the reserved zone has no tamperable surface (approval-inbox with
 *    source/params → rejected, bytes unchanged);
 *  - every butler write lands with by:'butler' → GET surfaces lastChange
 *    (the SPA banner's data source — 瞒不住);
 *  - undo really restores, twice toggles back (退得回).
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildMePanelSurface } from '../src/me-panel-surface.js'
import {
  buildButlerPanelToolset,
  renderPanelContractCheatsheet,
} from '../src/personal-butler-panel.js'

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
  spaceDir = await mkdtemp(join(tmpdir(), 'gotong-butler-panel-'))
})

afterEach(async () => {
  await rm(spaceDir, { recursive: true, force: true })
})

function build(userId = 'member-1') {
  const surface = buildMePanelSurface({ spaceDir })
  const toolset = buildButlerPanelToolset({ userId, surface })
  return { surface, toolset }
}

function textOf(r: { content: { type: string; text?: string }[] }): string {
  return r.content.map((c) => c.text ?? '').join('\n')
}

const panelFile = (userId: string): string =>
  join(spaceDir, 'butler', 'ui', 'user', userId, 'panel.json')

describe('get_my_panel (benign read)', () => {
  it('renders source, config JSON, library and the derived contract cheatsheet', async () => {
    const { surface, toolset } = build()
    await surface.installPanels('pack', [{ id: 'farm', title: '农事面', config: CFG_A }])
    const out = await toolset.callTool('get_my_panel', {})
    expect(out.isError).toBeUndefined()
    const text = textOf(out)
    expect(text).toContain('内置默认')
    expect(text).toContain('"schemaVersion"')
    expect(text).toContain('farm「农事面」')
    // Cheatsheet is DERIVED from PANEL_COMPONENT_CONTRACTS — reserved zone named.
    expect(text).toContain('approval-inbox')
    expect(text).toContain('保留区')
  })

  it('surfaces butler attribution with the undo hint', async () => {
    const { surface, toolset } = build()
    await surface.setPanel('member-1', CFG_A, { by: 'butler' })
    const text = textOf(await toolset.callTool('get_my_panel', {}))
    expect(text).toContain('我(阿同)')
    expect(text).toContain('undo')
  })
})

describe('set_panel_layout (benign direct-write, E1 safety net)', () => {
  it('config mode writes through the choke point and arms the banner', async () => {
    const { surface, toolset } = build()
    const out = await toolset.callTool('set_panel_layout', { config: CFG_B })
    expect(out.isError).toBeUndefined()
    expect(textOf(out)).toContain('横幅')
    expect(JSON.parse(await readFile(panelFile('member-1'), 'utf8'))).toEqual(CFG_B)
    const r = await surface.panel('member-1')
    expect(r.lastChange?.by).toBe('butler')
  })

  it('a hallucinated component type is rejected — file bytes UNCHANGED', async () => {
    const { surface, toolset } = build()
    await surface.setPanel('member-1', CFG_A)
    const before = await readFile(panelFile('member-1'))
    const out = await toolset.callTool('set_panel_layout', {
      config: {
        schemaVersion: 1,
        sections: [{ components: [{ type: 'crypto-ticker' }] }],
      },
    })
    expect(out.isError).toBe(true)
    expect(textOf(out)).toContain('未改动')
    const after = await readFile(panelFile('member-1'))
    expect(after.equals(before)).toBe(true)
    // Attribution untouched too: the failed write armed no banner.
    expect((await surface.panel('member-1')).lastChange?.by).toBe('human')
  })

  it('the reserved zone has no tamperable surface (params on approval-inbox rejected)', async () => {
    const { toolset } = build()
    const out = await toolset.callTool('set_panel_layout', {
      config: {
        schemaVersion: 1,
        sections: [
          { components: [{ type: 'approval-inbox', params: { hidden: true } }] },
        ],
      },
    })
    expect(out.isError).toBe(true)
    // Nothing ever landed for this user.
    await expect(readFile(panelFile('member-1'), 'utf8')).rejects.toThrow()
  })

  it('libraryId mode applies an installed shape; unknown id lists a way out', async () => {
    const { surface, toolset } = build()
    await surface.installPanels('pack', [{ id: 'farm', title: '农事面', config: CFG_A }])
    const ok = await toolset.callTool('set_panel_layout', { libraryId: 'farm' })
    expect(ok.isError).toBeUndefined()
    expect(JSON.parse(await readFile(panelFile('member-1'), 'utf8'))).toEqual(CFG_A)
    // The butler's most common write mode must arm the banner too — the live
    // round-trip caught applyLibrary dropping opts (attribution fell to
    // 'human' and the banner never showed). Pin every mode, not just config.
    expect((await surface.panel('member-1')).lastChange?.by).toBe('butler')
    const bad = await toolset.callTool('set_panel_layout', { libraryId: 'nope' })
    expect(bad.isError).toBe(true)
    expect(textOf(bad)).toContain('get_my_panel')
  })

  it('reset mode returns to the default; undo mode swaps back and forth', async () => {
    const { surface, toolset } = build()
    await surface.setPanel('member-1', CFG_A)
    const reset = await toolset.callTool('set_panel_layout', { reset: true })
    expect(reset.isError).toBeUndefined()
    await expect(readFile(panelFile('member-1'), 'utf8')).rejects.toThrow()
    // Butler reset still arms the banner on the default panel.
    expect((await surface.panel('member-1')).lastChange?.by).toBe('butler')
    const undo = await toolset.callTool('set_panel_layout', { undo: true })
    expect(undo.isError).toBeUndefined()
    expect(JSON.parse(await readFile(panelFile('member-1'), 'utf8'))).toEqual(CFG_A)
    const undo2 = await toolset.callTool('set_panel_layout', { undo: true })
    expect(undo2.isError).toBeUndefined()
    await expect(readFile(panelFile('member-1'), 'utf8')).rejects.toThrow()
  })

  it('undo with no history is a friendly refusal, not a crash', async () => {
    const { toolset } = build()
    const out = await toolset.callTool('set_panel_layout', { undo: true })
    expect(out.isError).toBe(true)
    expect(textOf(out)).toContain('没有可撤销')
  })

  it('exactly one mode per call: zero or two modes → refused, nothing written', async () => {
    const { toolset } = build()
    expect((await toolset.callTool('set_panel_layout', {})).isError).toBe(true)
    expect(
      (await toolset.callTool('set_panel_layout', { reset: true, undo: true })).isError,
    ).toBe(true)
    await expect(readFile(panelFile('member-1'), 'utf8')).rejects.toThrow()
  })

  it('an empty-string libraryId does not shadow config mode (predicate parity)', async () => {
    const { toolset } = build()
    // Mode count sees one mode (config); the execution branch must agree —
    // a bare typeof check would route to applyLibrary("") and refuse.
    const out = await toolset.callTool('set_panel_layout', { config: CFG_B, libraryId: '' })
    expect(out.isError).toBeUndefined()
    expect(JSON.parse(await readFile(panelFile('member-1'), 'utf8'))).toEqual(CFG_B)
  })

  it('unknown tool name → error text', async () => {
    const { toolset } = build()
    const out = await toolset.callTool('nope', {})
    expect(out.isError).toBe(true)
  })
})

describe('renderPanelContractCheatsheet', () => {
  it('derives every catalog type (no hand-copied list to rot)', async () => {
    const { PANEL_COMPONENT_TYPES } = await import('@gotong/personal-butler')
    const sheet = renderPanelContractCheatsheet()
    for (const t of PANEL_COMPONENT_TYPES) expect(sheet).toContain(`- ${t}(`)
    expect(sheet).toContain('start_workflow:<id>')
  })
})
