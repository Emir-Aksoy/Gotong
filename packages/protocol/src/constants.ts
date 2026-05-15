/**
 * Wire protocol version. Bumped to `'1.2'` to advertise per-method ACL
 * narrowing (`ServiceUseDecl.methods`), the new `forbidden_method` error
 * code, and the third-party `registerServiceMethods` extension point.
 * v1.0 / v1.1 clients keep working — the new HELLO field is optional,
 * unknown error codes pass through as strings, and unknown frames degrade
 * through the v1.0 `bad_frame` path. See `docs/services-over-ws-rfc.md` §8
 * and `docs/PROTOCOL.md` "What's new in v1.2".
 */
export const PROTOCOL_VERSION = '1.2' as const

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
 * Built-in service types AipeHub ships with. Used as the immutable base of
 * the runtime allowlist — third-party `registerServiceMethods` calls only
 * ADD entries on top of this map, never mutate or override it.
 *
 * Dotted forms (e.g. `'sql.exec'`) descend into a named sub-namespace on
 * the handle; the router splits on `.` once before doing the lookup.
 *
 * Aligned with the contracts in `@aipehub/services-sdk/types/{memory,
 * artifact,datastore}.ts`.
 */
export const BUILTIN_SERVICE_METHODS: Readonly<Record<string, readonly string[]>> = {
  memory: ['recall', 'remember', 'list', 'forget', 'clear'],
  artifact: ['write', 'read', 'list', 'exists', 'remove'],
  // DatastoreHandle has two nested namespaces (`kv` + `sql`); both must be
  // reachable. The `name` field is read-only and exposed eagerly by the SDK
  // (from the decl's `config.name`) so it doesn't need an RPC.
  datastore: ['kv.get', 'kv.set', 'kv.del', 'kv.keys', 'sql.exec', 'sql.query'],
}

/**
 * Runtime allowlist used by `ServiceCallRouter`. Starts as a copy of
 * `BUILTIN_SERVICE_METHODS`; the host extends it at bootstrap by calling
 * `registerServiceMethods` for each loaded plugin that declares its own
 * `wireMethods` (third-party service types).
 *
 * NOT exported directly — consumers should use `getServiceMethods` /
 * `isServiceMethodAllowed` so the extension hook stays the single
 * source of truth.
 */
const runtimeAllowlist = new Map<string, ReadonlySet<string>>(
  Object.entries(BUILTIN_SERVICE_METHODS).map(([t, ms]) => [t, new Set(ms)]),
)

/**
 * Register additional wire-callable methods for a service type. Used by
 * the host when loading a third-party plugin whose `wireMethods` lists
 * names not already covered by `BUILTIN_SERVICE_METHODS`.
 *
 * Idempotent — re-registering an already-allowed method is a no-op.
 * Cannot remove or override entries; the built-in set is the floor.
 *
 * Method names follow the same `'a'` or `'ns.method'` form as the
 * built-ins. The router refuses to dispatch `'a.b.c'` regardless of
 * what's registered — at most one dot.
 *
 * @example
 *   registerServiceMethods('notion', ['pages.create', 'pages.read'])
 */
export function registerServiceMethods(
  type: string,
  methods: readonly string[],
): void {
  if (!type || typeof type !== 'string') {
    throw new Error('registerServiceMethods: type must be a non-empty string')
  }
  if (!Array.isArray(methods)) {
    throw new Error('registerServiceMethods: methods must be an array')
  }
  const existing = runtimeAllowlist.get(type)
  const merged = new Set(existing ?? [])
  for (const m of methods) {
    if (typeof m !== 'string' || m.length === 0) continue
    // Refuse `'a.b.c'` paths at registration time — the router can't reach
    // them anyway, and silently accepting them just leads to confusing
    // unknown_method errors at call time.
    if (m.split('.').length > 2) {
      throw new Error(
        `registerServiceMethods: method '${m}' has more than one dot — ` +
          `wire methods are at most one level nested`,
      )
    }
    merged.add(m)
  }
  runtimeAllowlist.set(type, merged)
}

/**
 * Return the (frozen) set of methods the router will dispatch for a service
 * type. Returns `undefined` if the type was never seen — caller treats this
 * as `unknown_method`.
 */
export function getServiceMethods(type: string): ReadonlySet<string> | undefined {
  return runtimeAllowlist.get(type)
}

/**
 * Convenience predicate used by `ServiceCallRouter`. Strict membership; no
 * prefix or pattern matching.
 */
export function isServiceMethodAllowed(type: string, method: string): boolean {
  const set = runtimeAllowlist.get(type)
  return set !== undefined && set.has(method)
}

/**
 * Test-only: reset the runtime allowlist back to built-ins. Production code
 * never calls this — extensions registered once at host startup are
 * supposed to persist for the process lifetime.
 */
export function resetServiceMethodsForTests(): void {
  runtimeAllowlist.clear()
  for (const [t, ms] of Object.entries(BUILTIN_SERVICE_METHODS)) {
    runtimeAllowlist.set(t, new Set(ms))
  }
}

/**
 * @deprecated since v1.2 — use `isServiceMethodAllowed` / `getServiceMethods`
 * instead. Kept exported so existing third-party code that imported the
 * symbol keeps compiling; reflects only built-ins, not registered extensions.
 *
 * Will be removed in v2.0 once the in-tree callers are gone.
 */
export const SERVICE_METHOD_ALLOWLIST: Readonly<Record<string, readonly string[]>> =
  BUILTIN_SERVICE_METHODS

/**
 * Default per-call deadline the SDK applies when awaiting a SERVICE_RESULT.
 * The server does NOT enforce this — it's purely a client-side guard so a
 * dead connection doesn't strand awaiters. Tunable per `connect()` call.
 */
export const DEFAULT_SERVICE_CALL_TIMEOUT_MS = 30_000
