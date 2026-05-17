/**
 * Owner — the addressable unit that holds service data.
 *
 * A plugin never sees the yaml-level `scope:` string. It sees an Owner
 * with a `(kind, id)` pair and files data by that key. The
 * {@link ServiceRegistry} translates `scope: private | workflow | shared:<g>`
 * into an Owner before calling `plugin.attach()`.
 *
 * Default per RFC §4 is `'private'` (Q1 = A): an agent's data is
 * invisible to every other agent unless the yaml explicitly opts into
 * a `workflow` or `shared:<group>` scope.
 *
 * Reasoning: a plugin that accidentally derives data location from
 * scope text (rather than Owner) is a bug waiting to happen — leak
 * "shared" data into a "private" path on a typo. By collapsing scope
 * into Owner at registry time, plugins literally cannot make that
 * mistake.
 */
export type OwnerKind = 'agent' | 'workflow-run' | 'shared'

export interface Owner {
  /** What kind of entity this Owner represents. */
  readonly kind: OwnerKind
  /**
   * Stable identifier within its kind:
   *   - kind='agent'        → agentId
   *   - kind='workflow-run' → workflow runId
   *   - kind='shared'       → groupId (whatever the yaml authored)
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
 */
export type Scope = 'private' | 'workflow' | `shared:${string}`

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
}

/**
 * Translate a yaml scope string into the concrete Owner the plugin
 * receives. Throws when the scope can't be satisfied (e.g. asked for
 * `workflow` scope but no `runId` provided).
 *
 *   resolveOwner('private', { agentId: 'a1' })   → { kind:'agent', id:'a1' }
 *   resolveOwner('workflow', { runId: 'r1' })    → { kind:'workflow-run', id:'r1' }
 *   resolveOwner('shared:g', { groupId: 'g' })   → { kind:'shared', id:'g' }
 *
 * `groupId` may be omitted by the caller; this function parses it out
 * of the scope string when the caller didn't bother.
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
  if (scope.startsWith('shared:')) {
    const groupId = ctx.groupId ?? scope.slice('shared:'.length)
    if (!groupId) throw new Error(`scope 'shared:<group>' requires a non-empty group id`)
    assertSafeOwnerId(groupId)
    return { kind: 'shared', id: groupId }
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
  if (kind !== 'agent' && kind !== 'workflow-run' && kind !== 'shared') {
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
