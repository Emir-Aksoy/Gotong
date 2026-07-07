/**
 * R3 — public A2A Agent Card endpoint (/.well-known/agent-card.json).
 *
 * Verifies the route serves the host-injected card (200 + JSON, no auth),
 * 404s when no surface is wired, rejects non-GET, and derives the card's
 * base URL from the request (so it's correct behind a reverse proxy).
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Hub, Space } from '@gotong/core'

import {
  serveWeb,
  type AgentCardSurface,
  type WebServerHandle,
} from '../src/server.js'

interface Boot {
  tmp: string
  hub: Hub
  server: WebServerHandle
  baseUrl: string
}

async function boot(agentCard?: AgentCardSurface): Promise<Boot> {
  const tmp = await mkdtemp(join(tmpdir(), 'gotong-agent-card-'))
  const init = await Space.init(tmp, { name: 'card-test' })
  const hub = new Hub({ space: init.space })
  await hub.start()
  const server = await serveWeb(hub, {
    host: '127.0.0.1',
    port: 0,
    ...(agentCard ? { agentCard } : {}),
  })
  return { tmp, hub, server, baseUrl: server.url }
}

async function teardown(b: Boot): Promise<void> {
  await b.server.close()
  await b.hub.stop()
  await rm(b.tmp, { recursive: true, force: true })
}

// A fake surface that echoes the base URL it was handed, so the test can
// assert the route derives it from the request.
const fakeCard: AgentCardSurface = {
  json: (baseUrl) => JSON.stringify({ name: 'card-test', url: baseUrl, skills: [] }),
}

// STD-M1 — a surface with signing on (jwks() returns a JWKS) vs a surface with
// signing off (jwks() returns null → route 404s).
const fakeSignedCard: AgentCardSurface = {
  json: (baseUrl) => JSON.stringify({ name: 'card-test', url: baseUrl, skills: [] }),
  jwks: () => JSON.stringify({ keys: [{ kty: 'EC', crv: 'P-256', x: 'x', y: 'y', kid: 'k', use: 'sig', alg: 'ES256' }] }),
}
const fakeUnsignedCard: AgentCardSurface = {
  json: (baseUrl) => JSON.stringify({ name: 'card-test', url: baseUrl, skills: [] }),
  jwks: () => null,
}

describe('GET /.well-known/agent-card.json (R3)', () => {
  let b: Boot
  afterEach(async () => { if (b) await teardown(b) })

  it('404 when no agentCard surface is wired', async () => {
    b = await boot()
    const res = await fetch(`${b.baseUrl}/.well-known/agent-card.json`)
    expect(res.status).toBe(404)
  })

  it('200 + JSON card when the surface is wired (no auth required)', async () => {
    b = await boot(fakeCard)
    const res = await fetch(`${b.baseUrl}/.well-known/agent-card.json`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/application\/json/)
    const body = await res.json()
    expect(body.name).toBe('card-test')
    expect(Array.isArray(body.skills)).toBe(true)
  })

  it('derives the card url from the request host', async () => {
    b = await boot(fakeCard)
    const res = await fetch(`${b.baseUrl}/.well-known/agent-card.json`)
    const body = await res.json()
    // server.url is http://127.0.0.1:<port> — the route passes that through.
    expect(body.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
  })

  it('405 on non-GET', async () => {
    b = await boot(fakeCard)
    const res = await fetch(`${b.baseUrl}/.well-known/agent-card.json`, {
      method: 'POST',
    })
    expect(res.status).toBe(405)
  })
})

describe('GET /.well-known/jwks.json (STD-M1)', () => {
  let b: Boot
  afterEach(async () => { if (b) await teardown(b) })

  it('404 when no agentCard surface is wired', async () => {
    b = await boot()
    const res = await fetch(`${b.baseUrl}/.well-known/jwks.json`)
    expect(res.status).toBe(404)
  })

  it('404 when the card has no jwks method (legacy surface, signing off)', async () => {
    b = await boot(fakeCard)
    const res = await fetch(`${b.baseUrl}/.well-known/jwks.json`)
    expect(res.status).toBe(404)
  })

  it('404 when jwks() returns null (signing off)', async () => {
    b = await boot(fakeUnsignedCard)
    const res = await fetch(`${b.baseUrl}/.well-known/jwks.json`)
    expect(res.status).toBe(404)
  })

  it('200 + JWKS when signing is on', async () => {
    b = await boot(fakeSignedCard)
    const res = await fetch(`${b.baseUrl}/.well-known/jwks.json`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/application\/json/)
    const body = await res.json()
    expect(Array.isArray(body.keys)).toBe(true)
    expect(body.keys[0]).toMatchObject({ kty: 'EC', use: 'sig', alg: 'ES256' })
  })

  it('405 on non-GET', async () => {
    b = await boot(fakeSignedCard)
    const res = await fetch(`${b.baseUrl}/.well-known/jwks.json`, { method: 'POST' })
    expect(res.status).toBe(405)
  })
})
