import { randomUUID } from 'node:crypto'

import type { Hub, ParticipantId } from '@aipehub/core'
import {
  AWAIT_APPROVAL_TIMEOUT_MS,
  decodeFrame,
  encodeFrame,
  HELLO_TIMEOUT_MS,
  MAX_MISSED_PINGS,
  majorVersionOf,
  PROTOCOL_VERSION,
  type ClientFrame,
  type HelloFrame,
  type RejectCode,
  type ServerFrame,
  type ServiceCallFrame,
  type ServiceUseDecl,
} from '@aipehub/protocol'
import type { WebSocket } from 'ws'

import { RemoteAgentParticipant } from './remote-participant.js'
import { ServiceCallRouter } from './service-call-router.js'

type SessionState = 'AWAIT_HELLO' | 'AWAIT_APPROVAL' | 'READY' | 'CLOSING' | 'DEAD'

import type { AuthenticateResult, ServiceCallGateway } from './server.js'

export interface SessionOptions {
  remoteAddress?: string
  heartbeatIntervalMs: number
  authenticate?: (
    apiKey: string | undefined,
  ) => AuthenticateResult | Promise<AuthenticateResult>
  /** Admission policy. `'open'` is the default and the pre-v1.1 behaviour. */
  gating?: 'open' | 'admin-approval'
  /**
   * When present, enables protocol v1.1 SERVICE_CALL handling. The session
   * creates a `ServiceCallRouter` per HELLO that has a non-empty `services`
   * field; otherwise SERVICE_CALL is rejected as `forbidden_service`.
   */
  services?: ServiceCallGateway
}

export interface SessionInfo {
  sessionId: string
  state: SessionState
  remoteAddress?: string
  agents: ParticipantId[]
  connectedAt: number
}

/**
 * Per-connection state machine. Owns one WebSocket, one or more
 * RemoteAgentParticipants, and the heartbeat. Lifecycle:
 *
 *   AWAIT_HELLO -> READY -> CLOSING -> DEAD
 *
 * Errors and timeouts collapse straight to DEAD via `terminate()`.
 */
export class Session {
  readonly sessionId = `s_${randomUUID().slice(0, 8)}`
  readonly connectedAt = Date.now()
  private state: SessionState = 'AWAIT_HELLO'
  private readonly participants = new Map<ParticipantId, RemoteAgentParticipant>()
  private heartbeatTimer?: NodeJS.Timeout
  private helloTimer?: NodeJS.Timeout
  private missedPings = 0
  private closedHandlers: Array<() => void> = []
  /**
   * Pending admission application id, populated only while
   * `state === 'AWAIT_APPROVAL'`. Used by `cleanup()` to roll back
   * the application if the client disconnects before the admin decides.
   */
  private pendingApplicationId?: string

  /**
   * Per-session SERVICE_CALL router. Created in {@link handleHello} when
   * the client declared a non-empty `services` field AND the transport
   * was configured with a `ServiceCallGateway`. Disposed in
   * {@link cleanup}.
   */
  private serviceRouter?: ServiceCallRouter

  constructor(
    private readonly ws: WebSocket,
    private readonly hub: Hub,
    private readonly opts: SessionOptions,
  ) {
    ws.on('message', (data, isBinary) => {
      // The protocol is text/JSON; a binary frame is either a client
      // bug or a probe trying to feed us non-UTF-8 bytes. Pre-3.1 we
      // called `data.toString()` unconditionally — invalid-UTF-8
      // bytes silently turned into U+FFFD replacement chars and the
      // frame got "rejected" as malformed JSON with no useful hint.
      // Reject upfront with a clean reason so the client can see why.
      if (isBinary) {
        this.sendError('bad_frame', 'binary frames are not accepted (protocol is JSON/text)')
        return
      }
      const text = typeof data === 'string'
        ? data
        : (Array.isArray(data)
          ? Buffer.concat(data).toString('utf8')
          : (data as Buffer).toString('utf8'))
      this.onMessage(text).catch((err) =>
        console.error(`[ws][${this.sessionId}] handler threw:`, err),
      )
    })
    ws.on('close', () => this.cleanup())
    ws.on('error', (err) => {
      console.error(`[ws][${this.sessionId}] socket error:`, err)
      this.cleanup()
    })
    this.helloTimer = setTimeout(() => {
      if (this.state === 'AWAIT_HELLO') {
        this.sendReject('bad_hello', `HELLO not received within ${HELLO_TIMEOUT_MS}ms`)
        this.terminate()
      }
    }, HELLO_TIMEOUT_MS)
  }

