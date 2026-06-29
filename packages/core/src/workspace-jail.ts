/**
 * workspace-jail.ts — Layer 1 of the lightweight FS sandbox: a portable,
 * pure-lexical ARGV PATH JAIL (用户 2026-06-29「不用 Docker 的轻量文件围栏」).
 *
 * # The two-layer sandbox (this is layer 1)
 *
 * The hub drives external commands (cli-agent / acp-agent / the butler's
 * governed shell tool). We want them confined to allowed folders WITHOUT the
 * weight of Docker. Two layers, composed:
 *
 *   - **Layer 1 (here): argv path jail** — pure JS, 100% portable
 *     (Mac/Linux/Windows identical). Inspect the about-to-spawn `command` + its
 *     `args`: resolve every path-like argument and confirm it stays inside the
 *     allowed roots; reject anything we CAN'T reason about (shell metacharacters,
 *     an interpreter command that escapes argv reasoning, a path escaping the
 *     roots). This is a **policy gate + UX, not a security boundary** — its
 *     verdict feeds the same pre-spawn seam as `dangerousCommandGate`, so a
 *     `{ park }` suspends the task for a human to approve in `/me` (fail-closed:
 *     if we can't prove confinement, ask a person).
 *
 *   - **Layer 2 (M2): OS kernel jail** — `sandbox-exec` (macOS) / `bwrap`
 *     (Linux) actually confine the spawned process tree to the roots. THAT is
 *     the boundary. Layer 1 deliberately stays lexical (it never touches the
 *     filesystem), so a symlink inside an allowed root that points out is NOT
 *     layer 1's job to catch — layer 2 enforces the real perimeter.
 *
 * # Why lexical / pure
 *
 * `path.resolve` collapses `..` lexically, so `/work/../etc/passwd` → `/etc/...`
 * is caught here with zero fs access — deterministic, testable, and identical on
 * every OS. Resolving symlinks (`realpath`) would couple this to the filesystem
 * and still not be a real boundary; we leave that to layer 2 and keep layer 1 a
 * fast, portable, side-effect-free check.
 *
 * # What it is NOT for
 *
 * A freeform PROMPT passed to an agent CLI (e.g. `codex exec "<natural
 * language>"`) is not structured argv — scanning prose for metacharacters would
 * park on every sentence with a semicolon. Callers pass the STRUCTURAL argv
 * (command + flags + explicit path args) to {@link jailArgv}; the freeform
 * payload is confined by layer 2, and destructive-intent in the prompt is the
 * job of the complementary `dangerousCommandGate`.
 */

import path from 'node:path'

/** Why an invocation could not be proven confined to the allowed roots. */
export type JailParkCode =
  /** A path argument resolves outside every allowed root. */
  | 'path_escape'
  /** A shell metacharacter (`; & | $ \` < >` / newline) we can't reason about. */
  | 'shell_metacharacter'
  /** The command is a shell / interpreter / exec-launcher that escapes argv reasoning. */
  | 'interpreter_command'
  /** No allowed roots configured — nothing can be proven safe (fail-closed). */
  | 'no_allowed_roots'

/**
 * Verdict shape — intentionally the superset of cli-agent's `CliGateVerdict`
 * (`{ allow } | { park, reason }`) plus a machine-readable `code`, so wiring it
 * beside `dangerousCommandGate` is a trivial adapt (drop `code`).
 */
export type JailVerdict =
  | { readonly allow: true }
  | { readonly park: true; readonly reason: string; readonly code: JailParkCode }

export interface JailArgvOptions {
  /** The command about to be spawned (its basename is checked for interpreters). */
  command: string
  /** The structural arguments. Do NOT pass a freeform prompt here (see file doc). */
  args: readonly string[]
  /** Directories the invocation is confined to. Relative roots resolve against `cwd`. */
  allowedRoots: readonly string[]
  /** Working directory path arguments resolve against. Default `process.cwd()`. */
  cwd?: string
  /** Extra command basenames to treat as escape-capable interpreters. */
  extraInterpreters?: readonly string[]
}

/**
 * Shell metacharacters that signal an intent we can't verify with simple argv
 * reasoning: command chaining (`;` `&` `|`), substitution (`$` backtick),
 * redirection (`<` `>`), and newlines. Globs (`* ? [ ]`) and `~` are excluded —
 * under `shell: false` they're literal, and they appear in legitimate args.
 */
