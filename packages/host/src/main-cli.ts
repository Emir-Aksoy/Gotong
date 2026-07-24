/**
 * main-cli.ts — the host binary's CLI / process-boundary surface, split out of
 * main.ts to keep the assembly binary within its line budget (GUARD line-budget
 * gate). Everything here runs at the CLI boundary, before — or instead of —
 * booting the Hub. Two cohesive groups:
 *
 *   - env readers (env / envInt / envBool / envList): the 12-factor config
 *     primitives. main()'s wiring reads them ~40x, and the subcommands below
 *     read them too — so they live here and main.ts imports them back (they
 *     could not stay in main.ts: main.ts runs top-level ARGV dispatch as a side
 *     effect on import, so a subcommand module importing from it would cycle +
 *     re-trigger that dispatch).
 *   - pre-boot subcommands: --version (pkgVersion), --help (printUsage),
 *     `mint-admin-token` (lost-URL recovery) and `rotate-master-key`. Each
 *     opens GOTONG_SPACE WITHOUT starting any listeners and process.exit()s.
 *
 * The ARGV dispatch that CALLS these stays in main.ts (it is the entry
 * sequencing); this file is pure declarations, zero top-level side effects.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Space } from '@gotong/core'
import { BAKED_VERSION } from './version.js'
import { rotateMasterKey } from './rotate-master-key.js'
import { recoverMasterKeyRotation } from './master-key-recovery.js'
import { writeAdminLinkFile } from './admin-link.js'

export function pkgVersion(): string {
  // Prefer reading from disk so an in-place upgrade (`npm install -g
  // @gotong/host@new` without restarting tsc) reflects in --version.
  // Fall through to BAKED_VERSION when the disk read fails — in the
  // bun --compile single-file binary, package.json isn't on the
  // embedded /$bunfs/ virtual filesystem, so readFileSync throws
  // ENOENT and the baked constant kicks in.
  try {
    const url = new URL('../package.json', import.meta.url)
    const pkg = JSON.parse(readFileSync(url, 'utf8')) as { version?: string }
    return pkg.version ?? BAKED_VERSION
  } catch {
    return BAKED_VERSION
  }
}

/**
 * `gotong-host mint-admin-token [displayName]` — emergency recovery
 * when the first-run admin URL was lost. Reads GOTONG_SPACE from the env
 * exactly like the main path so the same `.gotong` directory is
 * reached. Does NOT start the Hub or open any listeners; only creates
 * a new admin row in admins.json and prints the URL (token shown
 * exactly once, matching createAdmin's contract).
 *
 * The printed URL uses GOTONG_HOST + GOTONG_WEB_PORT + GOTONG_COOKIE_SECURE
 * so what gets printed actually points at where the running host
 * would serve. Behind a reverse proxy you'll have to substitute the
 * external hostname yourself — same caveat as the first-run print.
 */
export async function mintAdminTokenCmd(displayNameArg: string | undefined): Promise<void> {
  const dir = env('GOTONG_SPACE', '.gotong')!
  const displayName = displayNameArg && displayNameArg.length > 0
    ? displayNameArg
    : env('GOTONG_ADMIN_DISPLAY_NAME', 'Recovered Operator')!

  let space: Space
  try {
    space = await Space.open(dir)
  } catch (err) {
    process.stderr.write(
      `error: could not open space '${dir}': ${
        err instanceof Error ? err.message : String(err)
      }\n` +
        `hint: GOTONG_SPACE must point at an already-initialised workspace.\n` +
        `      Run \`gotong-host\` (or your launcher) once to create it first.\n`,
    )
    process.exit(2)
  }

  const { admin, token } = await space.createAdmin(displayName)

  const host = env('GOTONG_HOST', '127.0.0.1')!
  const port = envInt('GOTONG_WEB_PORT', 3000)
  const proto = envBool('GOTONG_COOKIE_SECURE', false) ? 'https' : 'http'
  const adminUrl = `${proto}://${host}:${port}/admin?token=${token}`

  // Write the URL to runtime/admin-link.txt (0o600) instead of stdout.
  // Same H20 rationale as the first-run path in main(): the token is
  // secret-grade, log shippers should never see it.
  const linkPath = join(dir, 'runtime', 'admin-link.txt')
  await writeAdminLinkFile(linkPath, adminUrl)

  process.stdout.write(
    `\n` +
      `  New admin '${admin.displayName}' (${admin.id}) added to ${dir}/admins.json.\n` +
      `\n` +
      `  Admin URL saved to (mode 0o600 — read once and delete):\n` +
      `    ${linkPath}\n` +
      `\n` +
      `  Open the URL inside that file once; the cookie that gets set is\n` +
      `  what subsequent logins use. The token itself is hashed in\n` +
      `  admins.json — there is no way to recover the plaintext from\n` +
      `  disk after the link file is removed. Behind a reverse proxy:\n` +
      `  substitute your public hostname for '${host}:${port}' when you\n` +
      `  open the URL.\n\n`,
  )
}

