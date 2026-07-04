/**
 * Regression tests for the v3.1 web-endpoint security fixes (S1–S6 from
 * the post-v3.0 audit).
 *
 * Each `describe` block names the audit finding it locks down so a
 * future regression is unambiguous in CI output.
 *
 * Setup: boot a real `serveWeb` against a temp-dir Space, mint one
 * admin (token captured for Bearer-auth tests), and register a single
 * HumanParticipant (`worker-1`) whose worker cookie we also capture.
 * Tests then make plain `fetch` calls and assert status codes — no
 * supertest-style abstraction, the surface is small enough that the
 * raw HTTP is the clearer documentation.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  Hub,
  HumanParticipant,
  Space,
  type AdminRecord,
  type Task,
  type WorkerRecord,
} from '@gotong/core'

import { serveWeb, type WebServerHandle } from '../src/server.js'

interface BootResult {
  tmp: string
  hub: Hub
  server: WebServerHandle
  baseUrl: string
  admin: AdminRecord
  adminToken: string
  adminCookie: string
  worker: WorkerRecord
  workerCookie: string
  workerHuman: HumanParticipant
}

async function boot(opts: { trustProxy?: boolean } = {}): Promise<BootResult> {
  const tmp = await mkdtemp(join(tmpdir(), 'gotong-web-auth-'))
  const init = await Space.init(tmp, { name: 'auth-test' })
  const space = init.space
  const hub = new Hub({ space })
  await hub.start()

  // Mint an admin — Space.createAdmin returns the plaintext token once.
  const { admin, token: adminToken } = await space.createAdmin('TestAdmin')

  // Register a HumanParticipant + create a worker row that the cookie
  // path will recognise as the same id.
  const { worker } = await space.createWorker('worker-1', ['review'])
  const workerHuman = new HumanParticipant({
    id: worker.id,
    capabilities: worker.capabilities,
  })
  hub.register(workerHuman)
  // Worker session cookie — same scheme the POST /api/workers handler
  // mints internally, just bypassed here so tests don't need to call it.
  const workerSid = 'w-test-sid-' + Math.random().toString(36).slice(2)
  await space.addWorkerSession(workerSid, worker.id)
  const workerCookie = `gotong_worker=${workerSid}`

  // Admin session cookie — token-login produces a session row; mint it
  // directly here for the same reason.
  const adminSid = 'a-test-sid-' + Math.random().toString(36).slice(2)
  await space.addAdminSession(adminSid, admin.id)
  const adminCookie = `gotong_admin=${adminSid}`

  const server = await serveWeb(hub, {
    host: '127.0.0.1',
    port: 0,
    trustProxy: opts.trustProxy ?? false,
    // tight worker-create budget so the S6 rate-limit test doesn't have
    // to spam 30 reqs; keep adminLoginRateLimit default
    workerCreateRateLimit: { max: 2, windowSec: 60 },
  })

  return {
    tmp,
    hub,
    server,
    baseUrl: server.url,
    admin,
    adminToken,
    adminCookie,
    worker,
    workerCookie,
    workerHuman,
  }
}

async function teardown(b: BootResult): Promise<void> {
  await b.server.close()
  await b.hub.stop()
  await rm(b.tmp, { recursive: true, force: true })
}

// --- helpers --------------------------------------------------------------

/**
 * Dispatch a task to the worker without waiting for completion. The Hub
 * resolves `dispatch(...)` only when the human finishes the task, so
 * awaiting it deadlocks the test — we want the task to sit in
 * `workerHuman.pending()` so the test can probe the HTTP endpoint that
 * completes it. The returned promise is held but never awaited; we
 * attach a `.catch` to suppress unhandled-rejection noise when the
 * server-side outcome is irrelevant to the test (e.g. 403 paths leave
 * the task pending forever).
 */