  info(): SessionInfo {
    return {
      sessionId: this.sessionId,
      state: this.state,
      remoteAddress: this.opts.remoteAddress,
      agents: [...this.participants.keys()],
      connectedAt: this.connectedAt,
    }
  }

  onClosed(handler: () => void): void {
    this.closedHandlers.push(handler)
  }

  /** External graceful close (server shutdown). */
  close(reason = 'server_shutdown'): void {
    if (this.state === 'DEAD' || this.state === 'CLOSING') return
    this.state = 'CLOSING'
    this.send({ type: 'GOODBYE', reason })
    setTimeout(() => this.terminate(), 100)
  }

  // --- inbound -------------------------------------------------------------

  private async onMessage(text: string): Promise<void> {
    if (this.state === 'DEAD') return
    const r = decodeFrame(text)
    if (!r.ok) {
      this.sendError('bad_frame', r.reason)
      return
    }
    const frame = r.frame as ClientFrame

    if (this.state === 'AWAIT_HELLO') {
      if (frame.type !== 'HELLO') {
        this.sendReject('bad_hello', `expected HELLO, got ${frame.type}`)
        this.terminate()
        return
      }
      await this.handleHello(frame)
      return
    }
    if (this.state === 'AWAIT_APPROVAL') {
      // While we wait for admin approval, the only meaningful client frame
      // is GOODBYE (client gave up). PING is harmless; everything else is
      // silently ignored — agents have not been registered yet, so any
      // RESULT/PUBLISH/SUBSCRIBE would refer to nothing.
      if (frame.type === 'GOODBYE') this.handleGoodbye()
      else if (frame.type === 'PING') this.send({ type: 'PONG', ts: frame.ts })
      return
    }
    if (this.state !== 'READY') return

    switch (frame.type) {
      case 'RESULT':
        this.handleResult(frame.result)
        break
      case 'SERVICE_CALL':
        // Fire-and-forget: routing is async, but the protocol says results
        // can come back in any order, so we don't need to await before
        // accepting the next frame. The router never throws — every failure
        // is encoded into a SERVICE_RESULT.
        this.handleServiceCall(frame)
        break
      case 'PUBLISH':
        if (!this.participants.has(frame.from)) {
          this.sendError('forbidden_publish', `'${frame.from}' not owned by this connection`)
          break
        }
        this.hub.publish({ from: frame.from, channel: frame.channel, body: frame.body })
        break
      case 'SUBSCRIBE':
        if (!this.participants.has(frame.participantId)) {
          this.sendError('unknown_recipient', `'${frame.participantId}' not owned by this connection`)
          break
        }
        this.hub.subscribe(frame.participantId, frame.channel)
        break
      case 'UNSUBSCRIBE':
        if (!this.participants.has(frame.participantId)) break
        this.hub.unsubscribe(frame.participantId, frame.channel)
        break
      case 'PING':
        this.send({ type: 'PONG', ts: frame.ts })
        break
      case 'PONG':
        this.missedPings = 0
        break
      case 'GOODBYE':
        this.handleGoodbye()
        break
      case 'HELLO':
        this.sendError('unexpected_frame', 'HELLO already received')
        break
    }
  }