/**
 * `gotong-host rotate-master-key` (Route B P0-M4d) — rotate the identity
 * vault master key (KEK) for a local-file workspace without starting the Hub.
 *
 * Reads GOTONG_SPACE / GOTONG_MASTER_KEY_PROVIDER / GOTONG_MASTER_KEY exactly like the
 * boot path, so it loads the SAME current key, then generates a fresh random
 * key, re-wraps the data key in the DB under it (O(1) — secret rows untouched,
 * M4b/M4c; the one exception is a pre-envelope vault's first rotation, which
 * migrates its legacy rows once), and persists the new key to
 * `<space>/identity-master.key`. The new
 * key is NEVER printed (it's secret-grade; an attacker reading logs must not get
 * it). Since B① the space-secrets file (LLM keys) derives from the KEK and is
 * re-encrypted in the same rotation — so run this with the host STOPPED: a
 * running host still holds the old derived key and its writes could be lost to
 * (or mix keys with) the staged copy. (Pre-B① the old "keep serving on the
 * cached data key" claim was true; the unification traded it for one root key.)
 *
 * Exits 2 on any failure (wrong provider, missing/wrong-length key, db open).
 * Refusals land before the DB re-wrap commit point and leave at worst inert
 * `.next` staging, which the recovery pass below (same one boot runs)
 * reconciles. A failure or crash AFTER the commit does leave the live key one
 * step behind the DB — `.next` then holds the key the DB needs — and the same
 * recovery promotes it on the next run/boot; the new key survives on disk
 * either way (local filesystems; see rotate-master-key.ts header).
 */
export function rotateMasterKeyCmd(): void {
  const dir = env('GOTONG_SPACE', '.gotong')!
  let result: { keyFilePath: string }
  try {
    // Reconcile any interrupted prior rotation FIRST — after a crash between
    // the DB re-wrap and the promote, `<keyfile>.next` is the only key that
    // opens the vault; rotateMasterKey() refuses to touch that state, and
    // this recovery (promote or discard, the same logic boot runs) is what
    // makes a plain operator re-run come out clean instead of erroring.
    // 'inconclusive' is a VERDICT, not a shrug: the key state needs the
    // operator (the reason may name the exact rescue file) — rotating on top
    // would stage a key the old KEK can't commit and bury that pointer.
    const rec = recoverMasterKeyRotation(dir, env('GOTONG_MASTER_KEY_PROVIDER'))
    if (rec.action === 'inconclusive') {
      process.stderr.write(
        `error: master key state needs an operator before rotating: ${rec.reason}\n`,
      )
      process.exit(2)
    }
    result = rotateMasterKey({
      spaceDir: dir,
      providerKind: env('GOTONG_MASTER_KEY_PROVIDER'),
      envKeyMaterial: env('GOTONG_MASTER_KEY'),
      envKeyEncoding: 'hex',
    })
  } catch (err) {
    process.stderr.write(
      `error: master key rotation failed: ${
        err instanceof Error ? err.message : String(err)
      }\n` +
        `hint: GOTONG_SPACE must point at an initialised workspace whose current\n` +
        `      key still loads; rotation only supports the local-file provider.\n`,
    )
    process.exit(2)
  }

  process.stdout.write(
    `\n` +
      `  Vault master key rotated for ${dir}.\n` +
      `  New key written to (mode 0o600): ${result.keyFilePath}\n` +
      `\n` +
      `  The data key was re-wrapped in place — vault secret rows were NOT\n` +
      `  re-encrypted (exception: a pre-envelope vault's one-time envelope\n` +
      `  migration); secrets.enc.json WAS re-encrypted under the new derived\n` +
      `  key (B① unification). The OLD master key no longer opens this vault.\n` +
      `  The supported procedure is stop -> rotate -> start. If the host WAS\n` +
      `  running just now, restarting does not undo the damage: any secret it\n` +
      `  saved during the rotation was written under the old derived key and is\n` +
      `  now lost or key-mixed — verify your LLM keys still load, and restore\n` +
      `  secrets.enc.json from a consistent backup if not. Back up the new key\n` +
      `  file with the same care as the db; retire offsite copies of the old.\n\n`,
  )
}

