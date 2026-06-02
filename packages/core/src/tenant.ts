import { join } from 'node:path'

/**
 * Tenant / namespace primitive (Route B P0-M1).
 *
 * Until now "one space directory = one tenant" was an *implicit* model: a
 * workspace root held exactly one hub's worth of state and isolation was
 * "use a different directory". This module makes that dimension *explicit*
 * without changing any single-tenant behaviour — the reserved
 * {@link DEFAULT_TENANT} resolves to the bare workspace root (no extra path
 * segment), so existing deployments are byte-for-byte unchanged.
 *
 * The point of doing this now (long before hosted multi-tenancy actually
 * runs) is to reserve a *validated, shared* seam. P2 turns the dimension on;
 * P0 only threads it through the storage primitives so nothing has to be
 * re-plumbed later. Physical form (decision D-2) is "one space dir per
 * tenant": copy the directory and you carry the whole tenant — the same
 * file-first promise the framework already makes for a single hub.
 */

/**
 * The reserved tenant id for the single-tenant default. A workspace that
 * never opts into the tenant dimension *is* this tenant. It is special only
 * in {@link tenantRoot}, which maps it to the bare base root (no segment) so
 * the on-disk layout matches what a tenant-unaware caller produced before
 * this module existed.
 */
export const DEFAULT_TENANT = 'default'

/** Codes carried by {@link TenantIdError} so callers can branch without
 *  parsing the human-readable message. */
export type TenantIdErrorCode =
  | 'tenant_id_not_string'
  | 'tenant_id_empty'
  | 'tenant_id_too_long'
  | 'tenant_id_charset'

/**
 * Thrown by {@link assertTenantId} when a tenant id is unsafe to use as a
 * filesystem path segment or as a key. We fail loud rather than sanitise:
 * a silently-rewritten tenant id would let two distinct callers collide on
 * one physical location, which is exactly the isolation property this
 * dimension exists to guarantee.
 */
export class TenantIdError extends Error {
  readonly code: TenantIdErrorCode
  constructor(message: string, code: TenantIdErrorCode) {
    super(message)
    this.name = 'TenantIdError'
    this.code = code
  }
}

/** Upper bound on tenant id length. Generous for human/org slugs, small
 *  enough to stay well under path-length limits once composed. */
const MAX_TENANT_ID_LEN = 64

/**
 * Lowercase-only on purpose. Case-insensitive filesystems (macOS/APFS,
 * Windows/NTFS) would let `Alpha` and `alpha` collide on one directory while
 * looking distinct to the application — a silent cross-tenant leak. Forcing
 * lowercase removes the footgun. The leading char must be alphanumeric so a
 * tenant id can never start with `-`/`_` (avoids both shell-flag confusion
 * and dotfile-adjacent surprises); the rest may include `-`/`_`.
 */
const TENANT_ID_RE = /^[a-z0-9][a-z0-9_-]*$/

/**
 * Validate a tenant id is safe to use as a path segment and as a key.
 * Throws {@link TenantIdError} on any violation. `DEFAULT_TENANT` is itself
 * a legal id (it matches the charset) — callers that want the bare-root
 * behaviour should rely on {@link tenantRoot}'s short-circuit, not on this
 * function rejecting it.
 */
export function assertTenantId(id: string): void {
  if (typeof id !== 'string') {
    throw new TenantIdError(
      `tenant id must be a string; got ${typeof id}`,
      'tenant_id_not_string',
    )
  }
  if (id.length === 0) {
    throw new TenantIdError('tenant id must be non-empty', 'tenant_id_empty')
  }
  if (id.length > MAX_TENANT_ID_LEN) {
    throw new TenantIdError(
      `tenant id must be at most ${MAX_TENANT_ID_LEN} chars; got ${id.length}`,
      'tenant_id_too_long',
    )
  }
  if (!TENANT_ID_RE.test(id)) {
    throw new TenantIdError(
      `tenant id must match ${TENANT_ID_RE} (lowercase alphanumeric, then -/_); ` +
        `got ${JSON.stringify(id)}`,
      'tenant_id_charset',
    )
  }
}

/**
 * Normalise an optional namespace to a concrete, validated tenant id.
 * `undefined` → {@link DEFAULT_TENANT}; any provided value is validated
 * (throws {@link TenantIdError} on a bad one). Storage primitives call this
 * so a namespace is always a known-good string, never `undefined`.
 */
export function normalizeNamespace(ns?: string): string {
  if (ns === undefined) return DEFAULT_TENANT
  assertTenantId(ns)
  return ns
}

/**
 * Resolve a tenant's physical workspace root under a base directory.
 *
 * The default tenant maps to `baseRoot` itself — no extra segment — so a
 * single-tenant deployment's files land exactly where they did before this
 * dimension existed (the zero-behaviour-change guarantee). Every other
 * tenant lands under `<baseRoot>/tenants/<id>/`, an isolated subtree that
 * `cp -r` carries wholesale.
 */
export function tenantRoot(baseRoot: string, tenantId: string = DEFAULT_TENANT): string {
  if (tenantId === DEFAULT_TENANT) return baseRoot
  assertTenantId(tenantId)
  return join(baseRoot, 'tenants', tenantId)
}
