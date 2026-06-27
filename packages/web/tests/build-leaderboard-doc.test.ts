/**
 * Anti-corruption gate for the citation leaderboard CHECKED INTO
 * docs/zh/FLAGSHIP-TEMPLATES.md.
 *
 * `scripts/build-leaderboard-doc.mjs` renders the ranking into a marked region
 * of that doc, so the leaderboard is visible in the repo itself WITHOUT anyone
 * first building + deploying the static site. Its IO shell is guarded
 * (`if (process.argv[1] === …)`), so importing the module here runs no write —
 * only the pure helpers load.
 *
 * Two kinds of test live here:
 *   - pure-fn — citedByMap / renderLeaderboardMarkdown / spliceRegion, pinned on
 *     synthetic input (deterministic by construction: no timestamp, stable sort
 *     inherited from buildModel).
 *   - DRIFT GUARD (the load-bearing one) — re-render against the REAL corpus and
 *     assert the region checked into FLAGSHIP-TEMPLATES.md matches byte-for-byte.
 *     Add a `derivedFrom` edge, rename a template, or hand-edit the table without
 *     re-running `pnpm build:leaderboard`, and this fails — named, in CI —
 *     instead of the table rotting silently while the static site moves on.
 */

import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { buildModel, loadCorpus } from '../scripts/build-site.mjs'
import {
  MARK_END,
  MARK_START,
  citedByMap,
  renderLeaderboardMarkdown,
  spliceRegion,
} from '../scripts/build-leaderboard-doc.mjs'

const DOC_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'docs',
  'zh',
  'FLAGSHIP-TEMPLATES.md',
)

describe('citedByMap — reverse derivedFrom edges', () => {
  const templates = [
    { slug: 'a', name: 'Aaa', origin: 'flagship', derivedFrom: [] },
    { slug: 'b', name: 'Bbb', origin: 'flagship', derivedFrom: ['a'] },
    { slug: 'c', name: 'Ccc', origin: 'community', derivedFrom: ['a', 'ghost'] },
  ]

  it('maps a cited slug to the SORTED names of its citers', () => {
    const map = citedByMap(templates)
    expect(map.get('a')).toEqual(['Bbb', 'Ccc'])
  })

  it('skips unresolved targets and never lists a slug that only cites', () => {
    const map = citedByMap(templates)
    expect(map.has('ghost')).toBe(false) // typo'd citation — counted nowhere
    expect(map.has('b')).toBe(false) // b cites a, but nobody cites b
  })
})

describe('renderLeaderboardMarkdown', () => {
  it('renders a ranked table fenced by the markers', () => {
    const templates = [
      { slug: 'a', name: 'Aaa', origin: 'flagship', derivedFrom: [] },
      { slug: 'b', name: 'Bbb', origin: 'flagship', derivedFrom: ['a'] },
    ]
    const block = renderLeaderboardMarkdown(buildModel(templates), citedByMap(templates))
    expect(block).toBe(
      [
        MARK_START,
        '',
        '| # | 模板 | 被引用次数 | 谁基于它改的 |',
        '|---|---|---|---|',
        '| 1 | **Aaa** (`a`) | 1 | Bbb |',
        '',
        MARK_END,
      ].join('\n'),
    )
  })

  it('renders a placeholder (not a headerless empty table) when nothing is cited yet', () => {
    const block = renderLeaderboardMarkdown(
      buildModel([{ slug: 'a', name: 'Aaa', origin: 'flagship', derivedFrom: [] }]),
      citedByMap([]),
    )
    expect(block).toContain('还没有派生模板')
    expect(block).not.toContain('| # |')
    // Still fenced — the next generate run can find + replace it.
    expect(block.startsWith(MARK_START)).toBe(true)
    expect(block.endsWith(MARK_END)).toBe(true)
  })
})

describe('spliceRegion', () => {
  it('replaces ONLY the marked region, preserving surrounding text', () => {
    const doc = `before\n${MARK_START}\nOLD\n${MARK_END}\nafter`
    const next = spliceRegion(doc, `${MARK_START}\nNEW\n${MARK_END}`)
    expect(next).toBe(`before\n${MARK_START}\nNEW\n${MARK_END}\nafter`)
  })

  it('throws (never a silent no-op) when the markers are missing', () => {
    expect(() => spliceRegion('no markers here', 'block')).toThrow(/missing the leaderboard markers/)
  })
})

describe('drift guard — the checked-in region matches the real corpus', () => {
  it('FLAGSHIP-TEMPLATES.md leaderboard is freshly generated (else: run pnpm build:leaderboard)', async () => {
    const templates = await loadCorpus()
    const fresh = renderLeaderboardMarkdown(buildModel(templates), citedByMap(templates))

    const doc = await readFile(DOC_PATH, 'utf8')
    const start = doc.indexOf(MARK_START)
    const end = doc.indexOf(MARK_END)
    expect(start, 'leaderboard MARK_START missing from FLAGSHIP-TEMPLATES.md').toBeGreaterThanOrEqual(0)
    expect(end, 'leaderboard MARK_END missing from FLAGSHIP-TEMPLATES.md').toBeGreaterThan(start)

    const checkedIn = doc.slice(start, end + MARK_END.length)
    expect(checkedIn).toBe(fresh)
  })

  it('the real corpus carries no unresolved (typo’d) citations', async () => {
    const { unresolved } = buildModel(await loadCorpus())
    expect(unresolved).toEqual([])
  })
})
