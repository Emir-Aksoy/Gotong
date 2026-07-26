import { describe, expect, it } from 'vitest'

import {
  DEFAULT_PANEL,
  PANEL_COMPONENT_CONTRACTS,
  PANEL_COMPONENT_TYPES,
  PANEL_LIMITS,
  PANEL_RESERVED_TYPES,
  PANEL_SCHEMA_VERSION,
  validatePanelConfig,
  type PanelConfig,
} from '../src/panel-schema.js'

function minimal(overrides?: Partial<PanelConfig>): Record<string, unknown> {
  return {
    schemaVersion: PANEL_SCHEMA_VERSION,
    sections: [{ components: [{ type: 'chat' }] }],
    ...overrides,
  }
}

describe('validatePanelConfig — accepts', () => {
  it('DEFAULT_PANEL passes its own validator (the M1 acceptance gate)', () => {
    const res = validatePanelConfig(DEFAULT_PANEL)
    expect(res.ok).toBe(true)
  })

  it('accepts a full valid config with sources, params and quick-actions', () => {
    const res = validatePanelConfig({
      schemaVersion: 1,
      title: '爸爸的面板',
      sections: [
        {
          heading: '今天',
          components: [
            { type: 'weather', source: 'connector:weather', params: { days: 3 } },
            { type: 'calendar', source: 'schedules.mine', params: { view: 'week' } },
            { type: 'chat', params: { placeholder: '和阿同聊聊今天的地里活…' } },
          ],
        },
        {
          components: [
            { type: 'approval-inbox' },
            { type: 'markdown-card', source: 'content:farm-notes' },
            { type: 'quick-actions', params: { actions: ['open_chat', 'start_workflow:family-brief'] } },
          ],
        },
      ],
    })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.config.sections).toHaveLength(2)
  })

  it('every component type in the catalog has a contract (two-way roster)', () => {
    expect(Object.keys(PANEL_COMPONENT_CONTRACTS).sort()).toEqual([...PANEL_COMPONENT_TYPES].sort())
  })
})

