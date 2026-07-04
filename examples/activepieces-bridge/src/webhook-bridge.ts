/**
 * A generic inbound webhook -> Hub.dispatch bridge.
 *
 * Any automation platform that can send an HTTP POST (Activepieces, n8n, Make,
 * Zapier, a cron curl) can trigger an Gotong workflow through this. It is the
 * automation-side twin of the IM bridges: "HTTP in, capability dispatch out,
 * transcript on the side".
 *
 * Two trust rules make it safe to expose to an automation platform:
 *
 *   1. **Shared secret, fail-closed.** Every request must carry the operator's
 *      secret in `X-Gotong-Webhook-Secret`, compared in constant time. A blank
 *      secret is rejected at construction — there is no anonymous mode.
 *   2. **Capability-only, operator-allow-listed.** A request can only reach the
 *      capabilities the operator wired into `routes`; it can NEVER name an
 *      explicit agent. The request body becomes the task *payload*, nothing
 *      more. (Same rule the A2A server enforces — an external caller picks
 *      *what to do*, the operator decides *who may do it*.)
 */

import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createServer, type Server } from 'node:http'

/** The slice of `Hub` the bridge calls — narrow so it unit-tests with a fake. */
export interface DispatchLike {
  dispatch(opts: {
    from: string
    strategy: { kind: 'capability'; capabilities: string[] }
    payload: unknown
    title?: string
  }): Promise<{ kind: string; output?: unknown; error?: string }>
}

export interface WebhookRoute {
  /**
   * Capability the hook dispatches to. The bridge never dispatches to an
   * explicit target, so an external automation can only reach the capabilities
   * the operator opted in here.
   */
  capabilities: string[]
  title?: string
  /** Map the raw JSON body to a task payload. Default: pass the body through. */
  toPayload?: (body: unknown) => Record<string, unknown>
}

export interface WebhookBridgeOptions {
  hub: DispatchLike
  /**
   * Shared secret the automation platform sends in `X-Gotong-Webhook-Secret`.
   * Blank/whitespace throws at construction — the endpoint faces the internet,
   * so an unauthenticated mode would be a footgun.
   */
  secret: string
  /**
   * Hook name -> route. `POST /hooks/<name>` looks up `<name>`; an unknown
   * name 404s (no capability/agent enumeration on the wire).
   */
  routes: Record<string, WebhookRoute>
  /** `from` stamped on dispatched tasks. Default `automation:webhook`. */
  from?: string
  /** Max request body bytes. Default 256 KiB. */
  maxBodyBytes?: number
}

const HOOK_PREFIX = '/hooks/'

class BodyTooLarge extends Error {}

export interface WebhookBridge {
  /** Node `http` request handler — mount it on your own server if you have one. */
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>
  /** Convenience: start a dedicated `http` server on `port` (0 = ephemeral). */
  listen(port: number, host?: string): Promise<Server>
}

export function createWebhookBridge(opts: WebhookBridgeOptions): WebhookBridge {
  if (!opts.secret || !opts.secret.trim()) {
    throw new Error('webhook bridge: a non-empty `secret` is required (no anonymous mode)')
  }
  const from = opts.from ?? 'automation:webhook'
  const maxBodyBytes = opts.maxBodyBytes ?? 256 * 1024

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' })

    const path = (req.url ?? '').split('?')[0] ?? ''
    if (!path.startsWith(HOOK_PREFIX)) return sendJson(res, 404, { ok: false, error: 'not_found' })
    const name = decodeURIComponent(path.slice(HOOK_PREFIX.length))

    // Auth before route existence: don't leak which hook names exist to an
    // unauthenticated caller.
    if (!secretMatches(headerValue(req, 'x-gotong-webhook-secret'), opts.secret)) {
      return sendJson(res, 401, { ok: false, error: 'unauthorized' })
    }

    const route = opts.routes[name]
    if (!route) return sendJson(res, 404, { ok: false, error: 'unknown_hook' })

    let body: unknown
    try {
      const raw = await readBody(req, maxBodyBytes)
      body = raw.length ? JSON.parse(raw) : {}
    } catch (err) {
      if (err instanceof BodyTooLarge) return sendJson(res, 413, { ok: false, error: 'payload_too_large' })
      return sendJson(res, 400, { ok: false, error: 'invalid_json' })
    }

    const payload = route.toPayload ? route.toPayload(body) : isObject(body) ? body : {}
    const result = await opts.hub.dispatch({
      from,
      strategy: { kind: 'capability', capabilities: route.capabilities },
      payload,
      title: route.title ?? `webhook:${name}`,
    })

    if (result.kind === 'ok') return sendJson(res, 200, { ok: true, output: result.output })
    // A human-in-the-loop step parks the task; tell the automation it was
    // accepted but isn't done — it should not treat 202 as a final result.
    if (result.kind === 'suspended') {
      return sendJson(res, 202, { ok: true, status: 'accepted', note: 'task suspended for human review' })
    }
    return sendJson(res, 502, { ok: false, error: result.error ?? result.kind })
  }

  function listen(port: number, host = '127.0.0.1'): Promise<Server> {
    const server = createServer((req, res) => {
      void handle(req, res).catch(() => sendJson(res, 500, { ok: false, error: 'internal' }))
    })
    return new Promise((resolve) => server.listen(port, host, () => resolve(server)))
  }

  return { handle, listen }
}

// -- helpers -----------------------------------------------------------------

function secretMatches(provided: string | undefined, expected: string): boolean {
  if (!provided) return false
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  // Length check first — timingSafeEqual throws on unequal lengths. A length
  // oracle is an acceptable trade (same posture as the peer-token resolver).
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name]
  return Array.isArray(v) ? v[0] : v
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > maxBytes) {
        reject(new BodyTooLarge())
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(text)
}