const SHELL_METACHAR_RE = /[;&|$`<>\n\r]/

/**
 * Commands that can read/write the filesystem regardless of their argv, making
 * a path-argument check meaningless (false confidence). Shells, interpreters,
 * and exec-launchers. Matched on the command's basename, case-insensitively,
 * with trailing version digits stripped (`python3`, `python3.11` → `python`).
 */
export const DEFAULT_INTERPRETERS: readonly string[] = [
  // shells
  'sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'csh', 'tcsh', 'ash', 'busybox',
  // interpreters
  'python', 'node', 'deno', 'bun', 'ruby', 'perl', 'php', 'lua', 'tclsh', 'osascript',
  // exec-launchers / escape hatches
  'env', 'xargs', 'find', 'eval', 'exec', 'nohup', 'setsid', 'nice', 'timeout',
  'watch', 'ssh', 'sudo', 'doas', 'awk',
]

/**
 * Layer 1 gate: is this structured invocation provably confined to
 * `allowedRoots`? Returns `{ allow }` when yes, `{ park, reason, code }` when it
 * cannot be proven (fail-closed). Pure + synchronous — no filesystem access.
 *
 * Checks, in order (first failure wins):
 *   1. no allowed roots → `no_allowed_roots`
 *   2. command basename is an interpreter / shell / exec-launcher → `interpreter_command`
 *   3. command or any arg contains a shell metacharacter → `shell_metacharacter`
 *   4. a path-like arg resolves outside the roots → `path_escape`
 */
export function jailArgv(opts: JailArgvOptions): JailVerdict {
  const cwd = opts.cwd ?? process.cwd()
  const roots = opts.allowedRoots
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => path.resolve(cwd, r))
  if (roots.length === 0) {
    return park('no_allowed_roots', 'no allowed roots configured — refusing to run unconfined')
  }

  const interpreters = new Set(
    [...DEFAULT_INTERPRETERS, ...(opts.extraInterpreters ?? [])].map((s) => s.toLowerCase()),
  )
  const base = interpreterBasename(opts.command)
  if (interpreters.has(base)) {
    return park(
      'interpreter_command',
      `command '${opts.command}' is an interpreter/shell (${base}) that can access the ` +
        'filesystem regardless of its arguments — path confinement cannot be proven',
    )
  }

  if (SHELL_METACHAR_RE.test(opts.command)) {
    return park('shell_metacharacter', `command '${opts.command}' contains a shell metacharacter`)
  }
  for (const arg of opts.args) {
    if (SHELL_METACHAR_RE.test(arg)) {
      return park('shell_metacharacter', `argument '${arg}' contains a shell metacharacter`)
    }
  }

  for (const arg of opts.args) {
    const candidate = pathCandidate(arg)
    if (candidate === null || !looksLikePath(candidate)) continue
    if (!isInsideRoots(path.resolve(cwd, candidate), roots)) {
      return park('path_escape', `path argument '${candidate}' resolves outside the allowed roots`)
    }
  }

  return { allow: true }
}

/**
 * Is `target` inside any of `roots`? Lexical only — both sides should already be
 * absolute (callers resolve via `path.resolve`). Exposed for layer 2 and tests.
 */
export function isInsideRoots(target: string, roots: readonly string[]): boolean {
  return roots.some((root) => {
    const rel = path.relative(root, target)
    // '' = exactly the root; a sub-path never starts with '..' and is not
    // absolute (an absolute `rel` means a different drive/root on Windows).
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
  })
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

function park(code: JailParkCode, reason: string): JailVerdict {
  return { park: true, reason, code }
}

/** Lowercased basename with a leading-path and trailing version suffix stripped. */
function interpreterBasename(command: string): string {
  let base = path.basename(command.trim()).toLowerCase()
  // python3 / python3.11 / node20 → python / node, so a versioned interpreter
  // is still recognized.
  base = base.replace(/[\d.]+$/, '')
  return base
}

/**
 * Extract the path portion of an argument, or `null` when it isn't one:
 *   - `--flag=VALUE` → VALUE
 *   - `--flag` / `-x` (short flags) → null (not a path)
 *   - bare token → itself
 */
function pathCandidate(arg: string): string | null {
  if (arg.startsWith('--')) {
    const eq = arg.indexOf('=')
    return eq >= 0 ? arg.slice(eq + 1) : null
  }
  if (arg.startsWith('-')) return null
  return arg
}

/**
 * Would this token actually touch a path that could escape? Only absolute
 * paths, anything with a separator, and bare `..` can climb out — a bare
 * filename resolves inside `cwd` (an allowed root in practice) and is skipped.
 * Tokens with whitespace are treated as prose, not paths (defends against a
 * freeform fragment slipping in).
 */
function looksLikePath(s: string): boolean {
  if (!s || /\s/.test(s)) return false
  if (path.isAbsolute(s)) return true
  if (s.includes('/') || s.includes('\\')) return true
  return s === '..'
}
