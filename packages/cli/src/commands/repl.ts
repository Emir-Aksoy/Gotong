/**
 * `aipehub repl` — interactive shell against an in-process Hub.
 *
 * Treats stdin/stdout as a "local IM bridge": each line a user types
 * is a free-text dispatch to the default capability; meta commands
 * (`:help`, `:agents`, `:transcript`, `:dispatch`, `:quit`) are
 * intercepted before dispatch.
 *
 * Why same source tree as the IM bridges (Phase 12 M2-M7) instead of
 * a separate package: the *contract* is identical — string in, agent
 * reply out, transcript audit on the side. Only the I/O changes
 * (stdin/stdout vs WebSocket frame). Keeping it inside `@aipehub/cli`
 * means `npx @aipehub/cli repl` works the day after install.
 *
 * The actual REPL machinery lives in `../repl/` (parse / bootstrap /
 * loop) so the same modules can be re-used by future remote-REPL
 * (M13) or web-shell glue without re-implementing.
 */

import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'

import { createReplHub, type CreateReplHubOpts } from '../repl/bootstrap.js'
import { runReplLoop, type ReplIo } from '../repl/loop.js'

interface ParsedRepl {
  prompt: string
  /** Print agent banner before the first prompt. */
  banner: boolean
  fromId: string | null
}

export async function repl(args: readonly string[]): Promise<number> {
  const parsed = parseArgs(args)
  if (!parsed) return 2

  const handle = await createReplHub({} satisfies CreateReplHubOpts)

  if (parsed.banner) {
    process.stdout.write(
      [
        `AipeHub REPL — in-memory hub, agents: ${handle.hub
          .participants()
          .map((p) => p.id)
          .join(', ')}`,
        `Free-text dispatches to capability [${handle.defaultCapability.join(', ')}]; type :help, :quit to exit.`,
        '',
      ].join('\n'),
    )
  }

  // Hook SIGINT to break the read so the loop can clean up. readline
  // already does some of this, but we want the loop to see EOF as
  // `null` from `read()` rather than a thrown error.
  const ac = new AbortController()
  const onSigint = (): void => ac.abort()
  process.on('SIGINT', onSigint)

  const io = makeReadlineIo(ac.signal)

  const loopDeps = {
    io,
    hub: handle.hub,
    defaultCapability: handle.defaultCapability,
    ...(parsed.fromId ? { fromId: parsed.fromId } : {}),
  } as const

  try {
    await runReplLoop(loopDeps)
  } finally {
    process.removeListener('SIGINT', onSigint)
    await handle.shutdown()
  }
  return 0
}

// ---------------------------------------------------------------------------
// Argument parsing — small + explicit, matches `ping.ts` style.
// ---------------------------------------------------------------------------

function parseArgs(args: readonly string[]): ParsedRepl | null {
  let prompt = '> '
  let banner = true
  let fromId: string | null = null

  for (const arg of args) {
    if (arg === '--no-banner') {
      banner = false
    } else if (arg.startsWith('--prompt=')) {
      prompt = arg.slice('--prompt='.length)
      if (prompt.length === 0) {
        console.error('[aipehub] --prompt must not be empty')
        return null
      }
    } else if (arg.startsWith('--from=')) {
      const id = arg.slice('--from='.length)
      if (id.length === 0) {
        console.error('[aipehub] --from must not be empty')
        return null
      }
      fromId = id
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        [
          'aipehub repl [options]',
          '',
          'Options:',
          '  --prompt=<str>   Override the prompt (default `> `)',
          '  --from=<id>      Override the participant id used as Task.from',
          '                   (default `repl-user`; useful for testing)',
          '  --no-banner      Suppress the startup banner',
          '  --help / -h      Show this message',
        ].join('\n'),
      )
      return null
    } else {
      console.error(`[aipehub] unknown option: ${arg}`)
      return null
    }
  }

  void prompt // currently fixed-prompt in IO; reserved for future
  return { prompt, banner, fromId }
}

// ---------------------------------------------------------------------------
// `ReplIo` impl backed by `node:readline/promises` + AbortController.
// ---------------------------------------------------------------------------

/**
 * Build a `ReplIo` backed by Node's readline.
 *
 * Implementation note: we DON'T use `rl.question()`. In piped
 * (non-TTY) mode `question()` only resolves the first invocation —
 * subsequent calls hang because readline switched into "expecting
 * answer for prior question" mode and never re-emits a `line` event.
 * Switching to a line-event queue plus an EOF flag works in both
 * TTY and pipe paths (verified with `printf ... | aipehub repl`).
 *
 * Exported so the `setting` console's interactive sub-shell reuses the SAME
 * readline + SIGINT→abort seam (it consumes the `ReplIo` contract, not the
 * `runReplLoop` machinery — that one hardcodes `hub.dispatch`, which the
 * deterministic ops engine has no use for).
 */
export function makeReadlineIo(signal: AbortSignal): ReplIo {
  const rl = createInterface({ input, output, terminal: process.stdout.isTTY })
  let closed = false
  let eof = false

  // Queue of buffered lines (input arrived faster than we asked) +
  // a single waiter resolver (we asked but haven't received yet).
  const pendingLines: string[] = []
  let waiter: ((line: string | null) => void) | null = null

  rl.on('line', (line: string) => {
    if (waiter) {
      const w = waiter
      waiter = null
      w(line)
    } else {
      pendingLines.push(line)
    }
  })
  rl.on('close', () => {
    eof = true
    if (waiter) {
      const w = waiter
      waiter = null
      w(null)
    }
  })
  // SIGINT / external abort: unblock the waiter so the loop can exit.
  const onAbort = (): void => {
    if (waiter) {
      const w = waiter
      waiter = null
      w(null)
    }
  }
  signal.addEventListener('abort', onAbort, { once: true })

  return {
    async read(prompt: string): Promise<string | null> {
      if (closed || signal.aborted) return null
      if (pendingLines.length > 0) return pendingLines.shift()!
      if (eof) return null
      // Only write the prompt when we're actually going to block
      // (TTY path). In pipe mode the line is already in the queue
      // above — don't litter the output with prompts.
      if (process.stdout.isTTY) {
        output.write(prompt)
      }
      return new Promise<string | null>((resolve) => {
        waiter = resolve
      })
    },
    write(chunk: string): void {
      if (closed) return
      output.write(chunk)
    },
    async close(): Promise<void> {
      if (closed) return
      closed = true
      signal.removeEventListener('abort', onAbort)
      try {
        rl.close()
      } catch {
        // close errors are non-fatal — process exits anyway
      }
    },
  }
}
