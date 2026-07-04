/**
 * Boot-time security self-check (Route B P0-M6).
 *
 * Single-machine / loopback deployments are safe by construction. The danger
 * is an operator who exposes the hub to the network — binds a non-loopback
 * address, typically behind (or instead of) a reverse proxy — but forgets the
 * defenses that only start to matter once traffic crosses a wire:
 *
 *   - GOTONG_ALLOWED_HOSTS  Host/Origin allowlist on state-changing requests.
 *                         Unset → the CSRF / DNS-rebinding defense is OFF.
 *   - GOTONG_COOKIE_SECURE  Secure + SameSite=Strict on the session cookie.
 *                         Off → the cookie can ride a plain-HTTP request.
 *
 * Until now these gaps were silent — the boot banner even printed "loopback
 * only is safe" while bound to 0.0.0.0. This module makes the gap LOUD and
 * fail-closed: an exposed host with a missing defense refuses to start, unless
 * the operator explicitly accepts the risk via GOTONG_ALLOW_INSECURE=1 (which
 * downgrades the refusal to a loud warning — the escape hatch for "my reverse
 * proxy terminates TLS and validates Host upstream").
 *
 * Pure + side-effect-free so the policy is unit-tested; main.ts does only the
 * thin "fatal → print report + exit" wiring.
 */

export type BootSecuritySeverity = 'fatal' | 'warn'

export type BootSecurityCode =
  | 'host_check_disabled_while_exposed'
  | 'cookie_insecure_while_exposed'

export interface BootSecurityViolation {
  code: BootSecurityCode
  severity: BootSecuritySeverity
  /** One-line statement of what's wrong. */
  message: string
  /** Concrete env var(s) to set to fix it. */
  remediation: string
}

export interface BootSecurityInput {
  /** The bind address (SpaceConfig.host). */
  host: string
  /** Whether the Secure cookie flag is on (SpaceConfig.cookieSecure). */
  cookieSecure: boolean
  /** Parsed GOTONG_ALLOWED_HOSTS (undefined / empty = unset). */
  allowedHosts: string[] | undefined
  /** GOTONG_ALLOW_INSECURE — downgrade fatal violations to warnings. */
  allowInsecure: boolean
}

/**
 * Is the bind address a loopback / single-machine address? Loopback hosts are
 * network-isolated, so the exposure-only defenses aren't required.
 *
 * `0.0.0.0` / `::` (wildcard binds) are deliberately NOT loopback — they
 * listen on every interface, including external ones. Any other address or a
 * DNS name is treated as exposed (defense-in-depth: even a private-LAN bind
 * warrants the Host check).
 */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase()
  if (h === 'localhost' || h === '::1' || h === '[::1]') return true
  // The entire 127.0.0.0/8 loopback block, not just 127.0.0.1.
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true
  return false
}

/**
 * Audit the boot security posture. Returns an empty array for a safe
 * (loopback) deployment. For an exposed host, each missing defense becomes a
 * violation — `fatal` by default, downgraded to `warn` when `allowInsecure`.
 */
export function auditBootSecurity(input: BootSecurityInput): BootSecurityViolation[] {
  // Loopback is safe by construction — nothing required.
  if (isLoopbackHost(input.host)) return []

  const severity: BootSecuritySeverity = input.allowInsecure ? 'warn' : 'fatal'
  const out: BootSecurityViolation[] = []

  if (!input.allowedHosts || input.allowedHosts.length === 0) {
    out.push({
      code: 'host_check_disabled_while_exposed',
      severity,
      message:
        `bound to a non-loopback address (${input.host}) but GOTONG_ALLOWED_HOSTS ` +
        `is unset — the Host/Origin check on state-changing requests is ` +
        `disabled (CSRF / DNS-rebinding risk).`,
      remediation:
        `set GOTONG_ALLOWED_HOSTS=your.domain[,your-ws.domain] (the public ` +
        `host[:port] clients connect to).`,
    })
  }

  if (!input.cookieSecure) {
    out.push({
      code: 'cookie_insecure_while_exposed',
      severity,
      message:
        `bound to a non-loopback address (${input.host}) but the session ` +
        `cookie has no Secure flag — it can ride a plain-HTTP request.`,
      remediation: `set GOTONG_COOKIE_SECURE=1 (serve over HTTPS / behind a TLS proxy).`,
    })
  }

  return out
}

/**
 * Render a human-facing report for stderr / the boot banner. `fatal` toggles
 * the heading and appends the GOTONG_ALLOW_INSECURE escape-hatch note.
 */
export function formatBootSecurityReport(
  violations: BootSecurityViolation[],
  opts: { fatal: boolean },
): string {
  const lines: string[] = []
  lines.push(
    opts.fatal
      ? 'FATAL: refusing to start — this host is network-exposed but missing security defenses:'
      : 'WARNING: network-exposed host is missing security defenses (GOTONG_ALLOW_INSECURE accepted the risk):',
  )
  for (const v of violations) {
    lines.push(`  - [${v.code}] ${v.message}`)
    lines.push(`    fix: ${v.remediation}`)
  }
  if (opts.fatal) {
    lines.push(
      `  To accept this risk anyway (e.g. a reverse proxy validates Host and terminates TLS),`,
    )
    lines.push(`  set GOTONG_ALLOW_INSECURE=1 to downgrade these to warnings.`)
  }
  return lines.join('\n')
}
