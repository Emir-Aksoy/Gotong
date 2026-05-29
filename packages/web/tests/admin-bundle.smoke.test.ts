/**
 * Headless smoke for the esbuild-bundled `static/admin.js`.
 *
 * # Why this exists
 *
 * P3 moved the admin console source under `admin-src/` and now bundles it
 * through esbuild (IIFE format). esbuild prepends `"use strict";` and wraps
 * the file in its own IIFE. This smoke guards the risks that `node --check`
 * and the server-side route tests can't see:
 *
 *   1. the product *executes* under strict mode (a stray implicit global or
 *      octal literal throws only at run time, not at parse/--check time)
 *   2. the IIFE runs to completion — destructures the window.AipeHub helpers,
 *      defines every handler, and wires init through the readyState guard
 *   3. the readyState guard itself: app.js injects admin.js from inside its
 *      OWN DOMContentLoaded handler — i.e. AFTER the event already fired. A
 *      bare addEventListener('DOMContentLoaded') would register a listener
 *      that never runs, leaving the whole admin console dead. admin.js must
 *      boot immediately when the document is already parsed. This is the
 *      B1/B2 fix tracked in docs/zh/TECH-DEBT-2026-05.md — and exactly the
 *      class of bug the old route-level tests could never catch.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const ADMIN_JS = readFileSync(join(HERE, '..', 'static', 'admin.js'), 'utf8')

// The helpers admin-src/main.js destructures off window.AipeHub.
const AIPEHUB_HELPERS = [
  '$', 't', 'applyStaticI18n', 'onLangChange', 'escapeHtml', 'formatBytes', 'summarize',
  'isBadResult', 'fetchJson', 'connectStream', 'syncLangFromConfig',
  'fetchLeaderboard', 'renderLeaderboard', 'taskMetricsHtml', 'formatScore',
  'attachContribToggle', 'applyContribToggleState', 'attachCapChips',
  // R14b — app.js publishes the sole tab router here; main.js destructures it.
  'gotoTab',
]

interface RunResult {
  domListeners: Record<string, unknown>
  winListeners: Record<string, unknown>
  /** True if boot() ran: R14b registers a window `aipehub:tabchange` listener. */
  bootRan: boolean
}

function makeEl(): Record<string, unknown> {
  return {
    style: {},
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    hidden: true,
    textContent: '',
    innerHTML: '',
    value: '',
    appendChild() {}, setAttribute() {}, addEventListener() {},
    querySelector: () => null, querySelectorAll: () => [],
  }
}

/**
 * Evaluate the bundle in a fresh VM context with a stubbed DOM.
 *
 * @param readyState `document.readyState`. `'loading'` makes the bundle
 *   defer init to a DOMContentLoaded listener; anything else makes it boot
 *   immediately (the dynamic-injection path admin.js actually hits).
 * @param tolerantDom when true, getElementById/querySelector return a
 *   permissive fake element so the immediate boot can run its synchronous
 *   prefix; when false they return null (fine for the deferred path, which
 *   never touches the DOM at eval time).
 */
function runBundle(opts: { readyState?: string; tolerantDom?: boolean } = {}): RunResult {
  const aipeHub: Record<string, unknown> = {}
  for (const h of AIPEHUB_HELPERS) aipeHub[h] = () => {}
  // `$` is the selector helper resolveDom() uses to build its element
  // cache (dom.dStrategy = $('d-strategy'), ...) — must return an element.
  aipeHub.$ = () => makeEl()
  // Never-resolving so boot() suspends at its first
  // `await fetchJson('/api/whoami')` instead of dereferencing a fake
  // result. We only need to prove boot STARTED (ran setActiveTab), not
  // that the whole console finished wiring against a fake DOM.
  aipeHub.fetchJson = () => new Promise(() => {})
  aipeHub.installWorkflowAssist = () => ({ open() {}, close() {}, submit() {}, save() {} })

  const domListeners: Record<string, unknown> = {}
  // Window listeners boot registers (R14b: the `aipehub:tabchange`
  // subscription). Recording them is how we prove boot ran.
  const winListeners: Record<string, unknown> = {}
  // Shared by `window.location` and the bare `location` global the source
  // reads (logout() → window.location.href).
  const location = { hash: '', href: '' }
  const body = makeEl()
  const ctx = {
    window: {
      AipeHub: aipeHub,
      addEventListener: (type: string, cb: unknown) => { winListeners[type] = cb },
      location,
    },
    location,
    document: {
      readyState: opts.readyState,
      addEventListener: (type: string, cb: unknown) => { domListeners[type] = cb },
      getElementById: () => (opts.tolerantDom ? makeEl() : null),
      querySelector: () => (opts.tolerantDom ? makeEl() : null),
      querySelectorAll: () => [],
      createElement: () => makeEl(),
      body,
    },
    console,
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' }),
    EventSource: class { close() {} },
  }
  runInNewContext(ADMIN_JS, ctx)
  return {
    domListeners,
    winListeners,
    // R14b — admin.js no longer runs its own setActiveTab at boot; the
    // proof that boot ran is the window `aipehub:tabchange` subscription it
    // registers (before suspending on the first `await fetchJson`).
    bootRan: typeof winListeners['aipehub:tabchange'] === 'function',
  }
}

describe('static/admin.js — esbuild bundle smoke', () => {
  it('is the generated bundle (banner + strict mode + iife wrapper)', () => {
    expect(ADMIN_JS).toContain('AUTO-GENERATED by scripts/build-admin-ui.mjs')
    expect(ADMIN_JS).toContain('"use strict";')
    // esbuild stamps the entry path as a leading comment inside the IIFE.
    expect(ADMIN_JS).toContain('admin-src/main.js')
  })

  it('defers init to a DOMContentLoaded listener while the document is still loading', () => {
    let result: RunResult | undefined
    expect(() => { result = runBundle({ readyState: 'loading' }) }).not.toThrow()
    // Under 'loading' the guard registers the single init listener and has
    // not booted yet.
    expect(typeof result!.domListeners.DOMContentLoaded).toBe('function')
    expect(result!.bootRan).toBe(false)
  })

  it('boots immediately when the document is already parsed (dynamic-injection path)', () => {
    // Regression for B1/B2: app.js injects admin.js from inside its own
    // DOMContentLoaded handler — after the event already fired. A bare
    // DOMContentLoaded listener never ran, so the whole admin console was
    // dead. The readyState guard must boot init synchronously instead.
    let result: RunResult | undefined
    expect(() => { result = runBundle({ readyState: 'complete', tolerantDom: true }) }).not.toThrow()
    // init ran: boot registered its window `aipehub:tabchange` listener...
    expect(result!.bootRan).toBe(true)
    // ...and it did NOT defer to a DOMContentLoaded that would never fire.
    expect(result!.domListeners.DOMContentLoaded).toBeUndefined()
  })
})
