/**
 * SDUI-M3 — dedicated anti-rot gate for the family-panel-trio gallery pack.
 *
 * Why it lives in HOST tests: the gallery gate in @gotong/web treats panel
 * configs as opaque blobs (web's parser is shape-only — web must not import
 * personal-butler), so nothing in the web suite proves the shipped presets
 * pass the REAL validator. Host depends on both packages, so this gate
 * imports the embedded gallery straight from web's dist and runs every
 * preset through validatePanelConfig — the same choke point the install
 * sink uses. If a contract narrows or a preset rots, this goes red before
 * a user ever sees "preset skipped" warns at import time.
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
    agents: unknown[]
    workflows: unknown[]
    knowledgeBases: unknown[]
    panels: { id: string; title: string; description?: string; config: unknown }[]
  }
}

const entry = BUILTIN_TEMPLATES.find((t) => t.id === 'family-panel-trio')
if (!entry) throw new Error('family-panel-trio missing from the embedded gallery')
const parsed = parseTemplate(entry.yaml)

describe('family-panel-trio gallery pack (SDUI-M3)', () => {
  it('is the first panel-only template: 3 panels, zero agents/workflows/KBs', () => {
    // template.name doubles as the gallery card title AND the installPanels
    // pack key — it is the Chinese display name, per gallery convention.
    expect(parsed.name).toBe('家庭面板三形态(农事 / 生活 / 看板)')
    expect(parsed.agents.length).toBe(0)
    expect(parsed.workflows.length).toBe(0)
    expect(parsed.knowledgeBases.length).toBe(0)
    expect(parsed.panels.map((p) => p.id)).toEqual([
      'father-farm-care',
      'mother-local-life',
      'family-ops-board',
    ])
  })

  it('every preset passes the REAL validatePanelConfig (the install choke point)', () => {
    for (const p of parsed.panels) {
      const v = validatePanelConfig(p.config)
      expect(v.ok, `${p.id}: ${v.ok ? '' : v.errors.join('; ')}`).toBe(true)
      expect(p.title.length).toBeGreaterThan(0)
      expect(p.description && p.description.length).toBeTruthy()
    }
  })

  it('pins each shape to its load-bearing components', () => {
    const types = (id: string): string[] => {
      const p = parsed.panels.find((x) => x.id === id)
      const cfg = p?.config as { sections: { components: { type: string }[] }[] }
      return cfg.sections.flatMap((s) => s.components.map((c) => c.type))
    }
    // 父亲农事面:天气 + 农历周视图 + 农活清单 + 心得卡 + 对话。
    expect(types('father-farm-care')).toEqual(
      expect.arrayContaining(['weather', 'calendar', 'list', 'markdown-card', 'chat']),
    )
    // 母亲生活面:新闻流 + 快捷动作。
    expect(types('mother-local-life')).toEqual(
      expect.arrayContaining(['card-feed', 'quick-actions', 'weather', 'schedule-list']),
    )
    // operator 看板:保留区收件箱 + hub 状态 + 用量图。
    expect(types('family-ops-board')).toEqual(
      expect.arrayContaining(['approval-inbox', 'status-card', 'chart']),
    )
  })

  it('quick-actions never reference workflows (the pack ships none)', () => {
    for (const p of parsed.panels) {
      const cfg = p.config as {
        sections: { components: { type: string; params?: { actions?: string[] } }[] }[]
      }
      for (const s of cfg.sections) {
        for (const c of s.components) {
          if (c.type !== 'quick-actions') continue
          for (const a of c.params?.actions ?? []) {
            expect(a.startsWith('start_workflow:'), `${p.id} action ${a}`).toBe(false)
          }
        }
      }
    }
  })
})
