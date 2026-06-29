/**
 * workspace-jail-detect.ts — the ONE impure part of the FS sandbox: probe the
 * host for an OS kernel jail (layer 2). Everything in `workspace-jail.ts` is
 * pure argv/profile building; the actual "is bwrap installed and does
 * unprivileged userns work here?" question can only be answered by spawning, so
 * it lives apart.
 *
 * The probe is FUNCTIONAL, not a `which` lookup: a `bwrap` binary that can't
 * create a user namespace (hardened kernels, some containers) is useless, and a
 * `sandbox-exec` that the platform rejects is useless. So we actually run the
 * enforcer over a trivial `true` and trust it only if it exits 0. The result is
 * cached (the host's capability doesn't change within a process) but the cache
 * is bypassable for tests via an injected `spawn`.
 *
 * Degradation is the caller's job: a `kind: 'none'` capability means "no real
 * perimeter" — the caller falls back to layer 1 + a human gate + a loud warning,
 * never silently runs unconfined.
 */

import type { FsJailKind, FsJailSpec } from './workspace-jail.js'

/** Outcome of probing the host for an OS kernel jail. */
export interface FsJailCapability {
  /** The usable enforcer, or `'none'` when neither probe succeeded. */
  readonly kind: FsJailKind
  /** Human-readable reason, present when `kind === 'none'` (why no jail). */
  readonly reason?: string
}

/** Minimal probe result — exit code is all we need (0 = the enforcer works). */
export interface JailProbeResult {
  readonly ok: boolean
  /** Optional detail surfaced into `reason` on failure (stderr / spawn error). */
  readonly detail?: string
}

/** Injectable spawn-and-wait for tests; runs `command args…`, resolves exit==0. */
export type JailProbe = (command: string, args: readonly string[]) => Promise<JailProbeResult>

export interface DetectFsJailOptions {
  /** Override `process.platform` (tests). */
  platform?: NodeJS.Platform
  /** Override the functional probe (tests). Default spawns a real child. */
  probe?: JailProbe
  /** Skip the module-level cache (tests / re-probe). */
  noCache?: boolean
}

/**
 * A throwaway Seatbelt profile + `true`: if macOS accepts it the enforcer is
 * usable. `(allow default)` keeps the probe from being denied for unrelated
 * reasons — we're testing that `sandbox-exec` RUNS, not confinement here.
 */
const MAC_PROBE_PROFILE = '(version 1)(allow default)'

let cached: FsJailCapability | undefined

/**
 * Detect the OS kernel jail available on this host. Cached after the first call
 * (pass `noCache` to re-probe). Returns `{ kind: 'none', reason }` when no
 * enforcer works — the caller must then degrade (layer 1 + human gate + warn),
 * never run unconfined silently.
 */
export async function detectFsJail(opts: DetectFsJailOptions = {}): Promise<FsJailCapability> {
  if (cached && !opts.noCache) return cached

  const platform = opts.platform ?? process.platform
  const probe = opts.probe ?? defaultProbe

  let result: FsJailCapability
  if (platform === 'darwin') {
    const r = await probe('sandbox-exec', ['-p', MAC_PROBE_PROFILE, 'true'])
    result = r.ok
      ? { kind: 'sandbox-exec' }
      : { kind: 'none', reason: macReason(r.detail) }
  } else if (platform === 'linux') {
    // `--ro-bind / /` + `true` functionally tests unprivileged user namespaces
    // (the part hardened kernels disable), not just that the binary exists.
    const r = await probe('bwrap', ['--ro-bind', '/', '/', '--dev', '/dev', 'true'])
    result = r.ok
      ? { kind: 'bwrap' }
      : { kind: 'none', reason: bwrapReason(r.detail) }
  } else {
    result = { kind: 'none', reason: `no OS kernel jail on platform '${platform}' (Windows deferred)` }
  }

  if (!opts.noCache) cached = result
  return result
}

/** Clear the cached capability — for tests, or after an environment change. */
export function resetFsJailCache(): void {
  cached = undefined
}

/** Result of {@link prepareFsJail} — a ready-to-thread spec plus the honest degradation signal. */
export interface PreparedFsJail {
  /** Hand this to an adapter (`CliRunOptions.fsJail` / `AcpSpawnOptions.fsJail`). */
  readonly spec: FsJailSpec
  /** True when an OS kernel jail will actually confine the child tree. */
  readonly jailed: boolean
  /** Present iff NOT jailed — a loud message the caller should log AND pair with a human gate. */
  readonly warning?: string
}

export interface PrepareFsJailOptions extends DetectFsJailOptions {
  /** Directories the spawned tree may write to. */
  allowedRoots: readonly string[]
  /** Extra writable directories beyond the roots. */
  extraWritableRoots?: readonly string[]
}

/**
 * The one-call host seam: probe the OS jail, then return a {@link FsJailSpec}
 * ready to hand an adapter. When no enforcer is available (`kind: 'none'`),
 * `jailed` is false and `warning` carries the reason — the caller MUST log it and
 * pair the spawn with a human gate, never run unconfined silently. Folds the
 * detect → spec → degrade dance into one place so cli-agent / acp-agent / the
 * host don't each re-implement it.
 */
export async function prepareFsJail(opts: PrepareFsJailOptions): Promise<PreparedFsJail> {
  const detectOpts: DetectFsJailOptions = {
    ...(opts.platform !== undefined ? { platform: opts.platform } : {}),
    ...(opts.probe !== undefined ? { probe: opts.probe } : {}),
    ...(opts.noCache !== undefined ? { noCache: opts.noCache } : {}),
  }
  const cap = await detectFsJail(detectOpts)
  const spec: FsJailSpec = {
    allowedRoots: opts.allowedRoots,
    kind: cap.kind,
    ...(opts.extraWritableRoots !== undefined ? { extraWritableRoots: opts.extraWritableRoots } : {}),
  }
  if (cap.kind === 'none') {
    return { spec, jailed: false, warning: cap.reason ?? 'no OS kernel jail available' }
  }
  return { spec, jailed: true }
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

function macReason(detail?: string): string {
  return `sandbox-exec unavailable${detail ? `: ${detail}` : ''} — falling back to argv jail + human gate`
}

function bwrapReason(detail?: string): string {
  return `bwrap unavailable (install bubblewrap; needs unprivileged user namespaces)${
    detail ? `: ${detail}` : ''
  } — falling back to argv jail + human gate`
}

/**
 * The real probe: spawn the enforcer over `true` and resolve `ok` iff it exits
 * 0. A missing binary (`ENOENT`) or any spawn error resolves `ok: false` with
 * the message as detail — never throws, so detection degrades gracefully.
 */
const defaultProbe: JailProbe = async (command, args) => {
  const { spawn } = await import('node:child_process')
  return await new Promise<JailProbeResult>((resolve) => {
    let settled = false
    const done = (r: JailProbeResult) => {
      if (!settled) {
        settled = true
        resolve(r)
      }
    }
    try {
      const child = spawn(command, [...args], { stdio: 'ignore' })
      child.on('error', (err) => done({ ok: false, detail: (err as Error).message }))
      child.on('close', (code) => done({ ok: code === 0 }))
    } catch (err) {
      done({ ok: false, detail: (err as Error).message })
    }
  })
}
