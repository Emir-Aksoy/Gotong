/**
 * R3 (A2A alignment) — buildAgentCard unit tests.
 *
 * Verifies the conservative A2A Agent Card shape: identity + auth-scheme
 * declaration, honest (all-false) capabilities, NO skills, and the
 * bearer security scheme derived from R1's PeerAuthScheme kind.
 */

import { describe, expect, it } from 'vitest'

import { A2A_PROTOCOL_VERSION, buildAgentCard } from '../src/agent-card.js'

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
    expect(card.provider).toEqual({ organization: 'My Hub' })
    // Honest: the hub does not yet serve the A2A message API.
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

  it('declares a bearer security scheme when authSchemes includes bearer', () => {
    const card = buildAgentCard({ ...base, authSchemes: ['bearer'] })
    expect(card.securitySchemes).toBeDefined()
    expect(card.securitySchemes?.bearer).toEqual({
      type: 'http',
      scheme: 'bearer',
      description: expect.any(String),
    })
    expect(card.security).toEqual([{ bearer: [] }])
  })

  it('omits security fields entirely when no auth scheme is advertised', () => {
    const card = buildAgentCard({ ...base, authSchemes: [] })
    expect(card.securitySchemes).toBeUndefined()
    expect(card.security).toBeUndefined()
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

    it('advertises the skills it is explicitly given', () => {
      const card = buildAgentCard({
        ...base,
        skills: [
          { id: 'translate', name: 'translate' },
          { id: 'summarize', name: 'Summarize', description: 'condense text', tags: ['nlp'] },
        ],
      })
      expect(card.skills).toEqual([
        { id: 'translate', name: 'translate' },
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
      expect(card.skills).toEqual([{ id: 'a', name: 'a' }])
    })
  })
})
