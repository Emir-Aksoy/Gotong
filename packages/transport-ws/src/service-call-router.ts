/**
 * Per-session router for SERVICE_CALL frames (wire protocol v1.1).
 *
 * Translates an incoming `ServiceCallFrame` into a method invocation on a
 * service handle and produces a `ServiceResultFrame`. Owns a small cache of
 * (type, impl, owner) → handle so a session that calls `memory.recall`
 * twenty times doesn't trigger twenty `plugin.attach` round-trips.
 *
 * Design boundaries:
 *
 *   - **No dependency on `@aipehub/host` or `@aipehub/services-sdk`.** The
 *     router talks to the host's services layer through a narrow
 *     `ServiceCallGateway` interface defined in `./server.ts`. Tests
 *     supply a fake gateway; production wires `HubServices` as the
 *     gateway. Network code stays decoupled from the plugin contract.
 *
 *   - **No long-lived state past `dispose()`.** Detach on dispose is
 *     best-effort: a plugin whose `detach` throws is logged but the
 *     other cached handles are still cleaned up. This matches
 *     `HubServices.shutdownAll`'s philosophy.
 *
 *   - **ACL is enforced *before* attach.** A SERVICE_CALL with no matching
 *     declaration is rejected without touching the host services layer —
 *     so a malicious agent that floods CALL frames with random
 *     `(type, impl, owner)` combinations cannot make the host do
 *     filesystem work.
 *
 * See `docs/services-over-ws-rfc.md` for the design rationale.
 */

import type { ParticipantId } from '@aipehub/core'
import {
  getServiceMethods,
  isServiceMethodAllowed,
  type ServiceCallFrame,
  type ServiceErrorCode,
  type ServiceOwner,
  type ServiceOwnerPattern,
  type ServiceResultFrame,
  type ServiceUseDecl,
} from '@aipehub/protocol'

import type { ServiceCallGateway } from './server.js'

interface CachedHandle {
  type: string
  impl: string
  owner: ServiceOwner
  handle: unknown
}

export interface ServiceCallRouterOptions {
  gateway: ServiceCallGateway
  declarations: readonly ServiceUseDecl[]
  /**
   * Every `agent.id` declared in this connection's HELLO.agents. Used to
   * (a) verify `call.from` is owned by this connection and (b) substitute
   * the `'self'` shorthand in declared owner patterns.
   */
  sessionAgentIds: readonly ParticipantId[]
  /**
   * Optional logger. Falls back to `console.warn` on detach failures.
   */
  warn?: (msg: string, ctx?: Record<string, unknown>) => void
}

export class ServiceCallRouter {
  private readonly gateway: ServiceCallGateway
  private readonly declarations: readonly ServiceUseDecl[]
  private readonly sessionAgentIds: ReadonlySet<ParticipantId>
  private readonly warn: (msg: string, ctx?: Record<string, unknown>) => void
  /** Keyed by `${type}:${impl}:${ownerKey}`. */
  private readonly cache = new Map<string, CachedHandle>()
  private disposed = false

  constructor(opts: ServiceCallRouterOptions) {
    this.gateway = opts.gateway
    this.declarations = opts.declarations
    this.sessionAgentIds = new Set(opts.sessionAgentIds)
    this.warn = opts.warn ?? ((m, c) => console.warn(`[ServiceCallRouter] ${m}`, c ?? {}))
  }

