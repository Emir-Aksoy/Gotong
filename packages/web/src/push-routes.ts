/**
 * push-routes.ts — PUSH-M2 (+ SHELL-M6 native tokens). The member push face.
 *
 *   GET  /api/me/push                    → { available, publicKey?, count?, native }
 *   POST /api/me/push/subscribe          body = PushSubscription.toJSON()
 *   POST /api/me/push/unsubscribe        body = { endpoint }
 *   POST /api/me/push/native/register    body = { token, platform: 'ios'|'android' }
 *   POST /api/me/push/native/unregister  body = { token }
 *
 * GET is the SPA's/shell's feature detect: no surface wired (knob off / older
 * host) → 200 { available: false } and the notification card stays hidden —
 * same honesty contract as the panel /data/* routes. The POSTs answer 503
 * without their surface (setting-ops posture). The two surfaces are
 * INDEPENDENT: a hub can run APNs without GOTONG_WEBPUSH and vice versa, so
 * `native` is an additive key on GET (the pre-M6 SPA ignores it). SHELL-M6A:
 * `native.platforms` lists which legs are configured (apns.json ⇒ 'ios',
 * fcm.json ⇒ 'android') — the shell shows its enable button only when ITS
 * platform is served, so an iOS device never registers into an FCM-only hub.
 * Key material travels IN only: GET discloses device counts, never endpoints,
 * keys or tokens — each device already knows its own registration.
 *
 * Validation (web: https-only endpoint / no IP literals = the SSRF boundary;
 * native: per-platform token shape) lives in the HOST stores — the one choke
 * point; this layer only maps the duck-typed `code:'invalid'` refusal to a 400.
 * Auth: /api/me/* callers are resolved by handleMeRoute's session gate, so
 * `userId` is server-pinned and any userId in the query string is ignored.
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

/** Host `buildNativePushService().surface` satisfies this (duck, SHELL-M6/M6A). */
export interface MeNativePushSurface {
  count(userId: string): Promise<number>
  add(userId: string, input: unknown): Promise<{ count: number; replaced: boolean }>
  remove(userId: string, token: string): Promise<{ removed: boolean }>
  /** Configured legs ('ios' | 'android') — the shell gates its button on this. */
  platforms(): string[]
}

export interface MeWebPushRouteDeps {
  webPush: MeWebPushSurface | undefined
  nativePush?: MeNativePushSurface | undefined
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
    // `native` is additive (SHELL-M6): pre-M6 clients ignore it, the shell
    // reads only it. Either surface may exist without the other.
    const native = deps.nativePush
      ? {
          available: true,
          count: await deps.nativePush.count(userId),
          platforms: deps.nativePush.platforms(),
        }
      : { available: false, platforms: [] }
    if (!deps.webPush) {
      sendJson(res, { available: false, native })
      return true
    }
    sendJson(res, {
      available: true,
      publicKey: deps.webPush.publicKey(),
      count: await deps.webPush.count(userId),
      native,
    })
    return true
  }

  if (path === '/api/me/push/native/register' && method === 'POST') {
    if (!deps.nativePush) {
      sendJson(res, { error: 'native push not enabled on this host' }, 503)
      return true
    }
    const body = await readJsonBody(req).catch(() => null)
    try {
      const r = await deps.nativePush.add(userId, body)
      sendJson(res, { ok: true, count: r.count, replaced: r.replaced })
    } catch (err) {
      if ((err as { code?: string }).code === 'invalid') {
        sendJson(
          res,
          { error: 'invalid_registration', message: err instanceof Error ? err.message : String(err) },
          400,
        )
      } else {
        throw err
      }
    }
    return true
  }

  if (path === '/api/me/push/native/unregister' && method === 'POST') {
    if (!deps.nativePush) {
      sendJson(res, { error: 'native push not enabled on this host' }, 503)
      return true
    }
    const body = (await readJsonBody(req).catch(() => null)) as { token?: unknown } | null
    if (typeof body?.token !== 'string' || body.token.length === 0) {
      sendJson(res, { error: 'body must be { token }' }, 400)
      return true
    }
    const r = await deps.nativePush.remove(userId, body.token)
    sendJson(res, { ok: true, removed: r.removed })
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
