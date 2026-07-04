/**
 * Friendly boot-failure hints (ease-of-use ⑥-M2, extended ❸-M1).
 *
 * The host binds two ports on startup — the admin UI / API port (GOTONG_WEB_PORT,
 * via `serveWeb`) and the agent WebSocket port (GOTONG_WS_PORT, via
 * `serveWebSocket`) — and opens its workspace (GOTONG_SPACE) plus the identity
 * vault (master key) before the hub is up. When any of those fail the raw error
 * reaches the operator as a structured-fatal dump from the top-level boot catch,
 * which explains nothing actionable.
 *
 * `friendlyBootError` turns the common, recoverable boot failures into short,
 * actionable messages — which env var to change, plus a pointer at `gotong
 * doctor` (its ⑥-M1 sibling). It recognises, in order:
 *
 *   • EADDRINUSE                 a listen port is taken (the original ⑥-M2 case)
 *   • EACCES/EPERM on `listen`   not allowed to bind a privileged port (<1024) —
 *                                disambiguated from a workspace-permission
 *                                problem by the `listen` syscall, so a port-80
 *                                user is NOT wrongly told to fix GOTONG_SPACE
 *   • "master key" failures      the identity vault key is missing / wrong
 *                                length / unreadable (identity throws an
 *                                IdentityError whose message always names it)
 *   • EACCES/EPERM/EROFS (fs)    the workspace directory isn't writable
 *   • ENOSPC/EDQUOT              the disk holding the workspace is full / over quota
 *
 * It is a PURE function returning the text (or `null` when the error isn't one it
 * recognises, so the caller keeps its default `log.fatal` path) — the boot catch
 * does the actual stderr write + exit. Nothing in the routing / runner / schema
 * path is touched; this is a launcher-layer wrapper only.
 */

export interface BootPorts {
  webPort: number
  wsPort: number
}

/** Same parse the host config uses: a positive integer, else the default. */
function intOr(raw: string | undefined, fallback: number): number {
  const n = Number((raw ?? '').trim())
  return Number.isInteger(n) && n > 0 ? n : fallback
}

/** Resolve the two listen ports from the env (same keys/defaults as the host config). */
export function bootPortsFromEnv(env: Record<string, string | undefined> = process.env): BootPorts {
  return {
    webPort: intOr(env.GOTONG_WEB_PORT, 3000),
    wsPort: intOr(env.GOTONG_WS_PORT, 4000),
  }
}

/** Resolve the workspace directory from the env (same key/default as the host: `.gotong`). */
export function bootSpaceFromEnv(env: Record<string, string | undefined> = process.env): string {
  const dir = (env.GOTONG_SPACE ?? '').trim()
  return dir.length > 0 ? dir : '.gotong'
}

/** A boot error widened to read the runtime-only fields Node attaches to errno errors. */
type ErrnoLike = NodeJS.ErrnoException & { port?: number; path?: string }

const BANNER = '✖ Gotong could not start'
const DOCTOR_PORTS = 'Run `gotong doctor` to check ports and settings.'
const DOCTOR_SPACE = 'Run `gotong doctor` to check your workspace and settings.'

/** The path Node names on a filesystem error, else the env-resolved workspace dir. */
function spaceTarget(e: ErrnoLike, env: Record<string, string | undefined>): string {
  return typeof e.path === 'string' && e.path.length > 0 ? e.path : bootSpaceFromEnv(env)
}

/** Frame a hint: banner headline, blank line, body lines, blank line, doctor pointer. */
function frame(headline: string, body: string[], doctor: string): string {
  return [`${BANNER} — ${headline}`, '', ...body, '', `  ${doctor}`].join('\n')
}

/** EADDRINUSE — a listen port is already taken (the original ⑥-M2 case). */
function portInUseHint(e: ErrnoLike, env: Record<string, string | undefined>): string {
  const { webPort, wsPort } = bootPortsFromEnv(env)
  const port = typeof e.port === 'number' ? e.port : undefined

  let body: string[]
  if (port === webPort) {
    body = [
      `  Port ${webPort} (admin UI / API) is already in use. Either:`,
      `    • another Gotong may already be running — open http://127.0.0.1:${webPort}/`,
      `    • or set GOTONG_WEB_PORT to a free port (e.g. ${webPort + 1}) and relaunch`,
    ]
  } else if (port === wsPort) {
    body = [
      `  Port ${wsPort} (agent WebSocket) is already in use. Either:`,
      `    • another Gotong may already be running`,
      `    • or set GOTONG_WS_PORT to a free port (e.g. ${wsPort + 1}) and relaunch`,
    ]
  } else {
    const where = port ? `Port ${port}` : 'A port the host needs'
    body = [
      `  ${where} is already in use. Gotong listens on two ports:`,
      `    • GOTONG_WEB_PORT  admin UI / API    (now ${webPort})`,
      `    • GOTONG_WS_PORT   agent WebSocket   (now ${wsPort})`,
      `  Set whichever collides to a free port and relaunch.`,
    ]
  }
  return frame('a port it needs is already in use.', body, DOCTOR_PORTS)
}

