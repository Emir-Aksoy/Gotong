/**
 * admin-link.ts — persist the one-time first-run admin URL.
 *
 * Extracted from main.ts (Route B P0-M3-M4 follow-up). main.ts runs `main()`
 * at module top, so *importing anything from it boots a whole host* — a test
 * that only wants `writeAdminLinkFile` would (silently) try to bind the
 * default web port and, when that port is taken, crash the worker with
 * EADDRINUSE. Helpers that tests import belong in their own module, the way
 * `run-retention.ts` / `boot-security.ts` already are; main.ts stays a pure
 * entry point.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * Persist the one-time admin URL to `runtime/admin-link.txt` with file
 * mode 0o600. Idempotent — overwrites any prior link from a previous
 * run / mint-admin-token invocation. See H20 in AUDIT-v3.3.md.
 *
 * Why a file instead of `console.log`:
 *   - stdout from a daemon process is captured by `journalctl`,
 *     `docker logs`, `pm2 logs`, container log shippers, etc. Any
 *     reader of those logs picks up the token.
 *   - Pre-3.4 also dumped the token into the host's first boot banner,
 *     which is the easiest "search the logs for the admin URL" target
 *     for an attacker who lands a low-priv shell on the box.
 *   - The workspace directory is already protected by `SECURE_DIR_MODE`
 *     (0o700, see core/space.ts). Writing the link inside it with
 *     mode 0o600 puts it under exactly the same trust boundary the
 *     master key already enjoys — no new attack surface.
 */
export async function writeAdminLinkFile(path: string, url: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  // The runtime/ dir was already chmod'd to 0o700 by Space.init; the
  // file's own 0o600 is the second layer.
  await writeFile(path, url + '\n', { encoding: 'utf8', mode: 0o600 })
}