  private handleServiceCall(frame: ServiceCallFrame): void {
    const t0 = Date.now()
    if (!this.serviceRouter) {
      // Either v1.1 gateway wasn't configured on the transport, or the
      // client didn't declare any services in HELLO. Either way, the call
      // is forbidden.
      this.send({
        type: 'SERVICE_RESULT',
        callId: frame.callId,
        ok: false,
        error: {
          code: 'forbidden_service',
          message:
            'no service-call gateway available — either HELLO.services was empty ' +
            'or the transport was not started with the services option',
        },
      })
      this.auditServiceCall(frame, 'forbidden_service', Date.now() - t0)
      return
    }
    this.serviceRouter
      .route(frame)
      .then((result) => {
        this.send(result)
        this.auditServiceCall(
          frame,
          result.ok ? 'ok' : result.error.code,
          Date.now() - t0,
        )
      })
      .catch((err) => {
        // ServiceCallRouter.route() is contractually catch-all, but defend
        // against contract violations to keep the connection alive.
        console.error(`[ws][${this.sessionId}] router.route() threw:`, err)
        this.send({
          type: 'SERVICE_RESULT',
          callId: frame.callId,
          ok: false,
          error: {
            code: 'internal_error',
            message: err instanceof Error ? err.message : String(err),
          },
        })
        this.auditServiceCall(frame, 'internal_error', Date.now() - t0)
      })
  }

  /**
   * Append a `service_call` audit entry to the hub transcript. Best-effort:
   * a closed transcript at shutdown must not propagate up into the SERVICE_CALL
   * reply path. `args` are intentionally NOT included — they're free-form,
   * potentially user-data-bearing, and large. The admin UI consumes only the
   * identity + outcome.
   */
  private auditServiceCall(frame: ServiceCallFrame, outcome: string, durationMs: number): void {
    try {
      ;(this.hub.transcript as unknown as {
        append: (e: { ts: number; kind: string; data: unknown }) => void
      }).append({
        ts: Date.now(),
        kind: 'service_call',
        data: {
          from: frame.from,
          type: frame.service.type,
          impl: frame.service.impl,
          ownerKind: frame.service.owner.kind,
          ownerId: frame.service.owner.id,
          method: frame.method,
          outcome,
          durationMs,
        },
      })
    } catch {
      // ignore — transcript may be closed at shutdown
    }
  }

