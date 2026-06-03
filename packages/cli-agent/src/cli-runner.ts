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

    const cleanup = (): void => {
      if (killTimer) clearTimeout(killTimer)
      if (graceTimer) clearTimeout(graceTimer)
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort)
    }

    // SIGTERM first (lets the CLI flush), escalate to SIGKILL if it lingers.
    const kill = (): void => {
      if (settled) return
      child.kill('SIGTERM')
      graceTimer = setTimeout(() => {
        if (!settled) child.kill('SIGKILL')
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
    child.stdout?.on('data', (d: string) => {
      stdout += d
      opts.onChunk?.({ stream: 'stdout', text: d })
    })
    child.stderr?.on('data', (d: string) => {
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
