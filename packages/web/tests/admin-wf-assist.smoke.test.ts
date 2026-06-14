/**
 * Headless smoke for `static/admin-wf-assist.js` — the factory module
 * extracted from `admin.js` as part of the P3 audit cleanup.
 *
 * # Why this exists
 *
 * The browser-side IIFE has a 3-file contract that no other test sees:
 *
 *   1. admin-wf-assist.js exports `window.AipeHub.installWorkflowAssist`
 *   2. admin.js calls that factory with a bag of {dom, state, ma, wf,
 *      refreshWorkflows} closure refs and consumes the returned
 *      {open, close, submit, save}
 *   3. app.html declares all 17 `wf-assist-*` DOM ids the factory
 *      reaches into via dom.wfAssist* members
 *
 * Server-side route tests can't catch a regression here — neither can
 * `node --check`. This smoke pulls the static file off disk, runs it
 * in a fresh `vm` context with a tiny hand-rolled DOM fake, and walks
 * the open → submit → save → close lifecycle end-to-end. If anyone
 * renames a dom ref, breaks the factory shape, or stops calling
 * `refreshWorkflows()` after save, one of these eleven checks fails.
 *
 * The DOM fake is minimal on purpose — the factory only ever touches
 * textContent / hidden / disabled / dataset / classList / style /
 * innerHTML / appendChild / children / scrollTop / scrollHeight /
 * value / focus, all simple props. Pulling jsdom into devDeps for a
 * single smoke would cost ~10MB and 50+ transitive packages.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const WF_ASSIST_JS = readFileSync(
  join(HERE, '..', 'static', 'admin-wf-assist.js'),
  'utf8',
)
const APP_HTML = readFileSync(join(HERE, '..', 'static', 'app.html'), 'utf8')
const APP_CORE_JS = readFileSync(join(HERE, '..', 'static', 'app-core.js'), 'utf8')

// The factory now reads its user-facing strings from the live i18n dict
// (`window.AipeHub.t`) and re-renders on `window.AipeHub.onLangChange` —
// both provided in production by app-core.js. Pull the real `I18N.zh`
// off disk and inject it so this headless smoke exercises the true
// render path (and its Chinese-text assertions stay meaningful) instead
// of a hollow stub. Default language is zh, matching app-core.js.
function extractI18nZh(): Record<string, unknown> {
  const start = APP_CORE_JS.indexOf('const I18N = {')
  let i = APP_CORE_JS.indexOf('{', start)
  let depth = 0
  let end = -1
  for (; i < APP_CORE_JS.length; i++) {
    const c = APP_CORE_JS[i]
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) { end = i; break }
    }
  }
  const literal = APP_CORE_JS.slice(APP_CORE_JS.indexOf('{', start), end + 1)
  // eslint-disable-next-line no-eval
  const I18N = (0, eval)('(' + literal + ')') as { zh: Record<string, unknown> }
  return I18N.zh
}
const I18N_ZH = extractI18nZh()

// ---------------------------------------------------------------------------
// Hand-rolled minimal DOM. Each created node returns an object with just
// the properties admin-wf-assist.js actually touches.
// ---------------------------------------------------------------------------

type FakeEl = {
  tag: string
  hidden: boolean
  open: boolean
  disabled: boolean
  textContent: string
  innerHTML: string
  value: string
  scrollTop: number
  scrollHeight: number
  dataset: Record<string, string>
  classList: {
    _set: Set<string>
    add(...c: string[]): void
    remove(...c: string[]): void
    contains(c: string): boolean
  }
  style: Record<string, string>
  children: FakeEl[]
  files: unknown[]
  appendChild(child: FakeEl): FakeEl
  focus(): void
}

function makeElement(tag = 'div'): FakeEl {
  return {
    tag,
    hidden: true,
    open: false,
    disabled: false,
    textContent: '',
    innerHTML: '',
    value: '',
    scrollTop: 0,
    scrollHeight: 100,
    dataset: {},
    classList: {
      _set: new Set<string>(),
      add(...c) { c.forEach((x) => this._set.add(x)) },
      remove(...c) { c.forEach((x) => this._set.delete(x)) },
      contains(c) { return this._set.has(c) },
    },
    style: {},
    children: [],
    files: [],
    appendChild(child) { this.children.push(child); return child },
    focus() { /* noop */ },
  }
}

