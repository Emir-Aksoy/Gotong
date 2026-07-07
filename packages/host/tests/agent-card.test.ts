/**
 * R3 (A2A alignment) + NET-M4 (v1.0 shape + owner curation) — unit tests.
 *
 * Verifies the conservative A2A Agent Card shape: identity + auth-scheme
 * declaration, honest (all-false) capabilities, NO skills by default, the
 * bearer security scheme derived from R1's PeerAuthScheme kind, the v1.0
 * REQUIRED fields (supportedInterfaces / normalized skills /
 * securityRequirements double-write, provider dropped), and the curation
 * reader's whole-file honesty (absent=silent null / corrupt=warn+null,
 * never half a card).
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import {
  A2A_INTERFACE_PROTOCOL_VERSION,
  A2A_PROTOCOL_VERSION,
  buildAgentCard,
  readAgentCardCurationSync,
} from '../src/agent-card.js'

const base = {
  name: 'My Hub',
  version: '3.1.0',
  url: 'https://hub.example.com',
}

describe('buildAgentCard (R3)', () => {
  it('emits the conservative A2A card shape', () => {
    const card = buildAgentCard(base)
    expect(card.name).toBe('My Hub')
    expect(card.version).toBe('3.1.0')
    expect(card.url).toBe('https://hub.example.com')
    expect(card.protocolVersion).toBe(A2A_PROTOCOL_VERSION)
    // NET-M4 — v1.0 dropped provider-without-url; we no longer emit one.
    expect('provider' in card).toBe(false)
    // Honest: the hub serves only blocking message/send.
    expect(card.capabilities).toEqual({
      streaming: false,
      pushNotifications: false,
      stateTransitionHistory: false,
    })
    expect(card.defaultInputModes).toContain('text/plain')
    expect(card.defaultOutputModes).toContain('text/plain')
    // Conservative: never enumerate skills on a public endpoint.
    expect(card.skills).toEqual([])
  })

  // NET-M4 — A2A v1.0 requires supportedInterfaces (first = preferred).
  it('declares the v1.0 supportedInterfaces pointing at /a2a, honest about the 0.2 method surface', () => {
    const card = buildAgentCard(base)
    expect(card.supportedInterfaces).toEqual([
      {
        url: 'https://hub.example.com/a2a',
        protocolBinding: 'JSONRPC',
        protocolVersion: A2A_INTERFACE_PROTOCOL_VERSION,
      },
    ])
  })

  it('declares a bearer security scheme when authSchemes includes bearer (0.2.x + v1.0 double-write)', () => {
    const card = buildAgentCard({ ...base, authSchemes: ['bearer'] })
    expect(card.securitySchemes).toBeDefined()
    expect(card.securitySchemes?.bearer).toEqual({
      type: 'http',
      scheme: 'bearer',
      description: expect.any(String),
    })
    expect(card.security).toEqual([{ bearer: [] }])
    // v1.0 renamed the list; both names carry the same value mid-transition.
    expect(card.securityRequirements).toEqual([{ bearer: [] }])
  })

  it('omits security fields entirely when no auth scheme is advertised', () => {
    const card = buildAgentCard({ ...base, authSchemes: [] })
    expect(card.securitySchemes).toBeUndefined()
    expect(card.security).toBeUndefined()
    expect(card.securityRequirements).toBeUndefined()
  })

  it('omits security fields when authSchemes is unset', () => {
    const card = buildAgentCard(base)
    expect(card.securitySchemes).toBeUndefined()
    expect(card.security).toBeUndefined()
  })

  it('ignores unknown auth scheme kinds (only bearer is implemented)', () => {
    const card = buildAgentCard({ ...base, authSchemes: ['oauth2', 'mtls'] })
    expect(card.securitySchemes).toBeUndefined()
    expect(card.security).toBeUndefined()
  })

  it('uses a sensible default description when none / empty is given', () => {
    expect(buildAgentCard(base).description).toMatch(/Gotong federation hub/)
    expect(buildAgentCard({ ...base, description: '   ' }).description).toMatch(
      /Gotong federation hub/,
    )
  })

  it('honors an explicit description', () => {
    const card = buildAgentCard({ ...base, description: 'Custom hub blurb' })
    expect(card.description).toBe('Custom hub blurb')
  })

  it('round-trips through JSON', () => {
    const card = buildAgentCard({ ...base, authSchemes: ['bearer'] })
    const round = JSON.parse(JSON.stringify(card))
    expect(round.name).toBe('My Hub')
    expect(round.securitySchemes.bearer.scheme).toBe('bearer')
    expect(round.skills).toEqual([])
  })

  // C-M1 — skill advertisement is an explicit opt-in (host gates it behind
  // GOTONG_A2A_ADVERTISE_SKILLS). The card never auto-enumerates.
  describe('skills opt-in (Phase 18 C-M1)', () => {
    it('defaults to no skills when none are passed', () => {
      expect(buildAgentCard(base).skills).toEqual([])
    })

    it('advertises the skills it is explicitly given, normalized to the v1.0 wire shape', () => {
      const card = buildAgentCard({
        ...base,
        skills: [
          { id: 'translate', name: 'translate' },
          { id: 'summarize', name: 'Summarize', description: 'condense text', tags: ['nlp'] },
        ],
      })
      // v1.0 made description/tags REQUIRED — bare skills get honest defaults
      // (description = the id, tags = []), given ones pass through verbatim.
      expect(card.skills).toEqual([
        { id: 'translate', name: 'translate', description: 'translate', tags: [] },
        { id: 'summarize', name: 'Summarize', description: 'condense text', tags: ['nlp'] },
      ])
    })

    it('keeps every capability flag false even with skills advertised', () => {
      // We serve only blocking message/send — no streaming / push / history.
      const card = buildAgentCard({ ...base, skills: [{ id: 'chat', name: 'chat' }] })
      expect(card.capabilities).toEqual({
        streaming: false,
        pushNotifications: false,
        stateTransitionHistory: false,
      })
    })

    it('copies the skills array (caller mutation does not leak in)', () => {
      const skills = [{ id: 'a', name: 'a' }]
      const card = buildAgentCard({ ...base, skills })
      skills.push({ id: 'b', name: 'b' })
      expect(card.skills).toEqual([{ id: 'a', name: 'a', description: 'a', tags: [] }])
    })
  })
})

// NET-M4 — the owner curation file (`<space>/agent-card.json`).
describe('readAgentCardCurationSync (NET-M4)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'gotong-agent-card-'))
  afterAll(() => rmSync(tmp, { recursive: true, force: true }))

  const warns: string[] = []
  const log = { warn: (msg: string) => warns.push(msg) }
  let n = 0
  const fileWith = (content: string): string => {
    const f = join(tmp, `curation-${n++}.json`)
    writeFileSync(f, content)
    return f
  }

  it('absent file → null, silently (legacy env path applies)', () => {
    const before = warns.length
    expect(readAgentCardCurationSync(join(tmp, 'nope.json'), log)).toBeNull()
    expect(warns.length).toBe(before)
  })

  it('valid curation → displayName/description/skills, skills normalized-lite', () => {
    const f = fileWith(
      JSON.stringify({
        displayName: '爸爸的 hub',
        description: '家里的常驻 hub',
        skills: [{ id: 'dad-chat' }, { id: 'research', name: '帮查资料', tags: ['info', 7] }],
      }),
    )
    const c = readAgentCardCurationSync(f, log)
    expect(c).toEqual({
      displayName: '爸爸的 hub',
      description: '家里的常驻 hub',
      skills: [
        { id: 'dad-chat', name: 'dad-chat' },
        { id: 'research', name: '帮查资料', tags: ['info'] }, // 非字符串 tag 丢弃
      ],
    })
  })

  it('corrupt JSON / non-object / non-array skills / missing skill id → warn + null (whole file, never half a card)', () => {
    for (const bad of ['{oops', '"just a string"', '[]', '{"skills": "chat"}', '{"skills": [{"name":"无 id"}]}']) {
      const before = warns.length
      expect(readAgentCardCurationSync(fileWith(bad), log)).toBeNull()
      expect(warns.length).toBe(before + 1) // 每个文件路径独立节流,首次必 warn
    }
  })

  it('duplicate skill id → keep the first, warn', () => {
    const f = fileWith(JSON.stringify({ skills: [{ id: 'chat', name: 'A' }, { id: 'chat', name: 'B' }] }))
    const c = readAgentCardCurationSync(f, log)
    expect(c?.skills).toEqual([{ id: 'chat', name: 'A' }])
  })

  it('empty file object → skills [] (curation with nothing advertised is a valid, silent card)', () => {
    const c = readAgentCardCurationSync(fileWith('{}'), log)
    expect(c).toEqual({ skills: [] })
  })

  it('curated skills flow through buildAgentCard to the v1.0 wire shape verbatim — never auto-extended', () => {
    const f = fileWith(JSON.stringify({ skills: [{ id: 'dad-chat' }] }))
    const c = readAgentCardCurationSync(f, log)!
    const card = buildAgentCard({ ...base, skills: c.skills })
    expect(card.skills).toEqual([{ id: 'dad-chat', name: 'dad-chat', description: 'dad-chat', tags: [] }])
  })
})
