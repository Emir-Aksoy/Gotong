/**
 * profile — PRO-M1. The `AIPE_PROFILE` mapping layer is a presentation lens with
 * one non-negotiable property: **unset must be byte-identical to today**. These
 * tests pin that (the unset/empty path produces NO id, NO descriptor, NO banner
 * lines), plus the parse aliases, the typo-vs-unset distinction, and the shape of
 * the two descriptors.
 */

import { describe, expect, it } from 'vitest'

import {
  PROFILES,
  parseProfileEnv,
  profileBannerLines,
  resolveProfileEnv,
  type ProfileId,
} from '../src/profile.js'

describe('parseProfileEnv — canonical + aliases + junk', () => {
  it('maps the two canonical values', () => {
    expect(parseProfileEnv('hub')).toBe('hub')
    expect(parseProfileEnv('federation')).toBe('federation')
  })

  it('is case- and whitespace-insensitive, and normalizes underscores', () => {
    expect(parseProfileEnv('  HUB ')).toBe('hub')
    expect(parseProfileEnv('Federation')).toBe('federation')
    expect(parseProfileEnv('single_node')).toBe('hub')
    expect(parseProfileEnv('CROSS_HUB')).toBe('federation')
  })

  it('folds team AND org into federation (cross-hub) — the whole framing correction', () => {
    expect(parseProfileEnv('team')).toBe('federation')
    expect(parseProfileEnv('org')).toBe('federation')
    expect(parseProfileEnv('organization')).toBe('federation')
  })

  it('folds personal/local/single/node into hub (within-hub)', () => {
    for (const a of ['personal', 'local', 'single', 'node']) {
      expect(parseProfileEnv(a)).toBe('hub')
    }
  })

  it('returns undefined for unset, empty, and unrecognized', () => {
    expect(parseProfileEnv(undefined)).toBeUndefined()
    expect(parseProfileEnv('')).toBeUndefined()
    expect(parseProfileEnv('   ')).toBeUndefined()
    expect(parseProfileEnv('enterprise')).toBeUndefined()
    expect(parseProfileEnv('hubb')).toBeUndefined() // a typo, not a match
  })
})

describe('resolveProfileEnv — the three cases', () => {
  it('unset → {} (the byte-identical default: no id, no descriptor, no warning)', () => {
    expect(resolveProfileEnv(undefined)).toEqual({})
    expect(resolveProfileEnv('')).toEqual({})
    expect(resolveProfileEnv('   ')).toEqual({})
  })

  it('recognized → { id, descriptor }', () => {
    const r = resolveProfileEnv('federation')
    expect(r.id).toBe('federation')
    expect(r.descriptor).toBe(PROFILES.federation)
    expect(r.unrecognized).toBeUndefined()
  })

  it('non-empty-but-unknown → { unrecognized } so the caller can flag a typo', () => {
    const r = resolveProfileEnv('  Enterprise ')
    expect(r.id).toBeUndefined()
    expect(r.descriptor).toBeUndefined()
    expect(r.unrecognized).toBe('Enterprise') // trimmed, original casing preserved
  })

  it('distinguishes typo from unset — the point of this resolver over the bare parse', () => {
    expect('unrecognized' in resolveProfileEnv('typo')).toBe(true)
    expect('unrecognized' in resolveProfileEnv(undefined)).toBe(false)
  })
})

describe('profileBannerLines — presentation only, empty on default', () => {
  it('renders NOTHING for the unset default (so today\'s banner is untouched)', () => {
    expect(profileBannerLines(resolveProfileEnv(undefined))).toEqual([])
    expect(profileBannerLines(resolveProfileEnv('nonsense'))).toEqual([]) // typo also adds nothing
  })

  it('renders a bilingual lens block for a recognized profile', () => {
    const lines = profileBannerLines(resolveProfileEnv('hub'))
    const text = lines.join('\n')
    expect(lines.length).toBeGreaterThan(0)
    expect(text).toContain('视角 / Profile')
    expect(text).toContain('hub 内')
    expect(text).toContain('within-hub')
    expect(text).toContain(PROFILES.hub.docPath) // points the reader onward
  })

  it('uses no box-drawing glyphs (CJK double-width alignment safety)', () => {
    const text = profileBannerLines(resolveProfileEnv('federation')).join('\n')
    expect(/[┌┐└┘─│├┤┬┴┼]/.test(text)).toBe(false)
  })
})

describe('PROFILES — both descriptors are complete and correctly framed', () => {
  const ids: ProfileId[] = ['hub', 'federation']

  it('every field is present and non-empty for both', () => {
    for (const id of ids) {
      const d = PROFILES[id]
      expect(d.id).toBe(id)
      for (const s of [d.labelZh, d.labelEn, d.taglineZh, d.taglineEn, d.framingZh, d.framingEn, d.docPath]) {
        expect(typeof s).toBe('string')
        expect(s.length).toBeGreaterThan(0)
      }
      expect(d.leadsZh.length).toBeGreaterThan(0)
      expect(d.leadsEn.length).toBe(d.leadsZh.length) // bilingual parity
    }
  })

  it('the framing correction names the real divide, not the old axis', () => {
    expect(PROFILES.federation.framingZh).toContain('hub 内 vs 跨 hub')
    expect(PROFILES.hub.framingZh).toContain('主权 hub')
  })

  it('doc pointers are repo-relative paths that exist in the tree', () => {
    // Cheap contract check: they look like docs/ paths (existence is asserted by
    // the link-audit; here we just guard against an empty/absolute slip).
    for (const id of ids) {
      expect(PROFILES[id].docPath).toMatch(/^docs\/.+\.md$/)
    }
  })
})