// Boot the factory file in a fresh vm context. Returns the
// installWorkflowAssist function that the file registers on window.AipeHub.
function loadFactory(): (deps: unknown) => {
  open: () => void
  close: () => void
  submit: () => Promise<void>
  save: () => Promise<void>
} {
  const fakeWindow: { AipeHub: Record<string, unknown> } = {
    AipeHub: { t: I18N_ZH, onLangChange: () => {} },
  }
  const ctx = {
    window: fakeWindow,
    document: {
      createElement: (tag: string) => makeElement(tag),
      createTextNode: (text: string) => ({ textContent: text }),
    },
    setTimeout: (fn: () => void) => fn(),
    console,
  }
  runInNewContext(WF_ASSIST_JS, ctx)
  const install = fakeWindow.AipeHub.installWorkflowAssist as (
    deps: unknown,
  ) => ReturnType<ReturnType<typeof loadFactory>>
  if (typeof install !== 'function') {
    throw new Error('installWorkflowAssist not registered on window.AipeHub')
  }
  return install as never
}

// Shape that matches what admin.js's `$('wf-assist-...')` resolves to.
function buildDomBag(): Record<string, FakeEl> {
  const keys = [
    'wfAssistModal', 'wfAssistDescription', 'wfAssistGenerate', 'wfAssistMsg',
    'wfAssistResult', 'wfAssistStatusChip', 'wfAssistExplanation', 'wfAssistYaml',
    'wfAssistErrorDetails', 'wfAssistValidationError', 'wfAssistDeepcheckDetails',
    'wfAssistDeepcheckSummary', 'wfAssistDeepcheckList', 'wfAssistStreaming',
    'wfAssistStreamingText', 'wfAssistStreamingMeta', 'wfAssistSave',
  ]
  const dom: Record<string, FakeEl> = {}
  for (const k of keys) dom[k] = makeElement()
  return dom
}

// ---------------------------------------------------------------------------
// Stage 0 — sanity: every dom.wfAssist* ref the factory uses has a
// matching `id="..."` in app.html. If anyone renames an id without
// updating both files, this fails before we even instantiate.
// ---------------------------------------------------------------------------

describe('admin-wf-assist.js — DOM ID wiring', () => {
  it('every wfAssist* ref the factory uses has a matching id in app.html', () => {
    const refs = new Set<string>()
    // grep for `dom.wfAssist<Word>`
    for (const m of WF_ASSIST_JS.matchAll(/dom\.(wfAssist[A-Za-z]+)/g)) {
      refs.add(m[1]!)
    }
    expect(refs.size).toBeGreaterThanOrEqual(15)
    // Convention: dom.wfAssistFooBar resolves $('wf-assist-foo-bar'). Build the
    // expected id from the camelCase suffix.
    for (const ref of refs) {
      const suffix = ref.slice('wfAssist'.length) // "Modal" / "StreamingText" / ...
      const id = 'wf-assist-' + suffix
        .replace(/([a-z])([A-Z])/g, '$1-$2')
        .toLowerCase()
      const expected = `id="${id}"`
      expect(APP_HTML, `app.html missing ${expected} for dom.${ref}`)
        .toContain(expected)
    }
  })
})

// ---------------------------------------------------------------------------
// Stage 1 — lifecycle: walk open → submit → save → close end to end.
// ---------------------------------------------------------------------------

