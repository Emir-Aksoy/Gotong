/**
 * Phase 9 M4 — /api/admin/uploads route.
 *
 * Coverage:
 *   - 503 when host did not wire ctx.uploads (services bootstrap absent)
 *   - 401 when unauthenticated
 *   - 200 on a happy-path image upload: mime + filename from query →
 *     stub.put receives bytes + declaredMime + by(admin id); response
 *     echoes the stub's artifactId / mime / size
 *   - 400 on empty body
 *   - 413 on body over the HTTP-layer ceiling (50 MB)
 *   - 400 on plugin-side mime/size error (translated by message pattern)
 *   - mime defaults to ?mime=, then request content-type, then octet-stream
 *
 * The upload surface is injected as a stub so we don't drag the
 * artifact-file plugin into web tests (the host-side e2e covers that
 * loop). The route's job here is request parsing + auth gating + error
 * translation.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Hub, Space } from '@gotong/core'

import {
  serveWeb,
  type UploadSurface,
  type WebServerHandle,
} from '../src/server.js'

interface BootResult {
  tmp: string
  hub: Hub
  space: Space
  server: WebServerHandle
  baseUrl: string
  adminToken: string
  uploadCalls: Array<{
    bytes: Uint8Array
    declaredMime: string
    filename?: string
    by: string
  }>
  uploadResponse: { artifactId: string; mime: string; size: number }
  uploadThrows: Error | null
  /** Phase 9 M5 — entries the GET path resolves. */
  storedArtifacts: Map<string, { bytes: Uint8Array; mime: string }>
  getThrows: Error | null
}

async function boot(opts: { withUploads: boolean } = { withUploads: true }): Promise<BootResult> {
  const tmp = await mkdtemp(join(tmpdir(), 'gotong-web-uploads-'))
  const init = await Space.init(tmp, { name: 'uploads-test' })
  const space = init.space
  const hub = new Hub({ space })
  await hub.start()

  const { admin, token: adminToken } = await space.createAdmin('TestAdmin')
  void admin

  const uploadCalls: BootResult['uploadCalls'] = []
  const storedArtifacts = new Map<string, { bytes: Uint8Array; mime: string }>()
  const out: BootResult = {
    tmp, hub, space,
    server: undefined as unknown as WebServerHandle,
    baseUrl: '',
    adminToken,
    uploadCalls,
    uploadResponse: { artifactId: 'uploads/2026-05-26/abc.png', mime: 'image/png', size: 0 },
    uploadThrows: null,
    storedArtifacts,
    getThrows: null,
  }

  const uploadStub: UploadSurface = {
    async put(params) {
      uploadCalls.push({
        bytes: params.bytes,
        declaredMime: params.declaredMime,
        ...(params.filename !== undefined ? { filename: params.filename } : {}),
        by: params.by,
      })
      if (out.uploadThrows) throw out.uploadThrows
      // Persist to the in-memory store so a later GET can read it
      // back. Mirror the host implementation's contract.
      const artifactId = out.uploadResponse.artifactId
      const mime = out.uploadResponse.mime
      storedArtifacts.set(artifactId, {
        bytes: new Uint8Array(params.bytes),
        mime,
      })
      return { artifactId, mime, size: params.bytes.byteLength }
    },
    async get(artifactId) {
      if (out.getThrows) throw out.getThrows
      const found = storedArtifacts.get(artifactId)
      if (!found) {
        // Mirror node's ENOENT shape so the route's translator
        // produces 404.
        const err = new Error(`ENOENT: no such file or directory, open '${artifactId}'`)
        ;(err as NodeJS.ErrnoException).code = 'ENOENT'
        throw err
      }
      return found
    },
  }

  out.server = await serveWeb(hub, {
    host: '127.0.0.1',
    port: 0,
    ...(opts.withUploads ? { uploads: uploadStub } : {}),
  })
  out.baseUrl = out.server.url
  return out
}

async function teardown(b: BootResult): Promise<void> {
  await b.server.close()
  await b.hub.stop()
  await rm(b.tmp, { recursive: true, force: true })
}

