/**
 * Headless smoke for ⑤-M1 — simple mode (progressive disclosure) in `static/app.js`.
 *
 * # Why this exists
 *
 * Simple mode lives entirely in the SPA tab router: a per-device localStorage
 * flag (`gotong_simple_mode`) that trims the admin shell to a curated subset
 * (overview / agents / workflows / tasks / usage) and tucks the advanced tabs
 * (federation / SSO / quotas / …) away. It grants NO capability — the server
 * still enforces every route — so the only thing to verify is the client wiring:
 *
 *   1. when the flag is on, `<body data-simple-mode="1">` is set and every
 *      advanced tab button + section is tagged `.adv-only` (the CSS hook that
 *      removes them from the tabbar);
 *   2. the router GUARD is the real defense — a stale `#federation` hash can't
 *      strand you on a hidden tab: in simple mode `currentTabFromHash` rejects
 *      it and `setActiveTab` lands on `overview`; with simple mode off the same
 *      hash resolves to `federation`;
 *   3. flipping the settings toggle persists the flag and re-applies the body
 *      class live.
 *
 * Like admin-bundle.smoke.test.ts this runs the REAL shipped `static/app.js`
 * in a `node:vm` context with a stubbed DOM — `node --check` and route tests
 * can't see the boot-time tab filtering. The closures (effectiveAdminTabs,
 * markAdvancedTabs, …) aren't exported, so we drive them through boot: app.js
 * registers a deferred `DOMContentLoaded` handler which (signed-in branch) runs
 * `wireTabs()` synchronously before any await.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP_JS = readFileSync(join(HERE, '..', 'static', 'app.js'), 'utf8')

// Every admin tab the shell can show, plus the two C1 tabs (home/settings).
const ALL_TABS = [
  'overview', 'agents', 'workflows', 'tasks', 'activity', 'services', 'mcp',
  'users', 'quotas', 'usage', 'reputation', 'federation', 'oidc', 'saml',
  'home', 'settings',
]
// What simple mode tucks away = ADMIN_TABS − SIMPLE_ADMIN_TABS.
const ADVANCED = [
  'activity', 'services', 'mcp', 'users', 'quotas', 'reputation', 'federation',
  'oidc', 'saml',
]

/** A fake element with a real Set-backed classList + dataset so the router's
 *  add/toggle/contains actually track state we can assert on. */
function richEl(extra: Record<string, unknown> = {}): Record<string, any> {
  const classes = new Set<string>()
  const listeners: Record<string, (...a: unknown[]) => void> = {}
  return {
    dataset: {} as Record<string, string>,
    style: {},
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
    _classes: classes,
    _listeners: listeners,
    hidden: true,
    checked: false,
    textContent: '',
    innerHTML: '',
    value: '',
    appendChild() {},
    setAttribute() {},
    getAttribute() { return null },
    addEventListener: (type: string, cb: (...a: unknown[]) => void) => { listeners[type] = cb },
    querySelector: () => null,
    querySelectorAll: () => [],
    ...extra,
  }
}

interface Boot {
  body: Record<string, any>
  buttons: Record<string, Record<string, any>>
  sections: Record<string, Record<string, any>>
  checkbox: Record<string, any>
  store: Map<string, string>
  location: { hash: string; href: string }
  /** Invoke the captured DOMContentLoaded handler. */
  fireDomReady: () => void
}

