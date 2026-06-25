/**
 * Shared HTTP request/response helpers for the admin + member route
 * modules.
 *
 * Every route file used to carry a near-identical private copy of these
 * (8× `sendJson`, 7× `readJsonBody`, 3× `readTextBody`, 2× each cookie /
 * bearer reader). C3 in docs/zh/TECH-DEBT-2026-05.md collapses them here.
 *
 * Pure — depends only on the node:http types, never on an app-layer
 * module, so any route file can import it without risking a cycle.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

/**
 * 1 MB ceiling on a buffered request body. A runaway client can't grow
 * `buf` without bound and OOM the process. Upload routes that legitimately
 * need more read raw bytes through their own `readRawBody(req, maxBytes)`.
 */
export const MAX_BODY_BYTES = 1_000_000

/** Write `data` as a JSON response with the given status (default 200). */
export function sendJson(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data))
}

/**
 * Buffer a request body as a UTF-8 string, enforcing {@link MAX_BODY_BYTES}
 * on the *byte* length rather than the accumulated string's `.length`.
 *
 * Node delivers `data` chunks as Buffers; `String(chunk).length` counts
 * UTF-16 code units, and CJK text is 3 UTF-8 bytes per single code unit — so
 * a `.length` check silently let a body grow to ~3× the intended ceiling
 * before tripping. Counting bytes incrementally keeps the cap honest (and
 * still bounds memory: we reject before `buf` can grow past the limit).
 */
function bufferBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = ''
    let bytes = 0
    req.on('data', (chunk: Buffer | string) => {
      bytes += Buffer.byteLength(chunk)
      if (bytes > MAX_BODY_BYTES) {
        req.destroy()
        reject(new Error('body too large'))
        return
      }
      buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    })
    req.on('end', () => resolve(buf))
    req.on('error', reject)
  })
}

/**
 * Buffer a request body and `JSON.parse` it. Resolves `undefined` for an
 * empty body, rejects on a parse error or once the body exceeds
 * {@link MAX_BODY_BYTES}.
 */
export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const buf = await bufferBody(req)
  if (!buf) return undefined
  return JSON.parse(buf)
}

/**
 * Buffer a request body as raw text (no JSON parse) — used by routes that
 * accept either YAML or JSON. Same {@link MAX_BODY_BYTES} cap as
 * {@link readJsonBody}.
 */
export function readTextBody(req: IncomingMessage): Promise<string> {
  return bufferBody(req)
}

/** Read a single cookie value out of the request's `Cookie` header. */
export function readCookie(req: IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie
  if (!header) return undefined
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim()
  }
  return undefined
}

/**
 * Extract a Bearer token from the `Authorization` header. The scheme name
 * is matched case-insensitively per RFC 7235 §2.1 (so `bearer <tok>` is
 * accepted) and surrounding whitespace is trimmed.
 */
export function readBearer(req: IncomingMessage): string | undefined {
  const auth = req.headers['authorization']
  if (typeof auth !== 'string') return undefined
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim())
  return m ? m[1]!.trim() : undefined
}
