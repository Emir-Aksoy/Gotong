import { describe, expect, it } from 'vitest'

import {
  DEFAULT_PANEL,
  PANEL_BASELINE_CLIENT_SCHEMA_VERSION,
  PANEL_COMPONENT_CONTRACTS,
  PANEL_COMPONENT_TYPES,
  PANEL_LIMITS,
  PANEL_RESERVED_TABS,
  PANEL_RESERVED_TYPES,
  PANEL_SCALES,
  PANEL_SCHEMA_VERSION,
  PANEL_TAB_IDS,
  panelContract,
  panelContractVerdict,
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

describe('validatePanelConfig — tabs (SHELL-M4.5 skeleton)', () => {
  it('accepts an ordered subset of the closed tab catalog', () => {
    const res = validatePanelConfig(minimal({ tabs: ['panel', 'home', 'settings'] }))
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.config.tabs).toEqual(['panel', 'home', 'settings'])
  })

  it('accepts the full catalog in any order (B2: admin tabs are just entries)', () => {
    const res = validatePanelConfig(minimal({ tabs: [...PANEL_TAB_IDS].reverse() }))
    expect(res.ok).toBe(true)
  })

  it('absent tabs = valid (the client renders its role-default skeleton)', () => {
    // DEFAULT_PANEL deliberately carries no tabs — 未配 = 字节不变.
    expect('tabs' in DEFAULT_PANEL).toBe(false)
    expect(validatePanelConfig(minimal()).ok).toBe(true)
  })

  it('rejects unknown tab ids — the skeleton vocabulary is a closed set', () => {
    const res = validatePanelConfig(minimal({ tabs: ['home', 'evil-tab'] as never }))
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.errors.join('\n')).toContain('tabs[1]: unknown tab')
  })

  it('rejects duplicates, empties and non-arrays', () => {
    for (const bad of [['home', 'home'], [], 'home', 42, {}] as const) {
      const res = validatePanelConfig(minimal({ tabs: bad as never }))
      expect(res.ok, `tabs=${JSON.stringify(bad)}`).toBe(false)
    }
  })

  it('refuses loudly over the catalog-size cap (hostile long arrays)', () => {
    const res = validatePanelConfig(minimal({ tabs: Array(200).fill('home') as never }))
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.errors.join('\n')).toContain(`over ${PANEL_TAB_IDS.length}`)
  })

  it('reserved floor is a subset of the catalog (roster sanity)', () => {
    for (const t of PANEL_RESERVED_TABS) {
      expect(PANEL_TAB_IDS as readonly string[]).toContain(t)
    }
  })
})

