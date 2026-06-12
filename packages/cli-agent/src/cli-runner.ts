/**
 * runCliCommand — the spawn engine under the CLI shell-out adapter.
 *
 * One bounded invocation of a child process: write the prompt to stdin (or pass
 * it as an arg), stream stdout/stderr to an `onChunk` sink in real time (the
 * "observe" control seam), and resolve with the captured output + exit code.
 *
 * It deliberately does NOT decide what a non-zero exit means — the participant
 * above does. It only owns the OS-level concerns: spawning, env, stdin, live
 * streaming, abort (the "terminate" seam), and a hard timeout so a wedged CLI
 * can't park a worker forever. Spawn failure (ENOENT — command not found) is the
 * one thing it throws on, because there is no exit code to report.
 */

import { spawn } from 'node:child_process'

export interface CliChunk {
  stream: 'stdout' | 'stderr'
  /** Decoded UTF-8 text of this chunk (not newline-aligned). */
  text: string
}

export interface CliRunOptions {
  /** Executable to run (e.g. 'codex', 'claude', or process.execPath in tests). */
  command: string
  /** Final argv after the command (the caller has already placed the prompt). */
  args?: readonly string[]
  /** Working directory for the child (the repo the agent operates on). */
  cwd?: string
  /**
   * Extra env on top of the parent process env. A key set to `undefined` is
   * deleted from the child env (use this to scrub a secret the child must not
   * see). Everything else inherits, so PATH / HOME stay intact.
   */
  env?: Record<string, string | undefined>
  /**
   * Text written to the child's stdin, which is then closed. When omitted,
   * stdin is closed immediately so a CLI that reads stdin doesn't hang.
   */
  input?: string
  /** Abort → the child is killed (SIGTERM, then SIGKILL after a grace window). */
  signal?: AbortSignal
  /** Hard ceiling in ms. On expiry the child is killed and `timedOut` is set. */
  timeoutMs?: number
  /** Real-time output sink — fires per data chunk, before the run resolves. */
  onChunk?: (chunk: CliChunk) => void
}

export interface CliRunResult {
  /** Process exit code, or null if it was killed by a signal. */
  exitCode: number | null
  stdout: string
  stderr: string
  /** True when the run was killed by the timeout. */
  timedOut: boolean
  /** True when the run was killed via the abort signal. */
  aborted: boolean
}

/** ms to wait after SIGTERM before escalating to SIGKILL. */
const KILL_GRACE_MS = 2000

/**
 * ms to wait after the child's `exit` for stdio to drain (`close`) before
 * settling anyway. `close` is the normal settle path, but a grandchild that
 * inherited our pipes holds them open past the child's exit — without this
 * fallback the run would hang until the whole orphaned tree dies (audit B3).
 */
const EXIT_DRAIN_GRACE_MS = 500

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

export async function runCliCommand(opts: CliRunOptions): Promise<CliRunResult> {
  // The runner is generic: it receives the FINAL argv. Prompt placement (the
  // `{prompt}` token vs stdin) is a participant concern — see CliParticipant.
  const args = opts.args ? [...opts.args] : []

  return await new Promise<CliRunResult>((resolve, reject) => {
    // Already-aborted signal: don't even spawn.
    if (opts.signal?.aborted) {
      resolve({ exitCode: null, stdout: '', stderr: '', timedOut: false, aborted: true })
      return
    }

    let child
    try {
      child = spawn(opts.command, args, {
        cwd: opts.cwd,
        env: buildEnv(opts.env),
        stdio: ['pipe', 'pipe', 'pipe'],
        // Own process group (POSIX) so the kill ladder can signal the whole
        // tree — a CLI that spawned helpers must not leave them orphaned
        // when we SIGTERM/SIGKILL only the direct child (audit B3).
        detached: process.platform !== 'win32',
      })
    } catch (err) {
      reject(asSpawnError(opts.command, err))
      return
    }

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let aborted = false
    let settled = false
    let killTimer: NodeJS.Timeout | undefined
    let graceTimer: NodeJS.Timeout | undefined
    let drainTimer: NodeJS.Timeout | undefined

    const cleanup = (): void => {
      if (killTimer) clearTimeout(killTimer)
      if (graceTimer) clearTimeout(graceTimer)
      if (drainTimer) clearTimeout(drainTimer)
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort)
    }

    // Signal the whole process group when we own one (negative pid, POSIX);
    // fall back to the direct child if the group is already gone.
    const signalTree = (sig: NodeJS.Signals): void => {
      if (child.pid && process.platform !== 'win32') {
        try {
          process.kill(-child.pid, sig)
          return
        } catch { /* group gone — fall through to the direct child */ }
      }
      try { child.kill(sig) } catch { /* already dead */ }
    }

    // SIGTERM first (lets the CLI flush), escalate to SIGKILL if it lingers.
    const kill = (): void => {
      if (settled) return
      signalTree('SIGTERM')
      graceTimer = setTimeout(() => {
        if (!settled) signalTree('SIGKILL')
      }, KILL_GRACE_MS)
    }

    const onAbort = (): void => {
      aborted = true
      kill()
    }
    if (opts.signal) opts.signal.addEventListener('abort', onAbort, { once: true })

    if (opts.timeoutMs && opts.timeoutMs > 0) {
      killTimer = setTimeout(() => {
        timedOut = true
        kill()
      }, opts.timeoutMs)
    }

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    // Guard with `settled` like every other callback here: once the run has
    // resolved/rejected (close, error, or post-kill), a buffered `data` event
    // must not fire `onChunk` into an already-torn-down consumer — `onChunk`
    // is contracted to fire "before the run resolves", and a late append to
    // stdout/stderr is moot anyway (the result already carried the captured text).
    child.stdout?.on('data', (d: string) => {
      if (settled) return
      stdout += d
      opts.onChunk?.({ stream: 'stdout', text: d })
    })
    child.stderr?.on('data', (d: string) => {
      if (settled) return
      stderr += d
      opts.onChunk?.({ stream: 'stderr', text: d })
    })

    child.on('error', (err) => {
      if (settled) return
      settled = true
      cleanup()
      reject(asSpawnError(opts.command, err))
    })

    child.on('close', (code) => {
      if (settled) return
      settled = true
      cleanup()
      resolve({ exitCode: code, stdout, stderr, timedOut, aborted })
    })

    // `close` waits for stdio to fully drain — usually right, but a
    // grandchild holding our inherited pipes can postpone it indefinitely
    // after THIS child already exited. Settle from `exit` after a short
    // drain grace so a backgrounded helper can't wedge the run (audit B3).
    child.on('exit', (code) => {
      if (settled) return
      drainTimer = setTimeout(() => {
        if (settled) return
        settled = true
        cleanup()
        resolve({ exitCode: code, stdout, stderr, timedOut, aborted })
      }, EXIT_DRAIN_GRACE_MS)
    })

    // Feed stdin then close it. Closing is essential: a CLI that reads stdin
    // would otherwise block forever waiting for EOF.
    if (child.stdin) {
      if (opts.input !== undefined) child.stdin.write(opts.input)
      child.stdin.end()
    }
  })
}

/** Wrap a spawn/`error` event into a typed, message-clear error. */
function asSpawnError(command: string, err: unknown): Error {
  const code = (err as { code?: string })?.code
  const reason = code === 'ENOENT' ? `command not found: '${command}'` : errMsg(err)
  return Object.assign(new Error(`failed to run CLI: ${reason}`), { code, command })
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