/** EACCES/EPERM while binding a listen port — almost always a privileged port (<1024). */
function listenPermissionHint(e: ErrnoLike, env: Record<string, string | undefined>): string {
  const { webPort, wsPort } = bootPortsFromEnv(env)
  const port = typeof e.port === 'number' ? e.port : undefined
  const which =
    port === webPort
      ? 'GOTONG_WEB_PORT'
      : port === wsPort
        ? 'GOTONG_WS_PORT'
        : 'GOTONG_WEB_PORT / GOTONG_WS_PORT'
  const where = port ? `Port ${port}` : 'A port the host needs'
  return frame('it is not allowed to bind a port it needs.', [
    `  ${where} requires elevated privileges — ports below 1024 are`,
    `  restricted on most systems. Either:`,
    `    • set ${which} to a port ≥ 1024 (e.g. ${webPort} / ${wsPort}) and relaunch`,
    `    • or run behind a reverse proxy that forwards 80/443 to the high port`,
  ], DOCTOR_PORTS)
}

/**
 * The identity vault master key is missing / wrong length / unreadable.
 * Identity throws an IdentityError('invalid_input') whose message always names
 * "master key" — that substring is the discriminator (fs errors on the key file
 * say "identity-master.key" without the space, so they don't false-match and
 * fall through to the workspace-permission branch, which is the right fix there).
 */
function isMasterKeyError(e: ErrnoLike): boolean {
  // NOT a `e is Error` type guard: ErrnoLike already extends Error, so a
  // narrowing guard would collapse the negative branch (the fs/disk checks
  // below) to `never`. A plain boolean keeps `e` typed for the later branches.
  return typeof e.message === 'string' && /master key/i.test(e.message)
}

function masterKeyHint(e: Error, env: Record<string, string | undefined>): string {
  const space = bootSpaceFromEnv(env)
  return frame('the identity vault master key is missing or invalid.', [
    '  Gotong encrypts stored secrets (LLM keys, peer tokens) with a master key.',
    `  details: ${e.message}`,
    '  Depending on how you run it:',
    `    • default (local-file): the key lives at ${space}/identity-master.key —`,
    '      if it was moved or truncated, restore it from your backup (a NEW key',
    '      cannot decrypt secrets written under the old one)',
    '    • env provider: set GOTONG_MASTER_KEY to the 64-hex-char key and',
    '      GOTONG_MASTER_KEY_PROVIDER=env',
  ], DOCTOR_SPACE)
}

/** EACCES/EPERM/EROFS writing the workspace — fix perms or point GOTONG_SPACE elsewhere. */
function spacePermissionHint(e: ErrnoLike, env: Record<string, string | undefined>): string {
  const target = spaceTarget(e, env)
  const readOnly = e.code === 'EROFS'
  const cause = readOnly
    ? '  Gotong stores all state under GOTONG_SPACE, but that path is on a'
    : '  Gotong stores all state under GOTONG_SPACE; it could not write to:'
  const body = readOnly
    ? [
        cause,
        '  read-only filesystem:',
        `    ${target}`,
        '  Point GOTONG_SPACE at a writable directory (or remount read-write) and relaunch.',
      ]
    : [
        cause,
        `    ${target}`,
        '  Either:',
        '    • fix the directory owner/permissions so this process can write it',
        '      (e.g. chown/chmod, or run as the owning user)',
        '    • or point GOTONG_SPACE at a directory you own and relaunch',
      ]
  return frame('its workspace directory is not writable.', body, DOCTOR_SPACE)
}

/** ENOSPC/EDQUOT writing the workspace — the disk is full / over quota. */
function diskFullHint(e: ErrnoLike, env: Record<string, string | undefined>): string {
  const target = spaceTarget(e, env)
  const quota = e.code === 'EDQUOT'
  return frame('there is no space left to write its workspace.', [
    quota
      ? '  The disk holding GOTONG_SPACE is over quota while writing:'
      : '  The disk holding GOTONG_SPACE is full while writing:',
    `    ${target}`,
    quota ? '  Raise the quota (or free up space), then relaunch.' : '  Free up space, then relaunch.',
  ], DOCTOR_SPACE)
}

/**
 * Map a boot error to an actionable, human-readable hint — or `null` when it's
 * not a recognised, friendly-able failure (the caller then keeps its default
 * path). See the module header for the recognised set and ordering.
 */
export function friendlyBootError(
  err: unknown,
  env: Record<string, string | undefined> = process.env,
): string | null {
  if (err === null || err === undefined) return null
  const e = err as ErrnoLike

  // 1. Port already in use (the original ⑥-M2 case).
  if (e.code === 'EADDRINUSE') return portInUseHint(e, env)

  // 2. Permission denied binding a listen port (privileged port < 1024). The
  //    `listen` syscall distinguishes this from a workspace-permission problem
  //    so we don't tell a port-80 user to chmod their data directory.
  if ((e.code === 'EACCES' || e.code === 'EPERM') && e.syscall === 'listen')
    return listenPermissionHint(e, env)

  // 3. Master key missing / wrong length / unreadable (matched by message; runs
  //    before the fs-permission branch so a key-config error isn't mistaken for
  //    a generic EACCES).
  if (isMasterKeyError(e)) return masterKeyHint(e as Error, env)

  // 4. Workspace not writable: permission denied or a read-only mount.
  if (e.code === 'EACCES' || e.code === 'EPERM' || e.code === 'EROFS')
    return spacePermissionHint(e, env)

  // 5. Disk full / over quota while writing the workspace.
  if (e.code === 'ENOSPC' || e.code === 'EDQUOT') return diskFullHint(e, env)

  return null
}
