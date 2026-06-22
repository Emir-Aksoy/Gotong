/**
 * `aipehub start` — convenience launcher that delegates to `@aipehub/host`.
 *
 * The CLI deliberately does NOT depend on `@aipehub/host`: the host drags in
 * the LLM SDKs, better-sqlite3, the web bundle, … which would bloat every
 * `npx @aipehub/cli connect` / `repl`. So `start` resolves the host LAZILY at
 * runtime and hands the process over to it:
 *
 *   - host present  → import its `.` entry. That entry runs the server as a
 *                     top-level side-effect (exactly like the `aipehub-host`
 *                     bin shim does `import '../dist/main.js'`), so the current
 *                     process becomes the host — Hub + WebSocket + Web. Because
 *                     it runs in-process it inherits this process's env and
 *                     stdio unchanged: `aipehub start` ≡ `npx @aipehub/host`.
 *   - host absent   → print a one-line install hint and exit non-zero.
 *
 * The host is env-driven (AIPE_SPACE / AIPE_WEB_PORT / …), so `start` takes no
 * flags of its own beyond `--help`; stray args are rejected rather than
 * silently ignored (they would read as "configure the host" when they can't).
 */

const HOST_PKG = '@aipehub/host'

/**
 * Resolve a package specifier to its entry URL WITHOUT importing it. Returns
 * null when the package isn't installed.
 *
 * Uses `import.meta.resolve` — NOT `createRequire().resolve` — on purpose:
 * `@aipehub/host` (like every package here) is ESM-only, its `exports` map has
 * only an `import` condition. CJS resolution applies the `require`/`default`
 * conditions, finds neither, and throws `ERR_PACKAGE_PATH_NOT_EXPORTED` even
 * when the package IS installed — i.e. CJS would mis-report host as absent.
 * `import.meta.resolve` honors the `import` condition, so it lands on the same
 * `dist/index.js` the host's bin would. Synchronous since Node 20.6; the
 * `typeof === 'string'` guard degrades safely (→ "absent" → run-directly hint)
 * on any older runtime where it's async/undefined rather than over-claiming.
 *
 * Exported so the presence-probe mechanism is unit-testable against a package
 * that IS a CLI dep (e.g. `@aipehub/core`) without needing the host installed.
 */
export function resolveModule(spec: string): string | null {
  try {
    const resolved = import.meta.resolve(spec)
    return typeof resolved === 'string' ? resolved : null
  } catch {
    return null
  }
}

/** Injectable seams so both branches are testable without booting a real host. */
export interface StartDeps {
  /** Probe whether `@aipehub/host` is installed (its entry path, or null). */
  resolveHost?: () => string | null
  /** Import — and thereby boot — the host. */
  importHost?: () => Promise<unknown>
  /** stdout writer for help (defaults to `process.stdout.write`). */
  out?: (line: string) => void
  /** stderr writer for hints/errors (defaults to `console.error`). */
  err?: (line: string) => void
}

export async function start(
  args: readonly string[],
  deps: StartDeps = {},
): Promise<number> {
  const out = deps.out ?? ((l: string) => { process.stdout.write(l) })
  const err = deps.err ?? ((l: string) => { console.error(l) })
  const resolveHost = deps.resolveHost ?? (() => resolveModule(HOST_PKG))
  // `HOST_PKG` is a variable (not a string literal) on purpose: tsc only does
  // module resolution for `import("literal")`, so this dynamic import does NOT
  // require `@aipehub/host` to be a build-time dependency of the CLI.
  const importHost = deps.importHost ?? (() => import(HOST_PKG))

  if (args.includes('--help') || args.includes('-h')) {
    out(START_HELP)
    return 0
  }

  // Reject stray args: the host is configured by env, not flags, so a typo
  // like `start --space-dir=foo` would otherwise boot with the WRONG intent.
  const stray = args.find((a) => a !== '--help' && a !== '-h')
  if (stray) {
    err(`[aipehub start] unexpected argument: ${stray}`)
    err('  The host is configured via environment variables, not flags.')
    err('  Run `aipehub start --help` for the supported AIPE_* vars.')
    return 2
  }

  if (!resolveHost()) {
    err('[aipehub start] @aipehub/host is not installed.')
    err('')
    err('  `start` launches the production host, which ships as a SEPARATE')
    err('  package (kept out of the CLI so `connect` / `repl` stay tiny).')
    err('  Start it directly:')
    err('')
    err('      npx @aipehub/host')
    err('')
    err('  …or install it once so `aipehub start` works thereafter:')
    err('')
    err('      npm i -g @aipehub/host')
    err('')
    return 1
  }

  // Host present: importing its entry boots the server as a top-level
  // side-effect. The event loop stays alive (listeners on AIPE_WS_PORT /
  // AIPE_WEB_PORT), so we return 0 and the process keeps serving. A boot
  // failure is the host's own concern — it logs and `process.exit(1)`s.
  await importHost()
  return 0
}

const START_HELP = `aipehub start

Starts the production AipeHub host in THIS process. A thin convenience
wrapper around \`@aipehub/host\` — identical to \`npx @aipehub/host\`, but
reachable through the one \`aipehub\` CLI you already have for
\`connect\` / \`repl\` / \`init\`.

The host is a SEPARATE package (it pulls in LLM SDKs, SQLite, the web
bundle), so the CLI does not depend on it:

  - if @aipehub/host is installed, \`start\` launches it;
  - if not, \`start\` prints how to get it and exits non-zero.

The host is configured via environment variables (12-factor), e.g.:

  AIPE_SPACE=.aipehub        workspace directory (auto-created on first run)
  AIPE_WEB_PORT=3000         admin UI / API port
  AIPE_WS_PORT=4000          agent WebSocket port
  AIPE_OPEN_BROWSER=0        suppress the first-run browser auto-open

Run \`aipehub init\` first if you want to pin team mode or name the admin;
otherwise just:

  aipehub start

…then open the URL the host prints.
`
