/**
 * Route handlers for the first-time bootstrap wizard (`/api/setup/*`).
 *
 * Extracted from server.ts in the P3 audit cleanup (batch 3).
 *
 * Routes that exist solely to handle the "host has booted, the owner
 * row exists, but the owner hasn't finished setup yet" window:
 *
 *   GET /api/setup/needs-bootstrap
 *     Anonymous. Returns `{bootstrap: boolean}` so the unified SPA
 *     can decide whether to render the wizard vs the login form. No
 *     PII leakage — the response is just a flag.
 *
 *   POST /api/setup/owner-password
 *     LOOPBACK or OPERATOR SESSION (see Trust model below). Body:
 *     `{password: string}`. Refuses if
 *     `listUsers().length !== 1` (multi-user host means setup is
 *     already done) or if the owner already has a password
 *     credential. On success: sets the password + writes
 *     `setup_owner_created` audit row + returns `{ok: true}`.
 *
 *   POST /api/setup/owner-llm-key   (ease-of-use ②-M1)
 *     LOOPBACK or OPERATOR SESSION. Body: `{provider, apiKey, baseURL?, label?}`.
 *     The OPTIONAL second wizard step — writes an org-scope LLM key
 *     (vault row `kind='llm_provider' ownerKind='org'`) so the very
 *     first managed agent the owner creates has a key to resolve.
 *     Gated single-user (the personal-mode bootstrap window) so it
 *     never becomes a key-write surface on a multi-user/team host;
 *     those go through the admin credential UI. Repeatable (overwrites
 *     the prior org row for the same provider tag).
 *
 * # Trust model — two anchors, neither trusts a network middleman
 *
 * Every write above requires ONE of:
 *
 *   1. Loopback — `socket.remoteAddress` IS 127.0.0.1/::1. We never
 *      honour x-forwarded-for, even with trustProxy on: a reverse proxy
 *      in front must not be able to disguise an external request as
 *      local. Matches the mint-admin-token CLI trust model — anyone who
 *      can `ssh` to the host can already mint a token, so letting them
 *      finish setup from a localhost browser adds no new surface.
 *
 *   2. Authenticated operator session (DEPLOY-C followup) — the request
 *      carries auth that passes the SAME admin check every /api/admin/*
 *      route uses (v3 admin cookie/Bearer, or a v4 owner/admin session).
 *      The v3 token is minted at first boot into runtime/admin-link.txt
 *      (0600 inside the 0700 runtime dir — the master key's own trust
 *      boundary), so possession proves "operator with filesystem access",
 *      not network position. This is what makes the wizard reachable
 *      through a Docker port-forward, where the source IP is the bridge
 *      gateway and anchor 1 can never hold: the operator opens the
 *      admin-link URL, gets a session, and the wizard runs authenticated.
 *      Gateway IPs / XFF claims still buy nothing.
 *
 * Anchor 2 is strictly stronger than anchor 1 (any local process passes
 * 1; only a minted-token holder passes 2), so accepting it relaxes no
 * stance — it removes the accidental coupling between "is the operator
 * present" and "did the TCP connection originate on this netns".
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { readJsonBody, sendJson } from './http-helpers.js'
import type { IdentitySurface } from './identity-routes.js'

// -- types ----------------------------------------------------------------

export interface SetupRoutesCtx {
  identity?: IdentitySurface
  /**
   * ease-of-use ① — optional "test connection" probe. Structurally identical
   * to server.ts's `LlmKeyTestSurface`; inlined here (not imported) to avoid a
   * setup-routes ↔ server circular import. server.ts passes `ctx.llmKeyTest`
   * straight through, so duck typing keeps them in lockstep.
   */
  llmKeyTest?: {
    testLlmKey(input: {
      provider: string
      apiKey: string
      baseURL?: string
      model?: string
    }): Promise<{
      ok: boolean
      model: string
      latencyMs: number
      code?: string
      message?: string
    }>
  }
  /**
   * DEPLOY-B2 — optional "bring the IM bridge up now" surface, duck-typed to
   * the host's hot-start seam (`ImBridgesHandle.startPlatform`). Absent →
   * `/api/setup/owner-im` still writes the vault row and honestly reports the
   * bridge starts on next boot.
   */
  imHotStart?: {
    start(platform: 'telegram' | 'lark'): Promise<
      | { ok: true; source?: string }
      | { ok: false; reason: string; detail?: string }
    >
  }
  /**
   * DEPLOY-C followup — trust anchor 2 (see the header). server.ts injects
   * its `findAdminFromRequest` here so a request carried by an authenticated
   * operator (admin-link.txt v3 session / Bearer / v4 owner·admin) passes
   * the setup gates from a non-loopback socket — the Docker port-forward
   * case. Absent → byte-identical to the loopback-only behaviour.
   */
  isOperator?: (req: IncomingMessage) => Promise<boolean>
}

