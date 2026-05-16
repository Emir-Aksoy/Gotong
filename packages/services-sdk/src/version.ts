/**
 * Plugin SDK ↔ plugin version negotiation.
 *
 * Each plugin reports its `version` (semver). The SDK exports an
 * `SDK_VERSION` constant. When loading, the {@link ServiceRegistry}
 * compares majors: a plugin built against SDK 1.x cannot load into a
 * host that ships SDK 2.x (breaking changes assumed at major bumps).
 *
 * 0.x is treated like 1.x: every minor in 0.x may break, but during
 * MVP we want pre-1.0 churn to fail loud rather than silently.
 *
 * Plugins don't have to bump their version every release — only when
 * they want to declare compatibility with a newer SDK major.
 */

/**
 * Current SDK major. Bump together with breaking changes to the
 * `ServicePlugin` contract or to any per-type handle interface.
 *
 * Plugins compare against this via {@link majorMatches}.
 */
export const SDK_MAJOR = 0

/**
 * Parse a semver-ish string and return its major.
 *
 *   parseMajor('0.1.3')     → 0
 *   parseMajor('1.0.0-beta')→ 1
 *   parseMajor('weird')     → throws
 */
export function parseMajor(version: string): number {
  const m = /^(\d+)\./.exec(version.trim())
  if (!m) throw new Error(`unparseable version: ${version}`)
  return Number(m[1])
}

/**
 * True iff a plugin reporting `pluginVersion` is compatible with the
 * host's `sdkMajor`. Currently requires exact major equality.
 *
 * Future: allow plugin major ≤ sdkMajor when we add intentional
 * back-compat. Not in scope for MVP.
 */
export function majorMatches(pluginVersion: string, sdkMajor: number = SDK_MAJOR): boolean {
  return parseMajor(pluginVersion) === sdkMajor
}
