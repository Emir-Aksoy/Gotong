/**
 * sdui-ui-contract.test.ts — SDUI-M2 anti-rot gate.
 *
 * The renderer (static/sdui-ui.js) and the schema
 * (packages/personal-butler/src/panel-schema.ts) each carry a copy of the
 * closed component roster. Web must NOT import personal-butler (kernel-deps
 * direction), so both files are read as TEXT and the two lists are compared —
 * add a component to one side without the other and this test goes red.
 *
 * Also pins the renderer's two structural security properties at text level:
 *  - reserved zone: the registry invokes renderApprovalInbox with NO
 *    arguments, so no config entry can reach that renderer;
 *  - fixed badge: renderPanel calls renderBadge before it ever looks at the
 *    config, so no panel.json can remove or occlude the pending strip.
 *
 * SHELL-M4 added a second job: the renderer is now free-standing (it mounts in
 * a bare page via GotongPanel.mount), so the gates below also pin that it
 * carries everything it renders with — its own strings, its own stylesheet,
 * its own host element — and reaches the SPA only through mount() options.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const rendererSrc = readFileSync(
  fileURLToPath(new URL('../static/sdui-ui.js', import.meta.url)),
  'utf8',
)
const rendererCss = readFileSync(
  fileURLToPath(new URL('../static/sdui-ui.css', import.meta.url)),
  'utf8',
)
const appCoreSrc = readFileSync(
  fileURLToPath(new URL('../static/app-core.js', import.meta.url)),
  'utf8',
)
const stylesSrc = readFileSync(
  fileURLToPath(new URL('../static/styles.css', import.meta.url)),
  'utf8',
)
const standaloneSrc = readFileSync(
  fileURLToPath(new URL('../static/sdui-standalone.html', import.meta.url)),
  'utf8',
)
const standaloneBootSrc = readFileSync(
  fileURLToPath(new URL('../static/sdui-standalone.js', import.meta.url)),
  'utf8',
)
const schemaSrc = readFileSync(
  fileURLToPath(new URL('../../personal-butler/src/panel-schema.ts', import.meta.url)),
  'utf8',
)

/**
 * Drops whole-line comments. Same principle as the innerHTML gate below:
 * prose may SAY `document.getElementById`, code may not — the header comment
 * documents the mount() call site on purpose.
 */
function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter((line) => {
      const t = line.trim()
      return !(t.startsWith('*') || t.startsWith('//') || t.startsWith('/*'))
    })
    .join('\n')
}

/** Keys declared in one language block of the renderer's STRINGS table. */
function stringKeys(lang: 'zh' | 'en'): Set<string> {
  const open = rendererSrc.indexOf(`    ${lang}: {`)
  expect(open, `STRINGS.${lang} block not found`).toBeGreaterThanOrEqual(0)
  const close = rendererSrc.indexOf('\n    },', open)
  expect(close, `STRINGS.${lang} block not closed`).toBeGreaterThan(open)
  const body = rendererSrc.slice(open, close)
  return new Set([...body.matchAll(/^ {6}([A-Za-z0-9_]+):/gm)].map((m) => m[1]!))
}

/** Extracts the quoted string items of the first `NAME = [ ... ]` literal. */
function extractArray(src: string, name: string): string[] {
  const start = src.indexOf(`${name} = [`)
  expect(start, `${name} array literal not found`).toBeGreaterThanOrEqual(0)
  const open = src.indexOf('[', start)
  const close = src.indexOf(']', open)
  expect(close, `${name} array literal not closed`).toBeGreaterThan(open)
  const body = src.slice(open + 1, close)
  const items: string[] = []
  const re = /'([^']+)'/g
  let m: RegExpExecArray | null
  while ((m = re.exec(body)) !== null) items.push(m[1]!)
  return items
}