  /**
   * Resolve one SERVICE_CALL into a SERVICE_RESULT. Never throws — every
   * failure (ACL, attach, method invocation, bad args) is encoded into the
   * returned `{ ok: false, error: { code, message } }` shape so the session
   * can just `send(result)`.
   */
  async route(call: ServiceCallFrame): Promise<ServiceResultFrame> {
    if (this.disposed) {
      return this.makeError(call.callId, 'session_not_ready', 'router disposed')
    }

    // 1) Caller-identity check ------------------------------------------------
    if (!this.sessionAgentIds.has(call.from)) {
      return this.makeError(
        call.callId,
        'unknown_agent',
        `agent '${call.from}' is not owned by this connection`,
        { ownedIds: [...this.sessionAgentIds] },
      )
    }

    // 2) ACL: find a matching declaration -------------------------------------
    const matched = this.declarations.find((d) => declMatches(d, call, call.from))
    if (!matched) {
      // Differentiate: did (type, impl) match at least one decl but the owner
      // was off (forbidden_owner), or was the (type, impl) pair never declared
      // at all (forbidden_service)? Helps the agent author debug.
      const sameTypeImpl = this.declarations.some(
        (d) => d.type === call.service.type && d.impl === call.service.impl,
      )
      const code: ServiceErrorCode = sameTypeImpl ? 'forbidden_owner' : 'forbidden_service'
      return this.makeError(
        call.callId,
        code,
        code === 'forbidden_owner'
          ? `owner ${ownerKey(call.service.owner)} doesn't match any declared pattern for ${call.service.type}:${call.service.impl}`
          : `service ${call.service.type}:${call.service.impl} not declared in HELLO`,
      )
    }

    // 3) Method allowlist -----------------------------------------------------
    // Built-ins plus any third-party methods registered at host bootstrap
    // via `registerServiceMethods` (see protocol/constants.ts).
    if (!isServiceMethodAllowed(call.service.type, call.method)) {
      const set = getServiceMethods(call.service.type)
      return this.makeError(
        call.callId,
        'unknown_method',
        `method '${call.method}' is not on the allowlist for service type '${call.service.type}'`,
        { allowed: set ? [...set] : [] },
      )
    }
    // 3b) Per-decl method narrowing (v1.2 optional) ----------------------------
    // If the decl that matched in step (2) restricted its own subset via
    // `methods: [...]`, only those names are dispatchable on THIS connection
    // even though the type-level allowlist would let them through.
    if (matched.methods && matched.methods.length > 0 && !matched.methods.includes(call.method)) {
      return this.makeError(
        call.callId,
        'forbidden_method',
        `method '${call.method}' is not in the per-decl allowlist for ${call.service.type}:${call.service.impl}`,
        { allowed: [...matched.methods] },
      )
    }
    // Bounded method path: at most one dot (e.g. 'sql.exec').
    const segments = call.method.split('.')
    if (segments.length > 2) {
      return this.makeError(
        call.callId,
        'unknown_method',
        `method path has more than 2 segments: '${call.method}'`,
      )
    }

    // 4) args must be an array ------------------------------------------------
    if (!Array.isArray(call.args)) {
      return this.makeError(call.callId, 'bad_args', 'args must be an array')
    }

    // 5) Attach (or hit cache) ------------------------------------------------
    let cached: CachedHandle
    try {
      cached = await this.ensureHandle(matched, call.service.owner)
    } catch (err) {
      return this.makeError(
        call.callId,
        'attach_failed',
        err instanceof Error ? err.message : String(err),
      )
    }

    // 6) Resolve method on the handle ----------------------------------------
    let target: unknown
    let fn: unknown
    if (segments.length === 1) {
      target = cached.handle
      fn = (cached.handle as Record<string, unknown>)[segments[0]!]
    } else {
      // segments.length === 2
      const ns = (cached.handle as Record<string, unknown>)[segments[0]!]
      target = ns
      fn = ns && typeof ns === 'object'
        ? (ns as Record<string, unknown>)[segments[1]!]
        : undefined
    }
    if (typeof fn !== 'function') {
      return this.makeError(
        call.callId,
        'unknown_method',
        `handle has no method '${call.method}' even though allowlist permits it ` +
          `(plugin probably implements a subset of the contract)`,
      )
    }

    // 7) Invoke ---------------------------------------------------------------
    let value: unknown
    try {
      value = await (fn as (...a: unknown[]) => unknown).apply(target, call.args as unknown[])
    } catch (err) {
      return this.makeError(
        call.callId,
        'service_error',
        err instanceof Error ? err.message : String(err),
      )
    }

    return {
      type: 'SERVICE_RESULT',
      callId: call.callId,
      ok: true,
      value,
    }
  }

