/**
 * Perf audit B② — opt-in new-version probe.
 *
 * Ops-burden gap: nothing tells a set-and-forget operator that a newer Gotong
 * exists — npm releases and git pushes both land silently, so hosts quietly
 * age. Two closers: `gotong update --check` (CLI, on-demand) and THIS — a
 * daily background probe of the npm registry's `latest` dist-tag for the
 * unscoped `gotong` meta package (all 37 packages share one version, so one
 * tag IS the release line).
 *
 * Boundaries:
 *   - OPT-IN (`GOTONG_UPDATE_CHECK`). The probe is a phone-home in the
 *     minimal sense — a GET that reveals this box's IP + liveness to
 *     registry.npmjs.org — so it is off by default per the 数据离盒 opt-in
 *     law. Unset ⇒ `arm()` returns null, zero timers, zero network,
 *     byte-identical host. No payload is ever sent either way.
 *   - Notify, never act: the answer surfaces as a log line + an admin-panel
 *     signal (via `latest()` → HealthSnapshot.updateAvailable). Applying the
 *     update stays a human running `gotong update` — 重启权在运维手里.
 *   - Honest tri-state: `latest()` is undefined until a probe has SUCCEEDED
 *     (unknown ≠ up-to-date), null when current is the latest, a row when a
 *     newer release exists. A failed probe keeps the last successful answer —
 *     a release that existed doesn't un-exist when the network blips.
 */

import type { Logger } from '@gotong/core'

/** npm dist-tags endpoint (the same lightweight one the npm CLI uses). */
export const VERSION_CHECK_URL = 'https://registry.npmjs.org/-/package/gotong/dist-tags'
/** Daily — release cadence is days/weeks; anything faster is wasted probes. */
export const VERSION_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
/**
 * First probe shortly after boot rather than one interval in: a long-lived
 * host restarts rarely, and boot (unlike retention) has NOT just answered
 * this question. The delay keeps the probe out of the boot burst.
 */
export const VERSION_CHECK_INITIAL_DELAY_MS = 5 * 60 * 1000

export interface UpdateAvailableRow {
  current: string
  latest: string
}

export interface VersionCheckOptions {
  env: Record<string, string | undefined>
  /** The running host's own version (main.ts passes BAKED_VERSION). */
  current: string
  log: Logger
  /** Injectable probe (tests). Default GETs the dist-tags endpoint. */
  fetchLatest?: () => Promise<string>
  /** Injectable cadence/delay (tests only — NOT operator knobs). */
  intervalMs?: number
  initialDelayMs?: number
}

export interface VersionCheckHandle {
  /** undefined = no successful probe yet · null = current is latest · row = newer exists. */
  latest(): UpdateAvailableRow | null | undefined
  stop(): void
}

export function versionCheckEnabled(env: Record<string, string | undefined>): boolean {
  return ['1', 'true', 'on', 'yes'].includes((env.GOTONG_UPDATE_CHECK ?? '').trim().toLowerCase())
}

/**
 * `[major, minor, patch]` or null. Prerelease/build suffixes compare by
 * triple only — our releases are plain triples (version-gate pins them), so
 * finer ordering would be precision we can't honestly claim to need.
 */
export function parseSemverTriple(v: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+]|$)/.exec(v.trim())
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

/** >0 when a is newer than b, 0 equal, <0 older. */
export function compareSemverTriple(
  a: [number, number, number],
  b: [number, number, number],
): number {
  if (a[0] !== b[0]) return a[0] - b[0]
  if (a[1] !== b[1]) return a[1] - b[1]
  return a[2] - b[2]
}

async function fetchLatestReal(): Promise<string> {
  const res = await fetch(VERSION_CHECK_URL, {
    signal: AbortSignal.timeout(10_000),
    headers: { accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`registry answered ${res.status}`)
  const body = (await res.json()) as { latest?: unknown }
  if (typeof body.latest !== 'string' || !body.latest) throw new Error('no latest dist-tag')
  return body.latest
}

/**
 * Arm the daily probe, or return null when `GOTONG_UPDATE_CHECK` is unset
 * (zero timers — byte-identical host). Never throws; a failing probe warns
 * (at most once per cadence) and keeps the previous answer.
 */
export function armVersionCheck(opts: VersionCheckOptions): VersionCheckHandle | null {
  if (!versionCheckEnabled(opts.env)) return null

  const fetchLatest = opts.fetchLatest ?? fetchLatestReal
  let state: UpdateAvailableRow | null | undefined
  let running = false
  const probe = async (): Promise<void> => {
    if (running) return
    running = true
    try {
      const latest = await fetchLatest()
      const cur = parseSemverTriple(opts.current)
      const lat = parseSemverTriple(latest)
      if (!cur || !lat) {
        // No reliable answer — keep the previous state rather than guess.
        opts.log.warn('version check: unparseable version string', {
          current: opts.current,
          latest,
        })
        return
      }
      if (compareSemverTriple(lat, cur) > 0) {
        state = { current: opts.current, latest }
        opts.log.info('a newer gotong release is available', { current: opts.current, latest })
      } else {
        state = null
      }
    } catch (err) {
      opts.log.warn('version check probe failed', { err })
    } finally {
      running = false
    }
  }

  const first = setTimeout(() => void probe(), opts.initialDelayMs ?? VERSION_CHECK_INITIAL_DELAY_MS)
  first.unref?.()
  const timer = setInterval(() => void probe(), opts.intervalMs ?? VERSION_CHECK_INTERVAL_MS)
  timer.unref?.()

  return {
    latest: () => state,
    stop() {
      clearTimeout(first)
      clearInterval(timer)
    },
  }
}
