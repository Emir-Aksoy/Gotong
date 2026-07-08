/**
 * C-M2-M4a — oauth-backed MCP `SecretSource` (接入现实生活 track).
 *
 * The seam that turns a *connected* OAuth connector into a live bearer token in
 * an MCP server's `Authorization` header. Two angles:
 *
 *   1. The source itself — `${OAUTH_ACCESS_TOKEN}` resolves to the token of the
 *      connector wired to *that* server (by `mcpServerName`); every other ref,
 *      and that ref for a server with no connected/enabled connector, falls
 *      through to the base source. Zero connectors ⇒ base for everything =
 *      byte-for-byte today's behaviour.
 *   2. End-to-end through `resolveMcpServerConfig` — a real http spec whose
 *      header is `Bearer ${OAUTH_ACCESS_TOKEN}` resolves to the live token,
 *      proving the whole credential path (ref → source → vault → header).
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { randomBytes } from 'node:crypto'

import type { McpServerSpec } from '@gotong/core'
import {
  openIdentityStore,
  IdentityStore,
  MASTER_KEY_LEN_BYTES,
  type StoredOAuthTokenSet,
} from '@gotong/identity'

import { resolveMcpServerConfig, type SecretSource } from '../src/mcp-config.js'
import { makeOAuthSecretSource, OAUTH_ACCESS_TOKEN_REF } from '../src/oauth-secret-source.js'

const FIXED_KEY = randomBytes(MASTER_KEY_LEN_BYTES)

const GOOGLE = {
  id: 'google-calendar',
  displayName: 'Google Calendar',
  authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
  clientId: 'client-123.apps.googleusercontent.com',
  redirectUri: 'https://hub.test/api/oauth/callback',
  scope: 'https://www.googleapis.com/auth/calendar.readonly',
  mcpServerName: 'google-calendar',
  clientSecret: 'goog-secret-xyz',
} as const

const TOKENS: StoredOAuthTokenSet = {
  accessToken: 'ya29.live-access',
  refreshToken: '1//refresh',
  tokenType: 'Bearer',
  scope: 'https://www.googleapis.com/auth/calendar.readonly',
  accessTokenExpiresAt: 1_800_000_000_000,
}

describe('makeOAuthSecretSource (C-M2-M4a)', () => {
  let store: IdentityStore

  beforeEach(() => {
    store = openIdentityStore({ dbPath: ':memory:', masterKey: FIXED_KEY })
  })

  it('resolves ${OAUTH_ACCESS_TOKEN} to the live token of the connector wired to that server', () => {
    store.registerOAuthConnector(GOOGLE)
    store.setOAuthTokenSet('google-calendar', TOKENS)

    const source = makeOAuthSecretSource(store)
    expect(source('google-calendar')(OAUTH_ACCESS_TOKEN_REF)).toBe('ya29.live-access')
  })

  it('never leaks the token to a DIFFERENT server (linkage is by mcpServerName)', () => {
    store.registerOAuthConnector(GOOGLE)
    store.setOAuthTokenSet('google-calendar', TOKENS)

    // A base that would betray a fall-through: it returns a sentinel for the
    // oauth ref, so an undefined-from-oauth is visible as the sentinel.
    const base: SecretSource = (name) => (name === OAUTH_ACCESS_TOKEN_REF ? 'FELL_THROUGH' : undefined)
    const source = makeOAuthSecretSource(store, base)
    expect(source('some-other-server')(OAUTH_ACCESS_TOKEN_REF)).toBe('FELL_THROUGH')
  })

  it('falls through for a registered-but-not-yet-connected connector', () => {
    store.registerOAuthConnector(GOOGLE) // no setOAuthTokenSet → connected=false
    const base: SecretSource = () => 'FELL_THROUGH'
    const source = makeOAuthSecretSource(store, base)
    expect(source('google-calendar')(OAUTH_ACCESS_TOKEN_REF)).toBe('FELL_THROUGH')
  })

  it('falls through for a DISABLED connector even if it has a token', () => {
    store.registerOAuthConnector({ ...GOOGLE, enabled: false })
    store.setOAuthTokenSet('google-calendar', TOKENS)
    const base: SecretSource = () => 'FELL_THROUGH'
    const source = makeOAuthSecretSource(store, base)
    expect(source('google-calendar')(OAUTH_ACCESS_TOKEN_REF)).toBe('FELL_THROUGH')
  })

  it('delegates every non-oauth ref to the base source', () => {
    store.registerOAuthConnector(GOOGLE)
    store.setOAuthTokenSet('google-calendar', TOKENS)
    const base: SecretSource = (name) => (name === 'SLACK_TOKEN' ? 'xoxb-123' : undefined)
    const source = makeOAuthSecretSource(store, base)
    expect(source('google-calendar')('SLACK_TOKEN')).toBe('xoxb-123')
  })

  it('opt-in default: with zero connectors every ref goes to the base (byte-for-byte)', () => {
    const seen: string[] = []
    const base: SecretSource = (name) => {
      seen.push(name)
      return `env:${name}`
    }
    const source = makeOAuthSecretSource(store, base)
    expect(source('any-server')(OAUTH_ACCESS_TOKEN_REF)).toBe(`env:${OAUTH_ACCESS_TOKEN_REF}`)
    expect(source('any-server')('WHATEVER')).toBe('env:WHATEVER')
    expect(seen).toEqual([OAUTH_ACCESS_TOKEN_REF, 'WHATEVER'])
  })

  it('end-to-end: resolveMcpServerConfig injects the live token into an http Bearer header', () => {
    store.registerOAuthConnector(GOOGLE)
    store.setOAuthTokenSet('google-calendar', TOKENS)
    const source = makeOAuthSecretSource(store)

    const spec: McpServerSpec = {
      name: 'google-calendar',
      transport: 'http',
      url: 'https://mcp.google.test/v1',
      headers: { Authorization: `Bearer \${${OAUTH_ACCESS_TOKEN_REF}}` },
    }
    const cfg = resolveMcpServerConfig(spec, source(spec.name), {})
    expect(cfg).toEqual({
      name: 'google-calendar',
      transport: 'http',
      url: 'https://mcp.google.test/v1',
      headers: { Authorization: 'Bearer ya29.live-access' },
    })
  })

  it('a refreshed token set is reflected on the next resolve (live, not cached)', () => {
    store.registerOAuthConnector(GOOGLE)
    store.setOAuthTokenSet('google-calendar', TOKENS)
    const source = makeOAuthSecretSource(store)
    expect(source('google-calendar')(OAUTH_ACCESS_TOKEN_REF)).toBe('ya29.live-access')

    store.setOAuthTokenSet('google-calendar', { ...TOKENS, accessToken: 'ya29.rotated' })
    expect(source('google-calendar')(OAUTH_ACCESS_TOKEN_REF)).toBe('ya29.rotated')
  })
})
