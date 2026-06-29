/**
 * acp-session.ts — the long-lived ACP process engine. This is the "from startup
 * → hold session → dispatch" half of the OpenClaw-style adapter.
 *
 * One `AcpSession` owns ONE child process and ONE ACP session:
 *   - `ensureStarted()` spawns the agent once (or uses an injected transport in
 *     tests), runs the handshake (`initialize` → optional `authenticate` →
 *     `session/new`) exactly once, and caches the `sessionId`.
 *   - `prompt(text)` dispatches a task to the SAME session and BLOCKS until the
 *     turn ends — ACP `session/prompt` is one turn. Turns are serialized: a
 *     second prompt waits for the prior turn to fully complete, including while
 *     a permission is parked (an escalation keeps the turn open, not the lock
 *     released — so we never send two prompts into one in-progress turn).
 *   - `cancel()` is the ACP cancel NOTIFICATION (the in-flight prompt then ends
 *     with `stopReason: 'cancelled'`).
 *   - `terminate()` closes the connection + runs the SIGTERM→SIGKILL ladder.
 *
 * The interesting bit is the permission reverse request. When the agent asks to
 * run a tool, the registered `onPermission` handler returns a verdict:
 *   - `{ respond }`  → answer inline now (the synchronous gate path; no park).
 *   - `{ escalate }` → resolve the in-flight `prompt()` as `{ kind:'escalated' }`
 *     while leaving the reverse request OPEN and the underlying `session/prompt`
 *     connection request PENDING. The participant (M5) parks the hub task on that
 *     handle; on resume it answers the permission and re-awaits the SAME pending
 *     turn for its stopReason — no drift, because the subprocess never restarted.
 *
 * This package is a core-only leaf, so the spawn/env/kill-ladder helpers proven
 * in cli-agent's cli-runner are RE-IMPLEMENTED locally here rather than imported.
 */

import { spawn, type ChildProcess } from 'node:child_process'

import { wrapWithFsJail, type FsJailSpec } from '@aipehub/core'

import {
  AcpConnection,
  AcpConnectionError,
  type AcpTransport,
} from './acp-connection.js'
import {
  ACP_INITIALIZE,
  ACP_AUTHENTICATE,
  ACP_SESSION_NEW,
  ACP_SESSION_PROMPT,
  ACP_SESSION_CANCEL,
  ACP_REQUEST_PERMISSION,
  ACP_SESSION_UPDATE,
  ACP_ERROR,
  textBlock,
  cancelledOutcome,
  type JsonRpcId,
  type AcpClientCapabilities,
  type InitializeParams,
  type InitializeResult,
  type AuthenticateParams,
  type SessionNewParams,
  type SessionNewResult,
  type SessionPromptParams,
  type SessionPromptResult,
  type SessionCancelParams,
  type SessionUpdateParams,
  type AcpSessionUpdate,
  type AcpStopReason,
  type RequestPermissionParams,
  type RequestPermissionResult,
} from './acp-protocol.js'

const DEFAULT_PROTOCOL_VERSION = 1
/** ms to wait after SIGTERM before escalating to SIGKILL (mirrors cli-runner). */
const KILL_GRACE_MS = 2000

export interface AcpSpawnOptions {
  /** Executable to run (e.g. 'npx' for `npx @zed-industries/claude-code-acp`). */
  command: string
  /** Final argv after the command. */
  args?: readonly string[]
  /** Working directory for the child (the repo the agent operates on). */
  cwd?: string
  /** Extra env on top of the parent's; a key set to `undefined` is deleted (scrub a secret). */
  env?: Record<string, string | undefined>
  /**
   * Inject a transport (a crosswise PassThrough pair) to SKIP spawning a real
   * process — the seam the unit tests + the M6 acceptance gate drive. When set,
   * `command`/`args`/`cwd`/`env` are unused.
   */
  transport?: AcpTransport
  /**
   * Observe the child's stderr (the agent's own logging — NOT the OBSERVE stream,
   * which is `session/update` on stdout). A real bridge writes its diagnostics
   * here, so routing it to a log sink turns an opaque `-32603` into a debuggable
   * failure. Unset → stderr is drained silently (so a chatty agent can't wedge).
   */
  onStderr?: (chunk: string) => void
  /** ACP protocol version offered at `initialize` (default 1). */
  protocolVersion?: number
  /** Client capabilities advertised at `initialize` (MVP advertises none → agent must not call fs/terminal). */
  clientCapabilities?: AcpClientCapabilities
  /**
   * If the agent advertises auth methods, authenticate with this id before
   * `session/new`. MVP default skips it (the real bridges reuse their own CLI login).
   */
  authMethodId?: string
  /** Hard ceiling for the `initialize`(+`authenticate`)+`session/new` handshake. */
  initTimeoutMs?: number
  /**
   * Layer-2 OS kernel jail (FS sandbox). When set with a real `kind`, the
   * long-lived bridge process is wrapped under `sandbox-exec` / `bwrap` so every
   * file write across the session's lifetime stays inside the allowed roots —
   * the real boundary for a coding agent the hub holds open. `kind: 'none'` (no
   * enforcer) spawns unconfined; the caller degrades (per-tool gate + warning).
   * Ignored when `transport` is injected (tests skip spawning entirely).
   */
  fsJail?: FsJailSpec
}

