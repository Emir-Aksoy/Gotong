/**
 * A2aServer — inbound A2A `message/send` endpoint (Phase 18 C-M3).
 *
 * Turns an external A2A caller's blocking `message/send` into a local
 * `hub.dispatch` and replies with the result as an A2A `Message`. Lives in the
 * host (it needs identity for peer-token auth); web injects it duck-typed as
 * `A2aServerSurface { handle(req, res) }`, so web stays identity-free.
 *
 * Auth (its OWN bearer domain — NOT the browser admin session / CSRF model,
 * which is why server.ts routes `/a2a` before the CSRF gate and outside
 * requireAdmin):
 *   - caller sends `X-Aipe-Peer-Id: <their hub id>` + `Authorization: Bearer
 *     <pre-shared peer token>`,
 *   - we resolve the EXPECTED token for that peer from the vault and compare
 *     constant-time. Fail → 401, fail-closed (unknown peer, disabled peer, no
 *     vaulted token all resolve to null → 401).
 *
 * Dispatch mapping (deliberately narrow):
 *   - capability strategy ONLY — never explicit participant id (cross-org
 *     explicit dispatch leaks internal naming and is denied by inbound ACL);
 *   - the target capability is `message.metadata.skill` when present, else the
 *     server's configured `defaultCapability`; neither → invalid_params;
 *   - `origin = { orgId: <verified peer>, userId: <messageId> }` so the
 *     receiver-side ACL (B-M2) + audit log see who-from-which-org;
 *   - result mapping: ok → an `agent` Message with the output as text; failed
 *     / no_participant / suspended → JSON-RPC errors (we have no task lifecycle
 *     to poll, so a parked cross-org call is -32001, not a Task to follow).
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { timingSafeEqual } from 'node:crypto'

import type { Hub, PeerLinkAcl, Task, TaskResult } from '@aipehub/core'
import { evaluateInboundAcl } from '@aipehub/core'
import {
  A2A_ERROR,
  A2A_METHOD_MESSAGE_SEND,
  A2A_METHOD_TASKS_GET,
  JSONRPC_VERSION,
  agentMessage,
  completedTask,
  failedTask,
  messageText,
  workingTask,
  type A2AMessage,
  type A2AResponse,
  type A2ATask,
} from '@aipehub/a2a'

interface A2aLogger {
  warn(msg: string, data?: Record<string, unknown>): void
  info?(msg: string, data?: Record<string, unknown>): void
}

export interface A2aServerOptions {
  /**
   * `dispatch` runs an inbound `message/send`; `taskResult` is read by
   * `tasks/get` to poll a parked task's outcome from the transcript (the
   * canonical, passive seam — no new core hook). Route B P1-M8.
   */
  hub: Pick<Hub, 'dispatch' | 'taskResult'>
  /**
   * peerId → expected pre-shared token, or null for an unknown / disabled /
   * tokenless peer. Wire `buildPeerTokenResolver(identity, log)`.
   */
  resolvePeerToken: (peerId: string) => string | null
  /**
   * Audit A2 — peerId → the per-peer inbound ACL, or null for accept-all
   * (legacy / no policy). A2A `message/send` is the federation's SECOND
   * inbound door; without this it would bypass the per-link capability
   * allowlist the main HubLink path enforces in `installPeerLink`, letting
   * a peer restricted to capability X invoke ANY capability over `/a2a`.
   * Wire `(peerId) => identity.getPeerByPeerId(peerId)?.acl ?? null`.
   */
  resolvePeerAcl?: (peerId: string) => PeerLinkAcl | null
  /**
   * Audit A2 — per-peer inbound quota gate, sharing the SAME fixed-window
   * budget as the HubLink path so a peer can't sidestep its per-link cap by
   * flooding `/a2a` instead. Returns `{ok:false}` over budget. Omit → no
   * extra gate (auth + body-size limits still apply). Wire
   * `peerRegistry.inboundGateForPeer`.
   */
  inboundGate?: (
    peerId: string,
    task: Pick<Task, 'strategy' | 'origin'>,
  ) => { ok: true } | { ok: false; reason: string }
  /**
   * Capability dispatched to when a message carries no `metadata.skill`. When
   * unset AND the message omits a skill, the call is rejected (invalid_params).
   */
  defaultCapability?: string
  logger?: A2aLogger
  /** For the reply message id; injectable so tests are deterministic. */
  newMessageId?: () => string
  /**
   * Mints the OPAQUE a2a task handle returned when a dispatch suspends (never
   * the internal hub task id). Injectable so tests are deterministic; defaults
   * to a random uuid.
   */
  newTaskId?: () => string
  /** Clock for the parked-task TTL prune; injectable for tests. Defaults to `Date.now`. */
  now?: () => number
}

