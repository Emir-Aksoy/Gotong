/**
 * Anti-rot acceptance gate for the embedded template GALLERY (G-M1).
 *
 * `src/builtin-templates.ts` is GENERATED from a curated list of shipped
 * template manifests under examples (scripts/build-builtin-templates.mjs).
 * The single source of truth stays in examples/ (模版与框架分离); the generated
 * file is a derived, embedded copy so the gallery works without filesystem
 * access in a production binary.
 *
 * This test re-parses EVERY embedded manifest through the REAL `parseTemplate`
 * — the same parser the install route runs. So if a curated example changes
 * shape (or the generator embeds a broken copy), the gallery can't silently
 * ship a manifest that would blow up on one-click install: the drift surfaces
 * here, loudly.
 *
 * It asserts STRUCTURE only (schema/name/arrays), never "non-empty agents":
 * `child-desk` deliberately ships ZERO agents (零订阅 — the child hub has no
 * LLM subscription of its own; it calls the parent's), so a universal
 * agents.length > 0 would be wrong.
 */

import { describe, expect, it } from 'vitest'

import { BUILTIN_TEMPLATES } from '../src/builtin-templates.js'
import { parseTemplate } from '../src/template-manifest.js'

// The curated gallery — the exact set the generator embeds, in display order.
// Pinning the ids here makes "someone quietly added/removed a gallery entry"
// a visible test diff, not a surprise in the UI.
const EXPECTED_IDS = [
  'personal-coding-hub',
  'codex-deepseek-hub',
  'personal-research-hub',
  'morning-brief-hub',
  'battle-monk-training',
  'smart-home-hub',
  'cafe-ops',
  'warband-club',
  'tea-supply-link',
  'tea-chain-hq',
  'family-tutor',
  'child-desk',
]

describe('builtin template gallery (G-M1)', () => {
  it('embeds exactly the curated set, in order, with unique ids', () => {
    expect(BUILTIN_TEMPLATES.map((t) => t.id)).toEqual(EXPECTED_IDS)
    expect(new Set(BUILTIN_TEMPLATES.map((t) => t.id)).size).toBe(EXPECTED_IDS.length)
  })

  it('every entry points back at an examples/ source dir', () => {
    for (const t of BUILTIN_TEMPLATES) {
      expect(t.sourceExample, `${t.id} sourceExample`).toMatch(/^examples\//)
      expect(t.yaml.length, `${t.id} yaml`).toBeGreaterThan(0)
    }
  })

  // The load-bearing assertion: each embedded manifest must be installable.
  it.each(BUILTIN_TEMPLATES.map((t) => [t.id, t] as const))(
    '%s parses through the real parseTemplate',
    (_id, t) => {
      const parsed = parseTemplate(t.yaml)
      expect(parsed.schema).toBe('aipehub.template/v1')
      expect(typeof parsed.name).toBe('string')
      expect(parsed.name.length).toBeGreaterThan(0)
      expect(typeof parsed.version).toBe('number')
      // Structure present (arrays) — NOT non-empty: child-desk ships 0 agents.
      expect(Array.isArray(parsed.agents)).toBe(true)
      expect(Array.isArray(parsed.workflows)).toBe(true)
      expect(Array.isArray(parsed.knowledgeBases)).toBe(true)
      // A gallery template must teach the hub something: at least one of
      // agents / workflows / knowledge bases. (An empty manifest installs
      // nothing — not a useful one-click.)
      expect(
        parsed.agents.length + parsed.workflows.length + parsed.knowledgeBases.length,
        `${t.id} installs nothing`,
      ).toBeGreaterThan(0)
    },
  )
})
