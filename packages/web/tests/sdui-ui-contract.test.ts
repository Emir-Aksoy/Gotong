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
  it('KNOWN_TYPES mirrors PANEL_COMPONENT_TYPES exactly (order included)', () => {
    const rendererTypes = extractArray(rendererSrc, 'var KNOWN_TYPES')
    const schemaTypes = extractArray(schemaSrc, 'export const PANEL_COMPONENT_TYPES')
    expect(rendererTypes.length).toBeGreaterThan(0)
    expect(rendererTypes).toEqual(schemaTypes)
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
})
