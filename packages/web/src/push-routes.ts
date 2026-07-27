/**
 * push-routes.ts — PUSH-M2. The member Web Push subscription face.
 *
 *   GET  /api/me/push              → { available, publicKey?, count? }
 *   POST /api/me/push/subscribe    body = PushSubscription.toJSON()
 *   POST /api/me/push/unsubscribe  body = { endpoint }
 *
 * GET is the SPA's feature detect: no surface wired (knob off / older host)
 * → 200 { available: false } and the notification card stays hidden — same
 * honesty contract as the panel /data/* routes. The POSTs answer 503 without
 * a surface (setting-ops posture). The subscription's crypto keys travel IN
 * only: GET discloses a device count, never endpoints or keys — the browser
 * already knows its own subscription via `pushManager.getSubscription()`.
 *
 * Validation (https-only endpoint, no localhost / IP literals = the SSRF
 * boundary, key shapes) lives in the HOST store — the one choke point; this
 * layer only maps the duck-typed `code:'invalid'` refusal to a 400. Auth:
 * /api/me/* callers are resolved by handleMeRoute's session gate, so `userId`
 * is server-pinned and any userId in the query string is ignored.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import { readJsonBody, sendJson } from './http-helpers.js'

/** Host `buildMeWebPushSurface` satisfies this (duck; web stays host-free). */
export interface MeWebPushSurface {
  /** VAPID applicationServerKey (base64url) — what the browser subscribes with. */
  publicKey(): string
  /** How many devices this member has subscribed (projection — never the rows). */
  count(userId: string): Promise<number>
  add(userId: string, input: unknown): Promise<{ count: number; replaced: boolean }>
  remove(userId: string, endpoint: string): Promise<{ removed: boolean }>
}

export interface MeWebPushRouteDeps {
  webPush: MeWebPushSurface | undefined
}

/** Returns true when the request was handled (mirrors handleMePanelRoute). */
export async function handleMeWebPushRoute(
  deps: MeWebPushRouteDeps,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
  userId: string,
): Promise<boolean> {
  if (path === '/api/me/push' && method === 'GET') {
    if (!deps.webPush) {
      sendJson(res, { available: false })
      return true
    }
    sendJson(res, {
      available: true,
      publicKey: deps.webPush.publicKey(),
      count: await deps.webPush.count(userId),
    })
    return true
  }

  if (path === '/api/me/push/subscribe' && method === 'POST') {
    if (!deps.webPush) {
      sendJson(res, { error: 'web push not enabled on this host' }, 503)
      return true
    }
    const body = await readJsonBody(req).catch(() => null)
    try {
      const r = await deps.webPush.add(userId, body)
      sendJson(res, { ok: true, count: r.count, replaced: r.replaced })
    } catch (err) {
      if ((err as { code?: string }).code === 'invalid') {
        sendJson(
          res,
          { error: 'invalid_subscription', message: err instanceof Error ? err.message : String(err) },
          400,
        )
      } else {
        throw err
      }
    }
    return true
  }

  if (path === '/api/me/push/unsubscribe' && method === 'POST') {
    if (!deps.webPush) {
      sendJson(res, { error: 'web push not enabled on this host' }, 503)
      return true
    }
    const body = (await readJsonBody(req).catch(() => null)) as { endpoint?: unknown } | null
    if (typeof body?.endpoint !== 'string' || body.endpoint.length === 0) {
      sendJson(res, { error: 'body must be { endpoint }' }, 400)
      return true
    }
    const r = await deps.webPush.remove(userId, body.endpoint)
    sendJson(res, { ok: true, removed: r.removed })
    return true
  }

  return false
}