  private async handleHello(frame: HelloFrame): Promise<void> {
    if (this.helloTimer) {
      clearTimeout(this.helloTimer)
      this.helloTimer = undefined
    }

    if (majorVersionOf(frame.protocolVersion) !== majorVersionOf(PROTOCOL_VERSION)) {
      this.sendReject(
        'protocol_mismatch',
        `server speaks ${PROTOCOL_VERSION}, client speaks ${frame.protocolVersion}`,
      )
      this.terminate()
      return
    }

    // Default: open auth, every agent id allowed.
    let allowedAgents: readonly string[] | '*' = '*'

    if (this.opts.authenticate) {
      let raw: AuthenticateResult
      try {
        raw = await this.opts.authenticate(frame.apiKey)
      } catch (err) {
        this.sendReject(
          'internal_error',
          `authenticate threw: ${err instanceof Error ? err.message : String(err)}`,
        )
        this.terminate()
        return
      }
      // Normalize the three shapes.
      if (raw === false) {
        this.sendReject('auth_failed', 'apiKey verification failed')
        this.terminate()
        return
      }
      if (raw === true) {
        // accept, no per-agent restriction
      } else if (raw.ok === false) {
        this.sendReject('auth_failed', raw.reason ?? 'apiKey verification failed')
        this.terminate()
        return
      } else {
        // raw.ok === true
        if (raw.allowedAgents !== undefined && raw.allowedAgents !== '*') {
          allowedAgents = raw.allowedAgents
        }
      }
    }

    if (!Array.isArray(frame.agents) || frame.agents.length === 0) {
      this.sendReject('bad_hello', 'HELLO.agents must be a non-empty array')
      this.terminate()
      return
    }

    // --- per-agent shape + allowlist validation (pre-admission) ----------
    for (const decl of frame.agents) {
      if (!decl || typeof decl.id !== 'string') {
        this.sendReject('bad_hello', 'each agent must have a string id')
        this.terminate()
        return
      }
      if (allowedAgents !== '*' && !allowedAgents.includes(decl.id)) {
        this.sendReject(
          'forbidden_agent',
          `agent '${decl.id}' is not allowed for this API key`,
        )
        this.terminate()
        return
      }
    }

    // --- admission gate (v1.1) -------------------------------------------
    if (this.opts.gating === 'admin-approval') {
      this.state = 'AWAIT_APPROVAL'
      const admission = this.hub.requestAdmission({
        agents: frame.agents.map((a) => ({
          id: a.id,
          capabilities: Array.isArray(a.capabilities) ? a.capabilities : [],
        })),
        meta: {
          remoteAddress: this.opts.remoteAddress,
          clientName: frame.client?.name,
          clientVersion: frame.client?.version,
        },
        // Surface HELLO.services to the admin UI so the operator reviewing
        // this application can see the ACL the client is requesting BEFORE
        // approving — including per-decl method narrowing (v1.2). Pre-
        // validated above (illegal patterns reject HELLO); here we just
        // copy the shape across the protocol/core seam.
        ...(Array.isArray(frame.services) && frame.services.length > 0
          ? {
              services: frame.services.map((s) => ({
                type: s.type,
                impl: s.impl,
                owner: { kind: s.owner.kind, id: s.owner.id },
                ...(s.config !== undefined ? { config: s.config } : {}),
                ...(Array.isArray(s.methods) && s.methods.length > 0
                  ? { methods: [...s.methods] }
                  : {}),
              })),
            }
          : {}),
      })
      this.pendingApplicationId = admission.applicationId

      // C2: bound AWAIT_APPROVAL so a never-deciding admin (or a DoS
      // attacker piling up sockets) can't strand the connection forever.
      // The session is heartbeat-less in this state — without a ceiling,
      // RAM and file descriptors leak until the host falls over.
      const APPROVAL_TIMEOUT = Symbol('approval-timeout')
      let timer: NodeJS.Timeout | undefined
      const timeoutPromise = new Promise<typeof APPROVAL_TIMEOUT>((resolve) => {
        timer = setTimeout(() => resolve(APPROVAL_TIMEOUT), AWAIT_APPROVAL_TIMEOUT_MS)
      })
      const winner = await Promise.race([admission.decision, timeoutPromise])
      if (timer) clearTimeout(timer)

      // Client may have disconnected while we waited; cleanup() already
      // rolled the application back in that case. We narrow via a runtime
      // cast because TS's flow analysis pins the state to 'AWAIT_APPROVAL'
      // across the `await` even though `cleanup()` can fire from a different
      // event-loop task.
      if ((this.state as SessionState) === 'DEAD') return

      if (winner === APPROVAL_TIMEOUT) {
        // Roll back the still-pending application so admin UI cleans up.
        this.hub.rejectApplication(
          admission.applicationId,
          `await-approval exceeded ${AWAIT_APPROVAL_TIMEOUT_MS}ms`,
          'system',
        )
        this.pendingApplicationId = undefined
        this.sendReject('auth_failed', 'admission decision timed out')
        this.terminate()
        return
      }

      const decision = winner
      this.pendingApplicationId = undefined
      if (!decision.approved) {
        this.sendReject('auth_failed', decision.reason || 'admission rejected')
        this.terminate()
        return
      }
      // approved — fall through to registration
    }

    // --- register agents into the hub ------------------------------------
    const created: RemoteAgentParticipant[] = []
    for (const decl of frame.agents) {
      if (this.hub.registry.has(decl.id)) {
        for (const p of created) this.hub.unregister(p.id)
        this.sendReject('duplicate_id', `agent '${decl.id}' already registered`)
        this.terminate()
        return
      }
      const participant = new RemoteAgentParticipant({
        id: decl.id,
        capabilities: Array.isArray(decl.capabilities) ? decl.capabilities : [],
        send: (f) => this.send(f),
      })
      try {
        this.hub.register(participant)
      } catch (err) {
        for (const prev of created) this.hub.unregister(prev.id)
        this.sendReject(
          'internal_error',
          err instanceof Error ? err.message : String(err),
        )
        this.terminate()
        return
      }
      this.participants.set(decl.id, participant)
      created.push(participant)
    }

    // --- service router setup (protocol v1.1) ----------------------------
    // Only spin up a router if BOTH the transport supplies a gateway AND
    // the client declared services. Either missing → no service support
    // on this session; SERVICE_CALL gets forbidden_service.
    if (this.opts.services && Array.isArray(frame.services) && frame.services.length > 0) {
      const validation = validateServiceDecls(frame.services)
      if (!validation.ok) {
        // We already registered agents above; tear them down before bailing.
        for (const p of created) {
          try {
            this.hub.unregister(p.id)
          } catch {
            /* ignore */
          }
        }
        this.sendReject('bad_hello', validation.reason)
        this.terminate()
        return
      }
      this.serviceRouter = new ServiceCallRouter({
        gateway: this.opts.services,
        declarations: frame.services,
        sessionAgentIds: frame.agents.map((a) => a.id),
        warn: (msg, ctx) =>
          console.warn(`[ws][${this.sessionId}] ${msg}`, ctx ?? {}),
      })
    }

    this.send({
      type: 'WELCOME',
      sessionId: this.sessionId,
      protocolVersion: PROTOCOL_VERSION,
      serverTime: Date.now(),
      heartbeatIntervalMs: this.opts.heartbeatIntervalMs,
    })
    this.state = 'READY'
    this.startHeartbeat()
  }