describe('admin-wf-assist.js — factory lifecycle', () => {
  function setup() {
    const install = loadFactory()
    const dom = buildDomBag()
    const state: { assistWatcher: unknown } = { assistWatcher: null }
    const ma = {
      agents: [
        { id: 'writer', capabilities: ['chat'] },
        { id: 'reviewer', capabilities: ['review'] },
      ],
    }
    const wf = { workflows: [{ id: 'existing-wf' }] }
    let refreshCalls = 0
    const refreshWorkflows = async (): Promise<void> => { refreshCalls++ }

    const fetchCalls: Array<{ url: string; method?: string; body?: string }> = []
    const mockFetch = async (url: string, opts?: { method?: string; body?: string }) => {
      fetchCalls.push({ url, method: opts?.method, body: opts?.body })
      if (url === '/api/admin/workflows/assist') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            yaml: 'schema: aipehub.workflow/v1\nworkflow:\n  id: smoke-out\n',
            explanation: 'smoke explanation',
            raw: 'raw text',
            draftStatus: 'valid',
            deepCheck: {
              ok: false,
              violations: [
                { kind: 'unknown_capability', message: 'no agent has cap c', path: '$.steps[0]' },
              ],
            },
          }),
        }
      }
      if (url === '/api/admin/workflows/import') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, workflow: { id: 'smoke-out' } }),
        }
      }
      return { ok: false, status: 404, json: async () => ({}) }
    }

    const wfAssist = install({
      dom, state, ma, wf, refreshWorkflows, fetch: mockFetch,
    })
    return { wfAssist, dom, state, ma, wf, fetchCalls, getRefreshCalls: () => refreshCalls }
  }

  it('factory returns {open, close, submit, save}', () => {
    const { wfAssist } = setup()
    expect(typeof wfAssist.open).toBe('function')
    expect(typeof wfAssist.close).toBe('function')
    expect(typeof wfAssist.submit).toBe('function')
    expect(typeof wfAssist.save).toBe('function')
  })

  it('open() unhides modal, hides result, disables save', () => {
    const { wfAssist, dom } = setup()
    wfAssist.open()
    expect(dom.wfAssistModal!.hidden).toBe(false)
    expect(dom.wfAssistResult!.hidden).toBe(true)
    expect(dom.wfAssistSave!.disabled).toBe(true)
  })

  it('submit() with empty description shows inline error, fires no fetch', async () => {
    const { wfAssist, dom, fetchCalls } = setup()
    dom.wfAssistDescription!.value = ''
    await wfAssist.submit()
    expect(fetchCalls).toHaveLength(0)
    expect(dom.wfAssistMsg!.textContent).toContain('请先填')
  })

  it('submit() with real description POSTs /assist with contextHints from ma + wf', async () => {
    const { wfAssist, dom, fetchCalls } = setup()
    dom.wfAssistDescription!.value = 'A workflow that drafts and reviews'
    await wfAssist.submit()
    expect(fetchCalls).toHaveLength(1)
    const call = fetchCalls[0]!
    expect(call.url).toBe('/api/admin/workflows/assist')
    expect(call.method).toBe('POST')
    const body = JSON.parse(call.body ?? '{}') as {
      description: string
      contextHints?: {
        agents?: Array<{ id: string; capabilities: string[] }>
        existingWorkflowIds?: string[]
      }
    }
    expect(body.description).toBe('A workflow that drafts and reviews')
    expect(body.contextHints?.agents).toHaveLength(2)
    expect(body.contextHints?.existingWorkflowIds).toContain('existing-wf')
  })

  it('post-submit: save button enabled with yaml cached on dataset', async () => {
    const { wfAssist, dom } = setup()
    dom.wfAssistDescription!.value = 'demo'
    await wfAssist.submit()
    expect(dom.wfAssistSave!.disabled).toBe(false)
    expect(dom.wfAssistSave!.dataset.yaml).toContain('smoke-out')
  })

  it('deepCheck.ok=false renders yellow chip + violation list', async () => {
    const { wfAssist, dom } = setup()
    dom.wfAssistDescription!.value = 'demo'
    await wfAssist.submit()
    expect(dom.wfAssistStatusChip!.textContent).toContain('深度警告')
    // M4 spec: yellow bg (#fef3c7) for valid-but-deep-check-failed
    expect(dom.wfAssistStatusChip!.style.background).toBe('#fef3c7')
    expect(dom.wfAssistDeepcheckList!.children).toHaveLength(1)
  })

  it('watcher is cleared after submit() resolves', async () => {
    const { wfAssist, dom, state } = setup()
    dom.wfAssistDescription!.value = 'demo'
    await wfAssist.submit()
    expect(state.assistWatcher).toBeNull()
  })

  it('save() POSTs cached yaml to /import and calls refreshWorkflows once', async () => {
    const { wfAssist, dom, fetchCalls, getRefreshCalls } = setup()
    dom.wfAssistDescription!.value = 'demo'
    await wfAssist.submit()
    await wfAssist.save()
    const importCall = fetchCalls.find((c) => c.url === '/api/admin/workflows/import')
    expect(importCall).toBeDefined()
    expect(importCall!.body).toBe(dom.wfAssistSave!.dataset.yaml)
    expect(getRefreshCalls()).toBe(1)
  })

  it('close() hides modal and clears the watcher', () => {
    const { wfAssist, dom, state } = setup()
    wfAssist.open()
    state.assistWatcher = { taskId: 'leaked' } // simulate a leaked watcher
    wfAssist.close()
    expect(dom.wfAssistModal!.hidden).toBe(true)
    expect(state.assistWatcher).toBeNull()
  })
})
