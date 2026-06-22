// Friendly first-run entry — the smallest "download → running" nicety.
//
// host main.ts already auto-creates the workspace on first boot
// (`Space.openOrInit`) and serves a loopback setup wizard at the web
// root. The only thing missing was *pointing a fresh user at it*: this
// module renders the prominent "open this URL to finish setup" banner and
// (optionally, loopback-only) opens the browser for them.
//
// Everything here is pure / injectable so it can be unit-tested without
// booting a host. No core/protocol/identity behavior changes — this is a
// presentation wrapper, nothing more.

import { spawn as nodeSpawn } from 'node:child_process'

export type OpenBrowserMode = 'auto' | 'always' | 'never'

/**
 * Read `AIPE_OPEN_BROWSER`:
 *   - '0' / 'false' / 'off' / 'no'  → never
 *   - '1' / 'true'  / 'on'  / 'yes' → always
 *   - unset / anything else         → auto (first run only)
 */
export function parseOpenBrowserEnv(raw: string | undefined): OpenBrowserMode {
  const v = (raw ?? '').trim().toLowerCase()
  if (v === '0' || v === 'false' || v === 'off' || v === 'no') return 'never'
  if (v === '1' || v === 'true' || v === 'on' || v === 'yes') return 'always'
  return 'auto'
}

/**
 * Decide whether to auto-open a browser.
 *
 * Never when the host is network-exposed (don't pop a browser on a
 * headless server, and the loopback setup wizard isn't reachable there
 * anyway — that path uses the admin-token file). In `auto`, open only on
 * the very first run; `always` opens every start, `never` opens none.
 */
export function shouldOpenBrowser(
  mode: OpenBrowserMode,
  ctx: { loopback: boolean; firstRun: boolean },
): boolean {
  if (!ctx.loopback) return false
  if (mode === 'never') return false
  if (mode === 'always') return true
  return ctx.firstRun
}

/**
 * The prominent first-run guidance block. The setup wizard lives at the
 * web root (loopback bootstrap, no token needed) — send a fresh user
 * straight there. Bilingual + width-safe (no box-drawing so CJK double-
 * width glyphs don't misalign in a terminal).
 */
export function firstRunSetupBanner(webUrl: string): string {
  return [
    ``,
    `┌─ 下一步 / Next step ──────────────────────────`,
    ``,
    `  打开浏览器完成 5 分钟设置 (设置向导,无需 token):`,
    `  Open your browser to finish the 5-minute setup:`,
    ``,
    `      →  ${webUrl}`,
    ``,
    `  设置向导在本机回环 (loopback) 上运行。`,
    `  The setup wizard runs on loopback only.`,
    `└───────────────────────────────────────────────`,
  ].join('\n')
}

export interface SpawnLike {
  (
    command: string,
    args: string[],
    options: { detached: boolean; stdio: 'ignore' },
  ): { unref?: () => void }
}

/**
 * Best-effort: open `url` in the OS default browser. Detached + ignored
 * stdio so it never blocks or pollutes host logs; never throws (a missing
 * opener on a headless box is fine — the banner already printed the URL).
 * Returns true if the spawn was issued.
 *
 * `platform` and `spawn` are injectable for hermetic tests.
 */
export function openUrl(
  url: string,
  opts: {
    platform?: NodeJS.Platform
    spawn?: SpawnLike
    onError?: (err: unknown) => void
  } = {},
): boolean {
  const platform = opts.platform ?? process.platform
  const spawnImpl = opts.spawn ?? (nodeSpawn as unknown as SpawnLike)

  let command: string
  let args: string[]
  if (platform === 'darwin') {
    command = 'open'
    args = [url]
  } else if (platform === 'win32') {
    // `start` is a cmd builtin; the empty "" is the window title arg so a
    // URL with spaces/special chars isn't mistaken for the title.
    command = 'cmd'
    args = ['/c', 'start', '', url]
  } else {
    command = 'xdg-open'
    args = [url]
  }

  try {
    const child = spawnImpl(command, args, { detached: true, stdio: 'ignore' })
    child.unref?.()
    return true
  } catch (err) {
    opts.onError?.(err)
    return false
  }
}
