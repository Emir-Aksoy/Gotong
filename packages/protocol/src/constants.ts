export const PROTOCOL_VERSION = '1.0' as const

/** Default server PING cadence. Clients are told this value in WELCOME. */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000

/** A connection that has not sent HELLO within this window is closed. */
export const HELLO_TIMEOUT_MS = 5_000

/** Max in-flight unanswered PINGs before the server gives up on the connection. */
export const MAX_MISSED_PINGS = 2

/** Major versions must match. */
export function majorVersionOf(v: string): number {
  const m = v.split('.')[0]
  const n = Number.parseInt(m ?? '', 10)
  return Number.isFinite(n) ? n : -1
}