/**
 * A parked task minted by `message/send` (the dispatch suspended) and polled by
 * `tasks/get`. In-memory only — a host restart drops these (the caller re-polls,
 * gets TASK_NOT_FOUND, and re-sends; honest over persisting a handle whose hub
 * task may not survive). `peerId` scopes ownership: `tasks/get` from a different
 * peer must not resolve this record (anti-enumeration, fail-closed).
 */
interface A2aTaskRecord {
  hubTaskId: string
  peerId: string
  createdAt: number
}

const MAX_BODY_BYTES = 1_000_000
/** Parked tasks expire from the in-mem store after this; the poller re-sends. */
const TASK_TTL_MS = 60 * 60 * 1000
/** Hard ceiling on parked tasks held in memory (oldest-first eviction past TTL). */
const TASK_CAP = 10_000

export class A2aServer {
  private readonly hub: Pick<Hub, 'dispatch' | 'taskResult'>
  private readonly resolvePeerToken: (peerId: string) => string | null
  private readonly resolvePeerAcl:
    | ((peerId: string) => PeerLinkAcl | null)
    | undefined
  private readonly inboundGate:
    | ((
        peerId: string,
        task: Pick<Task, 'strategy' | 'origin'>,
      ) => { ok: true } | { ok: false; reason: string })
    | undefined
  private readonly defaultCapability: string | undefined
  private readonly log: A2aLogger | undefined
  private readonly newMessageId: () => string
  private readonly newTaskId: () => string
  private readonly now: () => number
  /** a2aTaskId → parked record (in-memory; dropped on restart — see A2aTaskRecord). */
  private readonly tasks = new Map<string, A2aTaskRecord>()

  constructor(opts: A2aServerOptions) {
    this.hub = opts.hub
    this.resolvePeerToken = opts.resolvePeerToken
    this.resolvePeerAcl = opts.resolvePeerAcl
    this.inboundGate = opts.inboundGate
    this.defaultCapability = opts.defaultCapability
    this.log = opts.logger
    this.newMessageId = opts.newMessageId ?? (() => crypto.randomUUID())
    this.newTaskId = opts.newTaskId ?? (() => crypto.randomUUID())
    this.now = opts.now ?? (() => Date.now())
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      writeJson(res, 405, { error: 'method not allowed' }, { allow: 'POST' })
      return
    }

    // --- auth (own bearer domain) ----------------------------------------
    const peerId = readHeader(req, 'x-aipe-peer-id')
    const bearer = readBearer(req)
    if (!peerId || !bearer) {
      writeJson(res, 401, { error: 'unauthorized' })
      return
    }
    const expected = this.resolvePeerToken(peerId)
    if (!expected || !constantTimeEqual(bearer, expected)) {
      this.log?.warn('a2a: bearer rejected', { peerId })
      writeJson(res, 401, { error: 'unauthorized' })
      return
    }

    // --- body + JSON-RPC parse -------------------------------------------
    let raw: string
    try {
      raw = await readBody(req)
    } catch {
      writeJson(res, 413, { error: 'request body too large' })
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      sendRpc(res, rpcError(null, A2A_ERROR.PARSE, 'invalid JSON'))
      return
    }
    const reqId = readRpcId(parsed)

    // Route by method. `tasks/get` polls a parked task (scoped to this peer);
    // everything else falls through to the message/send validator below (which
    // rejects unknown methods with METHOD_NOT_FOUND).
    if (readMethod(parsed) === A2A_METHOD_TASKS_GET) {
      this.handleTasksGet(res, reqId, peerId, parsed)
      return
    }

    const message = validateSendRequest(parsed)
    if (!message.ok) {
      sendRpc(res, rpcError(reqId, message.code, message.error))
      return
    }

    // --- pick the capability ---------------------------------------------
    const skill = readSkill(message.value)
    const capability = skill ?? this.defaultCapability
    if (!capability) {
      sendRpc(
        res,
        rpcError(reqId, A2A_ERROR.INVALID_PARAMS, 'no target skill (message.metadata.skill) and no default capability'),
      )
      return
    }

    // --- dispatch (capability strategy, stamped origin) ------------------
    const text = messageText(message.value)
    const dispatchInput = {
      from: peerId,
      strategy: { kind: 'capability' as const, capabilities: [capability] },
      payload: { text },
      origin: { orgId: peerId, userId: message.value.messageId },
    }