describe('sdui-ui.js ↔ panel-schema.ts contract', () => {
  // REPO HYGIENE, not a protocol requirement. In-repo the renderer really does
  // ship inside the hub, so a roster that drifts is a bug. SHELL-M3 made the
  // PROTOCOL stop depending on this equality (that is what the schemaVersion
  // handshake below is for) — a released shell may legitimately carry an older
  // roster. This check keeps the two copies in THIS artifact honest.
  it('KNOWN_TYPES mirrors PANEL_COMPONENT_TYPES exactly (order included)', () => {
    const rendererTypes = extractArray(rendererSrc, 'var KNOWN_TYPES')
    const schemaTypes = extractArray(schemaSrc, 'export const PANEL_COMPONENT_TYPES')
    expect(rendererTypes.length).toBeGreaterThan(0)
    expect(rendererTypes).toEqual(schemaTypes)
  })

  // SHELL-M3 — the image-card class of bug: a type listed as KNOWN with no
  // renderer validates fine, renders 「即将上线」 forever, and gets advertised
  // to the butler as usable. Staging a type one commit ahead of its renderer
  // is legitimate, so this gate forces that to be a DELIBERATE act rather than
  // something that quietly survives a release.
  it('every KNOWN_TYPE has a real renderer in the registry (no ghost components)', () => {
    const registryStart = rendererSrc.indexOf('var REGISTRY = {')
    expect(registryStart).toBeGreaterThanOrEqual(0)
    const registrySrc = rendererSrc.slice(registryStart)
    for (const type of extractArray(rendererSrc, 'var KNOWN_TYPES')) {
      // Registry keys appear either quoted ('approval-inbox':) or bare (chat:).
      const declared =
        registrySrc.includes(`'${type}':`) || new RegExp(`\\n    ${type}:`).test(registrySrc)
      expect(declared, `registry entry for KNOWN_TYPE '${type}'`).toBe(true)
    }
  })

  // SHELL-M3 — the renderer declares which schema it speaks, and the hub
  // answers with a verdict. In-repo the two versions must match (they ship in
  // one artifact); the mechanism's real job starts when a released shell
  // freezes its number while the hub moves on.
  it('the renderer declares a schemaVersion and it matches the hub schema', () => {
    const declared = /var CLIENT_SCHEMA_VERSION = (\d+)/.exec(rendererSrc)
    expect(declared, 'CLIENT_SCHEMA_VERSION not found in the renderer').not.toBeNull()
    const server = /export const PANEL_SCHEMA_VERSION = (\d+)/.exec(schemaSrc)
    expect(server, 'PANEL_SCHEMA_VERSION not found in the schema').not.toBeNull()
    expect(declared![1]).toBe(server![1])
    // …and it actually goes on the wire, not just sits in a constant.
    expect(rendererSrc).toContain("'/api/me/panel?client=' + CLIENT_SCHEMA_VERSION")
  })

  // SHELL-M3 — a schema newer than this build must NOT be rendered
  // best-effort: fields we know by name may have changed meaning. The badge
  // (fixed) and the shape picker (the way out) must survive the downgrade —
  // a version mismatch must never become a way to hide the pending strip.
  it('an outdated client degrades the WHOLE panel, keeping the badge and a way out', () => {
    const fnStart = rendererSrc.indexOf('function renderPanel')
    expect(fnStart).toBeGreaterThanOrEqual(0)
    const body = rendererSrc.slice(fnStart)
    const badge = body.indexOf('renderBadge(host)')
    const downgrade = body.indexOf("contract.verdict === 'client_outdated'")
    const configRead = body.indexOf('data.config')
    expect(downgrade).toBeGreaterThanOrEqual(0)
    // Badge first, downgrade decision second, config only if we got past it.
    expect(badge).toBeLessThan(downgrade)
    expect(downgrade).toBeLessThan(configRead)
    // The branch itself: loud notice + shape picker + stop.
    const branch = body.slice(downgrade, configRead)
    expect(branch).toContain('sduiClientOutdated')
    expect(branch).toContain('renderShapeSection(host, data.source)')
    expect(branch).toContain('return')
  })

  it('every reserved-zone type has a real renderer (never a placeholder card)', () => {
    const reserved = extractArray(schemaSrc, 'export const PANEL_RESERVED_TYPES')
    expect(reserved).toContain('approval-inbox')
    for (const type of reserved) {
      // Registry keys are quoted in the renderer ('approval-inbox': ...).
      expect(rendererSrc).toContain(`'${type}':`)
    }
  })

  it('reserved zone: approval-inbox renderer is invoked with NO config argument', () => {
    // The registry entry must call renderApprovalInbox() bare — passing the
    // component object would hand the config a surface into the reserved zone.
    expect(rendererSrc).toMatch(/'approval-inbox':\s*function \(\) \{ return renderApprovalInbox\(\) \}/)
    expect(rendererSrc).toContain('function renderApprovalInbox()')
  })

  it('fixed badge: renderPanel renders the badge before touching the config', () => {
    const fnStart = rendererSrc.indexOf('function renderPanel')
    expect(fnStart).toBeGreaterThanOrEqual(0)
    const badgeCall = rendererSrc.indexOf('renderBadge(host)', fnStart)
    const configRead = rendererSrc.indexOf('data.config', fnStart)
    expect(badgeCall).toBeGreaterThanOrEqual(0)
    expect(configRead).toBeGreaterThanOrEqual(0)
    expect(badgeCall).toBeLessThan(configRead)
  })

  it('unknown types degrade to a placeholder card (never crash, never blank)', () => {
    expect(rendererSrc).toContain('sduiUnknownComponent')
    expect(rendererSrc).toContain('sduiComingSoon')
  })

  // SDUI butler priority — chat discovery must prefer the SERVER-computed
  // isButler row; the first chat-capable row is only the fallback. With a
  // multi-chat hub (双脑: 接待 + 专家) rows[0]-order luck must never decide
  // which agent fronts the member's panel chat.
  it('chat discovery prefers the isButler row over the first chat-capable row', () => {
    expect(rendererSrc).toContain("isButler === true")
    // The pick: pinned → butler or nothing; default → butler first, then the
    // first chat row. Pinning the expression keeps the priority un-reorderable.
    expect(rendererSrc).toMatch(/butlerOnly \? found\.butler : \(found\.butler \|\| found\.chat\)/)
  })

  it("source 'chat.butler' pins to the butler with an honest no-butler state, no fallback", () => {
    // Renderer honors the ONE whitelisted chat source from the schema…
    expect(rendererSrc).toContain("component.source === 'chat.butler'")
    // …and the schema still whitelists exactly that literal for chat.
    expect(schemaSrc).toMatch(/chat:\s*\{\s*source:\s*'optional',\s*sources:\s*\['chat\.butler'\]/)
    // Butler-less hub + pinned chat = dedicated honest placeholder, not the
    // generic no-agent copy and never a substitute row.
    expect(rendererSrc).toContain('sduiChatNoButler')
  })

  // C1-b — every action verb the SCHEMA whitelists must have a renderer
  // branch. A verb added to panel-schema without one here would validate fine
  // yet render nothing (renderQuickActions skips unknown strings) — a valid
  // config silently losing a button is exactly the rot this pins.
  it('every whitelisted quick-action verb has a renderer branch', () => {
    for (const verb of extractArray(schemaSrc, 'export const PANEL_FIXED_ACTIONS')) {
      expect(rendererSrc, `renderer branch for action '${verb}'`).toContain(`a === '${verb}'`)
    }
    for (const prefix of extractArray(schemaSrc, 'export const PANEL_ACTION_PREFIXES')) {
      expect(rendererSrc, `renderer branch for prefix '${prefix}'`).toContain(`a.indexOf('${prefix}') === 0`)
    }
  })

  // C1-c — butler-written markdown reaches the DOM exclusively through
  // textContent/createTextNode. One `innerHTML =` anywhere in the renderer
  // would turn a compromised butler's display file into an XSS vector; this
  // pins the whole file, not just the markdown path (comments may SAY the
  // words, assignment may not).
  it('the renderer never assigns innerHTML/outerHTML (safe-markdown discipline)', () => {
    expect(rendererSrc).not.toMatch(/\.(inner|outer)HTML\s*=/)
    expect(rendererSrc).not.toMatch(/insertAdjacentHTML/)
  })

  // C1-c — every schema source prefix family must have a relay/reader in the
  // renderer: `content:` cards read the file named by the suffix, `connector:`
  // cards read the `connector.<slot>` relay file. A prefix added to the schema
  // without a renderer path = valid config rendering a dead card forever.
  it("both schema source prefix families ('content:'/'connector:') have renderer readers", () => {
    for (const prefix of extractArray(schemaSrc, 'export const PANEL_SOURCE_PREFIXES')) {
      expect(rendererSrc, `renderer reader for source prefix '${prefix}'`).toContain(`'${prefix}'`)
    }
    // The relay file convention itself (connector:<slot> → connector.<slot>).
    expect(rendererSrc).toContain("'connector.'")
  })

  // ── SHELL-M4: the renderer stands on its own ────────────────────────────
  //
  // This exact bug already shipped once: `sduiShapeInstallBtn` went out with
  // no app-core.js key and the install button rendered its raw key name. Back
  // then the strings lived in a DIFFERENT file from the code that used them,
  // so nothing could check them together. Now they are one file — and this
  // gate is the reason moving them was a cut, not a duplication.
  it('every sdui* string the renderer names resolves in BOTH languages', () => {
    const zh = stringKeys('zh')
    const en = stringKeys('en')
    expect(zh.size).toBeGreaterThan(50)
    const used = new Set([...rendererSrc.matchAll(/'(sdui[A-Za-z0-9_]*)'/g)].map((m) => m[1]!))
    expect(used.size).toBeGreaterThan(50)
    for (const key of used) {
      expect(zh.has(key), `zh copy for '${key}'`).toBe(true)
      expect(en.has(key), `en copy for '${key}'`).toBe(true)
    }
    // …and the reverse, same reasoning as the ghost-component gate: a key with
    // no caller is a promise nobody keeps, and it rots quietly.
    for (const key of zh) expect(used.has(key), `'${key}' is declared but never used`).toBe(true)
    expect([...zh].sort()).toEqual([...en].sort())
  })

  it('the host SPA no longer carries a second copy of the sdui strings', () => {
    // Two copies is how the raw-key bug became possible. One file owns them.
    expect(appCoreSrc).not.toMatch(/^\s+sdui[A-Za-z0-9_]*:/m)
  })

  it('the renderer stylesheet was CUT out of styles.css, not copied', () => {
    expect(rendererCss).toMatch(/\.sdui-card\b/)
    // A single `sdui` anywhere in the SPA stylesheet means the two copies are
    // back and can drift — which class wins would then depend on load order.
    expect(stylesSrc).not.toMatch(/sdui/)
  })

  it('the renderer only ever names its own classes (no host-SPA CSS reach-in)', () => {
    // Every class literal it writes into the DOM must be sdui-*, or mounting
    // in a page without styles.css would silently lose styling.
    const classLiterals = [
      ...rendererSrc.matchAll(/(?:className\s*=|classList\.add\(|classList\.remove\()\s*'([^']+)'/g),
      // The el(tag, cls, text) helper is how most nodes get their class.
      ...rendererSrc.matchAll(/\bel\('[a-z0-9]+',\s*'([^']+)'/g),
    ].map((m) => m[1]!)
    expect(classLiterals.length).toBeGreaterThan(40)
    for (const literal of classLiterals) {
      for (const cls of literal.split(/\s+/).filter(Boolean)) {
        expect(cls.startsWith('sdui-'), `class '${cls}' is not the renderer's own`).toBe(true)
      }
    }
  })

  it('the SPA autoboot is the FIRST CALLER of mount(), not a privileged side door', () => {
    // If the SPA reached past mount() into internals, every page load and every
    // browser test would exercise a path the shell can never take — and the
    // bare-page path would only be covered by this file. Keeping the SPA on the
    // public API means the shell's path is the one already being exercised.
    const bootAt = rendererSrc.indexOf('function boot()')
    expect(bootAt).toBeGreaterThanOrEqual(0)
    const boot = rendererSrc.slice(bootAt)
    expect(boot).toMatch(/mount\(\{/)
    // The five injection points must be options, not globals reached from the
    // render path. `window.Gotong` may appear ONLY inside boot() (the glue).
    const beforeBoot = codeOnly(rendererSrc.slice(0, bootAt))
    // (window.GotongPanel is the renderer's OWN export, hence the negative
    // lookahead — what must not appear is a reach into the host SPA.)
    expect(/window\.Gotong(?!Panel)/.test(beforeBoot)).toBe(false)
    expect(beforeBoot.includes('document.body')).toBe(false)
    expect(beforeBoot.includes('getElementById')).toBe(false)
    for (const opt of ['host', 'lang', 'gotoHome', 'storageKey']) {
      expect(rendererSrc, `mount() must accept opts.${opt}`).toContain(`o.${opt}`)
    }
    expect(rendererSrc).toContain('window.GotongPanel')
  })

  it('the bare-HTML page proves the mount contract with none of the SPA', () => {
    // The executable form of the acceptance criterion. If someone “fixes” this
    // page by pulling in styles.css/app-core.js, the proof evaporates — so the
    // absence is the assertion.
    expect(standaloneBootSrc).toContain('GotongPanel.mount(')
    expect(standaloneSrc).toContain('/sdui-standalone.js')
    expect(standaloneSrc).toContain('/sdui-ui.css')
    // The bootstrap must stay in a FILE. The hub serves `script-src 'self'`
    // (no 'unsafe-inline'), so an inline block is silently never executed —
    // found the hard way, and the native shell will be at least as strict.
    expect(standaloneSrc).not.toMatch(/<script>/)
    // M2's choke point still decides which hub — the shell needs exactly this.
    expect(standaloneSrc).toContain('/hub-target.js')
    expect(standaloneSrc).not.toContain('/styles.css')
    expect(standaloneSrc).not.toContain('/app-core.js')
    expect(standaloneSrc).not.toContain('/app.js')
    // A host element that is NOT #sdui-panel, so the autoboot is provably
    // inert here and the panel on screen came from the mount() call.
    expect(standaloneSrc).not.toContain('id="sdui-panel"')
  })

  // ── POLISH-M1: tokens + scale + theme ───────────────────────────────────

  // A scale tier the schema validates but no stylesheet implements would be a
  // valid config that changes nothing — the image-card class of rot, for
  // sizing. Every non-default tier must exist in all three places: schema
  // enum, renderer stamp, stylesheet token block.
  it('every schema scale tier has a renderer stamp and a stylesheet block', () => {
    const scales = extractArray(schemaSrc, 'export const PANEL_SCALES')
    expect(scales[0]).toBe('default')
    expect(scales.length).toBeGreaterThan(1)
    for (const tier of scales.slice(1)) {
      expect(rendererSrc, `renderer stamp for scale '${tier}'`).toContain(`'${tier}'`)
      expect(rendererCss, `stylesheet block for scale '${tier}'`).toContain(
        `[data-sdui-scale="${tier}"]`,
      )
    }
    // The stamp mechanism itself, and the token scope it depends on.
    expect(rendererSrc).toContain("host.setAttribute('data-sdui-scale'")
    expect(rendererSrc).toContain("classList.add('sdui-root')")
    expect(rendererCss).toMatch(/\.sdui-root\s*\{/)
    // Downgrade discipline: a stale attribute must be cleared before the
    // config is read, and the stamp may only happen after it — renderPanel
    // must not read scale from a schema it does not speak.
    const fnStart = rendererSrc.indexOf('function renderPanel')
    const clear = rendererSrc.indexOf("removeAttribute('data-sdui-scale')", fnStart)
    const stamp = rendererSrc.indexOf("setAttribute('data-sdui-scale'", fnStart)
    const configRead = rendererSrc.indexOf('data.config', fnStart)
    expect(clear).toBeGreaterThanOrEqual(0)
    expect(clear).toBeLessThan(configRead)
    expect(stamp).toBeGreaterThan(configRead)
  })

  it('the light theme is HOST-opt-in (mount option), and the config cannot reach it', () => {
    // Stylesheet carries the override block; mount() is the only writer.
    expect(rendererCss).toContain('[data-sdui-theme="light"]')
    expect(rendererSrc).toContain("o.theme === 'light'")
    // The light-chromed standalone page is the first real consumer — without
    // this the dark-hardcoded bubbles were nearly unreadable there.
    expect(standaloneBootSrc).toContain("theme: 'light'")
    // The SPA's content area is ALSO light chrome (white body under a dark
    // site header) — its autoboot must declare that, or dark-default tokens
    // paint invisible cards and washed-out muted text on the white page.
    const bootStart = rendererSrc.indexOf('function boot()')
    expect(bootStart).toBeGreaterThan(-1)
    expect(rendererSrc.slice(bootStart)).toContain("theme: 'light'")
    // renderPanel never touches the theme attribute: theme is host chrome,
    // not per-render state, and must never come from data.config.
    const fnStart = rendererSrc.indexOf('function renderPanel')
    const fnEnd = rendererSrc.indexOf('\n  }', rendererSrc.indexOf('renderShapeSection(host, data.source)', fnStart))
    expect(rendererSrc.slice(fnStart, fnEnd)).not.toContain('data-sdui-theme')
  })

  // ---- POLISH-M2: state blocks + icon registry ------------------------------

  it('every icon-name call site names a real ICON_PATHS entry — both ways', () => {
    const tableStart = rendererSrc.indexOf('var ICON_PATHS = {')
    expect(tableStart).toBeGreaterThan(-1)
    const tableSrc = rendererSrc.slice(tableStart, rendererSrc.indexOf('\n  }', tableStart))
    const declared = new Set([...tableSrc.matchAll(/^ {4}([a-z-]+):/gm)].map((m) => m[1]))
    expect(declared.size).toBeGreaterThan(0)
    // Call sites: direct svgIcon / emptyState / stateBlock literals, plus the
    // relayCard scaffold's 4th positional arg (its emptyIcon).
    const used = [
      ...rendererSrc.matchAll(/svgIcon\('([a-z-]+)'\)/g),
      ...rendererSrc.matchAll(/emptyState\('([a-z-]+)'/g),
      ...rendererSrc.matchAll(/stateBlock\('[a-z]+', '([a-z-]+)'/g),
      ...rendererSrc.matchAll(/relayCard\('[^']*', [^,]*, '[A-Za-z]*', '([a-z-]+)'/g),
    ].map((m) => m[1])
    expect(used.length).toBeGreaterThan(0)
    for (const name of used) {
      expect(declared.has(name), `icon '${name}' used but not in ICON_PATHS`).toBe(true)
    }
    // Reverse: an icon nobody renders is dead weight that will silently rot.
    for (const name of declared) {
      expect(used.includes(name), `icon '${name}' declared but never used`).toBe(true)
    }
  })

  it('the shimmer animation ships with a prefers-reduced-motion guard', () => {
    expect(rendererCss).toContain('@keyframes sdui-shimmer')
    const reduce = rendererCss.indexOf('prefers-reduced-motion: reduce')
    expect(reduce).toBeGreaterThan(-1)
    expect(rendererCss.slice(reduce)).toContain('animation: none')
  })

  it('skeleton loading pairs aria-busy set/remove (screen readers see the load)', () => {
    const skel = rendererSrc.indexOf('function skeletonInto')
    const settle = rendererSrc.indexOf('function settleBody')
    expect(skel).toBeGreaterThan(-1)
    expect(settle).toBeGreaterThan(skel)
    expect(rendererSrc.slice(skel, settle)).toContain("setAttribute('aria-busy'")
    expect(rendererSrc.slice(settle)).toContain("removeAttribute('aria-busy')")
  })
})
