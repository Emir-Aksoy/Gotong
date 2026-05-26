/**
 * Phase 9 M4 — uploads surface unit + e2e.
 *
 * Two layers:
 *   1. Unit test: mock HubServices, verify artifactId conventions
 *      (path shape, ext sanitisation, random uniqueness, mime
 *      pass-through) without touching the real plugin loader.
 *   2. E2E: real `@aipehub/service-artifact-file` attach via
 *      `bootstrapServices`, real `put()` writes bytes to disk, and
 *      a fresh attach can read them back via `handle.readBytes()`
 *      (the path Phase 9 M2/M3 providers take for multimodal).
 *
 * Failure cases:
 *   - filename with separators / NUL bytes / weird ext → safe path
 *   - filename absent → no ext, path still valid
 *   - randomness collisions handled by `randomHex` test seam
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createLogger, Hub, Space } from '@aipehub/core'
import type {
  ArtifactHandle,
  AttachedHandle,
  Owner,
} from '@aipehub/services-sdk'

import { bootstrapServices, type HubServices } from '../src/services/index.js'
import { createUploadSurface, UPLOADS_OWNER_REF } from '../src/uploads.js'

const logger = createLogger('uploads-test', { disabled: true })

// ---------------------------------------------------------------------------
// Unit tests — mocked HubServices
// ---------------------------------------------------------------------------

interface FakeHandleCalls {
  writes: Array<{ path: string; bytes: Uint8Array; mime: string | undefined }>
}

function makeFakeServices(calls: FakeHandleCalls): HubServices {
  const handle: ArtifactHandle = {
    async write(path, content, opts) {
      const bytes = typeof content === 'string'
        ? Buffer.from(content, 'utf8')
        : content
      calls.writes.push({ path, bytes, mime: opts?.mime })
      return { ref: path, path, size: bytes.byteLength, ts: 1700000000000, mime: opts?.mime ?? 'application/octet-stream' }
    },
    async read() { throw new Error('not used') },
    async readBytes() { throw new Error('not used') },
    async list() { return [] },
    async exists() { return false },
    async remove() { /* noop */ },
  }
  const attached: AttachedHandle = {
    type: 'artifact',
    impl: 'file',
    owner: UPLOADS_OWNER_REF,
    handle,
  }
  // We only call `services.attach`; cast through unknown to dodge the
  // full HubServices shape — tests in services-e2e.test.ts cover the
  // real wiring.
  return {
    attach: async (_spec) => attached,
  } as unknown as HubServices
}

