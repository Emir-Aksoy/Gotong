/**
 * `aipehub check [--strict]` — deterministic (non-AI) self-check of a host
 * workspace: runtime config 体检 + workflow/agent definition validation.
 *
 * Like `start`, the validator lives in the SEPARATE `@aipehub/host` package
 * (it needs `parseWorkflow`, `auditBootSecurity`, the Space layout) — so the
 * tiny CLI does NOT depend on the host. `check` resolves it LAZILY at runtime
 * and delegates to the host's non-booting `./check` subpath export:
 *
 *   - host present → import `@aipehub/host/check` and run its `runCheckCli`.
 *                    That subpath is deliberately a NON-booting module (the
 *                    host's `.` entry boots the server), so importing it runs
 *                    the validator, not a hub.
 *   - host absent  → print how to get it and exit non-zero (the validators are
 *                    the host's; there's nothing meaningful the CLI can check
 *                    on its own).
 *
 * All flags (`--strict`, `--help`) belong to the host's `runCheckCli`, so this
 * wrapper forwards the args verbatim and keeps a single source of help truth.
 */

import { resolveModule } from './start.js'

const HOST_PKG = '@aipehub/host'
// A variable, not a string literal, on purpose: tsc only resolves
// `import("literal")` at build time, so this dynamic import does NOT make
// `@aipehub/host` a build-time dependency of the CLI (same trick as `start`).
const CHECK_PKG = '@aipehub/host/check'

/** The slice of `@aipehub/host/check` this command uses. */
interface CheckModule {
  runCheckCli: (deps?: { argv?: readonly string[] }) => Promise<number>
}

/** Injectable seams so both branches are testable without the host installed. */
export interface CheckDeps {
  /** Probe whether `@aipehub/host` is installed (its entry path, or null). */
  resolveHost?: () => string | null
  /** Import the host's non-booting `./check` module. */
  importCheck?: () => Promise<CheckModule>
  /** stderr writer for the absent-host hint (defaults to `console.error`). */
  err?: (line: string) => void
}

export async function check(
  args: readonly string[],
  deps: CheckDeps = {},
): Promise<number> {
  const err = deps.err ?? ((l: string) => { console.error(l) })
  const resolveHost = deps.resolveHost ?? (() => resolveModule(HOST_PKG))
  const importCheck = deps.importCheck ?? (() => import(CHECK_PKG) as Promise<CheckModule>)

  if (!resolveHost()) {
    err('[aipehub check] @aipehub/host is not installed.')
    err('')
    err('  `check` validates a workspace with the host\'s own validators, which')
    err('  ship in the SEPARATE @aipehub/host package. Install it once:')
    err('')
    err('      npm i -g @aipehub/host        # then: aipehub check')
    err('')
    err('  …or just run the host — it validates the same things on boot:')
    err('')
    err('      npx @aipehub/host')
    err('')
    return 1
  }

  // Forward the args (sans the `check` subcommand token, which the dispatcher
  // already stripped) straight to the host's CLI body.
  const mod = await importCheck()
  return mod.runCheckCli({ argv: args })
}