  private handleResult(result: import('@aipehub/core').TaskResult): void {
    for (const p of this.participants.values()) {
      if (p.tryResolveTask(result)) return
    }
    this.sendError('unknown_task', `no pending task ${result.taskId}`, { taskId: result.taskId })
  }

  private handleGoodbye(): void {
    if (this.state !== 'READY') return
    this.state = 'CLOSING'
    this.send({ type: 'GOODBYE' })
    setTimeout(() => this.terminate(), 100)
  }

  // --- heartbeat -----------------------------------------------------------

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      if (this.state !== 'READY') return
      if (this.missedPings >= MAX_MISSED_PINGS) {
        console.warn(`[ws][${this.sessionId}] closing — missed ${this.missedPings} PINGs`)
        this.terminate()
        return
      }
      this.missedPings += 1
      this.send({ type: 'PING', ts: Date.now() })
    }, this.opts.heartbeatIntervalMs)
  }

  // --- outbound ------------------------------------------------------------

  private send(frame: ServerFrame): void {
    if (this.ws.readyState !== this.ws.OPEN) return
    try {
      this.ws.send(encodeFrame(frame))
    } catch (err) {
      console.error(`[ws][${this.sessionId}] send failed:`, err)
    }
  }

  private sendReject(code: RejectCode, message: string): void {
    this.send({ type: 'REJECT', code, message })
  }

  private sendError(code: string, message: string, context?: unknown): void {
    this.send({ type: 'ERROR', code, message, context })
  }

  // --- teardown ------------------------------------------------------------

  private terminate(): void {
    if (this.state === 'DEAD') return
    try {
      this.ws.terminate()
    } catch {
      /* ignore */
    }
    this.cleanup()
  }

  private cleanup(): void {
    if (this.state === 'DEAD') return
    this.state = 'DEAD'
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = undefined
    }
    if (this.helloTimer) {
      clearTimeout(this.helloTimer)
      this.helloTimer = undefined
    }
    // Roll back a still-pending admission application if the client
    // disconnects before the admin decides. This both resolves the dangling
    // decision promise and appends an `agent_rejected` event so observers
    // see the dropout.
    if (this.pendingApplicationId) {
      try {
        this.hub.rejectApplication(this.pendingApplicationId, 'client_disconnected')
      } catch {
        /* ignore */
      }
      this.pendingApplicationId = undefined
    }
    for (const p of this.participants.values()) {
      p.failAllPending('remote_disconnect')
      try {
        this.hub.unregister(p.id)
      } catch {
        /* ignore */
      }
    }
    this.participants.clear()
    // Best-effort detach of any service handles this session lazy-attached.
    // dispose() never throws; warn-logs internally.
    if (this.serviceRouter) {
      const router = this.serviceRouter
      this.serviceRouter = undefined
      router.dispose().catch((err) => {
        console.error(`[ws][${this.sessionId}] router.dispose() failed:`, err)
      })
    }
    for (const h of this.closedHandlers) {
      try {
        h()
      } catch {
        /* ignore */
      }
    }
    this.closedHandlers = []
  }
}