describe('createUploadSurface (unit)', () => {
  it('writes bytes through the attached handle with declared mime', async () => {
    const calls: FakeHandleCalls = { writes: [] }
    const uploads = await createUploadSurface({
      services: makeFakeServices(calls),
      logger,
      now: () => new Date(Date.UTC(2026, 4, 26)),
      randomHex: () => 'abcdef012345',
    })
    const out = await uploads.put({
      bytes: new Uint8Array([1, 2, 3, 4]),
      declaredMime: 'image/png',
      filename: 'cat.png',
      by: 'admin-1',
    })
    expect(out).toEqual({
      artifactId: 'uploads/2026-05-26/abcdef012345.png',
      mime: 'image/png',
      size: 4,
    })
    expect(calls.writes).toHaveLength(1)
    expect(calls.writes[0]!.path).toBe('uploads/2026-05-26/abcdef012345.png')
    expect(calls.writes[0]!.bytes).toEqual(new Uint8Array([1, 2, 3, 4]))
    expect(calls.writes[0]!.mime).toBe('image/png')
  })

  it('drops unsafe filename components (path separators, NUL)', async () => {
    const calls: FakeHandleCalls = { writes: [] }
    const uploads = await createUploadSurface({
      services: makeFakeServices(calls),
      logger,
      now: () => new Date(Date.UTC(2026, 0, 5)),
      randomHex: () => 'aaaaaaaaaaaa',
    })
    const out = await uploads.put({
      bytes: new Uint8Array([9]),
      declaredMime: 'image/jpeg',
      filename: '../../../etc/passwd.jpg',
      by: 'admin-1',
    })
    // The path-separator stripping keeps only "passwd.jpg" → ".jpg"
    expect(out.artifactId).toBe('uploads/2026-01-05/aaaaaaaaaaaa.jpg')
  })

  it('produces empty ext when filename has none / is invalid', async () => {
    const calls: FakeHandleCalls = { writes: [] }
    const uploads = await createUploadSurface({
      services: makeFakeServices(calls),
      logger,
      now: () => new Date(Date.UTC(2026, 4, 26)),
      randomHex: () => 'bbbbbbbbbbbb',
    })
    // No filename at all
    const a = await uploads.put({
      bytes: new Uint8Array([1]),
      declaredMime: 'application/octet-stream',
      by: 'x',
    })
    expect(a.artifactId).toBe('uploads/2026-05-26/bbbbbbbbbbbb')
    // Filename without dot
    const b = await uploads.put({
      bytes: new Uint8Array([2]),
      declaredMime: 'application/octet-stream',
      filename: 'noext',
      by: 'x',
    })
    expect(b.artifactId).toBe('uploads/2026-05-26/bbbbbbbbbbbb')
    // Extension > 8 chars
    const c = await uploads.put({
      bytes: new Uint8Array([3]),
      declaredMime: 'application/octet-stream',
      filename: 'big.javascriptmodule',
      by: 'x',
    })
    expect(c.artifactId).toBe('uploads/2026-05-26/bbbbbbbbbbbb')
    // Extension with non-alphanum chars sanitised
    const d = await uploads.put({
      bytes: new Uint8Array([4]),
      declaredMime: 'application/octet-stream',
      filename: 'a.PnG!',
      by: 'x',
    })
    // 'P' 'n' 'G' '!' → lowercased + non-alphanum stripped = 'png'
    expect(d.artifactId).toBe('uploads/2026-05-26/bbbbbbbbbbbb.png')
  })

  it('different random hex → different artifactIds for back-to-back uploads', async () => {
    const calls: FakeHandleCalls = { writes: [] }
    let counter = 0
    const randomHex = () => ['111111111111', '222222222222', '333333333333'][counter++]!
    const uploads = await createUploadSurface({
      services: makeFakeServices(calls),
      logger,
      now: () => new Date(Date.UTC(2026, 4, 26)),
      randomHex,
    })
    const a = await uploads.put({ bytes: new Uint8Array([1]), declaredMime: 'image/png', by: 'x' })
    const b = await uploads.put({ bytes: new Uint8Array([2]), declaredMime: 'image/png', by: 'x' })
    const c = await uploads.put({ bytes: new Uint8Array([3]), declaredMime: 'image/png', by: 'x' })
    expect(new Set([a.artifactId, b.artifactId, c.artifactId]).size).toBe(3)
    expect(a.artifactId).toBe('uploads/2026-05-26/111111111111')
    expect(b.artifactId).toBe('uploads/2026-05-26/222222222222')
    expect(c.artifactId).toBe('uploads/2026-05-26/333333333333')
  })

  it('UPLOADS_OWNER_REF is the shared/uploads owner', () => {
    const expected: Owner = { kind: 'shared', id: 'uploads' }
    expect(UPLOADS_OWNER_REF).toEqual(expected)
  })

  it('get() proxies to handle.readBytes', async () => {
    // The fake handle's readBytes was a stub; rewrite it inline to
    // verify the upload surface's `get` delegates with the right
    // artifactId.
    const captured: { calls: string[] } = { calls: [] }
    const handle = {
      async write(path: string, _content: string | Uint8Array, opts?: { mime?: string }) {
        return { ref: path, path, size: 0, ts: 0, mime: opts?.mime ?? 'application/octet-stream' }
      },
      async read() { throw new Error('unused') },
      async readBytes(refOrPath: string) {
        captured.calls.push(refOrPath)
        return { bytes: new Uint8Array([7, 7, 7]), mime: 'image/png' }
      },
      async list() { return [] },
      async exists() { return false },
      async remove() { /* noop */ },
    }
    const fakeServices = {
      attach: async () => ({
        type: 'artifact', impl: 'file', owner: UPLOADS_OWNER_REF, handle,
      }),
    } as unknown as HubServices
    const uploads = await createUploadSurface({ services: fakeServices, logger })
    const out = await uploads.get('uploads/2026-05-26/abc.png')
    expect(captured.calls).toEqual(['uploads/2026-05-26/abc.png'])
    expect(Array.from(out.bytes)).toEqual([7, 7, 7])
    expect(out.mime).toBe('image/png')
  })
})

