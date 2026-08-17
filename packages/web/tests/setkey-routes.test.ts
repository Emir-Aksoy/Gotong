/**
 * HANDS-M3b — HTTP tests for the public one-time `/setkey` form.
 *
 *   GET  /setkey/<token>   the form
 *   POST /setkey           spend the link, write the key
 *
 * These go through the real `serveWeb`, not the handler in isolation, because
 * three of the load-bearing facts are properties of where the route is MOUNTED
 * and would still read fine in a unit test of the handler alone:
 *
 *   - it is reachable with no cookie, no bearer, no CSRF token (that is the
 *     whole point: the caller has no session, the token IS the authorisation);
 *   - it sits BEFORE the CSRF gate, so a form POST with a foreign Origin and no
 *     token is not rejected — the same posture as `/api/devices/claim`;
 *   - it has its own per-IP budget, and the budget is checked before the
 *     surface is touched at all.
 *
 * The one promise the whole face makes: the SECRET reaches the host surface and
 * appears in no response body — not on the result page, and not on the form
 * that comes back after a truncated paste. Every response in this file is
 * scanned for it, including the failures, because a "helpful" error message is
 * exactly where it would leak.
 *
 * Two more that are cheap to assert and expensive to lose:
 *   - no inline `<script>` anywhere (CSP is `script-src 'self'` with no
 *     `unsafe-inline`, so one would be silently dropped — SHELL-M4's lesson);
 *   - `cache-control: no-store` + `<meta name="referrer" content="no-referrer">`,
 *     because a live one-time token is sitting in this page's URL.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { request } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Hub, Space } from '@gotong/core'

import { serveWeb, type WebServerHandle } from '../src/server.js'
import type {
  SetKeyLinkPageDto,
  SetKeyLinkSurface,
  SetKeySubmitDto,
} from '../src/setkey-routes.js'

/** The value that must not come back out of any of these responses. */
const SECRET = 'sk-ant-web-form-0123456789abcdef'
const TOKEN = 'a'.repeat(64)

const OK_PAGE: SetKeyLinkPageDto = {
  ok: true,
  expiresAt: Date.now() + 9 * 60_000,
  targets: [
    { value: 'agent:assistant', kind: 'agent', name: 'assistant', provider: 'anthropic', filled: true },
    { value: 'agent:pinned', kind: 'agent', name: 'pinned', provider: 'anthropic', blocked: 'env-pinned', envName: 'PINNED_KEY', filled: false },
    { value: 'agent:fake', kind: 'agent', name: 'fake', provider: 'mock', blocked: 'mock', filled: false },
    { value: 'provider:anthropic', kind: 'provider', name: 'anthropic', filled: false },
  ],
}

/**
 * Records what the route delivered and answers whatever the test asked for.
 * Nothing here touches a vault: what is under test is the route, not the write.
 */
class StubSetKeyLink implements SetKeyLinkSurface {
  readonly pageCalls: unknown[] = []
  readonly submitCalls: Array<{ token: unknown; target: string; secret: string }> = []
  page: SetKeyLinkPageDto = OK_PAGE
  submit: SetKeySubmitDto = {
    ok: true,
    slot: 'agent',
    agentId: 'assistant',
    provider: 'anthropic',
    restart: { restarted: ['assistant'], failed: [] },
  }

  async linkPage(token: unknown): Promise<SetKeyLinkPageDto> {
    this.pageCalls.push(token)
    return this.page
  }
  async submitLink(args: { token: unknown; target: string; secret: string }): Promise<SetKeySubmitDto> {
    this.submitCalls.push(args)
    return this.submit
  }
}

interface Boot {
  tmp: string
  server: WebServerHandle
  stub: StubSetKeyLink | undefined
}

async function boot(opts: { withSurface?: boolean; allowedHosts?: string[] } = {}): Promise<Boot> {
  const withSurface = opts.withSurface ?? true
  const tmp = await mkdtemp(join(tmpdir(), 'gotong-setkey-routes-'))
  const init = await Space.init(tmp, { name: 'setkey-routes-test' })
  const hub = new Hub({ space: init.space })
  await hub.start()

  const stub = withSurface ? new StubSetKeyLink() : undefined
  const server = await serveWeb(hub, {
    host: '127.0.0.1',
    port: 0,
    ...(opts.allowedHosts ? { allowedHosts: opts.allowedHosts } : {}),
    ...(stub ? { setKeyLink: stub } : {}),
  })
  return { tmp, server, stub }
}