  /**
   * Best-effort detach of every cached handle. Idempotent; multiple `dispose`
   * calls are no-ops after the first.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    const errs: unknown[] = []
    for (const cached of this.cache.values()) {
      try {
        await this.gateway.detachFor(cached.owner)
      } catch (err) {
        errs.push(err)
        this.warn('gateway.detachFor threw during dispose', {
          owner: ownerKey(cached.owner),
          err: err instanceof Error ? err.message : String(err),
        })
      }
    }
    this.cache.clear()
    // Re-surface the *first* error for callers that care about strict
    // shutdown — but only after we've best-effort-cleaned everything else.
    if (errs.length > 0 && errs[0] instanceof Error) {
      // Don't throw — dispose is called from cleanup paths where a throw is
      // worse than a log. The warn() above is the user-facing report.
    }
  }

  /**
   * Detach handles whose owner is `{ kind:'agent', id: agentId }`. Called by
   * the session when one of its agents leaves (HELLO declared multiple,
   * graceful per-agent close). Other owner kinds (workflow-run, shared) are
   * unaffected — they're not bound to a single agent's lifetime.
   */
  async onAgentLeft(agentId: ParticipantId): Promise<void> {
    if (this.disposed) return
    for (const [key, cached] of [...this.cache.entries()]) {
      if (cached.owner.kind === 'agent' && cached.owner.id === agentId) {
        try {
          await this.gateway.detachFor(cached.owner)
        } catch (err) {
          this.warn('gateway.detachFor threw for agent-left', {
            agent: agentId,
            owner: ownerKey(cached.owner),
            err: err instanceof Error ? err.message : String(err),
          })
        }
        this.cache.delete(key)
      }
    }
  }

  /** Number of currently-cached handles. Exposed for tests + diagnostics. */
  cacheSize(): number {
    return this.cache.size
  }

  // ---------------------------------------------------------------------------

  private async ensureHandle(
    decl: ServiceUseDecl,
    owner: ServiceOwner,
  ): Promise<CachedHandle> {
    const key = `${decl.type}:${decl.impl}:${ownerKey(owner)}`
    const existing = this.cache.get(key)
    if (existing) return existing
    const attached = await this.gateway.attach({
      type: decl.type,
      impl: decl.impl,
      owner,
      config: decl.config,
    })
    const cached: CachedHandle = {
      type: decl.type,
      impl: decl.impl,
      owner,
      handle: attached.handle,
    }
    this.cache.set(key, cached)
    return cached
  }

  private makeError(
    callId: string,
    code: ServiceErrorCode,
    message: string,
    context?: unknown,
  ): ServiceResultFrame {
    return {
      type: 'SERVICE_RESULT',
      callId,
      ok: false,
      error: context !== undefined ? { code, message, context } : { code, message },
    }
  }
}

// =============================================================================
// Helpers (file-private)
// =============================================================================

/**
 * Does one declaration match an incoming call? Strict equality on type / impl
 * + owner-pattern match (id wildcard / 'self' substitution / literal eq).
 *
 * `callerAgentId` is the value of `'self'` for `kind:'agent'` patterns.
 */
function declMatches(
  decl: ServiceUseDecl,
  call: ServiceCallFrame,
  callerAgentId: ParticipantId,
): boolean {
  if (decl.type !== call.service.type) return false
  if (decl.impl !== call.service.impl) return false
  return ownerPatternMatches(decl.owner, call.service.owner, callerAgentId)
}

/**
 * `pattern` describes allowed owners (with `'*'` and `'self'` shorthands);
 * `concrete` is the actual owner of the call. `callerAgentId` is what
 * `'self'` resolves to (only valid when `pattern.kind === 'agent'`).
 */
export function ownerPatternMatches(
  pattern: ServiceOwnerPattern,
  concrete: ServiceOwner,
  callerAgentId: ParticipantId,
): boolean {
  if (pattern.kind !== concrete.kind) return false
  if (pattern.id === '*') return true
  if (pattern.id === 'self') {
    return pattern.kind === 'agent' && concrete.id === callerAgentId
  }
  return pattern.id === concrete.id
}

function ownerKey(owner: ServiceOwner): string {
  return `${owner.kind}/${owner.id}`
}
