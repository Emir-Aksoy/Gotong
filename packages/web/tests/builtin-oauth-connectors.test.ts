/**
 * Anti-rot acceptance gate for the built-in outbound OAuth connector directory
 * (C-M2-M5b).
 *
 * `src/builtin-oauth-connectors.ts` is a HAND-AUTHORED framework-level constant.
 * Each entry's `mcpServer` is the exact `McpHttpServerSpec` the one-click install
 * posts to `/api/admin/mcp-servers`, so this test re-parses EVERY one through the
 * REAL `validateMcpServersArray` — the same validator the install route runs.
 *
 * It also pins the curated id set (add/remove = visible diff) and enforces the
 * credential-discipline boundary (②): the bearer header MUST be the FIXED M4a
 * injection ref `Bearer ${OAUTH_ACCESS_TOKEN}` (never a plaintext token), and the
 * preset MUST NOT bake any client_id / client_secret (those are admin-supplied).
 */

import { describe, expect, it } from 'vitest'

import {
  BUILTIN_OAUTH_CONNECTORS,
  OAUTH_CONNECTOR_CATEGORIES,
  OAUTH_CONNECTOR_ADMIN_FIELDS,
  OAUTH_ACCESS_TOKEN_BEARER,
  type BuiltinOAuthConnector,
} from '../src/builtin-oauth-connectors.js'
import { validateMcpServersArray } from '../src/manifest.js'

// The curated directory — pinning ids makes "someone quietly added/removed a
// preset" a test diff, not a surprise in the admin UI.
const EXPECTED_IDS = ['google-calendar', 'gmail']

// The exact fixed ref M4a resolves per-connector; the header must be this and
// only this (see host oauth-secret-source.ts OAUTH_ACCESS_TOKEN_REF).
const FIXED_BEARER = 'Bearer ${OAUTH_ACCESS_TOKEN}'

const bearerOf = (c: BuiltinOAuthConnector): string | undefined =>
  c.mcpServer.headers?.Authorization

describe('built-in outbound OAuth connector directory (C-M2-M5b)', () => {
  it('ships exactly the curated set, in order, with unique ids', () => {
    expect(BUILTIN_OAUTH_CONNECTORS.map((c) => c.id)).toEqual(EXPECTED_IDS)
    expect(new Set(BUILTIN_OAUTH_CONNECTORS.map((c) => c.id)).size).toBe(EXPECTED_IDS.length)
  })

  it('display names and mcpServer.names are each unique', () => {
    const names = BUILTIN_OAUTH_CONNECTORS.map((c) => c.name)
    expect(new Set(names).size, 'duplicate display name').toBe(names.length)
    const serverNames = BUILTIN_OAUTH_CONNECTORS.map((c) => c.mcpServer.name)
    expect(new Set(serverNames).size, 'duplicate mcpServer.name').toBe(serverNames.length)
  })

  it('every category is in the allowed set', () => {
    for (const c of BUILTIN_OAUTH_CONNECTORS) {
      expect(OAUTH_CONNECTOR_CATEGORIES, `${c.id} category`).toContain(c.category)
    }
  })

  it('has a whatFor, https endpoints, a scope and an https homepage on every entry', () => {
    for (const c of BUILTIN_OAUTH_CONNECTORS) {
      expect(c.whatFor.length, `${c.id} whatFor`).toBeGreaterThan(0)
      expect(c.scope.length, `${c.id} scope`).toBeGreaterThan(0)
      expect(c.authorizationEndpoint, `${c.id} authorizationEndpoint`).toMatch(/^https:\/\//)
      expect(c.tokenEndpoint, `${c.id} tokenEndpoint`).toMatch(/^https:\/\//)
      expect(c.homepage, `${c.id} homepage`).toMatch(/^https:\/\//)
    }
  })

  // The load-bearing assertion: every embedded mcpServer passes the real
  // validator at once (also enforces cross-entry name uniqueness like a real
  // install batch would).
  it('every mcpServer passes the real validateMcpServersArray', () => {
    const specs = BUILTIN_OAUTH_CONNECTORS.map((c) => c.mcpServer)
    const out = validateMcpServersArray(specs, 'builtin-oauth')
    expect(out).toHaveLength(specs.length)
    expect(out.map((s) => s.name)).toEqual(specs.map((s) => s.name))
  })

  it.each(BUILTIN_OAUTH_CONNECTORS.map((c) => [c.id, c] as const))(
    '%s mcpServer validates individually and is remote http',
    (_id, c) => {
      const out = validateMcpServersArray([c.mcpServer], `builtin-oauth[${c.id}]`)
      expect(out).toHaveLength(1)
      expect(c.mcpServer.transport).toBe('http')
      expect(c.mcpServer.url).toMatch(/^https:\/\//)
    },
  )

  // Boundary ②: the bearer is the FIXED injection ref, never a plaintext token,
  // and it's the ONLY header — nothing else smuggled in.
  it('every mcpServer bearer is the fixed ${OAUTH_ACCESS_TOKEN} ref, no plaintext', () => {
    expect(OAUTH_ACCESS_TOKEN_BEARER).toBe(FIXED_BEARER)
    for (const c of BUILTIN_OAUTH_CONNECTORS) {
      expect(bearerOf(c), `${c.id} Authorization header`).toBe(FIXED_BEARER)
      // No header value hardcodes a secret-shaped literal; any ${...} must be the
      // one clean ref (catches a half-typed "${OAUTH_ACCESS_TOKEN" too).
      for (const [k, v] of Object.entries(c.mcpServer.headers ?? {})) {
        if (v.includes('${') || v.includes('}')) {
          expect(v, `${c.id} header[${k}] malformed ref`).toBe(FIXED_BEARER)
        }
      }
    }
  })

  // Boundary ②: the admin supplies their own OAuth app; the preset must NOT bake
  // a client_id / client_secret (structurally — the type has no such field, but
  // pin it so a future edit that adds one is caught).
  it('bakes no client_id / client_secret (admin-supplied)', () => {
    expect([...OAUTH_CONNECTOR_ADMIN_FIELDS]).toEqual(['clientId', 'clientSecret', 'redirectUri'])
    for (const c of BUILTIN_OAUTH_CONNECTORS) {
      const keys = Object.keys(c)
      expect(keys, `${c.id} bakes clientId`).not.toContain('clientId')
      expect(keys, `${c.id} bakes clientSecret`).not.toContain('clientSecret')
    }
  })

  // Refresh viability: M4b can only keep a connector alive if the provider issued
  // a refresh_token — for Google that needs access_type=offline in the authorize
  // URL. Every preset must carry it (else it silently dies after ~1h).
  it('every preset carries access_type=offline for refresh viability', () => {
    for (const c of BUILTIN_OAUTH_CONNECTORS) {
      expect(c.extraAuthParams?.access_type, `${c.id} access_type`).toBe('offline')
      // extraAuthParams are flat string→string (M5a validation + authorize URL).
      for (const [k, v] of Object.entries(c.extraAuthParams ?? {})) {
        expect(typeof v, `${c.id} extraAuthParams.${k}`).toBe('string')
      }
    }
  })

  it('every sourceRef cites an official provider doc (google) to verify against', () => {
    for (const c of BUILTIN_OAUTH_CONNECTORS) {
      expect(c.sourceRef, `${c.id} sourceRef`).toMatch(/developers\.google\.com/)
    }
  })
})
