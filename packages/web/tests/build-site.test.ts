/**
 * Anti-corruption gate for the community storefront generator (pre-launch
 * checklist item 7).
 *
 * `scripts/build-site.mjs` renders the static landing page + template gallery +
 * citation leaderboard from the validated template corpus. Its IO shell is
 * guarded (`if (process.argv[1] === …)`) so importing the module here runs NO
 * filesystem sweep and writes NO files — only the pure helpers load, and this
 * test pins their behaviour:
 *
 *   - assignSlugs  — the public-handle scheme. This is where a real bug lived
 *     (two templates in one example dir collided on the dir basename); the
 *     uniqueness guard + group-by-dir rule below is the regression fence.
 *   - extractTemplate — reads the display surface + provenance.derivedFrom off a
 *     raw manifest, filtering junk, throwing on a manifest it can't read.
 *   - buildModel — the leaderboard core: in-degree citation count + surfacing a
 *     typo'd (unresolved) citation as a warning instead of a silent miscount.
 *   - escapeHtml / render* — a community name/description is UNTRUSTED, so it
 *     must never break out of markup. The XSS case is load-bearing.
 *
 * Deterministic by construction (no timestamp, stable sort) — these tests can
 * assert exact output.
 */

import { describe, expect, it } from 'vitest'

import {
  assignSlugs,
  buildModel,
  escapeHtml,
  extractTemplate,
  renderIndexHtml,
  renderTemplatesJson,
  teaser,
} from '../scripts/build-site.mjs'

describe('escapeHtml', () => {
  it('escapes every markup-significant character', () => {
    expect(escapeHtml(`<script>"&'</script>`)).toBe(
      '&lt;script&gt;&quot;&amp;&#39;&lt;/script&gt;',
    )
  })

  it('coerces non-strings without throwing', () => {
    expect(escapeHtml(42)).toBe('42')
    expect(escapeHtml(null)).toBe('null')
  })
})

describe('teaser', () => {
  it('takes the first paragraph, collapses whitespace', () => {
    expect(teaser('First   para\nstill first.\n\nSecond para.')).toBe('First para still first.')
  })

  it('clips at max with an ellipsis', () => {
    expect(teaser('x'.repeat(50), 10)).toBe(`${'x'.repeat(9)}…`)
  })

  it('returns empty for falsy input', () => {
    expect(teaser('')).toBe('')
    expect(teaser(undefined)).toBe('')
  })
})

describe('assignSlugs — the public-handle scheme', () => {
  it('single template in an examples/<dir> → the dir basename (NOT the filename)', () => {
    // examples/tea-supply-link ships tea-shop.template.yaml — the gallery id is
    // `tea-supply-link`, the dir, so a fork can cite it by the name everyone
    // knows.
    const [s] = assignSlugs([
      { rel: 'examples/tea-supply-link/template/tea-shop.template.yaml', origin: 'flagship' },
    ])
    expect(s.slug).toBe('tea-supply-link')
  })

  it('MULTIPLE templates in one dir → file stems disambiguate (the bug that bit)', () => {
    // examples/family-learning-hub ships BOTH family-tutor + child-desk. Naming
    // both after the dir would collide; the group-by-dir rule falls back to the
    // file stem. This is the regression that the uniqueness guard now catches.
    const out = assignSlugs([
      { rel: 'examples/family-learning-hub/template/family-tutor.template.yaml', origin: 'flagship' },
      { rel: 'examples/family-learning-hub/template/child-desk.template.yaml', origin: 'flagship' },
    ])
    expect(out.map((s) => s.slug)).toEqual(['family-tutor', 'child-desk'])
  })

  it('community files → file stem', () => {
    const [s] = assignSlugs([
      { rel: 'templates/community/templates/my-cool-template.yaml', origin: 'community' },
    ])
    expect(s.slug).toBe('my-cool-template')
  })

  it('throws (loud at build) on an ambiguous duplicate handle', () => {
    // Two community submissions whose file stems collide across subdirs — an
    // ambiguous public handle must be a build failure, never a silently
    // overwritten card / a citation pointing at the wrong template.
    expect(() =>
      assignSlugs([
        { rel: 'templates/community/templates/a/dup.yaml', origin: 'community' },
        { rel: 'templates/community/templates/b/dup.yaml', origin: 'community' },
      ]),
    ).toThrow(/duplicate template slug 'dup'/)
  })

  it('preserves input order and carries other fields through', () => {
    const out = assignSlugs([
      { rel: 'examples/a/template/a.template.yaml', origin: 'flagship', abs: '/x/a' },
      { rel: 'examples/b/template/b.template.yaml', origin: 'flagship', abs: '/x/b' },
    ])
    expect(out.map((s) => s.slug)).toEqual(['a', 'b'])
    expect(out[0].abs).toBe('/x/a')
  })
})