// -- helpers --------------------------------------------------------------

/**
 * Loopback check (trust anchor 1) from `socket.remoteAddress` directly — we
 * do NOT honour x-forwarded-for, even when trustProxy is on. We'd rather
 * refuse than let a misconfigured edge disguise an external request as
 * local; a visitor who isn't loopback must instead present an operator
 * session (anchor 2) or fall back to the CLI.
 *
 * Exported so the `/` root-path handler can reuse the SAME loopback trust
 * model when deciding whether to surface the setup wizard at the web root
 * during the first-run bootstrap window (ease-of-use ①-M1 followup).
 */
export function isLoopbackReq(req: IncomingMessage): boolean {
  const a = req.socket?.remoteAddress ?? ''
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1'
}

/**
 * Which trust anchor (header § "Trust model") lets this request through the
 * setup gates — `null` means neither and the caller must 403. The anchor is
 * also recorded in each write's audit row (`metadata.anchor`) so a later
 * reader can tell a localhost claim from an operator-session one.
 *
 * Fail-closed: an isOperator that throws counts as "not an operator" (the
 * request can still pass via loopback). A rate-limited admin lookup inside
 * the injected checker maps to `false` for the same reason.
 */
async function setupTrustAnchor(
  ctx: SetupRoutesCtx,
  req: IncomingMessage,
): Promise<'loopback' | 'operator-session' | null> {
  if (isLoopbackReq(req)) return 'loopback'
  if (ctx.isOperator) {
    try {
      if (await ctx.isOperator(req)) return 'operator-session'
    } catch {
      /* fail closed */
    }
  }
  return null
}

/**
 * The "first-run bootstrap is still pending" predicate, shared between the
 * `/api/setup/needs-bootstrap` flag route and the `/` root handler (the
 * latter serves the unified SPA — so the wizard surfaces — instead of
 * worker.html while this is true and the request is loopback).
 *
 * True iff: identity is wired AND there is exactly one user (the owner the
 * host bootstrapped) AND that owner has no password credential yet. Any
 * other shape (no identity, multi-user/team host, owner already has a
 * password) means setup is done → false. Single source of truth so the
 * flag the SPA reads and the routing decision can never drift apart.
 */
export function isBootstrapPending(identity: IdentitySurface | undefined): boolean {
  if (!identity) return false
  const users = identity.listUsers()
  if (users.length !== 1) return false
  const owner = users[0]!
  const creds = identity.listCredentials(owner.id)
  return !creds.some((c) => c.kind === 'password')
}

/** Provider tag of a vault row from `metadata.provider`, defensively. */
function vaultProviderTag(meta: Record<string, unknown> | null | undefined): string | null {
  if (!meta || typeof meta !== 'object') return null
  const p = (meta as Record<string, unknown>).provider
  return typeof p === 'string' ? p : null
}

/**
 * Providers the first-run wizard may write. Kept small on purpose — these are
 * the three the host's `selectLlmApiKey` resolves an ORG vault row for:
 *   - `openai-compatible` — the umbrella tag a managed DeepSeek agent uses
 *     (`provider: openai-compatible` + `baseURL: https://api.deepseek.com/v1`).
 *     The org-pool tier IS consulted for this tag (only workspace/env are
 *     skipped), so a row tagged here resolves for those agents.
 *   - `anthropic` / `openai` — direct vendor tags.
 * The umbrella tag is intentionally ambiguous (Qwen/Zhipu also use
 * openai-compatible); for a single-owner first-run wizard that's acceptable —
 * the owner is configuring their own hub's default key.
 */
const SETUP_LLM_PROVIDERS = new Set(['openai-compatible', 'anthropic', 'openai'])

// -- route handler --------------------------------------------------------

/**
 * Handle `/api/setup/*` routes.
 * Returns `true` if the request was handled, `false` otherwise.
 */