/** The gate's answer to a permission reverse request. */
export type AcpPermissionVerdict =
  /** Answer the reverse request now (allow or deny) — no park. */
  | { respond: RequestPermissionResult }
  /** Park: resolve the in-flight prompt as `escalated`, keep the request open. */
  | { escalate: true }

export type AcpPermissionHandler = (
  params: RequestPermissionParams,
) => AcpPermissionVerdict | Promise<AcpPermissionVerdict>

/**
 * The handle handed out when a prompt escalates. The participant stashes it
 * across suspend/resume (in-memory — see the package README's durability boundary)
 * and on resume calls `respond()` then awaits `awaitStopReason()` (the SAME
 * pending turn).
 */
export interface AcpPendingPermission {
  /** Opaque key the participant stores in the park state to re-find this handle. */
  token: string
  /** What the agent wanted to do — the host renders this into the inbox item. */
  params: RequestPermissionParams
  /** Answer the still-open reverse request (allow / deny). */
  respond(result: RequestPermissionResult): void
  respondError(code: number, message: string): void
  /** Re-await the same in-flight `session/prompt` for its stopReason (no drift). */
  awaitStopReason(): Promise<AcpStopReason>
}

/** A prompt either ran to completion, or escalated a permission to a human. */
export type AcpPromptOutcome =
  | { kind: 'done'; stopReason: AcpStopReason }
  | { kind: 'escalated'; permission: AcpPendingPermission }

export interface AcpPromptOptions {
  /** Abort → the underlying `session/prompt` request is abandoned. */
  signal?: AbortSignal
  /**
   * Per-turn OBSERVE handler. Scoped to THIS turn and routed via the active-turn
   * slot, so a participant can close it over the task id without a racy shared
   * field — and it keeps receiving updates across a park (same turn, same connP).
   */
  onUpdate?: AcpUpdateHandler
  /** Per-turn permission handler — overrides the session-level one for this turn. */
  onPermission?: AcpPermissionHandler
}

export type AcpUpdateHandler = (update: AcpSessionUpdate) => void

interface Inflight {
  /** The connection-level `session/prompt` request — stays pending across an escalation. */
  connP: Promise<SessionPromptResult>
  /** Resolve the outer `prompt()` promise as `escalated` (keeps `connP` pending). */
  resolveEscalated: (permission: AcpPendingPermission) => void
}

export class AcpSession {
  private readonly opts: AcpSpawnOptions
  private conn: AcpConnection | undefined
  private child: ChildProcess | undefined
  private startPromise: Promise<{ sessionId: string }> | undefined
  private sessionIdValue: string | undefined
  private terminated = false

  private updateHandler: AcpUpdateHandler | undefined
  private permissionHandler: AcpPermissionHandler | undefined
  private closeHandler: ((err?: Error) => void) | undefined

  private inflight: Inflight | null = null
  private permCounter = 0
  /** Serializes turns: a new prompt waits on this until the prior turn fully ends. */
  private turnLock: Promise<unknown> = Promise.resolve()
  /**
   * The in-flight turn's per-turn handlers. The turn lock guarantees exactly one
   * active turn, so this is unambiguous; it survives a park (cleared only when the
   * connection request settles) so resume updates still reach the right handlers.
   */
  private active: { onUpdate?: AcpUpdateHandler; onPermission?: AcpPermissionHandler } | null = null

