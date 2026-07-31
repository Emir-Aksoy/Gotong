/**
 * AGRI-M1 — dedicated anti-rot gate for the agri-assist gallery pack's PANEL.
 *
 * Why it lives in HOST tests (mirrors family-panel-trio-template.test.ts):
 * the gallery gate in @gotong/web treats panel configs as opaque blobs (web's
 * parser is shape-only — web must not import personal-butler), so nothing in
 * the web suite proves the shipped preset passes the REAL validator. Host
 * depends on both packages, so this gate imports the embedded gallery straight
 * from web's dist and runs the preset through validatePanelConfig — the same
 * choke point the install sink uses.
 *
 * agri-assist adds one hazard the panel-only trio never had: it ships
 * workflows AND a quick-actions card, so `start_workflow:` actions are legal
 * here — but ONLY for workflows shipped in the same pack. A typo'd id would
 * render a button whose dispatch 403s forever ("没有对你开放"), which no
 * schema check catches — the ids live in two different resource classes.
 */
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

import { validatePanelConfig } from '@gotong/personal-butler'

const here = dirname(fileURLToPath(import.meta.url))
const webDist = (f: string) => pathToFileURL(join(here, '..', '..', 'web', 'dist', f)).href

const { BUILTIN_TEMPLATES } = (await import(webDist('builtin-templates.js'))) as {
  BUILTIN_TEMPLATES: { id: string; yaml: string }[]
}
const { parseTemplate } = (await import(webDist('template-manifest.js'))) as {
  parseTemplate: (yaml: string) => {
    name: string
    agents: { id: string; capabilities: string[] }[]
    workflows: { id: string }[]
    panels: { id: string; title: string; description?: string; config: unknown }[]
  }
}

const entry = BUILTIN_TEMPLATES.find((t) => t.id === 'agri-assist')
if (!entry) throw new Error('agri-assist missing from the embedded gallery')
const parsed = parseTemplate(entry.yaml)

type PanelCfg = {
  sections: { components: { type: string; source?: string; params?: { actions?: string[] } }[] }[]
}

describe('agri-assist gallery pack (AGRI-M1)', () => {
  it('is the first combined pack: 1 agent + 2 workflows + 1 panel in one install', () => {
    expect(parsed.name).toBe('农业辅助(家庭菜园/果园)')
    expect(parsed.agents.map((a) => a.id)).toEqual(['garden-advisor'])
    expect(parsed.workflows.map((w) => w.id)).toEqual(['garden-weekly-plan', 'garden-diagnose'])
    expect(parsed.panels.map((p) => p.id)).toEqual(['garden-care'])
  })

  it('the preset passes the REAL validatePanelConfig (the install choke point)', () => {
    const p = parsed.panels[0]!
    const v = validatePanelConfig(p.config)
    expect(v.ok, v.ok ? '' : v.errors.join('; ')).toBe(true)
    expect(p.title.length).toBeGreaterThan(0)
    expect(p.description && p.description.length).toBeTruthy()
  })

  it('pins the load-bearing components: schedules are REAL data, not decoration', () => {
    const cfg = parsed.panels[0]!.config as PanelCfg
    const comps = cfg.sections.flatMap((s) => s.components)
    expect(comps.map((c) => c.type)).toEqual(
      expect.arrayContaining([
        'weather',
        'calendar',
        'schedule-list',
        'list',
        'markdown-card',
        'chat',
        'quick-actions',
      ]),
    )
    // The weekly calendar binds schedules.mine — once the shipped weekly
    // suggestion is person-armed, the grid shows the real fire marks.
    const calendar = comps.find((c) => c.type === 'calendar')!
    expect(calendar.source).toBe('schedules.mine')
    // The advisor-notes card is butler-written relay content (C1-c 中转约定).
    const notes = comps.find((c) => c.type === 'markdown-card')!
    expect(notes.source).toBe('content:garden-notes')
  })

  it('every start_workflow: action targets a workflow SHIPPED IN THIS PACK', () => {
    const shipped = new Set(parsed.workflows.map((w) => w.id))
    const cfg = parsed.panels[0]!.config as PanelCfg
    const actions = cfg.sections
      .flatMap((s) => s.components)
      .filter((c) => c.type === 'quick-actions')
      .flatMap((c) => c.params?.actions ?? [])
    const workflowActions = actions.filter((a) => a.startsWith('start_workflow:'))
    // The pack's whole point is one-tap runs — at least one button must exist.
    expect(workflowActions.length).toBeGreaterThan(0)
    for (const a of workflowActions) {
      const id = a.slice('start_workflow:'.length)
      expect(shipped.has(id), `quick-action targets un-shipped workflow '${id}'`).toBe(true)
    }
  })
})
