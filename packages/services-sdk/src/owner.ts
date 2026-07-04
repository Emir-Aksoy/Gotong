/**
 * Owner — the addressable unit that holds service data.
 *
 * A plugin never sees the yaml-level `scope:` string. It sees an Owner
 * with a `(kind, id)` pair and files data by that key. The
 * {@link ServiceRegistry} translates the yaml scope into an Owner
 * before calling `plugin.attach()`.
 *
 * Default per RFC §4 is `'private'` (Q1 = A): an agent's data is
 * invisible to every other agent unless the yaml explicitly opts into
 * a `workflow`, `shared:<group>`, `user:<userId>`, `org`, or
 * `peer:<peerId>` scope.
 *
 * Reasoning: a plugin that accidentally derives data location from
 * scope text (rather than Owner) is a bug waiting to happen — leak
 * "shared" data into a "private" path on a typo. By collapsing scope
 * into Owner at registry time, plugins literally cannot make that
 * mistake.
 *
 * A3 (v4 Phase 5) — `'user' | 'org' | 'peer'` were added to align with
 * `@gotong/identity`'s vault `OwnerKind`. The three new kinds enable
 * higher-level services (B1 OrgApiPool, B3 Knowledge, D1 Peer Registry)
 * to file data by identity-rooted ownership without re-inventing the
 * vocabulary. The original three kinds remain valid — they answer
 * "which runtime entity holds this row" rather than "which principal
 * owns it"; both axes are needed.
 */
export type OwnerKind =
  | 'agent'
  | 'workflow-run'
  | 'shared'
  // A3 (v4 Phase 5) — identity-rooted owners. Values mirror
  // `@gotong/identity`'s `OwnerKind` so the two packages can pass
  // (kind, id) tuples to each other without translation.
  | 'user'
  | 'org'
  | 'peer'

/**
 * Sentinel id for the `'org'` kind. The host IS the implicit org owner
 * (a single Gotong install == one organisation), so there's no real
 * org id to scope by. We use `'self'` as the path segment so the
 * filesystem layout (`<rootDir>/org/self/...`) stays readable instead
 * of producing an awkward bare `<rootDir>/org/` directory.
 *
 * Mirrors how `@gotong/identity`'s vault stores ownerKind='org' rows
 * with `owner_id IS NULL`: the absence is real in the data model, but
 * the filesystem path needs *something*.
 */
export const ORG_SELF_ID = 'self'

export interface Owner {
  /** What kind of entity this Owner represents. */
  readonly kind: OwnerKind
  /**
   * Stable identifier within its kind:
   *   - kind='agent'        → agentId
   *   - kind='workflow-run' → workflow runId
   *   - kind='shared'       → groupId (whatever the yaml authored)
   *   - kind='user'         → v4 user id
   *   - kind='org'          → always `ORG_SELF_ID` ('self')
   *   - kind='peer'         → peer hub id
   */
  readonly id: string
}

/**
 * Scope string as it appears in agent / workflow yaml. The Registry
 * accepts these and produces an Owner.
 *
 *   'private'                   → (agent, <agentId>)
 *   'workflow'                  → (workflow-run, <runId>)
 *   'shared:industry-coaches'   → (shared, 'industry-coaches')
 *   'user:<userId>'             → (user, <userId>)        — A3
 *   'org'                       → (org, 'self')           — A3
 *   'peer:<peerId>'             → (peer, <peerId>)        — A3
 */
export type Scope =
  | 'private'
  | 'workflow'
  | 'org'
  | `shared:${string}`
  | `user:${string}`
  | `peer:${string}`

/**
 * Context required to translate a Scope to an Owner. Only the fields
 * the chosen scope needs must be present (e.g. `workflow` requires
 * `runId` but not `groupId`).
 */
export interface ScopeContext {
  agentId?: string
  runId?: string
  /** Already-parsed group id when scope starts with `shared:`. */
  groupId?: string
  /** A3 — already-parsed user id when scope starts with `user:`. */
  userId?: string
  /** A3 — already-parsed peer id when scope starts with `peer:`. */
  peerId?: string
}

/**
 * Translate a yaml scope string into the concrete Owner the plugin
 * receives. Throws when the scope can't be satisfied (e.g. asked for
 * `workflow` scope but no `runId` provided).
 *
 *   resolveOwner('private', { agentId: 'a1' })       → { kind:'agent', id:'a1' }
 *   resolveOwner('workflow', { runId: 'r1' })        → { kind:'workflow-run', id:'r1' }
 *   resolveOwner('shared:g', { groupId: 'g' })       → { kind:'shared', id:'g' }
 *   resolveOwner('user:alice', { userId: 'alice' })  → { kind:'user', id:'alice' }
 *   resolveOwner('org', {})                          → { kind:'org', id:'self' }
 *   resolveOwner('peer:hub-x', { peerId: 'hub-x' })  → { kind:'peer', id:'hub-x' }
 *
 * For prefixed scopes (`shared:` / `user:` / `peer:`), the id may be
 * supplied either via the prefix OR via ScopeContext; the context
 * takes precedence so a yaml typo can be corrected at runtime.
 */