describe('validatePanelConfig — fail-closed rejects', () => {
  it('rejects non-objects outright', () => {
    for (const bad of [null, undefined, 'x', 7, [], true]) {
      const res = validatePanelConfig(bad)
      expect(res.ok).toBe(false)
    }
  })

  it('rejects unknown top-level / section / component keys', () => {
    expect(validatePanelConfig({ ...minimal(), theme: 'dark' }).ok).toBe(false)
    expect(
      validatePanelConfig(minimal({ sections: [{ components: [{ type: 'chat' }], style: 'x' }] } as never)).ok,
    ).toBe(false)
    expect(
      validatePanelConfig(minimal({ sections: [{ components: [{ type: 'chat', href: 'x' }] }] } as never)).ok,
    ).toBe(false)
  })

  it('rejects wrong schemaVersion (version negotiation happens elsewhere)', () => {
    const res = validatePanelConfig(minimal({ schemaVersion: 2 } as never))
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.errors.join('\n')).toContain('schemaVersion')
  })

  it('rejects unknown component types — a hallucinated layout cannot land', () => {
    const res = validatePanelConfig(minimal({ sections: [{ components: [{ type: 'crypto-ticker' }] }] } as never))
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.errors.join('\n')).toContain('crypto-ticker')
  })

  it('rejects any source/params on reserved-zone components (nothing to tamper)', () => {
    for (const type of PANEL_RESERVED_TYPES) {
      expect(
        validatePanelConfig(minimal({ sections: [{ components: [{ type, source: 'inbox.pending' }] }] } as never))
          .ok,
      ).toBe(false)
      expect(
        validatePanelConfig(minimal({ sections: [{ components: [{ type, params: { limit: 1 } }] }] } as never)).ok,
      ).toBe(false)
      // Bare placement stays legal.
      expect(validatePanelConfig(minimal({ sections: [{ components: [{ type }] }] } as never)).ok).toBe(true)
    }
  })

  it('rejects off-whitelist sources: arbitrary URLs, wrong bindings, bad suffixes', () => {
    const cases: Array<[string, string]> = [
      ['weather', 'https://evil.example/x'], // URL never passes the named whitelist
      ['weather', 'tasks.mine'], // valid source, wrong component
      ['markdown-card', 'content:../../etc/passwd'], // traversal shape in suffix
      ['markdown-card', 'content:'], // empty suffix
      ['chat', 'connector:weather'], // chat only binds chat.butler
    ]
    for (const [type, source] of cases) {
      const res = validatePanelConfig(minimal({ sections: [{ components: [{ type, source }] }] } as never))
      expect(res.ok, `${type} + ${source}`).toBe(false)
    }
  })

  it('rejects a missing source where the contract requires one', () => {
    const res = validatePanelConfig(minimal({ sections: [{ components: [{ type: 'weather' }] }] } as never))
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.errors.join('\n')).toContain('required')
  })

  it('rejects unknown / out-of-range params per component whitelist', () => {
    const cases: Array<Record<string, unknown>> = [
      { type: 'weather', source: 'connector:weather', params: { days: 30 } },
      { type: 'weather', source: 'connector:weather', params: { unit: 'C' } },
      { type: 'calendar', source: 'schedules.mine', params: { view: 'year' } },
      { type: 'chat', params: { placeholder: 'x'.repeat(PANEL_LIMITS.maxParamStringChars + 1) } },
      { type: 'divider', params: { thick: true } }, // component takes no params at all
    ]
    for (const component of cases) {
      const res = validatePanelConfig(minimal({ sections: [{ components: [component] }] } as never))
      expect(res.ok, JSON.stringify(component)).toBe(false)
    }
  })

  it('rejects off-whitelist quick-actions verbs (no arbitrary calls from config)', () => {
    const bad = ['delete_agent', 'start_workflow:../x', 'open_chat; rm -rf /']
    for (const action of bad) {
      const res = validatePanelConfig(
        minimal({ sections: [{ components: [{ type: 'quick-actions', params: { actions: [action] } }] }] } as never),
      )
      expect(res.ok, action).toBe(false)
    }
    expect(
      validatePanelConfig(
        minimal({ sections: [{ components: [{ type: 'quick-actions', params: { actions: [] } }] }] } as never),
      ).ok,
    ).toBe(false)
  })

  it('refuses loudly over caps: sections, total components, title length', () => {
    const manySections = Array.from({ length: PANEL_LIMITS.maxSections + 1 }, () => ({
      components: [{ type: 'divider' }],
    }))
    expect(validatePanelConfig(minimal({ sections: manySections } as never)).ok).toBe(false)

    const manyComponents = [
      { components: Array.from({ length: PANEL_LIMITS.maxComponents + 1 }, () => ({ type: 'divider' })) },
    ]
    const res = validatePanelConfig(minimal({ sections: manyComponents } as never))
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.errors.join('\n')).toContain(`over ${PANEL_LIMITS.maxComponents}`)

    expect(validatePanelConfig(minimal({ title: 'x'.repeat(PANEL_LIMITS.maxTitleChars + 1) } as never)).ok).toBe(
      false,
    )
  })

  it('rejects empty sections arrays and empty component lists', () => {
    expect(validatePanelConfig(minimal({ sections: [] } as never)).ok).toBe(false)
    expect(validatePanelConfig(minimal({ sections: [{ components: [] }] } as never)).ok).toBe(false)
  })

  it('collects multiple errors in one pass (butler fixes a bad layout in one round)', () => {
    const res = validatePanelConfig({
      schemaVersion: 9,
      theme: 'dark',
      sections: [{ components: [{ type: 'nope' }, { type: 'weather' }] }],
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.errors.length).toBeGreaterThanOrEqual(3)
  })
})