    // Audit A2 — enforce the SAME per-peer inbound contract the HubLink path
    // enforces in `installPeerLink`, BEFORE dispatch. A2A is federation's
    // second inbound door; skipping these here is the bypass the audit found.
    //   1. ACL (capability allowlist / requireOrigin[Role]) — `evaluateInboundAcl`
    //      is the exact predicate the mesh path uses, so they can't drift.
    const acl = this.resolvePeerAcl?.(peerId)
    if (acl) {
      const verdict = evaluateInboundAcl(dispatchInput, acl)
      if (!verdict.ok) {
        this.log?.warn('a2a: inbound acl denied', { peerId, reason: verdict.reason })
        sendRpc(
          res,
          rpcError(reqId, A2A_ERROR.INVALID_PARAMS, `cross_org_acl_denied (${verdict.reason})`),
        )
        return
      }
    }
    //   2. Per-link quota — shares the HubLink fixed-window budget so `/a2a`
    //      can't be used to dodge the cap.
    if (this.inboundGate) {
      const verdict = this.inboundGate(peerId, dispatchInput)
      if (!verdict.ok) {
        this.log?.warn('a2a: inbound quota denied', { peerId, reason: verdict.reason })
        sendRpc(
          res,
          rpcError(reqId, A2A_ERROR.INTERNAL, `cross_org_policy_denied (${verdict.reason})`),
        )
        return
      }
    }

    let result: TaskResult
    try {
      result = await this.hub.dispatch(dispatchInput)
    } catch (err) {
      this.log?.warn('a2a: dispatch threw', { peerId, err: err instanceof Error ? err.message : String(err) })
      sendRpc(res, rpcError(reqId, A2A_ERROR.INTERNAL, 'dispatch failed'))
      return
    }

    // A suspend (long compute / HITL approval) can't answer in one blocking
    // round-trip: mint an opaque task handle scoped to THIS peer and return a
    // `working` Task; the caller polls `tasks/get`. Everything else (ok / failed
    // / no_participant / cancelled) answers inline below.
    if (result.kind === 'suspended') {
      const a2aTaskId = this.registerParkedTask(result.taskId, peerId)
      sendRpc(res, { jsonrpc: JSONRPC_VERSION, id: reqId, result: workingTask(a2aTaskId) })
      return
    }

    sendRpc(res, this.resultToResponse(reqId, result))
  }

  /**
   * `tasks/get` — resolve a parked task's current status. Ownership is enforced:
   * an unknown id AND one owned by a DIFFERENT peer both resolve to
   * TASK_NOT_FOUND (anti-enumeration; never reveal another org's task exists).
   * The outcome is read passively from the transcript via `hub.taskResult` —
   * still parked / not yet recorded → `working`; resumed → completed / failed.
   */
  private handleTasksGet(
    res: ServerResponse,
    id: string | number | null,
    peerId: string,
    parsed: unknown,
  ): void {
    const params = (parsed as { params?: { id?: unknown } }).params
    const taskId = params?.id
    if (typeof taskId !== 'string' || taskId.length === 0) {
      sendRpc(res, rpcError(id, A2A_ERROR.INVALID_PARAMS, 'params.id is required'))
      return
    }
    const record = this.tasks.get(taskId)
    if (!record || record.peerId !== peerId) {
      sendRpc(res, rpcError(id, A2A_ERROR.TASK_NOT_FOUND, 'task not found'))
      return
    }
    const result = this.hub.taskResult(record.hubTaskId)
    sendRpc(res, { jsonrpc: JSONRPC_VERSION, id, result: this.taskRecordToA2A(taskId, result) })
  }

  /** Map a hub `TaskResult` (or undefined = not yet recorded) to an A2A `Task` status. */
  private taskRecordToA2A(a2aTaskId: string, result: TaskResult | undefined): A2ATask {
    if (!result || result.kind === 'suspended') return workingTask(a2aTaskId)
    if (result.kind === 'ok') {
      return completedTask(a2aTaskId, outputToText(result.output), this.newMessageId())
    }
    // failed / cancelled / no_participant → a failed Task carrying the reason.
    const errorText =
      result.kind === 'failed'
        ? result.error
        : result.kind === 'cancelled'
          ? `cancelled: ${result.reason}`
          : result.reason
    return failedTask(a2aTaskId, errorText, this.newMessageId())
  }

  /** Mint an opaque handle for a parked hub task, scoped to `peerId`; prune first. */
  private registerParkedTask(hubTaskId: string, peerId: string): string {
    this.pruneTasks()
    const a2aTaskId = this.newTaskId()
    this.tasks.set(a2aTaskId, { hubTaskId, peerId, createdAt: this.now() })
    return a2aTaskId
  }

  /** Drop TTL-expired records, then evict oldest-first if still over the cap. */
  private pruneTasks(): void {
    const cutoff = this.now() - TASK_TTL_MS
    for (const [id, rec] of this.tasks) {
      if (rec.createdAt < cutoff) this.tasks.delete(id)
    }
    while (this.tasks.size > TASK_CAP) {
      const oldest = this.tasks.keys().next().value
      if (oldest === undefined) break
      this.tasks.delete(oldest)
    }
  }

  private resultToResponse(
    id: string | number | null,
    result: Exclude<TaskResult, { kind: 'suspended' }>,
  ): A2AResponse {
    switch (result.kind) {
      case 'ok': {
        const reply = agentMessage(outputToText(result.output), this.newMessageId())
        return { jsonrpc: JSONRPC_VERSION, id, result: reply }
      }
      case 'failed':
        return rpcError(id, A2A_ERROR.INTERNAL, result.error)
      case 'no_participant':
        return rpcError(id, A2A_ERROR.NO_PARTICIPANT, result.reason)
      case 'cancelled':
        return rpcError(id, A2A_ERROR.INTERNAL, `cancelled: ${result.reason}`)
    }
  }
}