async function dispatchTaskToWorker(b: BootResult): Promise<Task> {
  void b.hub
    .dispatch({
      payload: { question: 'is this thing on?' },
      strategy: { kind: 'explicit', to: b.worker.id },
    })
    .catch(() => {
      /* test isn't checking the dispatch outcome */
    })
  // Wait for the task to materialise in the assignee's pending queue —
  // dispatch is async; one microtask + macrotask is enough.
  for (let i = 0; i < 50; i++) {
    const pending = b.workerHuman.pending()
    if (pending.length > 0) return pending[pending.length - 1]!
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('dispatchTaskToWorker: task never landed in pending()')
}

// =========================================================================
// S2 — GET /api/stream must require auth
// =========================================================================

describe('S2: /api/stream requires auth', () => {
  let b: BootResult
  beforeEach(async () => { b = await boot() })
  afterEach(async () => { await teardown(b) })

  it('returns 401 when no admin/worker auth is presented', async () => {
    const r = await fetch(`${b.baseUrl}/api/stream`)
    expect(r.status).toBe(401)
    // SSE never started — no content-type: event-stream
    expect(r.headers.get('content-type') ?? '').not.toMatch(/event-stream/)
  })

  it('opens the SSE stream when an admin cookie is presented', async () => {
    // We don't keep the stream open here — just probe that the headers
    // come back as SSE and the status is 200. AbortController immediately
    // cancels so the stream cleanup path fires.
    const ctl = new AbortController()
    const r = await fetch(`${b.baseUrl}/api/stream`, {
      headers: { cookie: b.adminCookie },
      signal: ctl.signal,
    }).catch(() => null)
    // The server writes headers synchronously; we just need to observe
    // the status before we abort. If the abort raced us, the status
    // we got is still meaningful.
    if (r) {
      expect(r.status).toBe(200)
      expect(r.headers.get('content-type') ?? '').toMatch(/event-stream/)
    }
    ctl.abort()
  })

  it('opens the SSE stream when a worker cookie is presented', async () => {
    const ctl = new AbortController()
    const r = await fetch(`${b.baseUrl}/api/stream`, {
      headers: { cookie: b.workerCookie },
      signal: ctl.signal,
    }).catch(() => null)
    if (r) {
      expect(r.status).toBe(200)
      expect(r.headers.get('content-type') ?? '').toMatch(/event-stream/)
    }
    ctl.abort()
  })
})

// =========================================================================
// S3 — GET /api/state must require auth
// =========================================================================

describe('S3: /api/state requires auth', () => {
  let b: BootResult
  beforeEach(async () => { b = await boot() })
  afterEach(async () => { await teardown(b) })

  it('returns 401 unauthenticated', async () => {
    const r = await fetch(`${b.baseUrl}/api/state`)
    expect(r.status).toBe(401)
  })

  it('returns 200 with admin cookie and a snapshot payload', async () => {
    const r = await fetch(`${b.baseUrl}/api/state`, {
      headers: { cookie: b.adminCookie },
    })
    expect(r.status).toBe(200)
    const body = await r.json() as Record<string, unknown>
    // Sanity: snapshot contains the participants array.
    expect(body).toHaveProperty('participants')
    expect(body).toHaveProperty('transcript')
  })

  it('returns 200 with worker cookie', async () => {
    const r = await fetch(`${b.baseUrl}/api/state`, {
      headers: { cookie: b.workerCookie },
    })
    expect(r.status).toBe(200)
  })

  it('returns 200 with admin Bearer token', async () => {
    const r = await fetch(`${b.baseUrl}/api/state`, {
      headers: { authorization: `Bearer ${b.adminToken}` },
    })
    expect(r.status).toBe(200)
  })
})

// =========================================================================
// S1 — POST /api/tasks/:id/(complete|reject) must require auth
// =========================================================================

describe('S1: /api/tasks/:id/complete requires assignee or admin', () => {
  let b: BootResult
  beforeEach(async () => { b = await boot() })
  afterEach(async () => { await teardown(b) })

  it('returns 403 unauthenticated (cannot hijack another human\'s task)', async () => {
    const task = await dispatchTaskToWorker(b)
    const r = await fetch(`${b.baseUrl}/api/tasks/${task.id}/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ output: { hijacked: true } }),
    })
    expect(r.status).toBe(403)
    // Task should still be pending on the worker.
    expect(b.workerHuman.pending().some((t) => t.id === task.id)).toBe(true)
  })

  it('returns 200 when the assigned worker completes via their own cookie', async () => {
    const task = await dispatchTaskToWorker(b)
    const r = await fetch(`${b.baseUrl}/api/tasks/${task.id}/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: b.workerCookie },
      body: JSON.stringify({ output: { answer: 42 } }),
    })
    expect(r.status).toBe(200)
    expect(b.workerHuman.pending().some((t) => t.id === task.id)).toBe(false)
  })

  it('returns 200 when admin completes on a worker\'s behalf', async () => {
    const task = await dispatchTaskToWorker(b)
    const r = await fetch(`${b.baseUrl}/api/tasks/${task.id}/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: b.adminCookie },
      body: JSON.stringify({ output: { closed_by: 'admin' } }),
    })
    expect(r.status).toBe(200)
    expect(b.workerHuman.pending().some((t) => t.id === task.id)).toBe(false)
  })

  it('returns 403 when a different worker tries to complete', async () => {
    // Mint a second worker that is NOT the task assignee.
    const { worker: other } = await b.hub.space!.createWorker('other-worker', [])
    const otherSid = 'o-' + Math.random().toString(36).slice(2)
    await b.hub.space!.addWorkerSession(otherSid, other.id)
    const otherCookie = `gotong_worker=${otherSid}`
    const task = await dispatchTaskToWorker(b)
    const r = await fetch(`${b.baseUrl}/api/tasks/${task.id}/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: otherCookie },
      body: JSON.stringify({ output: { hijacked: true } }),
    })
    expect(r.status).toBe(403)
    // Original task untouched.
    expect(b.workerHuman.pending().some((t) => t.id === task.id)).toBe(true)
  })

  it('returns 404 for an unknown task id even when authenticated', async () => {
    const r = await fetch(`${b.baseUrl}/api/tasks/no-such-task/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: b.adminCookie },
      body: JSON.stringify({ output: {} }),
    })
    expect(r.status).toBe(404)
  })
})

// =========================================================================
// S4 — /admin?token=… must refuse to overwrite an existing admin cookie
// =========================================================================

describe('S4: /admin?token rejects session fixation', () => {
  let b: BootResult
  beforeEach(async () => { b = await boot() })
  afterEach(async () => { await teardown(b) })

  it('returns 409 when a valid admin cookie is already present', async () => {
    // Visit /admin?token=<bytes> while carrying an admin cookie — the
    // server must NOT silently swap the cookie for a session bound to
    // whoever owns the token.
    const r = await fetch(`${b.baseUrl}/admin?token=${b.adminToken}`, {
      headers: { cookie: b.adminCookie },
      redirect: 'manual',
    })
    expect(r.status).toBe(409)
    // No Set-Cookie should have been written — the existing cookie wins.
    const setCookie = r.headers.get('set-cookie')
    expect(setCookie).toBeNull()
  })

  it('accepts the token-login when no cookie is present', async () => {
    const r = await fetch(`${b.baseUrl}/admin?token=${b.adminToken}`, {
      redirect: 'manual',
    })
    expect(r.status).toBe(302)
    expect(r.headers.get('set-cookie') ?? '').toMatch(/gotong_admin=/)
  })
})

// =========================================================================
// S5 — clientIp must ignore X-Forwarded-For unless trustProxy=true
// =========================================================================

describe('S5: X-Forwarded-For is ignored unless trustProxy=true', () => {
  it('rate-limit cannot be bypassed by rotating XFF when trustProxy=false', async () => {
    const b = await boot({ trustProxy: false })
    try {
      // Use a tiny worker-create budget (set to 2 in boot) so we can
      // exhaust it within a handful of requests. After hitting the cap
      // from one peer IP, sending a different XFF should NOT reset
      // the budget — all requests share the same socket.remoteAddress.
      const make = async (xff: string, body: string) =>
        fetch(`${b.baseUrl}/api/workers`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-forwarded-for': xff },
          body,
        })

      const r1 = await make('1.1.1.1', JSON.stringify({ id: 'spam-1', capabilities: [] }))
      const r2 = await make('2.2.2.2', JSON.stringify({ id: 'spam-2', capabilities: [] }))
      // Both succeed — under budget.
      expect(r1.status).toBe(200)
      expect(r2.status).toBe(200)
      // Third attempt: bumps over the 2/min cap. The attacker sends a
      // fresh XFF hoping for a fresh bucket; trustProxy=false ignores
      // it, so we still hit 429.
      const r3 = await make('3.3.3.3', JSON.stringify({ id: 'spam-3', capabilities: [] }))
      expect(r3.status).toBe(429)
    } finally {
      await teardown(b)
    }
  })

  // We intentionally don't test the trustProxy=true success path here:
  // simulating a real proxy on localhost is brittle, and the change is
  // a one-line conditional — the off path being correct is the bug
  // that mattered, the on path is just "use XFF when told to".
})

// =========================================================================
// S6 — POST /api/workers must rate-limit per-IP
// =========================================================================

describe('S6: /api/workers is rate-limited per IP', () => {
  let b: BootResult
  beforeEach(async () => { b = await boot() })
  afterEach(async () => { await teardown(b) })

  it('returns 429 after exhausting the budget', async () => {
    const post = async (id: string) =>
      fetch(`${b.baseUrl}/api/workers`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, capabilities: [] }),
      })
    const r1 = await post('alpha')
    const r2 = await post('bravo')
    expect(r1.status).toBe(200)
    expect(r2.status).toBe(200)
    // Budget set to 2 in boot(); third should bounce.
    const r3 = await post('charlie')
    expect(r3.status).toBe(429)
    expect(r3.headers.get('retry-after')).toBe('60')
  })
})