/**
 * A raw request, because the CSRF control below has to send a `Host` header of
 * its own choosing and `fetch` silently ignores one. This is also closer to what
 * a browser actually puts on the wire for a `<form method="post">`.
 */
function rawPost(
  url: string,
  path: string,
  headers: Record<string, string>,
  body: string,
): Promise<{ status: number; body: string }> {
  const { hostname, port } = new URL(url)
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname,
        port,
        path,
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(body), ...headers },
      },
      (res) => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (c) => (text += c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }))
      },
    )
    req.on('error', reject)
    req.end(body)
  })
}

/** POST a form body exactly as the rendered `<form method="post">` would. */
function postForm(
  url: string,
  fields: Record<string, string>,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${url}/setkey`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...extraHeaders },
    body: new URLSearchParams(fields).toString(),
    redirect: 'manual',
  })
}

describe('public one-time /setkey form (HANDS-M3b)', () => {
  let b: Boot

  afterEach(async () => {
    await b.server.close()
    await rm(b.tmp, { recursive: true, force: true })
  })

  it('THE POINT: the form is reachable with no cookie, no bearer, no CSRF token', async () => {
    b = await boot()
    const res = await fetch(`${b.server.url}/setkey/${TOKEN}`)
    expect(res.status).toBe(200)
    const html = await res.text()
    // The token reached the surface verbatim, and the picker rendered from it.
    expect(b.stub!.pageCalls).toEqual([TOKEN])
    expect(html).toContain('value="agent:assistant"')
    expect(html).toContain('<form method="post" action="/setkey">')
  })

  it('is mounted BEFORE the CSRF gate — a cross-origin form POST is not rejected', async () => {
    // The gate only bites when `allowedHosts` is configured, so configure it:
    // a test that "passes" because the gate was off everywhere proves nothing.
    b = await boot({ allowedHosts: ['gotong.test'] })
    const hostile = { host: 'gotong.test', origin: 'https://evil.example' }
    const form = new URLSearchParams({ token: TOKEN, target: 'agent:assistant', secret: SECRET }).toString()

    // CONTROL FIRST: the very same request shape against a guarded path is
    // turned away by the Origin check, so the next assertion is about where
    // this route is mounted and not about a gate that was asleep.
    const guarded = await rawPost(b.server.url, '/api/admin/identity/login', hostile, '{}')
    expect(guarded.status).toBe(403)
    expect(guarded.body).toContain('cross-origin')

    // And the public form goes through: there is no ambient credential here for
    // a CSRF attack to spend, and whoever holds the token can just open the link.
    const res = await rawPost(b.server.url, '/setkey', hostile, form)
    expect(res.status).toBe(200)
    expect(b.stub!.submitCalls).toEqual([{ token: TOKEN, target: 'agent:assistant', secret: SECRET }])
  })

  it('THE PROMISE: the secret is in no response body — not on success, not on a retry', async () => {
    b = await boot()
    const ok = await postForm(b.server.url, { token: TOKEN, target: 'agent:assistant', secret: SECRET })
    const okHtml = await ok.text()
    expect(okHtml).not.toContain(SECRET)
    expect(okHtml).toContain('已存入')

    // The one failure that re-renders the form. The field must come back EMPTY:
    // pre-filling it would mean shipping the secret back down the wire.
    b.stub!.submit = { ok: false, code: 'bad_secret', reason: 'too_short' }
    const retry = await postForm(b.server.url, { token: TOKEN, target: 'agent:assistant', secret: 'short' })
    expect(retry.status).toBe(400)
    const retryHtml = await retry.text()
    expect(retryHtml).not.toContain('short')
    expect(retryHtml).toContain('name="secret"')
    expect(retryHtml).not.toMatch(/name="secret"[^>]*value=/)
    // It is the form again, not a dead end.
    expect(retryHtml).toContain('<form method="post" action="/setkey">')
  })

  it('every page: no inline <script>, no-store, and no-referrer', async () => {
    b = await boot()
    const pages = [
      await fetch(`${b.server.url}/setkey/${TOKEN}`),
      await postForm(b.server.url, { token: TOKEN, target: 'agent:assistant', secret: SECRET }),
    ]
    for (const res of pages) {
      expect(res.headers.get('cache-control')).toContain('no-store')
      const html = await res.text()
      // CSP is `script-src 'self'` with no unsafe-inline: an inline script would
      // be dropped without a word, so the page must not depend on one.
      expect(html).not.toMatch(/<script/i)
      expect(html).toContain('<meta name="referrer" content="no-referrer">')
    }
  })

  it('blocked targets are offered as disabled, with the reason spelled out', async () => {
    b = await boot()
    const html = await (await fetch(`${b.server.url}/setkey/${TOKEN}`)).text()
    // The picker declines to offer the impossible. It is not a second gate —
    // the host refuses a crafted submit for these anyway.
    expect(html).toMatch(/<option value="agent:pinned" disabled>/)
    expect(html).toMatch(/<option value="agent:fake" disabled>/)
    expect(html).toContain('PINNED_KEY')
    expect(html).toMatch(/<option value="agent:assistant">/)
    expect(html).toMatch(/<option value="provider:anthropic">/)
  })

  it('a dead or forbidden link is a page, with the two cases kept apart', async () => {
    b = await boot()
    b.stub!.page = { ok: false, code: 'link_invalid' }
    const gone = await fetch(`${b.server.url}/setkey/${TOKEN}`)
    expect(gone.status).toBe(404)
    expect(await gone.text()).toContain('/setkey link')

    b.stub!.page = { ok: false, code: 'not_allowed' }
    const nope = await fetch(`${b.server.url}/setkey/${TOKEN}`)
    expect(nope.status).toBe(403)
    expect(await nope.text()).toContain('权限')
  })

  it('every refusal code renders a page — the exhaustive switch is really reachable', async () => {
    b = await boot()
    const cases: Array<[SetKeySubmitDto, string]> = [
      [{ ok: false, code: 'link_invalid' }, '链接'],
      [{ ok: false, code: 'not_allowed' }, '权限'],
      [{ ok: false, code: 'unknown_target', agents: ['assistant'], providers: ['anthropic'] }, '不认识'],
      [{ ok: false, code: 'ambiguous_target', target: 'anthropic' }, '分不清'],
      [{ ok: false, code: 'env_pinned', agentId: 'pinned', envName: 'PINNED_KEY' }, 'PINNED_KEY'],
      [{ ok: false, code: 'mock_agent', agentId: 'fake' }, 'mock'],
      [{ ok: false, code: 'vendor_ambiguous', agents: ['a'] }, 'openai-compatible'],
      [{ ok: false, code: 'bad_secret', reason: 'bad_chars' }, '控制字符'],
    ]
    for (const [outcome, needle] of cases) {
      b.stub!.submit = outcome
      // `bad_secret` re-renders the FORM when the link is still readable; make
      // the page unavailable so this loop sees the result page for every code.
      b.stub!.page = { ok: false, code: 'link_invalid' }
      const res = await postForm(b.server.url, { token: TOKEN, target: 'agent:assistant', secret: SECRET })
      expect(res.status).toBe(400)
      const html = await res.text()
      expect(html, `code ${outcome.code}`).toContain(needle)
      expect(html, `code ${outcome.code} leaked the secret`).not.toContain(SECRET)
    }
  })

  it('a shared write reports what it shadowed and how the restart went', async () => {
    b = await boot()
    b.stub!.submit = {
      ok: true,
      slot: 'shared',
      provider: 'anthropic',
      shadowed: [{ agentId: 'assistant', reason: 'per-agent' }, { agentId: 'pinned', reason: 'env-pinned' }],
      restart: { restarted: ['a'], failed: ['b'] },
    }
    const html = await (await postForm(b.server.url, { token: TOKEN, target: 'provider:anthropic', secret: SECRET })).text()
    expect(html).toContain('assistant')
    expect(html).toContain('pinned')
    expect(html).toContain('重启失败')
    // A partial failure must not read as a clean success.
    expect(html).toContain('要等它下次启动才生效')
  })

  it('no lifecycle wired → says stored but NOT yet in effect', async () => {
    b = await boot()
    b.stub!.submit = {
      ok: true,
      slot: 'agent',
      agentId: 'assistant',
      provider: 'anthropic',
      restart: { restarted: [], failed: [], unavailable: true },
    }
    const html = await (await postForm(b.server.url, { token: TOKEN, target: 'agent:assistant', secret: SECRET })).text()
    expect(html).toContain('没接 agent 重启')
  })

  it('names from the surface are escaped — the result page cannot be broken out of', async () => {
    b = await boot()
    b.stub!.submit = {
      ok: false,
      code: 'env_pinned',
      agentId: '<img src=x onerror=alert(1)>',
      envName: '"><script>alert(2)</script>',
    }
    const html = await (await postForm(b.server.url, { token: TOKEN, target: 'agent:x', secret: SECRET })).text()
    expect(html).not.toMatch(/<script/i)
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;img src=x')
  })

  it('no surface wired → 404, indistinguishable from "no such page"', async () => {
    b = await boot({ withSurface: false })
    const get = await fetch(`${b.server.url}/setkey/${TOKEN}`)
    expect(get.status).toBe(404)
    const post = await postForm(b.server.url, { token: TOKEN, target: 'agent:assistant', secret: SECRET })
    expect(post.status).toBe(404)
    // And it does not name itself in the answer.
    expect(await post.text()).not.toContain('setkey')
  })

  it('over budget → 429 BEFORE the surface is touched', async () => {
    b = await boot()
    let last = 200
    // Budget is 10/min per IP; the 11th must be turned away.
    for (let i = 0; i < 12 && last !== 429; i++) {
      last = (await fetch(`${b.server.url}/setkey/${TOKEN}`)).status
    }
    expect(last).toBe(429)
    const before = b.stub!.submitCalls.length
    const flood = await postForm(b.server.url, { token: TOKEN, target: 'agent:assistant', secret: SECRET })
    expect(flood.status).toBe(429)
    // A flood must not get us to parse its payloads.
    expect(b.stub!.submitCalls).toHaveLength(before)
  })

  it('wrong method on either path is 405, not a page', async () => {
    b = await boot()
    const postToForm = await fetch(`${b.server.url}/setkey/${TOKEN}`, { method: 'POST', body: '' })
    expect(postToForm.status).toBe(405)
    expect(postToForm.headers.get('allow')).toBe('GET')
    const getToSubmit = await fetch(`${b.server.url}/setkey`)
    expect(getToSubmit.status).toBe(405)
    expect(getToSubmit.headers.get('allow')).toBe('POST')
  })

  it('an oversized body is refused without reaching the surface', async () => {
    b = await boot()
    const res = await postForm(b.server.url, {
      token: TOKEN,
      target: 'agent:assistant',
      secret: 'x'.repeat(20_000),
    })
    expect(res.status).toBe(413)
    expect(b.stub!.submitCalls).toHaveLength(0)
  })

  it('missing form fields become empty strings, and the host decides', async () => {
    b = await boot()
    b.stub!.submit = { ok: false, code: 'link_invalid' }
    const res = await postForm(b.server.url, {})
    expect(res.status).toBe(400)
    // The route does not invent a refusal of its own — whether an empty token is
    // "invalid" is the host's answer, and it must get the chance to give it.
    expect(b.stub!.submitCalls).toEqual([{ token: '', target: '', secret: '' }])
  })

  it('the token is URL-decoded out of the path before the surface sees it', async () => {
    b = await boot()
    b.stub!.page = { ok: false, code: 'link_invalid' }
    await fetch(`${b.server.url}/setkey/${encodeURIComponent('a/b c')}`)
    expect(b.stub!.pageCalls).toEqual(['a/b c'])
  })
})