// --- helpers ---------------------------------------------------------------

function readHeader(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name]
  const s = Array.isArray(v) ? v[0] : v
  return s && s.length > 0 ? s : undefined
}

function readBearer(req: IncomingMessage): string | undefined {
  const auth = readHeader(req, 'authorization')
  if (!auth) return undefined
  const m = /^Bearer\s+(.+)$/i.exec(auth)
  return m?.[1]?.trim() || undefined
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    total += buf.length
    if (total > MAX_BODY_BYTES) throw new Error('body too large')
    chunks.push(buf)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Pull the JSON-RPC method out of an unparsed request (undefined when absent/odd). */
function readMethod(parsed: unknown): string | undefined {
  if (parsed && typeof parsed === 'object') {
    const method = (parsed as { method?: unknown }).method
    if (typeof method === 'string') return method
  }
  return undefined
}

/** Pull the JSON-RPC id out of an unparsed request (null when absent/odd). */
function readRpcId(parsed: unknown): string | number | null {
  if (parsed && typeof parsed === 'object') {
    const id = (parsed as { id?: unknown }).id
    if (typeof id === 'string' || typeof id === 'number') return id
  }
  return null
}

type SendValidation =
  | { ok: true; value: A2AMessage }
  | { ok: false; code: number; error: string }

function validateSendRequest(parsed: unknown): SendValidation {
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, code: A2A_ERROR.INVALID_REQUEST, error: 'request must be a JSON object' }
  }
  const r = parsed as { jsonrpc?: unknown; method?: unknown; params?: unknown }
  if (r.jsonrpc !== JSONRPC_VERSION) {
    return { ok: false, code: A2A_ERROR.INVALID_REQUEST, error: 'jsonrpc must be "2.0"' }
  }
  if (r.method !== A2A_METHOD_MESSAGE_SEND) {
    return { ok: false, code: A2A_ERROR.METHOD_NOT_FOUND, error: `unsupported method ${String(r.method)}` }
  }
  const params = r.params as { message?: unknown } | undefined
  const message = params?.message as Partial<A2AMessage> | undefined
  if (!message || typeof message !== 'object' || !Array.isArray(message.parts)) {
    return { ok: false, code: A2A_ERROR.INVALID_PARAMS, error: 'params.message.parts is required' }
  }
  if (typeof message.messageId !== 'string' || message.messageId.length === 0) {
    return { ok: false, code: A2A_ERROR.INVALID_PARAMS, error: 'params.message.messageId is required' }
  }
  return { ok: true, value: message as A2AMessage }
}

function readSkill(message: A2AMessage): string | undefined {
  const skill = message.metadata?.skill
  return typeof skill === 'string' && skill.length > 0 ? skill : undefined
}

function outputToText(output: unknown): string {
  if (typeof output === 'string') return output
  if (output === undefined || output === null) return ''
  // A common agent shape is `{ text: '...' }` — surface it directly.
  if (typeof output === 'object' && typeof (output as { text?: unknown }).text === 'string') {
    return (output as { text: string }).text
  }
  return JSON.stringify(output)
}

function rpcError(id: string | number | null, code: number, message: string): A2AResponse {
  return { jsonrpc: JSONRPC_VERSION, id, error: { code, message } }
}

function sendRpc(res: ServerResponse, body: A2AResponse): void {
  // JSON-RPC errors ride on HTTP 200 (the error is in the envelope); transport
  // failures (auth, oversize) used non-200 above.
  writeJson(res, 200, body)
}

function writeJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  const json = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', ...extraHeaders })
  res.end(json)
}
