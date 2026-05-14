/**
 * Wire protocol version. Bumped to `'1.1'` to advertise SERVICE_CALL /
 * SERVICE_RESULT support. v1.0 clients keep working — the new HELLO field
 * is optional and unknown frames degrade through the v1.0 `bad_frame`
 * path. See `docs/services-over-ws-rfc.md` §8.
 */
export const PROTOCOL_VERSION = '1.1' as const

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

/**
 * Whitelisted method names per service type. The server's `ServiceCallRouter`
 * MUST refuse to dispatch any `method` not present in this table — keeps the
 * attack surface bounded (no prototype-chain walking; no plugin-private
 * helpers exposed).
 *
 * Dotted forms (e.g. `'sql.exec'`) descend into a named sub-namespace on
 * the handle; the router splits on `.` once before doing the lookup.
 *
 * Aligned with the contracts in `@aipehub/services-sdk/types/{memory,artifact,
 * datastore}.ts`. Third-party service types are NOT covered by this table
 * in v1.1 — `extendServiceMethodAllowlist` lands in v1.2 (RFC §5.3).
 */
export const SERVICE_METHOD_ALLOWLIST: Readonly<Record<string, readonly string[]>> = {
  memory: ['recall', 'remember', 'list', 'forget', 'clear'],
  artifact: ['write', 'read', 'list', 'exists', 'remove'],
  // DatastoreHandle has two nested namespaces (`kv` + `sql`); both must be
  // reachable. The `name` field is read-only and exposed eagerly by the SDK
  // (from the decl's `config.name`) so it doesn't need an RPC.
  datastore: ['kv.get', 'kv.set', 'kv.del', 'kv.keys', 'sql.exec', 'sql.query'],
}

/**
 * Default per-call deadline the SDK applies when awaiting a SERVICE_RESULT.
 * The server does NOT enforce this — it's purely a client-side guard so a
 * dead connection doesn't strand awaiters. Tunable per `connect()` call.
 */
export const DEFAULT_SERVICE_CALL_TIMEOUT_MS = 30_000