/** Build a fresh VM context + stubbed DOM, evaluate app.js, return handles. */
function bootApp(opts: { role?: string; simpleMode?: '1' | '0' | null; hash?: string } = {}): Boot {
  const role = opts.role ?? 'owner'

  // One element per tab name for buttons and sections; dataset.tab carries the
  // name so the router's `btn.dataset.tab` reads resolve.
  const buttons: Record<string, Record<string, any>> = {}
  const sections: Record<string, Record<string, any>> = {}
  for (const name of ALL_TABS) {
    const b = richEl(); b.dataset.tab = name; buttons[name] = b
    const s = richEl(); s.dataset.tab = name; sections[name] = s
  }
  const buttonList = ALL_TABS.map((n) => buttons[n])
  const sectionList = ALL_TABS.map((n) => sections[n])

  const roleMeta = richEl({ getAttribute: (a: string) => (a === 'content' ? role : null) })
  const checkbox = richEl()
  const body = richEl({ hidden: false })

  const store = new Map<string, string>()
  if (opts.simpleMode != null) store.set('gotong_simple_mode', opts.simpleMode)

  const location = { hash: opts.hash ?? '', href: '' }

  const domListeners: Record<string, (...a: unknown[]) => void> = {}
  const winListeners: Record<string, (...a: unknown[]) => void> = {}

  const querySelector = (sel: string): Record<string, any> | null => {
    if (sel.includes('meta[name')) return roleMeta
    if (sel === '#settings-simple-mode') return checkbox
    return richEl() // tolerant for #admin-tabbar / #role-badge / etc.
  }
  const querySelectorAll = (sel: string): Array<Record<string, any>> => {
    if (sel.startsWith('.tabbar-btn')) return buttonList
    if (sel.includes('section[data-tab]')) return sectionList
    return [] // [data-roles] and anything else
  }

  const ctx: Record<string, unknown> = {
    window: {
      Gotong: {
        t: {} as Record<string, unknown>,
        onLangChange: () => {},
        installWorkflowAssist: () => ({ open() {}, close() {}, submit() {}, save() {} }),
        escapeHtml: (s: string) => s,
        formatBytes: (n: number) => String(n),
        formatTs: (n: number) => String(n),
      },
      addEventListener: (type: string, cb: (...a: unknown[]) => void) => { winListeners[type] = cb },
      dispatchEvent: () => true,
      location,
    },
    location,
    localStorage: {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => { store.set(k, String(v)) },
      removeItem: (k: string) => { store.delete(k) },
    },
    document: {
      readyState: 'complete',
      addEventListener: (type: string, cb: (...a: unknown[]) => void) => { domListeners[type] = cb },
      getElementById: () => richEl(),
      querySelector,
      querySelectorAll,
      createElement: () => richEl(),
      head: richEl(),
      body,
    },
    console,
    // Post-IIFE PWA block reads `'serviceWorker' in navigator` at eval time;
    // empty object → false → the registration block is skipped.
    navigator: {},
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    fetch: () => new Promise(() => {}), // never resolves — suspend async render paths
    CustomEvent: class { type: string; detail: unknown; constructor(type: string, init?: any) { this.type = type; this.detail = init?.detail } },
    EventSource: class { close() {} },
  }

  runInNewContext(APP_JS, ctx)

  return {
    body, buttons, sections, checkbox, store, location,
    fireDomReady: () => {
      const cb = domListeners.DOMContentLoaded
      if (typeof cb !== 'function') throw new Error('app.js did not register a DOMContentLoaded handler')
      // The handler is async; the signed-in branch runs wireTabs() synchronously
      // before its first await. Ignore the returned promise (fire-and-forget
      // render paths suspend on the never-resolving fetch).
      void cb()
    },
  }
}

describe('static/app.js — ⑤-M1 simple mode smoke', () => {
  it('evaluates the shipped bundle and registers a DOMContentLoaded handler', () => {
    expect(() => bootApp()).not.toThrow()
  })

  it('simple mode on: tags advanced tabs and lands a stale #federation hash on overview', () => {
    const app = bootApp({ role: 'owner', simpleMode: '1', hash: '#federation' })
    expect(() => app.fireDomReady()).not.toThrow()

    // body flag set
    expect(app.body.dataset.simpleMode).toBe('1')

    // every advanced tab button + section tagged .adv-only (the CSS hide hook)
    for (const name of ADVANCED) {
      expect(app.buttons[name]._classes.has('adv-only')).toBe(true)
      expect(app.sections[name]._classes.has('adv-only')).toBe(true)
    }
    // curated tabs are NOT tagged advanced
    for (const name of ['overview', 'agents', 'workflows', 'tasks', 'usage']) {
      expect(app.buttons[name]._classes.has('adv-only')).toBe(false)
    }

    // the router GUARD redirected #federation → overview (it's not a valid
    // simple-mode tab), so the advanced section can't be the active one.
    expect(app.body.dataset.activeTab).toBe('overview')
    expect(app.sections.overview._classes.has('tab-hidden')).toBe(false)
    expect(app.sections.federation._classes.has('tab-hidden')).toBe(true)
  })

  it('simple mode off: #federation resolves to federation (advanced tabs still reachable)', () => {
    const app = bootApp({ role: 'owner', simpleMode: null, hash: '#federation' })
    app.fireDomReady()

    expect(app.body.dataset.simpleMode).toBeUndefined()
    expect(app.body.dataset.activeTab).toBe('federation')
    expect(app.sections.federation._classes.has('tab-hidden')).toBe(false)
    // adv-only is tagged regardless (the class is inert without the body flag /
    // CSS rule) — markAdvancedTabs always runs.
    expect(app.buttons.federation._classes.has('adv-only')).toBe(true)
  })

  it('toggling the settings switch persists the flag and re-applies the body class live', () => {
    const app = bootApp({ role: 'owner', simpleMode: null, hash: '#overview' })
    app.fireDomReady()
    expect(app.body.dataset.simpleMode).toBeUndefined()

    const onChange = app.checkbox._listeners.change
    expect(typeof onChange).toBe('function')

    // flip ON
    app.checkbox.checked = true
    onChange()
    expect(app.store.get('gotong_simple_mode')).toBe('1')
    expect(app.body.dataset.simpleMode).toBe('1')

    // flip OFF — body flag removed (delete, not empty string) and persisted
    app.checkbox.checked = false
    onChange()
    expect(app.store.get('gotong_simple_mode')).toBe('0')
    expect(app.body.dataset.simpleMode).toBeUndefined()
  })
})
