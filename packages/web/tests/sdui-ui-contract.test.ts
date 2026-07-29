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
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const rendererSrc = readFileSync(
  fileURLToPath(new URL('../static/sdui-ui.js', import.meta.url)),
  'utf8',
)
const schemaSrc = readFileSync(
  fileURLToPath(new URL('../../personal-butler/src/panel-schema.ts', import.meta.url)),
  'utf8',
)

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
})