  constructor(opts: AcpSpawnOptions) {
    this.opts = opts
  }

  /** OBSERVE: every `session/update` (message/thought chunks, tool_call, plan). */
  onUpdate(handler: AcpUpdateHandler): void {
    this.updateHandler = handler
  }

  /** INTERCEPT: the agent's permission reverse requests. */
  onPermission(handler: AcpPermissionHandler): void {
    this.permissionHandler = handler
  }

  /** Fires when the connection closes (child exit / transport end / terminate). */
  onClose(handler: (err?: Error) => void): void {
    this.closeHandler = handler
  }

  get sessionId(): string | undefined {
    return this.sessionIdValue
  }

  get alive(): boolean {
    if (this.terminated) return false
    if (this.child) return !this.child.killed && this.child.exitCode === null
    return true
  }

  /** Spawn + handshake exactly once; cached. Set the handlers BEFORE calling this. */
  ensureStarted(): Promise<{ sessionId: string }> {
    if (!this.startPromise) this.startPromise = this.doStart()
    return this.startPromise
  }

  /**
   * Dispatch a task to the held session and block until the turn ends (or a
   * permission escalates). Turns are serialized — a parked turn keeps the lock.
   */
  async prompt(text: string, opts: AcpPromptOptions = {}): Promise<AcpPromptOutcome> {
    // Wait for the prior turn to fully complete (incl. a parked one). Release on
    // connP settle, NOT on the outer promise — so an escalation holds the lock.
    const prior = this.turnLock
    let releaseTurn!: () => void
    this.turnLock = new Promise<void>((r) => {
      releaseTurn = r
    })
    await prior.catch(() => {})

    if (this.terminated) {
      releaseTurn()
      throw new AcpConnectionError('acp session terminated')
    }
    if (opts.signal?.aborted) {
      releaseTurn()
      throw new AcpConnectionError('acp prompt aborted')
    }

    const { sessionId } = await this.ensureStarted()
    const conn = this.conn
    if (!conn) {
      releaseTurn()
      throw new AcpConnectionError('acp connection not established')
    }

    // Past `await prior` → no other turn is live, so claiming the active slot here
    // is race-free. Cleared when connP settles (after resume for a parked turn).
    this.active = { onUpdate: opts.onUpdate, onPermission: opts.onPermission }

    const connP = conn.request<SessionPromptResult>(
      ACP_SESSION_PROMPT,
      { sessionId, prompt: [textBlock(text)] } satisfies SessionPromptParams,
      opts.signal ? { signal: opts.signal } : {},
    )
    // The turn (and thus the lock) is done only when connP settles. An escalation
    // resolves the OUTER promise early but leaves connP pending → lock stays held.
    connP.then(
      () => {
        this.active = null
        releaseTurn()
      },
      () => {
        this.active = null
        releaseTurn()
      },
    )

    return await new Promise<AcpPromptOutcome>((resolve, reject) => {
      this.inflight = {
        connP,
        resolveEscalated: (permission) => {
          this.inflight = null
          resolve({ kind: 'escalated', permission })
        },
      }
      connP.then(
        (r) => {
          this.inflight = null
          resolve({ kind: 'done', stopReason: r.stopReason })
        },
        (e) => {
          this.inflight = null
          reject(e instanceof Error ? e : new Error(String(e)))
        },
      )
    })
  }

  /** ACP cancel is a NOTIFICATION; the in-flight prompt then ends with stopReason 'cancelled'. */
  cancel(): void {
    if (this.conn && this.sessionIdValue) {
      this.conn.notify(ACP_SESSION_CANCEL, { sessionId: this.sessionIdValue } satisfies SessionCancelParams)
    }
  }

  /** Close the connection and kill the child (SIGTERM → grace → SIGKILL). Idempotent. */
  async terminate(): Promise<void> {
    if (this.terminated) return
    this.terminated = true
    this.conn?.close()
    await this.killChild()
  }

  // --- internals -----------------------------------------------------------