export async function handleSetupRoute(
  ctx: SetupRoutesCtx,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
): Promise<boolean> {
  if (path === '/api/setup/needs-bootstrap' && method === 'GET') {
    sendJson(res, { bootstrap: isBootstrapPending(ctx.identity) })
    return true
  }

  if (path === '/api/setup/owner-password' && method === 'POST') {
    if (!ctx.identity) {
      sendJson(res, { error: 'v4 identity store not enabled on this host' }, 503)
      return true
    }
    const sockAddr = req.socket?.remoteAddress ?? ''
    const anchor = await setupTrustAnchor(ctx, req)
    if (!anchor) {
      sendJson(
        res,
        { error: 'setup-owner-password needs loopback or an admin session — open the runtime/admin-link.txt URL first, or use `aipehub-host mint-admin-token` from a remote shell' },
        403,
      )
      return true
    }
    const users = ctx.identity.listUsers()
    if (users.length !== 1) {
      sendJson(res, { error: 'setup already complete (multi-user host)' }, 409)
      return true
    }
    const owner = users[0]!
    const creds = ctx.identity.listCredentials(owner.id)
    if (creds.some((c) => c.kind === 'password')) {
      sendJson(res, { error: 'owner already has a password' }, 409)
      return true
    }
    let body: unknown
    try { body = await readJsonBody(req) }
    catch { sendJson(res, { error: 'invalid JSON body' }, 400); return true }
    const b = (body ?? {}) as { password?: unknown }
    const password = typeof b.password === 'string' ? b.password : ''
    // setPassword inside the store enforces the real complexity gate
    // (and may throw weak_password). The 12-char floor here is a
    // friendly client-side hint to avoid round-trips for trivial mistakes.
    if (password.length < 12) {
      sendJson(res, { error: 'password must be at least 12 characters' }, 400)
      return true
    }
    try {
      ctx.identity.setPassword(owner.id, password)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      sendJson(res, { error: `setPassword failed: ${msg}` }, 400)
      return true
    }
    // Audit row keeps actor_source='anonymous' — the setup surface is
    // pre-identity (no v4 session vocabulary applies even when an operator
    // session admitted the call); WHICH anchor admitted it lives in
    // metadata.anchor. The target_user_id pins the row to the owner that
    // just got their password set.
    if (typeof ctx.identity.writeAuditLog === 'function') {
      try {
        ctx.identity.writeAuditLog({
          action: 'setup_owner_created',
          actorSource: 'anonymous',
          targetUserId: owner.id,
          ip: sockAddr,
          metadata: { anchor },
          success: true,
        })
      } catch { /* audit failure is non-fatal */ }
    }
    sendJson(res, { ok: true })
    return true
  }

  // ease-of-use ②-M1 — optional first-run LLM key step. Mirrors the
  // owner-password gates (loopback + single-user) and writes the org vault
  // row the host's OrgApiPool reads. Repeatable: re-running the wizard (or
  // re-submitting) overwrites the prior org row for the same provider tag.
  if (path === '/api/setup/owner-llm-key' && method === 'POST') {
    const id = ctx.identity
    // Needs the vault write APIs. A pre-vault IdentityStore (or a test stub)
    // lacks them → 503, same shape as the no-identity case.
    if (
      !id ||
      typeof id.createVaultEntry !== 'function' ||
      typeof id.listVaultEntries !== 'function'
    ) {
      sendJson(res, { error: 'v4 identity vault not enabled on this host' }, 503)
      return true
    }
    const sockAddr = req.socket?.remoteAddress ?? ''
    const anchor = await setupTrustAnchor(ctx, req)
    if (!anchor) {
      sendJson(
        res,
        { error: 'setup-owner-llm-key needs loopback or an admin session; configure keys via the admin credential UI on a remote host' },
        403,
      )
      return true
    }
    // Single-user gate: this is the personal-mode bootstrap window. On a
    // multi-user/team host setup is already done — operators add org keys
    // through the authenticated admin UI, not this anonymous loopback route.
    const users = id.listUsers()
    if (users.length !== 1) {
      sendJson(res, { error: 'setup already complete (multi-user host)' }, 409)
      return true
    }
    const owner = users[0]!
    let body: unknown
    try { body = await readJsonBody(req) }
    catch { sendJson(res, { error: 'invalid JSON body' }, 400); return true }
    const b = (body ?? {}) as {
      provider?: unknown
      apiKey?: unknown
      baseURL?: unknown
      label?: unknown
    }
    const provider = typeof b.provider === 'string' ? b.provider : ''
    const apiKey = typeof b.apiKey === 'string' ? b.apiKey.trim() : ''
    const baseURL = typeof b.baseURL === 'string' && b.baseURL.trim() ? b.baseURL.trim() : undefined
    const label = typeof b.label === 'string' && b.label.trim() ? b.label.trim() : null
    if (!SETUP_LLM_PROVIDERS.has(provider)) {
      sendJson(res, { error: `unsupported provider (allowed: ${[...SETUP_LLM_PROVIDERS].join(', ')})` }, 400)
      return true
    }
    if (apiKey.length === 0) {
      sendJson(res, { error: 'apiKey is required' }, 400)
      return true
    }
    // Overwrite hygiene: revoke prior active org rows carrying the same
    // provider tag so the vault doesn't accumulate stale wizard keys.
    // Not required for correctness (resolveLlmKey already picks the newest
    // active row) — just keeps re-runs clean. Best-effort.
    try {
      const prior = id
        .listVaultEntries({ kind: 'llm_provider', ownerKind: 'org', activeOnly: true })
        .filter((e) => vaultProviderTag(e.metadata) === provider)
      if (typeof id.revokeVaultEntry === 'function') {
        for (const e of prior) id.revokeVaultEntry(e.id)
      }
    } catch { /* overwrite cleanup is best-effort */ }
    try {
      id.createVaultEntry({
        kind: 'llm_provider',
        ownerKind: 'org',
        ownerId: null,
        secret: apiKey,
        label,
        // Non-secret context only. `provider` is the resolution tag; `baseURL`
        // is informational for the admin UI (the agent's own YAML carries the
        // real baseURL used at call time).
        metadata: { provider, ...(baseURL ? { baseURL } : {}), registeredBy: 'setup-wizard' },
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      sendJson(res, { error: `vault write failed: ${msg}` }, 400)
      return true
    }
    // Audit row uses actor_source='anonymous' (setup surface is pre-identity;
    // the admitting anchor is in metadata), pinned to the owner. The secret
    // never appears — only the provider tag.
    if (typeof id.writeAuditLog === 'function') {
      try {
        id.writeAuditLog({
          action: 'setup_owner_llm_key',
          actorSource: 'anonymous',
          targetUserId: owner.id,
          ip: sockAddr,
          metadata: { provider, anchor },
          success: true,
        })
      } catch { /* audit failure is non-fatal */ }
    }
    sendJson(res, { ok: true, provider })
    return true
  }

  // DEPLOY-B2 — optional first-run IM step. Mirrors the owner-llm-key gates
  // (loopback + single-user bootstrap window) and writes the org vault row
  // the host's `resolveImCreds` reads (`kind='im_bridge'`, metadata.platform
  // as the resolution tag). Then asks the host — through the optional
  // `imHotStart` surface — to bring the bridge up NOW, so the wizard's
  // promise is "paste the token, the bot answers", not "…after a restart".
  // The bridge result is reported honestly: `started: false` still means the
  // token IS saved (a restart will pick it up via the same vault row).
  if (path === '/api/setup/owner-im' && method === 'POST') {
    const id = ctx.identity
    if (
      !id ||
      typeof id.createVaultEntry !== 'function' ||
      typeof id.listVaultEntries !== 'function'
    ) {
      sendJson(res, { error: 'v4 identity vault not enabled on this host' }, 503)
      return true
    }
    const sockAddr = req.socket?.remoteAddress ?? ''
    const anchor = await setupTrustAnchor(ctx, req)
    if (!anchor) {
      sendJson(
        res,
        { error: 'setup-owner-im needs loopback or an admin session; configure IM via env vars on a remote host' },
        403,
      )
      return true
    }
    const users = id.listUsers()
    if (users.length !== 1) {
      sendJson(res, { error: 'setup already complete (multi-user host)' }, 409)
      return true
    }
    const owner = users[0]!
    let body: unknown
    try { body = await readJsonBody(req) }
    catch { sendJson(res, { error: 'invalid JSON body' }, 400); return true }
    const b = (body ?? {}) as {
      platform?: unknown
      token?: unknown
      appId?: unknown
      appSecret?: unknown
    }
    const platform = typeof b.platform === 'string' ? b.platform : ''
    if (platform !== 'telegram' && platform !== 'lark') {
      sendJson(res, { error: 'unsupported platform (allowed: telegram, lark)' }, 400)
      return true
    }
    // Per-platform shape: telegram is one token; lark is appId (non-secret,
    // goes to metadata) + appSecret (the vault secret). Same split
    // `resolveImCreds` reads back.
    let secret: string
    let metadata: Record<string, unknown>
    if (platform === 'telegram') {
      const token = typeof b.token === 'string' ? b.token.trim() : ''
      if (!token) { sendJson(res, { error: 'token is required' }, 400); return true }
      secret = token
      metadata = { platform, registeredBy: 'setup-wizard' }
    } else {
      const appId = typeof b.appId === 'string' ? b.appId.trim() : ''
      const appSecret = typeof b.appSecret === 'string' ? b.appSecret.trim() : ''
      if (!appId || !appSecret) {
        sendJson(res, { error: 'appId and appSecret are required' }, 400)
        return true
      }
      secret = appSecret
      metadata = { platform, appId, registeredBy: 'setup-wizard' }
    }
    // Overwrite hygiene — same as owner-llm-key: revoke prior active rows for
    // the platform so wizard re-runs don't stack stale tokens (resolveImCreds
    // already picks newest; this just keeps the vault clean). Best-effort.
    try {
      const prior = id
        .listVaultEntries({ kind: 'im_bridge', ownerKind: 'org', activeOnly: true })
        .filter((e) => {
          const m = e.metadata
          return !!m && typeof m === 'object' && (m as Record<string, unknown>).platform === platform
        })
      if (typeof id.revokeVaultEntry === 'function') {
        for (const e of prior) id.revokeVaultEntry(e.id)
      }
    } catch { /* overwrite cleanup is best-effort */ }
    try {
      id.createVaultEntry({
        kind: 'im_bridge',
        ownerKind: 'org',
        ownerId: null,
        secret,
        label: null,
        metadata,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      sendJson(res, { error: `vault write failed: ${msg}` }, 400)
      return true
    }
    // Hot-start AFTER the vault write (the host resolves creds at call time,
    // so ordering is the contract). Absent surface / refusal / throw all
    // degrade to "saved; starts on next boot" — never to a lost token.
    let bridge: { started: boolean; source?: string; reason?: string; detail?: string }
    if (ctx.imHotStart) {
      try {
        const r = await ctx.imHotStart.start(platform)
        bridge = r.ok
          ? { started: true, ...(r.source ? { source: r.source } : {}) }
          : { started: false, reason: r.reason ?? 'start_failed', ...(r.detail ? { detail: r.detail } : {}) }
      } catch (err) {
        bridge = { started: false, reason: 'start_failed', detail: String(err) }
      }
    } else {
      bridge = { started: false, reason: 'not_wired' }
    }
    // Audit: platform + anchor only — the token never appears anywhere but
    // the vault.
    if (typeof id.writeAuditLog === 'function') {
      try {
        id.writeAuditLog({
          action: 'setup_owner_im',
          actorSource: 'anonymous',
          targetUserId: owner.id,
          ip: sockAddr,
          metadata: { platform, bridgeStarted: bridge.started, anchor },
          success: true,
        })
      } catch { /* audit failure is non-fatal */ }
    }
    sendJson(res, { ok: true, platform, bridge })
    return true
  }

  // ease-of-use ① — first-run "test connection" probe. The wizard offers a
  // 测试连接 button right next to the key field so the lowest-capability user
  // gets an immediate verdict instead of discovering a dead key much later.
  // Same two-anchor gate as owner-llm-key — sends ONE minimal request with
  // the typed key; the host service never logs it.
  if (path === '/api/setup/test-llm-key' && method === 'POST') {
    if (!ctx.llmKeyTest) {
      sendJson(res, { error: 'llm key test not available on this host' }, 503)
      return true
    }
    if ((await setupTrustAnchor(ctx, req)) === null) {
      sendJson(
        res,
        { error: 'setup test-llm-key needs loopback or an admin session; use the admin test-connection on a remote host' },
        403,
      )
      return true
    }
    let body: unknown
    try { body = await readJsonBody(req) }
    catch { sendJson(res, { error: 'invalid JSON body' }, 400); return true }
    const b = (body ?? {}) as {
      provider?: unknown; apiKey?: unknown; baseURL?: unknown; model?: unknown
    }
    const provider = typeof b.provider === 'string' ? b.provider.trim() : ''
    const apiKey = typeof b.apiKey === 'string' ? b.apiKey : ''
    const baseURL = typeof b.baseURL === 'string' && b.baseURL.trim() ? b.baseURL.trim() : undefined
    const model = typeof b.model === 'string' && b.model.trim() ? b.model.trim() : undefined
    if (!provider) { sendJson(res, { error: 'provider is required' }, 400); return true }
    if (!apiKey.trim()) { sendJson(res, { error: 'apiKey is required' }, 400); return true }
    // The probe classifies every error into the verdict — a 200 here always
    // carries a usable result (ok or a friendly code), so the UI never has to
    // interpret a thrown 500.
    const result = await ctx.llmKeyTest.testLlmKey({ provider, apiKey, baseURL, model })
    sendJson(res, result)
    return true
  }

  return false
}