// ---------------------------------------------------------------------------
// E2E — real artifact-file plugin
// ---------------------------------------------------------------------------

describe('createUploadSurface (e2e via real artifact-file plugin)', () => {
  let root: string
  let space: Space
  let hub: Hub
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'aipe-uploads-e2e-'))
    await rm(root, { recursive: true, force: true })
    const opened = await Space.init(root, { name: 'test' })
    space = opened.space
    hub = new Hub({ space })
    await hub.start()
    // Pin the manifest to only artifact-file (skip memory + datastore
    // for a leaner e2e).
    await writeFile(
      join(space.paths.services, 'plugins.json'),
      JSON.stringify({ plugins: ['@aipehub/service-artifact-file'] }, null, 2) + '\n',
      'utf8',
    )
  })
  afterEach(async () => {
    await hub.stop()
    await rm(root, { recursive: true, force: true })
  })

  it('boots, attaches, persists bytes to disk, readBytes returns the same bytes', async () => {
    const boot = await bootstrapServices({ space, hub, logger })
    const uploads = await createUploadSurface({
      services: boot.services,
      logger,
    })
    const original = Buffer.from('hello phase 9 multimodal\n')
    const out = await uploads.put({
      bytes: original,
      declaredMime: 'text/plain',
      filename: 'hi.txt',
      by: 'admin-e2e',
    })
    expect(out.artifactId).toMatch(/^uploads\/\d{4}-\d{2}-\d{2}\/[0-9a-f]{12}\.txt$/)
    expect(out.mime).toBe('text/plain')
    expect(out.size).toBe(original.byteLength)

    // Verify on disk — `shared/uploads/<artifactId>` is the canonical
    // path artifact-file uses for `{ kind: 'shared', id: 'uploads' }`.
    const onDisk = await readFile(
      join(space.paths.services, 'artifact', 'file', 'shared', 'uploads', out.artifactId),
    )
    expect(onDisk.equals(original)).toBe(true)

    // Verify resolver path — attach a fresh handle (same owner) and
    // `readBytes` returns the same bytes + same mime. This is the
    // pathway Phase 9 M2/M3 providers take when resolving a
    // FileRefBlock from `artifactId`.
    const second = await boot.services.attach({
      type: 'artifact',
      impl: 'file',
      owner: UPLOADS_OWNER_REF,
      config: {
        name: 'system-uploads',
        maxBytesPerFile: 50 * 1024 * 1024,
        allowedMimePrefixes: ['*'],
      },
    })
    const handle = second.handle as ArtifactHandle
    const read = await handle.readBytes(out.artifactId)
    expect(Buffer.from(read.bytes).equals(original)).toBe(true)
    expect(read.mime).toBe('text/plain')

    // Phase 9 M5 — same `uploads` surface can also GET via .get().
    // This is the path /api/admin/uploads (GET) takes when rendering
    // a file_ref in the admin UI.
    const back = await uploads.get(out.artifactId)
    expect(Buffer.from(back.bytes).equals(original)).toBe(true)
    expect(back.mime).toBe('text/plain')
  })

  it('e2e: rejects an artifact larger than the plugin cap (50 MB) but accepts 1 MB', async () => {
    const boot = await bootstrapServices({ space, hub, logger })
    const uploads = await createUploadSurface({
      services: boot.services,
      logger,
    })
    // 1 MB OK — well under the 50 MB cap.
    const okay = Buffer.alloc(1024 * 1024, 0x41)
    const out = await uploads.put({
      bytes: okay,
      declaredMime: 'application/octet-stream',
      filename: 'a.bin',
      by: 'admin',
    })
    expect(out.size).toBe(1024 * 1024)
    // The 50 MB cap is enforced at the plugin level by the
    // service-artifact-file's `maxBytesPerFile` config the upload
    // surface seeds. We assert just above the boundary.
    const over = Buffer.alloc(50 * 1024 * 1024 + 1, 0x42)
    await expect(
      uploads.put({
        bytes: over,
        declaredMime: 'application/octet-stream',
        filename: 'b.bin',
        by: 'admin',
      }),
    ).rejects.toThrow(/exceeds maxBytesPerFile/)
  })
})
