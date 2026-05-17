/**
 * Public surface of @aipehub/services-sdk.
 *
 * Two entry points:
 *   - `@aipehub/services-sdk`         (this file)  — runtime
 *   - `@aipehub/services-sdk/testing` (testing.ts) — shared contract suite
 *
 * The split keeps `vitest` out of the runtime dep graph: hosts don't
 * need a test runner installed just to load plugins.
 */

// Owner / scope model
export {
  resolveOwner,
  ownerKey,
  parseOwnerKey,
  ownersEqual,
  assertSafeOwnerId,
} from './owner.js'
export type { Owner, OwnerKind, Scope, ScopeContext } from './owner.js'

// Trash model
export {
  trashId,
  makeTrashRef,
  isExpired,
  TRASH_DEFAULT_RETENTION_MS,
  TRASH_BUCKET_MS,
} from './trash.js'
export type { TrashRef } from './trash.js'

// Snapshot
export { PREVIEW_MAX_BYTES } from './snapshot.js'
export type { ServiceSnapshot, PreviewBlob } from './snapshot.js'

// Plugin contract
export type {
  ServicePlugin,
  ServiceType,
  ServiceInitCtx,
  HubSurfaceForPlugins,
  PluginEntry,
  PluginsManifest,
} from './plugin.js'

// Per-type handle interfaces
export type {
  MemoryEntry,
  MemoryHandle,
  MemoryKind,
  MemoryQuery,
  NewMemoryEntry,
} from './types/memory.js'
export type {
  ArtifactRef,
  ArtifactHandle,
} from './types/artifact.js'
export type {
  DatastoreHandle,
  KvHandle,
  SqlHandle,
} from './types/datastore.js'

// Agent ctx (RFC §7)
export { EMPTY_SERVICE_CTX } from './types/agent-ctx.js'
export type { ServiceCtx } from './types/agent-ctx.js'

// Registry + loader
export { ServiceRegistry } from './registry.js'
export {
  loadPlugins,
  DEFAULT_FIRST_PARTY_PLUGINS,
} from './loader.js'
export type { LoadPluginsOpts, LoadPluginsResult } from './loader.js'

// Version
export { SDK_MAJOR, parseMajor, majorMatches } from './version.js'

// Errors
export {
  PluginLoadError,
  PluginVersionMismatchError,
  PluginConflictError,
  PluginNotFoundError,
  ServiceConfigError,
  TrashRestoreConflictError,
} from './errors.js'
