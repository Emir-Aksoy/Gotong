/**
 * Route handlers for file upload / download (Phase 9 multimodal).
 *
 * Extracted from server.ts in the P3 audit cleanup.
 *
 * Routes handled:
 *   GET   /api/admin/uploads   download an artifact by ?id=
 *   POST  /api/admin/uploads   upload raw octet-stream
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { sendJson } from './http-helpers.js'
import type { AdminRecord, ParticipantId } from '@gotong/core'
import { createLogger } from '@gotong/core'

const log = createLogger('uploads-routes')

// -- types ----------------------------------------------------------------

/** Mirrors the UploadSurface defined in server.ts / WebServerOptions. */
export interface UploadsRouteSurface {
  put(params: {
    bytes: Uint8Array
    declaredMime: string
    filename?: string
    by: ParticipantId
  }): Promise<{ artifactId: string; mime: string; size: number }>
  get(artifactId: string): Promise<{ bytes: Uint8Array; mime: string }>
}

export interface UploadsRoutesCtx {
  uploads?: UploadsRouteSurface
  requireAdmin: (req: IncomingMessage, res: ServerResponse) => Promise<AdminRecord | null>
}

// -- HTTP helpers ---------------------------------------------------------

export function readRawBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    req.on('data', (chunk: Buffer | string) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      total += buf.length
      if (total > maxBytes) {
        req.destroy()
        reject(new Error(`body too large (limit ${maxBytes} bytes)`))
        return
      }
      chunks.push(buf)
    })
    req.on('end', () => resolve(Buffer.concat(chunks, total)))
    req.on('error', reject)
  })
}

// -- route handler --------------------------------------------------------

/**
 * Handle `/api/admin/uploads` routes.
 * Returns `true` if the request was handled, `false` otherwise.
 */
export async function handleUploadsRoute(
  ctx: UploadsRoutesCtx,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
): Promise<boolean> {
  if (path !== '/api/admin/uploads') return false

  // --- download ---
  if (method === 'GET') {
    const admin = await ctx.requireAdmin(req, res)
    if (!admin) return true
    if (!ctx.uploads) {
      sendJson(res, { error: 'uploads not enabled on this host' }, 503)
      return true
    }
    const u = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
    const id = u.searchParams.get('id')
    if (!id) {
      sendJson(res, { error: 'missing ?id=<artifactId>' }, 400)
      return true
    }
    try {
      const { bytes, mime } = await ctx.uploads.get(id)
      const filename = id.split('/').pop() ?? 'artifact'
      const safeFilename = filename.replace(/[^A-Za-z0-9._-]/g, '_')
      res.writeHead(200, {
        'content-type': mime || 'application/octet-stream',
        'content-length': String(bytes.byteLength),
        'content-disposition': `inline; filename="${safeFilename}"`,
        'cache-control': 'private, max-age=300',
      })
      res.end(Buffer.from(bytes))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const lower = msg.toLowerCase()
      const code = lower.includes('enoent') || lower.includes('no such file')
        ? 404
        : (/traversal|relative|null byte/.test(msg) ? 400 : 500)
      sendJson(res, { error: msg }, code)
    }
    return true
  }

  // --- upload ---
  if (method === 'POST') {
    const admin = await ctx.requireAdmin(req, res)
    if (!admin) return true
    if (!ctx.uploads) {
      sendJson(res, { error: 'uploads not enabled on this host' }, 503)
      return true
    }
    const u = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
    const filename = u.searchParams.get('filename') || undefined
    const declaredMime =
      u.searchParams.get('mime')
      || (typeof req.headers['content-type'] === 'string'
          ? req.headers['content-type']!.split(';')[0]!.trim()
          : '')
      || 'application/octet-stream'

    const HARD_CEILING_BYTES = 50 * 1024 * 1024
    const declaredLen = Number.parseInt(
      typeof req.headers['content-length'] === 'string' ? req.headers['content-length'] : '',
      10,
    )
    if (Number.isFinite(declaredLen) && declaredLen > HARD_CEILING_BYTES) {
      sendJson(res, { error: `body too large (limit ${HARD_CEILING_BYTES} bytes)` }, 413)
      req.resume()
      return true
    }
    let bytes: Buffer
    try {
      bytes = await readRawBody(req, HARD_CEILING_BYTES)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const code = msg.startsWith('body too large') ? 413 : 400
      sendJson(res, { error: msg }, code)
      return true
    }
    if (bytes.length === 0) {
      sendJson(res, { error: 'empty body (no file content)' }, 400)
      return true
    }
    try {
      const put = await ctx.uploads.put({
        bytes,
        declaredMime,
        ...(filename ? { filename } : {}),
        by: admin.id,
      })
      sendJson(res, put)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.warn('upload rejected', { by: admin.id, mime: declaredMime, size: bytes.length, err: msg })
      const isClientError = /mime|exceeds maxBytes|traversal|relative|null byte/.test(msg)
      sendJson(res, { error: msg }, isClientError ? 400 : 500)
    }
    return true
  }

  return false
}
