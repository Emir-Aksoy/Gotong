/**
 * skeleton-config-contract.test.ts — SHELL-M4.5 anti-rot gate.
 *
 * Fork B2 put ALL tabs (not just the member three) into the panel config, and
 * M0 demanded one gate for the new failure mode B1 didn't have:
 *
 *   配置驱动的 tabbar 不得成为提权路径 — a member config naming an admin tab
 *   (1) renders no button, (2) loads no bundle, (3) the server 403s anyway.
 *
 * Layers 1+2 are pinned BEHAVIOURALLY here by booting the real shipped
 * static/app.js in a node:vm DOM stub (layer 3 lives in c1-app-shell.test.ts
 * against a real server + member session). The structural reason the property
 * holds is that effectiveTabs() is the ONLY place config and role meet, and it
 * composes by intersection — config can only ever narrow.
 *
 * The text half pins the wire contract: app.js's TAB_REGISTRY and the schema's
 * PANEL_TAB_IDS are the same roster (web must NOT import personal-butler —
 * kernel-deps direction — so both files are read as TEXT, same discipline as
 * sdui-ui-contract.test.ts), the reserved floor mirrors PANEL_RESERVED_TABS,
 * and the skeleton reader's schema version stays in lockstep with
 * PANEL_SCHEMA_VERSION (SHELL-M3: never guess at a newer schema).
 */

import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'

const appJs = readFileSync(fileURLToPath(new URL('../static/app.js', import.meta.url)), 'utf8')
const appHtml = readFileSync(fileURLToPath(new URL('../static/app.html', import.meta.url)), 'utf8')
const appCoreSrc = readFileSync(
  fileURLToPath(new URL('../static/app-core.js', import.meta.url)),
  'utf8',
)
const schemaSrc = readFileSync(
  fileURLToPath(new URL('../../personal-butler/src/panel-schema.ts', import.meta.url)),
  'utf8',
)

// ---------------------------------------------------------------------------
// Text-level parses (fail loudly if a shape changes so the gate can't go
// silently green against the wrong anchor — the mutation-test lesson).
// ---------------------------------------------------------------------------

function must<T>(v: T | null | undefined, what: string): T {
  if (v == null) throw new Error(`skeleton gate: could not parse ${what}`)
  return v
}

const registryBlock = must(
  appJs.match(/const TAB_REGISTRY = \[([\s\S]*?)\n {2}\]/)?.[1],
  'TAB_REGISTRY block in app.js',
)
const registryEntries = [...registryBlock.matchAll(
  /\{ id: '([a-z]+)', i18n: '([A-Za-z]+)', roles: (ALL_ROLES|ADMIN_ROLES|\['owner'\]) \}/g,
)].map((m) => ({ id: m[1]!, i18n: m[2]!, roles: m[3]! }))

const schemaTabsBlock = must(
  schemaSrc.match(/export const PANEL_TAB_IDS = \[([\s\S]*?)\] as const/)?.[1],
  'PANEL_TAB_IDS block in panel-schema.ts',
)
const schemaTabIds = [...schemaTabsBlock.matchAll(/'([a-z]+)'/g)].map((m) => m[1]!)

const appReserved = [...must(
  appJs.match(/const RESERVED_TABS = \[([^\]]+)\]/)?.[1],
  'RESERVED_TABS in app.js',
).matchAll(/'([a-z]+)'/g)].map((m) => m[1]!)
const schemaReserved = [...must(
  schemaSrc.match(/export const PANEL_RESERVED_TABS = \[([^\]]+)\] as const/)?.[1],
  'PANEL_RESERVED_TABS in panel-schema.ts',
).matchAll(/'([a-z]+)'/g)].map((m) => m[1]!)