const MANIFEST = `schema: aipehub.template/v1
template:
  name: 测试模板
  description: |-
    第一段说明。

    第二段不该进 teaser。
  agents:
    - id: one
  workflows: []
  knowledgeBases:
    - name: kb
  defaults:
    apiKeyPrompt:
      provider: openai-compatible
  provenance:
    derivedFrom:
      - upstream-a
      - ""
      - upstream-b
    author: Alice
    notes: 传承说明
`

describe('extractTemplate', () => {
  it('reads the display surface + provenance off a real manifest', () => {
    const t = extractTemplate(MANIFEST, 'examples/x/template/x.template.yaml', 'flagship', 'x')
    expect(t).toMatchObject({
      slug: 'x',
      name: '测试模板',
      source: 'examples/x/template/x.template.yaml',
      origin: 'flagship',
      agents: 1,
      workflows: 0,
      knowledgeBases: 1,
      apiKeyPrompt: true,
      author: 'Alice',
      notes: '传承说明',
    })
    // First paragraph only.
    expect(t.description.startsWith('第一段说明。')).toBe(true)
  })

  it('filters empty/non-string derivedFrom entries', () => {
    const t = extractTemplate(MANIFEST, 'rel', 'flagship', 'x')
    expect(t.derivedFrom).toEqual(['upstream-a', 'upstream-b'])
  })

  it('defaults provenance to empty when absent (no provenance block)', () => {
    const noProv = `schema: aipehub.template/v1
template:
  name: Bare
`
    const t = extractTemplate(noProv, 'rel', 'community', 'bare')
    expect(t.derivedFrom).toEqual([])
    expect(t.author).toBe('')
    expect(t.apiKeyPrompt).toBe(false)
  })

  it('throws on a wrong/missing schema (a broken file is loud)', () => {
    expect(() => extractTemplate('schema: nope\ntemplate: {name: x}', 'rel', 'flagship', 'x')).toThrow(
      /wrong schema/,
    )
    expect(() => extractTemplate('name: orphan', 'rel', 'flagship', 'x')).toThrow(/wrong schema/)
  })
})

describe('buildModel — citation leaderboard', () => {
  const templates = [
    { slug: 'a', name: 'Aaa', origin: 'flagship', derivedFrom: [] },
    { slug: 'b', name: 'Bbb', origin: 'flagship', derivedFrom: ['a'] },
    { slug: 'c', name: 'Ccc', origin: 'community', derivedFrom: ['a', 'b'] },
    { slug: 'd', name: 'Ddd', origin: 'flagship', derivedFrom: ['ghost'] },
  ]

  it('counts inbound citations (in-degree) per slug', () => {
    const { templates: enriched } = buildModel(templates)
    const count = (s) => enriched.find((t) => t.slug === s).citationCount
    expect(count('a')).toBe(2) // cited by b and c
    expect(count('b')).toBe(1) // cited by c
    expect(count('c')).toBe(0)
    expect(count('d')).toBe(0)
  })

  it('leaderboard holds only cited templates, ranked by count', () => {
    const { leaderboard } = buildModel(templates)
    expect(leaderboard).toEqual([
      { slug: 'a', name: 'Aaa', citationCount: 2 },
      { slug: 'b', name: 'Bbb', citationCount: 1 },
    ])
  })

  it('surfaces a typo’d citation as an unresolved edge (never a silent miscount)', () => {
    const { unresolved } = buildModel(templates)
    expect(unresolved).toEqual([{ from: 'd', to: 'ghost' }])
  })

  it('sorts flagship before community, then by name (deterministic)', () => {
    const { templates: enriched } = buildModel(templates)
    expect(enriched.map((t) => t.slug)).toEqual(['a', 'b', 'd', 'c'])
  })
})

describe('render* — untrusted content stays inside markup', () => {
  // `source` is required — cardHtml derives the "view source" link from it.
  const model = buildModel([
    { slug: 'evil', name: '<script>alert(1)</script>', origin: 'flagship', derivedFrom: [], description: 'x', source: 'examples/evil/template/evil.template.yaml' },
    { slug: 'b', name: 'Bee', origin: 'flagship', derivedFrom: ['evil'], description: 'y', source: 'examples/b/template/b.template.yaml' },
  ])

  it('renderIndexHtml escapes a malicious template name', () => {
    const html = renderIndexHtml(model)
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    // The card anchor and leaderboard link both exist (citation graph rendered).
    expect(html).toContain('id="tpl-evil"')
    expect(html).toContain('href="#tpl-evil"')
  })

  it('renderTemplatesJson emits a stable, parseable feed', () => {
    const json = renderTemplatesJson(model)
    const parsed = JSON.parse(json)
    expect(parsed.schema).toBe('aipehub.site/v1')
    expect(parsed.templateCount).toBe(2)
    expect(parsed.leaderboard).toEqual([{ slug: 'evil', name: '<script>alert(1)</script>', citationCount: 1 }])
    // Deterministic: trailing newline, two-space indent.
    expect(json.endsWith('\n')).toBe(true)
  })
})