export function printUsage(): void {
  process.stdout.write(`Usage:
  gotong-host                            run the host (env-driven)
  gotong-host mint-admin-token [name]    add a fresh admin (recovery)
  gotong-host rotate-master-key          rotate the vault master key (KEK)
  gotong-host --version | -V             print version + exit
  gotong-host --help    | -h             this message + exit

Production Gotong host. Reads all configuration from environment
variables (12-factor style). No CLI flags drive runtime behavior — set
the env, run the command. The same binary works for local dev, LAN
deployments, and public VPS behind Caddy / nginx.

SUBCOMMANDS

  mint-admin-token [displayName]
      Recover when the first-run admin URL got lost (.command window
      closed, scrollback gone, etc). Opens GOTONG_SPACE without starting
      any listeners, creates a fresh admin in admins.json, prints the
      one-time login URL, and exits. Existing admins are unaffected.
      Default displayName: GOTONG_ADMIN_DISPLAY_NAME, else 'Recovered Operator'.
      Exits with status 2 if GOTONG_SPACE does not point at an
      initialised workspace.

  rotate-master-key
      Rotate the identity vault master key (KEK) without starting the
      Hub. Loads the current key (GOTONG_MASTER_KEY_PROVIDER / GOTONG_MASTER_KEY),
      generates a fresh random key, re-wraps the data key under it in O(1)
      (vault secret rows are NOT re-encrypted — except once, on a
      pre-envelope vault's first rotation; secrets.enc.json IS — the
      LLM-key store derives from the KEK since B①), and writes the new key
      to <GOTONG_SPACE>/identity-master.key (mode 0600, never printed).
      STOP the host first — a running host still holds the old derived
      key and could lose writes to (or mix keys with) the staged copy.
      local-file provider only — env / kms keys are rotated out of band.
      Exits with status 2 on failure. Refusals happen before anything
      commits; a crash mid-rotation leaves a staged state that boot
      recovery (or the recovery pass a re-run does first) completes —
      the new key is never lost. Run ONE rotation at a time, on a local
      disk (not NFS/SMB) — docs/OPERATIONS.md.

ENVIRONMENT
  GOTONG_SPACE              workspace directory (default: .gotong)
  GOTONG_HOST               bind address (default: 127.0.0.1)
  GOTONG_WEB_PORT           HTTP port (default: 3000)
  GOTONG_WS_PORT            WebSocket port for remote agents (default: 4000)
  GOTONG_GATING             'open' | 'admin-approval' (default: admin-approval)
  GOTONG_COOKIE_SECURE      '1' to set Secure + SameSite=Strict (default: 0)
  GOTONG_ALLOWED_HOSTS      comma list — enforce Host: / Origin: on state-changing requests
  GOTONG_ALLOW_INSECURE     '1' to downgrade the exposed-host boot self-check to a warning
  GOTONG_ADMIN_RATE_MAX     admin login attempts per IP per window (default: 10)
  GOTONG_ADMIN_RATE_SEC     rate-limit window in seconds (default: 60)
  GOTONG_DEFAULT_LANG       'zh' | 'en' (default: zh)
  GOTONG_HEARTBEAT_MS       transport heartbeat ms (default: 30000)
  GOTONG_SPACE_NAME         label for space.json on first init (default: Gotong)
  GOTONG_ADMIN_DISPLAY_NAME first admin's display name (default: Operator)
  GOTONG_WORKFLOWS_DIR      directory of *.yaml/*.json workflow files to
                          auto-load on boot
                          (default: <GOTONG_SPACE>/workflows/definitions)

  GOTONG_TRANSCRIPT_KEEP_SEGMENTS  keep N newest sealed transcript segments in
                          the boot load path; archive older into archive/
                          (bounds boot load to O(tail); unset = no archiving)
  GOTONG_TRANSCRIPT_ARCHIVE_DAYS   archive sealed segments older than N days
                          (may combine with KEEP_SEGMENTS; archived bytes
                          stay on disk for audit; malformed value fails boot)
  GOTONG_RUN_KEEP           keep N newest TERMINAL workflow runs on the active
                          scan path; archive older into runs/archive/ (bounds
                          boot-resume/history/metrics to O(tail); running runs
                          never archived; unset = off)
  GOTONG_RUN_ARCHIVE_DAYS   archive terminal runs that ended more than N days ago
                          (may combine with GOTONG_RUN_KEEP; archived runs stay
                          reachable for audit; malformed value fails boot)
  GOTONG_LEDGER_KEEP_DAYS   prune usage-ledger (billing) rows older than N days at
                          boot (retained window stays exportable; unset = off;
                          malformed value fails boot). Sibling knobs, same
                          semantics: GOTONG_AUDIT_KEEP_DAYS (audit_log),
                          GOTONG_PEER_SUMMARY_KEEP_DAYS (peer_summary_snapshots),
                          GOTONG_ALERT_FIRINGS_KEEP_DAYS (resolved alert firings;
                          open firings are never pruned)

  GOTONG_ASSISTANT_PROVIDER 'anthropic' (default) | 'openai' | 'mock' —
                          provider for the host-built-in WorkflowAssistantAgent
                          (Phase 13 M3). Skip registration when no key
                          available; admin UI's AI button hides via 503.
  GOTONG_ASSISTANT_MODEL    optional provider-specific model id for the assistant
  GOTONG_ASSISTANT_MAX_TOKENS  integer cap on assist response tokens (default 4096)
  GOTONG_ASSISTANT_DISABLED '1' | 'true' → don't register the assistant at all

  GOTONG_SECRET_KEY         optional master key for the workspace secrets file
                          (64 hex chars; overrides on-disk runtime/secret.key)
  GOTONG_MASTER_KEY_PROVIDER  identity vault master key source:
                          'local-file' (default, <GOTONG_SPACE>/identity-master.key)
                          | 'env' (inject via GOTONG_MASTER_KEY, no disk)
                          | 'kms-stub' (reserved seam, fails closed)
  GOTONG_MASTER_KEY         identity vault master key as 64 hex chars; required
                          when GOTONG_MASTER_KEY_PROVIDER=env
  ANTHROPIC_API_KEY       fallback Anthropic key for managed LLM agents
  OPENAI_API_KEY          fallback OpenAI key for managed LLM agents

EXAMPLES
  # Local one-liner (creates ./.gotong on first run, prints admin URL)
  npx @gotong/host

  # Custom workspace and ports
  GOTONG_SPACE=/srv/gotong GOTONG_WEB_PORT=3030 npx @gotong/host

  # Public deployment behind a TLS-terminating reverse proxy
  GOTONG_HOST=127.0.0.1 \\
  GOTONG_COOKIE_SECURE=1 \\
  GOTONG_ALLOWED_HOSTS=hub.example.com,hub-ws.example.com \\
  npx @gotong/host

DOCS
  https://github.com/Emir-Aksoy/Gotong/blob/main/docs/OVERVIEW.md
  https://github.com/Emir-Aksoy/Gotong/blob/main/docs/DEPLOY.md
`)
}

export function env(name: string, fallback?: string): string | undefined {
  const v = process.env[name]
  return v === undefined || v === '' ? fallback : v
}

export function envInt(name: string, fallback: number): number {
  const v = env(name)
  if (v === undefined) return fallback
  const n = Number(v)
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new Error(`${name} must be an integer; got '${v}'`)
  }
  return n
}

export function envBool(name: string, fallback: boolean): boolean {
  const v = env(name)
  if (v === undefined) return fallback
  return v === '1' || v.toLowerCase() === 'true' || v.toLowerCase() === 'yes'
}

export function envList(name: string): string[] | undefined {
  const v = env(name)
  if (v === undefined) return undefined
  const list = v.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
  return list.length > 0 ? list : undefined
}