const bundlesBlock = must(
  appJs.match(/const TAB_BUNDLES = \[([\s\S]*?)\n {2}\]/)?.[1],
  'TAB_BUNDLES block in app.js',
)
const bundleTabs = [...bundlesBlock.matchAll(/tab: '([a-z]+)'/g)].map((m) => m[1]!)
const bundleSrcs = [...bundlesBlock.matchAll(/'(\/[a-z0-9-]+\.js)'/g)].map((m) => m[1]!)
const coreBundles = [...must(
  appJs.match(/const CORE_ADMIN_BUNDLES = \[([^\]]+)\]/)?.[1],
  'CORE_ADMIN_BUNDLES in app.js',
).matchAll(/'(\/[a-z0-9-]+\.js)'/g)].map((m) => m[1]!)

describe('SHELL-M4.5 — skeleton wire contract (text level)', () => {
  it('parses a real registry (18 entries, not an empty match)', () => {
    expect(registryEntries.length).toBe(18)
  })

  it('TAB_REGISTRY ids ≡ PANEL_TAB_IDS, same order (two-way roster)', () => {
    // Order matters on both sides: registry order is the role-default
    // skeleton, and the schema order feeds the butler cheat sheet.
    expect(registryEntries.map((e) => e.id)).toEqual(schemaTabIds)
  })

  it('RESERVED_TABS ≡ PANEL_RESERVED_TABS (the un-removable floor)', () => {
    expect(appReserved).toEqual(schemaReserved)
    // The floor must be a subset of the roster and cover the three surfaces
    // that must never be config-removable: approvals inbox (home), the
    // member's undo/shape escape hatch (panel), language/logout (settings).
    expect(appReserved).toEqual(['home', 'panel', 'settings'])
  })

  it('skeleton reader schema version is in lockstep with PANEL_SCHEMA_VERSION', () => {
    const reader = must(
      appJs.match(/const SKELETON_SCHEMA_VERSION = (\d+)/)?.[1],
      'SKELETON_SCHEMA_VERSION in app.js',
    )
    const schema = must(
      schemaSrc.match(/export const PANEL_SCHEMA_VERSION = (\d+)/)?.[1],
      'PANEL_SCHEMA_VERSION in panel-schema.ts',
    )
    expect(reader).toBe(schema)
  })

  it('role baselines match the retired static markup exactly', () => {
    const rolesById = new Map(registryEntries.map((e) => [e.id, e.roles]))
    for (const id of ['home', 'panel', 'settings']) {
      expect(rolesById.get(id), id).toBe('ALL_ROLES')
    }
    for (const id of ['overview', 'agents', 'workflows', 'tasks', 'activity', 'services', 'mcp', 'reallife']) {
      expect(rolesById.get(id), id).toBe('ADMIN_ROLES')
    }
    for (const id of ['users', 'quotas', 'usage', 'reputation', 'federation', 'oidc', 'saml']) {
      expect(rolesById.get(id), id).toBe("['owner']")
    }
  })

  it('app.html ships an EMPTY nav — no static tabbar button anywhere in the bytes', () => {
    // A static button would bypass both the role filter and the config.
    // The scan covers comments too on purpose: served bytes are served bytes.
    expect(appHtml).not.toContain('tabbar-btn')
    expect(appHtml).toContain('id="admin-tabbar"')
  })

  it('every registry id has a <section data-tab> to land on', () => {
    // A generated button without a section would activate a blank screen.
    for (const { id } of registryEntries) {
      expect(appHtml, id).toContain(`data-tab="${id}"`)
    }
  })

  it('every registry i18n key exists in BOTH app-core dictionaries', () => {
    // The sduiShapeInstallBtn lesson: a missing key renders the raw key name
    // in the UI. Each tab label key must appear at least twice (zh + en).
    for (const { i18n } of registryEntries) {
      const hits = appCoreSrc.match(new RegExp(`\\b${i18n}:`, 'g')) ?? []
      expect(hits.length, i18n).toBeGreaterThanOrEqual(2)
    }
  })

  it('bundle map: 14 bundles total, every mapped tab is a real registry id', () => {
    const ids = new Set(registryEntries.map((e) => e.id))
    for (const tab of bundleTabs) {
      expect(ids.has(tab), tab).toBe(true)
    }
    // The historical serial chain had exactly these 14 (it was 15 until the
    // outbound ACP adapter and its acp-ui.js were retired, 2026-08-27);
    // by-config loading may trim at runtime but the MAP must still account
    // for every one of them — a bundle dropped from the map would silently
    // never load for anyone.
    expect(coreBundles).toEqual(['/admin-wf-assist.js', '/admin.js'])
    expect(coreBundles.length + bundleSrcs.length).toBe(14)
    // No duplicates across the map.
    expect(new Set([...coreBundles, ...bundleSrcs]).size).toBe(14)
  })

  it('every mapped bundle src exists in static/ (a typo would 404 the chain)', () => {
    for (const src of [...coreBundles, ...bundleSrcs]) {
      const p = fileURLToPath(new URL(`../static/${src.slice(1)}`, import.meta.url))
      expect(existsSync(p), src).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// Behavioural half — boot the real app.js in a VM DOM stub.
// ---------------------------------------------------------------------------

interface VmBoot {
  body: Record<string, any>
  /** data-tab of every button the shell generated, in order. */
  renderedTabs: () => string[]
  /** The generated button elements themselves (for attribute assertions). */
  buttons: () => Array<Record<string, any>>
  /** script srcs injected into <head>, in order. */
  injectedSrcs: string[]
  fireDomReady: () => Promise<void>
}

function makeEl(): Record<string, any> {
  const classes = new Set<string>()
  const attrs: Record<string, string> = {}
  return {
    dataset: {} as Record<string, string>,
    style: {},
    hidden: true,
    checked: false,
    textContent: '',
    innerHTML: '',
    value: '',
    _classes: classes,
    classList: {
      add: (c: string) => { classes.add(c) },
      remove: (c: string) => { classes.delete(c) },
      toggle: (c: string, force?: boolean) => {
        const on = force === undefined ? !classes.has(c) : force
        if (on) classes.add(c); else classes.delete(c)
        return on
      },
      contains: (c: string) => classes.has(c),
    },
    setAttribute(k: string, v: string) { attrs[k] = v },
    getAttribute(k: string) { return attrs[k] ?? null },
    appendChild() {},
    addEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
  }
}

function bootVm(opts: { role: string; panel?: unknown; hash?: string; failFetch?: boolean }): VmBoot {
  // Default hub answer: current schema, no tabs → role-default skeleton.
  const panelResponse = opts.panel ?? {
    schemaVersion: 1,
    config: { schemaVersion: 1, sections: [] },
    source: 'default',
  }

  // The nav collects generated buttons; assigning textContent = '' clears it
  // (that's how renderTabbar resets), appendChild collects.
  const navChildren: Array<Record<string, any>> = []
  const nav = makeEl()
  Object.defineProperty(nav, 'textContent', {
    get: () => '',
    set: () => { navChildren.length = 0 },
  })
  nav.appendChild = (child: Record<string, any>) => { navChildren.push(child) }

  // One section per registry id so setActiveTab has something to toggle.
  const sections = registryEntries.map(({ id }) => {
    const s = makeEl()
    s.dataset.tab = id
    return s
  })

  const injectedSrcs: string[] = []
  const head = makeEl()
  head.appendChild = (el: Record<string, any>) => {
    if (typeof el.src === 'string') {
      injectedSrcs.push(el.src)
      // Resolve the inject() promise so the serial chain advances — the whole
      // by-config list drains on the microtask queue.
      if (typeof el.onload === 'function') el.onload()
    }
  }

  const body = makeEl()
  body.hidden = false

  const roleMeta = makeEl()
  roleMeta.getAttribute = (a: string) => (a === 'content' ? opts.role : null)

  const location = { hash: opts.hash ?? '', href: '' }
  const domListeners: Record<string, (...a: unknown[]) => void> = {}

  const querySelector = (sel: string): Record<string, any> | null => {
    if (sel === 'meta[name="x-gotong-role"]') return roleMeta
    if (sel === 'meta[name="x-gotong-bootstrap"]') return null
    if (sel === '#admin-tabbar') return nav
    return makeEl()
  }
  const querySelectorAll = (sel: string): Array<Record<string, any>> => {
    if (sel.startsWith('.tabbar-btn')) return [...navChildren]
    if (sel.includes('section[data-tab]')) return sections
    return []
  }

  const ctx: Record<string, unknown> = {
    window: {
      Gotong: {
        t: {} as Record<string, unknown>,
        onLangChange: () => {},
        escapeHtml: (s: string) => s,
        formatBytes: (n: number) => String(n),
        formatTs: (n: number) => String(n),
      },
      addEventListener: () => {},
      dispatchEvent: () => true,
      location,
    },
    location,
    localStorage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    },
    document: {
      readyState: 'complete',
      addEventListener: (type: string, cb: (...a: unknown[]) => void) => { domListeners[type] = cb },
      getElementById: (id: string) => (id === 'admin-tabbar' ? nav : makeEl()),
      querySelector,
      querySelectorAll,
      createElement: () => makeEl(),
      head,
      body,
    },
    console,
    navigator: {},
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    fetch: (url: unknown) =>
      String(url).startsWith('/api/me/panel')
        ? opts.failFetch
          ? Promise.reject(new Error('offline'))
          : Promise.resolve({ ok: true, status: 200, json: async () => panelResponse })
        : new Promise(() => {}),
    CustomEvent: class { type: string; detail: unknown; constructor(type: string, init?: any) { this.type = type; this.detail = init?.detail } },
    EventSource: class { close() {} },
  }

  runInNewContext(appJs, ctx)

  return {
    body,
    renderedTabs: () => navChildren.map((b) => String(b.dataset.tab)),
    buttons: () => [...navChildren],
    injectedSrcs,
    fireDomReady: async () => {
      const cb = domListeners.DOMContentLoaded
      if (typeof cb !== 'function') throw new Error('app.js did not register DOMContentLoaded')
      await (cb() as unknown as Promise<void>)
      // Drain the microtask-only inject chain (sync onload → .then hops).
      await new Promise((r) => setTimeout(r, 0))
    },
  }
}

const ALL_IDS = registryEntries.map((e) => e.id)
const ALL_BUNDLES = [
  '/admin-wf-assist.js', '/admin.js', '/operator-steward-ui.js', '/setting-ops-ui.js',
  '/identity-ui.js', '/quotas-ui.js', '/reputation-ui.js', '/usage-ui.js',
  '/peer-admin-ui.js', '/peer-manifest-ui.js', '/peer-summary-ui.js', '/a2a-ui.js',
  '/oidc-ui.js', '/saml-ui.js',
]

describe('SHELL-M4.5 — skeleton behaviour (real app.js in a VM)', () => {
  it('no config → role-default skeleton, all 14 bundles, byte-identical default', async () => {
    const vm = bootVm({ role: 'owner' })
    await vm.fireDomReady()
    expect(vm.renderedTabs()).toEqual(ALL_IDS)
    expect(vm.body.dataset.activeTab).toBe('overview')
    expect(vm.injectedSrcs).toEqual(ALL_BUNDLES)
  })

  it('GATE: member config naming admin tabs renders NO button and loads NO bundle', async () => {
    // The B2 gate proper. A member's config lists `users` + `federation`
    // (admin/owner tabs): the intersection strips both, the reserved floor
    // fills in, and — critically — not one admin bundle is even fetched.
    const vm = bootVm({
      role: 'member',
      panel: {
        schemaVersion: 1,
        config: { schemaVersion: 1, tabs: ['users', 'federation', 'home'], sections: [] },
        source: 'member',
      },
    })
    await vm.fireDomReady()
    expect(vm.renderedTabs()).toEqual(['home', 'panel', 'settings'])
    expect(vm.injectedSrcs).toEqual([])
    expect(vm.body.dataset.activeTab).toBe('home')
  })

  it('owner config trims tabs → bundles trim with them (B2 main increment)', async () => {
    // Only `agents` from the admin family → the core pair loads (admin.js
    // drives the agents tab) but every satellite stays unfetched.
    const vm = bootVm({
      role: 'owner',
      panel: {
        schemaVersion: 1,
        config: { schemaVersion: 1, tabs: ['agents', 'home'], sections: [] },
        source: 'member',
      },
    })
    await vm.fireDomReady()
    expect(vm.renderedTabs()).toEqual(['agents', 'home', 'panel', 'settings'])
    expect(vm.injectedSrcs).toEqual(['/admin-wf-assist.js', '/admin.js'])
    // 首屏纳入配置 — the config's first usable entry is the landing screen.
    expect(vm.body.dataset.activeTab).toBe('agents')
  })

  it('config reorders → landing screen follows; a deep-link hash still wins', async () => {
    const panel = {
      schemaVersion: 1,
      config: { schemaVersion: 1, tabs: ['usage', 'overview', 'home'], sections: [] },
      source: 'member',
    }
    const vm = bootVm({ role: 'owner', panel })
    await vm.fireDomReady()
    expect(vm.body.dataset.activeTab).toBe('usage')

    const deep = bootVm({ role: 'owner', panel, hash: '#overview' })
    await deep.fireDomReady()
    expect(deep.body.dataset.activeTab).toBe('overview')
  })

  it('config-only-admin-tabs member still gets the reserved floor (never a blank shell)', async () => {
    const vm = bootVm({
      role: 'member',
      panel: {
        schemaVersion: 1,
        config: { schemaVersion: 1, tabs: ['users', 'saml'], sections: [] },
        source: 'member',
      },
    })
    await vm.fireDomReady()
    expect(vm.renderedTabs()).toEqual(['home', 'panel', 'settings'])
    expect(vm.body.dataset.activeTab).toBe('home')
  })

  it('SHELL-M3 discipline: a NEWER schemaVersion → tabs ignored, role default', async () => {
    // The skeleton reader never guesses at a newer schema. The fallback is
    // also the harmless direction: role default only ever shows MORE within
    // the role, never less.
    const vm = bootVm({
      role: 'owner',
      panel: {
        schemaVersion: 2,
        config: { schemaVersion: 2, tabs: ['agents'], sections: [] },
        source: 'member',
      },
    })
    await vm.fireDomReady()
    expect(vm.renderedTabs()).toEqual(ALL_IDS)
    expect(vm.body.dataset.activeTab).toBe('overview')
    expect(vm.injectedSrcs).toEqual(ALL_BUNDLES)
  })

  it('hub fetch failing entirely → role default (fail-soft, never a dead shell)', async () => {
    const vm = bootVm({ role: 'owner', failFetch: true })
    await vm.fireDomReady()
    expect(vm.renderedTabs()).toEqual(ALL_IDS)
    expect(vm.body.dataset.activeTab).toBe('overview')
    expect(vm.injectedSrcs).toEqual(ALL_BUNDLES)
  })

  it('generated buttons carry the retired markup contract (data-tab/roles/i18n)', async () => {
    const vm = bootVm({ role: 'owner' })
    await vm.fireDomReady()
    const btns = vm.buttons()
    const home = btns[0]!
    expect(home.dataset.tab).toBe('home')
    expect(home.dataset.roles).toBe('owner,admin,member,viewer')
    expect(home.getAttribute('data-i18n')).toBe('tabHome')
    const users = btns.find((b) => b.dataset.tab === 'users')!
    expect(users.dataset.roles).toBe('owner')
    expect(users.getAttribute('data-i18n')).toBe('tabUsers')
  })

  it('member with no config sees exactly the pre-M4.5 member three', async () => {
    const vm = bootVm({ role: 'member' })
    await vm.fireDomReady()
    expect(vm.renderedTabs()).toEqual(['home', 'panel', 'settings'])
    expect(vm.injectedSrcs).toEqual([])
    expect(vm.body.dataset.activeTab).toBe('home')
  })
})
