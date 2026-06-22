/**
 * Friendly boot-failure hints (ease-of-use ⑥-M2).
 *
 * The host binds two ports on startup — the admin UI / API port (AIPE_WEB_PORT,
 * via `serveWeb`) and the agent WebSocket port (AIPE_WS_PORT, via
 * `serveWebSocket`). Both reject with a raw `EADDRINUSE` when their port is
 * taken, which otherwise reaches the operator as a structured-fatal dump from
 * the top-level boot catch. On a fresh box "address in use" almost always means
 * one of two recoverable things — a second host is already running, or the
 * default port collides with something else — neither of which a stack trace
 * explains.
 *
 * `friendlyBootError` turns that one common failure into a short, actionable
 * message: which env var to change, plus a pointer at `aipehub doctor` (its ⑥-M1
 * sibling). It is a PURE function returning the text (or `null` when the error
 * isn't one it recognises, so the caller keeps its default `log.fatal` path) —
 * the boot catch does the actual stderr write + exit. Nothing in the routing /
 * runner / schema path is touched; this is a launcher-layer wrapper only.
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
    webPort: intOr(env.AIPE_WEB_PORT, 3000),
    wsPort: intOr(env.AIPE_WS_PORT, 4000),
  }
}

/**
 * Map a boot error to an actionable, human-readable hint — or `null` when it's
 * not a recognised, friendly-able failure (the caller then keeps its default
 * path). Today it recognises `EADDRINUSE` on either listen port.
 */
export function friendlyBootError(
  err: unknown,
  env: Record<string, string | undefined> = process.env,
): string | null {
  // A listen-time EADDRINUSE carries the colliding port on `.port` at runtime,
  // though `ErrnoException` doesn't declare it — widen the cast to read it.
  const e = err as (NodeJS.ErrnoException & { port?: number }) | null | undefined
  if (!e || e.code !== 'EADDRINUSE') return null

  const { webPort, wsPort } = bootPortsFromEnv(env)
  // Name the specific env var when we can identify which listener it was, else
  // describe both.
  const port = typeof e.port === 'number' ? e.port : undefined

  let body: string[]
  if (port === webPort) {
    body = [
      `  Port ${webPort} (admin UI / API) is already in use. Either:`,
      `    • another AipeHub may already be running — open http://127.0.0.1:${webPort}/`,
      `    • or set AIPE_WEB_PORT to a free port (e.g. ${webPort + 1}) and relaunch`,
    ]
  } else if (port === wsPort) {
    body = [
      `  Port ${wsPort} (agent WebSocket) is already in use. Either:`,
      `    • another AipeHub may already be running`,
      `    • or set AIPE_WS_PORT to a free port (e.g. ${wsPort + 1}) and relaunch`,
    ]
  } else {
    const where = port ? `Port ${port}` : 'A port the host needs'
    body = [
      `  ${where} is already in use. AipeHub listens on two ports:`,
      `    • AIPE_WEB_PORT  admin UI / API    (now ${webPort})`,
      `    • AIPE_WS_PORT   agent WebSocket   (now ${wsPort})`,
      `  Set whichever collides to a free port and relaunch.`,
    ]
  }

  return [
    '✖ AipeHub could not start — a port it needs is already in use.',
    '',
    ...body,
    '',
    '  Run `aipehub doctor` to check ports and settings before starting.',
  ].join('\n')
}