describe('validatePanelConfig — scale (POLISH-M1 老龄友好)', () => {
  it('accepts every catalog tier — the enum IS the whole styling surface', () => {
    for (const scale of PANEL_SCALES) {
      const res = validatePanelConfig(minimal({ scale }))
      expect(res.ok, `scale=${scale}`).toBe(true)
      if (res.ok) expect(res.config.scale).toBe(scale)
    }
  })

  it('absent scale = valid (base tier; 未配 = 字节不变)', () => {
    expect('scale' in DEFAULT_PANEL).toBe(false)
    expect(validatePanelConfig(minimal()).ok).toBe(true)
  })

  it('rejects free-form styling smuggled through scale — closed set, no CSS', () => {
    for (const bad of ['huge', 'font-size:40px', '', 40, { large: true }, ['large']] as const) {
      const res = validatePanelConfig(minimal({ scale: bad as never }))
      expect(res.ok, `scale=${JSON.stringify(bad)}`).toBe(false)
      if (!res.ok) expect(res.errors.join('\n')).toContain('scale: must be one of')
    }
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

describe('validatePanelConfig — hardening (Codex 收口)', () => {
  it('rejects prototype-inherited fields (own-property pin)', () => {
    // A config whose load-bearing keys live on the prototype chain must not
    // validate — JSON.parse output never has a custom prototype, so anything
    // that does is a constructed object smuggling fields past hasOwn checks.
    const viaProto = Object.create({
      sections: [{ components: [{ type: 'chat' }] }],
    }) as Record<string, unknown>
    viaProto.schemaVersion = PANEL_SCHEMA_VERSION
    expect(validatePanelConfig(viaProto).ok).toBe(false)

    class Sneaky {
      schemaVersion = PANEL_SCHEMA_VERSION
      sections = [{ components: [{ type: 'chat' }] }]
    }
    expect(validatePanelConfig(new Sneaky()).ok).toBe(false)
  })

  it('rejects control and bidi-override characters in title / heading / string params', () => {
    // Built via fromCharCode so no raw control bytes live in this source file.
    const ctl = 'x' + String.fromCharCode(7) + 'y' // BEL
    const bidi = 'x' + String.fromCharCode(0x202e) + 'y' // RLO override
    expect(validatePanelConfig(minimal({ title: ctl } as never)).ok).toBe(false)
    expect(
      validatePanelConfig(
        minimal({ sections: [{ heading: bidi, components: [{ type: 'chat' }] }] } as never),
      ).ok,
    ).toBe(false)
    const res = validatePanelConfig(
      minimal({ sections: [{ components: [{ type: 'chat', params: { placeholder: ctl } }] }] } as never),
    )
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.errors.join('\n')).toContain('control or bidi')
  })

  it('reserved approval-inbox may appear at most once per config', () => {
    const res = validatePanelConfig(
      minimal({
        sections: [
          { components: [{ type: 'approval-inbox' }] },
          { components: [{ type: 'approval-inbox' }] },
        ],
      } as never),
    )
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.errors.join('\n')).toContain('at most once')
    // A single reserved placement stays legal (bare, no source/params).
    expect(
      validatePanelConfig(minimal({ sections: [{ components: [{ type: 'approval-inbox' }] }] } as never)).ok,
    ).toBe(true)
  })
})

// SHELL-M3 — version negotiation. The shell ships on its own clock, so these
// verdicts are what stands between "old app renders a schema it half-knows"
// and an honest downgrade.
describe('panelContract — version negotiation', () => {
  it('same version = ok', () => {
    const c = panelContract(PANEL_SCHEMA_VERSION)
    expect(c).toEqual({
      server: PANEL_SCHEMA_VERSION,
      client: PANEL_SCHEMA_VERSION,
      verdict: 'ok',
      componentTypes: PANEL_COMPONENT_TYPES,
    })
  })

  // THE case the milestone exists for, and the one the constant server version
  // makes unreachable through panelContract() today: a shell frozen at v1
  // meeting a hub that has moved to v2. Tested on the rule directly so it is
  // covered before the divergence can happen in the field.
  it('client behind the hub = client_outdated (the whole-panel downgrade case)', () => {
    expect(panelContractVerdict(2, 1)).toBe('client_outdated')
    expect(panelContractVerdict(9, 3)).toBe('client_outdated')
  })

  it('client ahead of the hub renders normally — a newer renderer must read older configs', () => {
    expect(panelContractVerdict(1, 2)).toBe('client_ahead')
    expect(panelContract(PANEL_SCHEMA_VERSION + 5).verdict).toBe('client_ahead')
  })

  it('equal versions are ok at every pair', () => {
    for (const v of [1, 2, 17]) expect(panelContractVerdict(v, v)).toBe('ok')
  })

  it('absent or garbled declarations fall back to the baseline, never to a crash', () => {
    for (const bad of [undefined, null, '', 'abc', '1.5', 0, -3, Infinity, NaN, {}, []]) {
      const c = panelContract(bad)
      expect(c.client, `declaration ${JSON.stringify(bad)}`).toBe(
        PANEL_BASELINE_CLIENT_SCHEMA_VERSION,
      )
    }
  })

  it('accepts the string form a query param actually arrives as', () => {
    expect(panelContract('1').client).toBe(1)
    expect(panelContract('7').client).toBe(7)
  })

  it('every advertised component type has a contract entry (the catalog IS the promise)', () => {
    // SHELL-M3 dropped image-card precisely because it was advertised without a
    // renderer. The catalog a client is handed must never list a ghost again.
    for (const type of panelContract().componentTypes) {
      expect(PANEL_COMPONENT_CONTRACTS[type], `contract for '${type}'`).toBeDefined()
    }
    expect(panelContract().componentTypes).not.toContain('image-card')
  })
})