  private async doStart(): Promise<{ sessionId: string }> {
    if (this.terminated) throw new AcpConnectionError('acp session terminated')
    const transport = this.opts.transport ?? this.spawnChild()
    const conn = new AcpConnection(transport)
    this.conn = conn
    conn.onNotify((m, p) => this.onNotification(m, p))
    conn.onRequest((m, p, id) => this.onReverseRequest(m, p, id))
    conn.onClose((err) => {
      this.terminated = true
      this.closeHandler?.(err)
    })

    const ac = new AbortController()
    const timer =
      this.opts.initTimeoutMs && this.opts.initTimeoutMs > 0
        ? setTimeout(() => ac.abort(), this.opts.initTimeoutMs)
        : undefined
    try {
      const initResult = await conn.request<InitializeResult>(
        ACP_INITIALIZE,
        {
          protocolVersion: this.opts.protocolVersion ?? DEFAULT_PROTOCOL_VERSION,
          clientCapabilities: this.opts.clientCapabilities ?? {},
        } satisfies InitializeParams,
        { signal: ac.signal },
      )
      if (this.opts.authMethodId && (initResult.authMethods?.length ?? 0) > 0) {
        await conn.request(ACP_AUTHENTICATE, { methodId: this.opts.authMethodId } satisfies AuthenticateParams, { signal: ac.signal })
      }
      // ACP `session/new` REQUIRES both an absolute `cwd` AND an `mcpServers`
      // array (real bridges validate via zod → omitting `mcpServers` rejects
      // with -32602 Invalid params). Empty array = we proxy no MCP servers into
      // the agent; cwd defaults to the host's cwd when the caller didn't pin one.
      const newResult = await conn.request<SessionNewResult>(
        ACP_SESSION_NEW,
        { cwd: this.opts.cwd ?? process.cwd(), mcpServers: [] } satisfies SessionNewParams,
        { signal: ac.signal },
      )
      this.sessionIdValue = newResult.sessionId
      return { sessionId: newResult.sessionId }
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private onNotification(method: string, params: unknown): void {
    if (method === ACP_SESSION_UPDATE) {
      const p = params as SessionUpdateParams | undefined
      if (p?.update) (this.active?.onUpdate ?? this.updateHandler)?.(p.update)
    }
  }

  private onReverseRequest(method: string, params: unknown, id: JsonRpcId): void {
    if (method === ACP_REQUEST_PERMISSION) {
      void this.handlePermissionRequest(params as RequestPermissionParams, id)
    } else {
      // fs/* and terminal/* are out of MVP scope — reject so the agent doesn't hang.
      this.conn?.respondError(id, ACP_ERROR.METHOD_NOT_FOUND, `unsupported reverse request: ${method}`)
    }
  }

  private async handlePermissionRequest(params: RequestPermissionParams, id: JsonRpcId): Promise<void> {
    const conn = this.conn
    if (!conn) return
    const handler = this.active?.onPermission ?? this.permissionHandler
    if (!handler) {
      conn.respondError(id, ACP_ERROR.METHOD_NOT_FOUND, 'no permission handler registered')
      return
    }
    let verdict: AcpPermissionVerdict
    try {
      verdict = await handler(params)
    } catch (err) {
      conn.respondError(id, ACP_ERROR.INTERNAL, `permission handler threw: ${errMsg(err)}`)
      return
    }
    if ('respond' in verdict) {
      conn.respond(id, verdict.respond)
      return
    }
    // escalate → hand the in-flight prompt an `escalated` outcome and keep this
    // reverse request OPEN. Capture `inflight` locally so the handle keeps working
    // after `this.inflight` is nulled.
    const inflight = this.inflight
    if (!inflight) {
      // No turn to escalate against, or a second escalation in one turn: fail-closed.
      conn.respond(id, cancelledOutcome())
      return
    }
    const token = `acp-perm-${++this.permCounter}`
    const permission: AcpPendingPermission = {
      token,
      params,
      respond: (result) => conn.respond(id, result),
      respondError: (code, m) => conn.respondError(id, code, m),
      awaitStopReason: () => inflight.connP.then((r) => r.stopReason),
    }
    inflight.resolveEscalated(permission)
  }

  private spawnChild(): AcpTransport {
    // Layer-2 FS jail: wrap the bridge under the OS kernel enforcer so EVERY file
    // write over the held session's lifetime is confined to the roots. `kind:
    // 'none'` passes through unchanged (caller degrades). cwd stays the repo: the
    // enforcer runs there and (bwrap) re-chdirs the inner process to the same dir.
    let command = this.opts.command
    let args = this.opts.args ? [...this.opts.args] : []
    if (this.opts.fsJail && this.opts.fsJail.kind !== 'none') {
      const wrapped = wrapWithFsJail({
        command,
        args,
        allowedRoots: this.opts.fsJail.allowedRoots,
        kind: this.opts.fsJail.kind,
        ...(this.opts.cwd !== undefined ? { cwd: this.opts.cwd } : {}),
        ...(this.opts.fsJail.extraWritableRoots !== undefined
          ? { extraWritableRoots: this.opts.fsJail.extraWritableRoots }
          : {}),
      })
      command = wrapped.command
      args = wrapped.args
    }

    let child: ChildProcess
    try {
      child = spawn(command, args, {
        cwd: this.opts.cwd,
        env: buildEnv(this.opts.env),
        stdio: ['pipe', 'pipe', 'pipe'],
        // Own process group (POSIX) so `killChild`'s ladder can signal the whole
        // tree. The canonical command is `npx -y @zed-industries/claude-code-acp`:
        // the direct child is `npx`, the real ACP bridge is a `node` grandchild.
        // SIGTERM/SIGKILL on the direct pid alone would orphan that bridge (and
        // anything IT spawned); a process-group kill reaps them (mirrors cli-runner B3).
        detached: process.platform !== 'win32',
      })
    } catch (err) {
      throw asSpawnError(command, err)
    }
    this.child = child
    child.on('error', (err) => {
      // Async spawn failure (ENOENT): close the connection with the cause so the
      // pending handshake rejects with a clear message, not a generic close.
      this.conn?.close(asSpawnError(command, err))
    })
    if (!child.stdout || !child.stdin) {
      throw asSpawnError(command, new Error('child stdio not available'))
    }
    // stderr is the agent's own logging, not the OBSERVE stream. Route it to the
    // observer if one is set (debuggability), else drain it so a chatty agent
    // can't fill the pipe buffer and wedge.
    const onStderr = this.opts.onStderr
    if (onStderr) child.stderr?.on('data', (d: Buffer | string) => onStderr(d.toString()))
    else child.stderr?.resume()
    return { input: child.stdout, output: child.stdin }
  }

  private async killChild(): Promise<void> {
    const child = this.child
    if (!child || child.killed || child.exitCode !== null) return
    // Signal the whole process group when we own one (negative pid, POSIX); the
    // canonical `npx … claude-code-acp` makes the real bridge a `node` grandchild,
    // so a direct-pid kill would orphan it (and anything IT spawned). Fall back to
    // the direct child if the group is already gone or on Windows (mirrors cli-runner B3).
    const signalTree = (sig: NodeJS.Signals): void => {
      if (child.pid && process.platform !== 'win32') {
        try {
          process.kill(-child.pid, sig)
          return
        } catch {
          /* group gone — fall through to the direct child */
        }
      }
      try {
        child.kill(sig)
      } catch {
        /* already dead */
      }
    }
    signalTree('SIGTERM')
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        // `child.killed` flips the moment the SIGTERM above is *sent*, not
        // when the process exits — gating on it made this escalation dead
        // code and let a SIGTERM-ignoring bridge linger as a zombie. The
        // real "still alive" condition is "hasn't exited yet."
        if (child.exitCode === null && child.signalCode === null) signalTree('SIGKILL')
        resolve()
      }, KILL_GRACE_MS)
      const done = (): void => {
        clearTimeout(t)
        resolve()
      }
      child.once('close', done)
      child.once('exit', done)
    })
  }
}

/** Merge parent env with overrides; an `undefined` override deletes the key. */
function buildEnv(overrides?: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  if (!overrides) return env
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete env[k]
    else env[k] = v
  }
  return env
}

/** Wrap a spawn/`error` event into a typed, message-clear error. */
function asSpawnError(command: string, err: unknown): Error {
  const code = (err as { code?: string })?.code
  const reason = code === 'ENOENT' ? `command not found: '${command}'` : errMsg(err)
  return Object.assign(new AcpConnectionError(`failed to spawn ACP agent: ${reason}`), { code, command })
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