export function resolveOwner(scope: Scope, ctx: ScopeContext): Owner {
  if (scope === 'private') {
    if (!ctx.agentId) throw new Error(`scope 'private' requires ctx.agentId`)
    assertSafeOwnerId(ctx.agentId)
    return { kind: 'agent', id: ctx.agentId }
  }
  if (scope === 'workflow') {
    if (!ctx.runId) throw new Error(`scope 'workflow' requires ctx.runId`)
    assertSafeOwnerId(ctx.runId)
    return { kind: 'workflow-run', id: ctx.runId }
  }
  if (scope === 'org') {
    // 'org' takes no id — the host is the implicit org. We still emit
    // a path-safe sentinel ('self') so plugins can build a directory
    // path without special-casing the empty-id case.
    return { kind: 'org', id: ORG_SELF_ID }
  }
  if (scope.startsWith('shared:')) {
    const groupId = ctx.groupId ?? scope.slice('shared:'.length)
    if (!groupId) throw new Error(`scope 'shared:<group>' requires a non-empty group id`)
    assertSafeOwnerId(groupId)
    return { kind: 'shared', id: groupId }
  }
  if (scope.startsWith('user:')) {
    const userId = ctx.userId ?? scope.slice('user:'.length)
    if (!userId) throw new Error(`scope 'user:<userId>' requires a non-empty user id`)
    assertSafeOwnerId(userId)
    return { kind: 'user', id: userId }
  }
  if (scope.startsWith('peer:')) {
    const peerId = ctx.peerId ?? scope.slice('peer:'.length)
    if (!peerId) throw new Error(`scope 'peer:<peerId>' requires a non-empty peer id`)
    assertSafeOwnerId(peerId)
    return { kind: 'peer', id: peerId }
  }
  throw new Error(`unknown scope: ${scope}`)
}

/**
 * Deterministic key used to identify an Owner across logs / paths /
 * registry entries. Two Owners with the same `(kind, id)` produce the
 * same key; never collide across kinds even when the same string
 * happens to be both an agentId and a groupId.
 *
 *   ownerKey({ kind: 'agent', id: 'writer-zh' })   → 'agent/writer-zh'
 *   ownerKey({ kind: 'shared', id: 'writer-zh' })  → 'shared/writer-zh'
 */
export function ownerKey(owner: Owner): string {
  return `${owner.kind}/${owner.id}`
}

/**
 * Parse a string of the form `kind/id` back into an Owner. Inverse of
 * {@link ownerKey}. Throws on malformed input. Used by the registry
 * to look up trash entries by their stored path.
 */
export function parseOwnerKey(key: string): Owner {
  const slash = key.indexOf('/')
  if (slash < 0) throw new Error(`malformed owner key: ${key}`)
  const kind = key.slice(0, slash) as OwnerKind
  const id = key.slice(slash + 1)
  if (
    kind !== 'agent' &&
    kind !== 'workflow-run' &&
    kind !== 'shared' &&
    kind !== 'user' &&
    kind !== 'org' &&
    kind !== 'peer'
  ) {
    throw new Error(`unknown owner kind in key: ${kind}`)
  }
  if (!id) throw new Error(`empty id in owner key: ${key}`)
  return { kind, id }
}

/** Reference-style equality. Two owners are equal iff kind+id match. */
export function ownersEqual(a: Owner, b: Owner): boolean {
  return a.kind === b.kind && a.id === b.id
}

/**
 * Reject Owner.id values that would escape per-tenant directories
 * when interpolated into a filesystem path.
 *
 * First-party plugins build paths as `join(rootDir, owner.kind, owner.id)`
 * and treat the result as per-tenant. Without this guard, a hostile or
 * buggy caller passing `{kind:'agent', id:'../shared/group-x'}` walks
 * into another tenant's tree on platforms where `join` honours the
 * `..` segment (i.e. every POSIX system + Windows).
 *
 * Rejects:
 *   - non-string or empty id
 *   - null byte (`\0`) — POSIX terminates paths at the byte, attack on bridges
 *   - path separators (`/` or `\\`)
 *   - bare `.` or `..` (the dangerous standalone segments)
 *
 * Allows:
 *   - ASCII alphanumeric + `_-.`
 *   - Unicode letters (e.g. Chinese agent ids like `writer-中文`)
 *   - UUIDs (no separators)
 *
 * Plugins SHOULD call this from their own `ownerDir`-equivalent
 * function as defense-in-depth — `resolveOwner` validates at scope-
 * translation time, but a plugin may receive an `Owner` constructed
 * through any path the host wires up, so it's worth checking again at
 * the point of `join()`.
 */
export function assertSafeOwnerId(id: string): void {
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('Owner.id must be a non-empty string')
  }
  if (id.includes('\0')) {
    throw new Error(`Owner.id contains a null byte: ${JSON.stringify(id)}`)
  }
  if (id.includes('/') || id.includes('\\')) {
    throw new Error(`Owner.id must not contain path separators: ${JSON.stringify(id)}`)
  }
  if (id === '.' || id === '..') {
    throw new Error(`Owner.id must not be a relative-path segment: ${JSON.stringify(id)}`)
  }
}