/**
 * Shape-check the `services` array a client sent in HELLO. Validating
 * here (not inside the router) means malformed declarations are caught
 * before we promise the client a service-enabled session.
 *
 * Returns `{ ok: true }` on success or `{ ok: false, reason }` for the
 * REJECT message. We intentionally do NOT validate `config` here — that's
 * the plugin's job at first-attach time.
 */
function validateServiceDecls(
  decls: readonly ServiceUseDecl[],
): { ok: true } | { ok: false; reason: string } {
  for (let i = 0; i < decls.length; i++) {
    const d = decls[i]!
    if (!d || typeof d !== 'object') {
      return { ok: false, reason: `services[${i}] must be an object` }
    }
    if (typeof d.type !== 'string' || !d.type) {
      return { ok: false, reason: `services[${i}].type must be a non-empty string` }
    }
    if (typeof d.impl !== 'string' || !d.impl) {
      return { ok: false, reason: `services[${i}].impl must be a non-empty string` }
    }
    const owner = d.owner as { kind?: unknown; id?: unknown } | undefined
    if (!owner || typeof owner !== 'object') {
      return { ok: false, reason: `services[${i}].owner must be an object` }
    }
    if (owner.kind !== 'agent' && owner.kind !== 'workflow-run' && owner.kind !== 'shared') {
      return {
        ok: false,
        reason: `services[${i}].owner.kind must be 'agent' | 'workflow-run' | 'shared'`,
      }
    }
    if (typeof owner.id !== 'string' || !owner.id) {
      return { ok: false, reason: `services[${i}].owner.id must be a non-empty string` }
    }
    if (owner.id === 'self' && owner.kind !== 'agent') {
      return {
        ok: false,
        reason: `services[${i}].owner.id='self' only valid when owner.kind='agent'`,
      }
    }
    // v1.2: per-method ACL narrowing. Optional; when set must be an array
    // of strings with at most one dot per name (same as the type-level
    // allowlist). Empty array is rejected — that's a footgun that would
    // silently forbid every method.
    if (d.methods !== undefined) {
      if (!Array.isArray(d.methods)) {
        return { ok: false, reason: `services[${i}].methods must be an array of strings` }
      }
      if (d.methods.length === 0) {
        return {
          ok: false,
          reason: `services[${i}].methods is empty — omit the field for "all methods", do not pass []`,
        }
      }
      for (let j = 0; j < d.methods.length; j++) {
        const m = d.methods[j]
        if (typeof m !== 'string' || !m) {
          return { ok: false, reason: `services[${i}].methods[${j}] must be a non-empty string` }
        }
        if (m.split('.').length > 2) {
          return {
            ok: false,
            reason: `services[${i}].methods[${j}]='${m}' — at most one dot per wire method`,
          }
        }
      }
    }
  }
  return { ok: true }
}