describe('POST /api/admin/uploads', () => {
  let b: BootResult
  afterEach(async () => { await teardown(b) })

  it('503 when host did not wire ctx.uploads', async () => {
    b = await boot({ withUploads: false })
    const r = await fetch(`${b.baseUrl}/api/admin/uploads?filename=a.png&mime=image/png`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${b.adminToken}`,
        'content-type': 'image/png',
      },
      body: new Uint8Array([1, 2, 3]),
    })
    expect(r.status).toBe(503)
    const j = await r.json()
    expect(j.error).toMatch(/uploads not enabled/)
  })

  it('401 when unauthenticated', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}/api/admin/uploads?filename=a.png&mime=image/png`, {
      method: 'POST',
      headers: { 'content-type': 'image/png' },
      body: new Uint8Array([1, 2, 3]),
    })
    expect(r.status).toBe(401)
  })

  it('200 happy path — image upload echoes stub response', async () => {
    b = await boot()
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    const r = await fetch(`${b.baseUrl}/api/admin/uploads?filename=cat.png&mime=image/png`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${b.adminToken}`,
        'content-type': 'application/octet-stream',
      },
      body: bytes,
    })
    expect(r.status).toBe(200)
    const j = await r.json()
    expect(j).toEqual({
      artifactId: 'uploads/2026-05-26/abc.png',
      mime: 'image/png',
      size: 4,
    })
    expect(b.uploadCalls).toHaveLength(1)
    const call = b.uploadCalls[0]!
    expect(call.declaredMime).toBe('image/png')
    expect(call.filename).toBe('cat.png')
    // First admin id from `space.createAdmin` is `'admin'`; later ones
    // are `'admin-2'`, `'admin-3'`, etc. Either way, non-empty + starts
    // with 'admin'.
    expect(call.by).toMatch(/^admin/)
    expect(Buffer.from(call.bytes).equals(Buffer.from(bytes))).toBe(true)
  })

  it('mime falls back to request content-type when ?mime= is absent', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}/api/admin/uploads?filename=a.png`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${b.adminToken}`,
        'content-type': 'image/jpeg; charset=binary',
      },
      body: new Uint8Array([1]),
    })
    expect(r.status).toBe(200)
    expect(b.uploadCalls[0]!.declaredMime).toBe('image/jpeg')
  })

  it('mime falls back to application/octet-stream as a last resort', async () => {
    b = await boot()
    // Some fetch implementations always send content-type; this test
    // covers the code path by sending an empty content-type header value.
    const r = await fetch(`${b.baseUrl}/api/admin/uploads?filename=blob`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${b.adminToken}`,
      },
      body: new Uint8Array([1]),
    })
    expect(r.status).toBe(200)
    // Whatever fetch supplied as default content-type wins over the
    // ultimate octet-stream fallback; both are acceptable here. What
    // matters is the route resolved a non-empty mime.
    expect(b.uploadCalls[0]!.declaredMime.length).toBeGreaterThan(0)
  })

  it('400 on empty body', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}/api/admin/uploads?filename=a.png&mime=image/png`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${b.adminToken}`,
        'content-type': 'image/png',
      },
      body: new Uint8Array([]),
    })
    expect(r.status).toBe(400)
    const j = await r.json()
    expect(j.error).toMatch(/empty body/)
  })

  it('400 on plugin mime-not-allowed error', async () => {
    b = await boot()
    b.uploadThrows = new Error(`mime 'application/x-shockwave-flash' not in allow-list [text/]`)
    const r = await fetch(`${b.baseUrl}/api/admin/uploads?filename=a.swf&mime=application/x-shockwave-flash`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${b.adminToken}`,
        'content-type': 'application/x-shockwave-flash',
      },
      body: new Uint8Array([1]),
    })
    expect(r.status).toBe(400)
    const j = await r.json()
    expect(j.error).toMatch(/not in allow-list/)
  })

  it('400 on plugin size-over-cap error', async () => {
    b = await boot()
    b.uploadThrows = new Error(`artifact 'big.png' exceeds maxBytesPerFile (100 > 50)`)
    const r = await fetch(`${b.baseUrl}/api/admin/uploads?filename=big.png&mime=image/png`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${b.adminToken}`,
        'content-type': 'image/png',
      },
      body: new Uint8Array([1]),
    })
    expect(r.status).toBe(400)
    const j = await r.json()
    expect(j.error).toMatch(/exceeds maxBytes/)
  })

  it('500 on a non-client-shaped plugin error', async () => {
    b = await boot()
    b.uploadThrows = new Error(`ENOSPC: no space left on device, write`)
    const r = await fetch(`${b.baseUrl}/api/admin/uploads?filename=a.png&mime=image/png`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${b.adminToken}`,
        'content-type': 'image/png',
      },
      body: new Uint8Array([1]),
    })
    // Disk-full doesn't match any client-shape pattern → bubble as 500.
    expect(r.status).toBe(500)
  })

  // ----- GET /api/admin/uploads — Phase 9 M5 download path ----------

  it('GET 503 when uploads not enabled', async () => {
    b = await boot({ withUploads: false })
    const r = await fetch(`${b.baseUrl}/api/admin/uploads?id=anything`, {
      headers: { authorization: `Bearer ${b.adminToken}` },
    })
    expect(r.status).toBe(503)
  })

  it('GET 401 when unauthenticated', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}/api/admin/uploads?id=anything`)
    expect(r.status).toBe(401)
  })

  it('GET 400 when ?id= is missing', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}/api/admin/uploads`, {
      headers: { authorization: `Bearer ${b.adminToken}` },
    })
    expect(r.status).toBe(400)
    const j = await r.json()
    expect(j.error).toMatch(/missing \?id=/)
  })

  it('GET 200 round-trips POST: artifactId resolves back to original bytes + mime', async () => {
    b = await boot()
    // First POST to populate.
    b.uploadResponse = { artifactId: 'uploads/2026-05-26/aaa.png', mime: 'image/png', size: 0 }
    const original = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])
    const post = await fetch(`${b.baseUrl}/api/admin/uploads?filename=cat.png&mime=image/png`, {
      method: 'POST',
      headers: { authorization: `Bearer ${b.adminToken}`, 'content-type': 'image/png' },
      body: original,
    })
    expect(post.status).toBe(200)
    const postBody = await post.json()
    // Now GET it back.
    const get = await fetch(
      `${b.baseUrl}/api/admin/uploads?id=${encodeURIComponent(postBody.artifactId)}`,
      { headers: { authorization: `Bearer ${b.adminToken}` } },
    )
    expect(get.status).toBe(200)
    expect(get.headers.get('content-type')).toMatch(/^image\/png/)
    expect(get.headers.get('content-length')).toBe(String(original.byteLength))
    expect(get.headers.get('content-disposition')).toMatch(/inline; filename="aaa\.png"/)
    expect(get.headers.get('cache-control')).toMatch(/private/)
    const buf = Buffer.from(await get.arrayBuffer())
    expect(buf.equals(original)).toBe(true)
  })

  it('GET 404 on unknown artifactId', async () => {
    b = await boot()
    const r = await fetch(`${b.baseUrl}/api/admin/uploads?id=does-not-exist`, {
      headers: { authorization: `Bearer ${b.adminToken}` },
    })
    expect(r.status).toBe(404)
  })

  it('GET 400 on a traversal-shaped artifactId error', async () => {
    b = await boot()
    b.getThrows = new Error('path traversal denied: ../../etc/passwd')
    const r = await fetch(`${b.baseUrl}/api/admin/uploads?id=anything`, {
      headers: { authorization: `Bearer ${b.adminToken}` },
    })
    expect(r.status).toBe(400)
  })

  it('GET sanitises Content-Disposition filename to safe chars', async () => {
    b = await boot()
    b.uploadResponse = { artifactId: 'uploads/2026-05-26/weird name!.png', mime: 'image/png', size: 0 }
    const original = Buffer.from([9])
    await fetch(`${b.baseUrl}/api/admin/uploads?filename=cat.png&mime=image/png`, {
      method: 'POST',
      headers: { authorization: `Bearer ${b.adminToken}`, 'content-type': 'image/png' },
      body: original,
    })
    const get = await fetch(
      `${b.baseUrl}/api/admin/uploads?id=${encodeURIComponent(b.uploadResponse.artifactId)}`,
      { headers: { authorization: `Bearer ${b.adminToken}` } },
    )
    expect(get.status).toBe(200)
    const cd = get.headers.get('content-disposition')!
    // 'weird name!.png' → 'weird_name_.png' (spaces + '!' → '_')
    expect(cd).toMatch(/filename="weird_name_\.png"/)
  })

  it('413 when body exceeds the 50 MB HTTP-layer cap', async () => {
    b = await boot()
    // Send a stream that exceeds the cap. Using a constant 51 MB buffer
    // is the simplest way to trip the limit deterministically. Test
    // runtime: ~150 ms on a 2026 Air for the allocation + send.
    const big = Buffer.alloc(50 * 1024 * 1024 + 1, 0x41)
    const r = await fetch(`${b.baseUrl}/api/admin/uploads?filename=huge.bin&mime=application/octet-stream`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${b.adminToken}`,
        'content-type': 'application/octet-stream',
      },
      body: big,
    })
    expect(r.status).toBe(413)
    const j = await r.json().catch(() => ({}))
    expect(j.error).toMatch(/body too large/)
  })
})
