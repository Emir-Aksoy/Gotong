/**
 * `ServicesAdminSurface` — the read+write contract the web layer
 * uses to drive the Hub Services admin REST API.
 *
 * Why a separate, narrowed surface (instead of letting the web layer
 * import `HubServices` from `@gotong/host`):
 *
 *   1. `@gotong/web` lives upstream of `@gotong/host` in the
 *      dependency graph (host already depends on web). Reversing
 *      that would close a workspace cycle.
 *   2. The surface stays plain-data — no types from
 *      `@gotong/services-sdk` leak through. The web layer's only
 *      knowledge of services is what's described here.
 *
 * The host's `HubServices` implements this interface. Web's
 * `serveWeb({ services })` accepts the surface and wires it to the
 * REST routes. SSE streaming of `service_trashed` / `service_purged`
 * is independent — it flows through the transcript and uses no
 * methods on this interface.
 *
 * All methods are async-friendly even when an implementation could
 * answer sync. That gives implementations room to read files / take
 * locks without breaking the contract.
 */

import type { ParticipantId } from './types.js'

export interface ServicePluginDescriptor {
  /** Service category — `'memory' | 'artifact' | 'datastore' | ...` */
  readonly type: string
  /** Implementation discriminator within a type. */
  readonly impl: string
  /** Plugin's declared semver. */
  readonly version: string
  /** Optional human-readable one-liner. */
  readonly description?: string
}

/** Plain-data Owner — no class identity, no helpers. */
export interface ServiceOwnerRef {
  /** `'agent' | 'workflow-run' | 'shared'` (or a future kind). */
  readonly kind: string
  readonly id: string
}

/**
 * `(plugin, owner)` triple used as the key for every per-owner
 * service operation. The admin UI builds these from `(type, impl)`
 * dropdowns + an agents.json lookup.
 */
export interface ServiceTarget {
  readonly type: string
  readonly impl: string
  readonly owner: ServiceOwnerRef
}

/**
 * Snapshot returned from `describe` — matches `ServiceSnapshot` from
 * the SDK byte-for-byte but lives in core so web doesn't import the
 * SDK type. The implementation in HubServices passes the plugin
 * response straight through.
 */
export interface ServiceSnapshotView {
  readonly sizeBytes: number
  readonly itemCount?: number
  readonly lastAccess?: number
  readonly preview?: ServicePreviewBlob
}

export interface ServicePreviewBlob {
  readonly mime: string
  readonly text?: string
  readonly base64?: string
  readonly truncated?: boolean
}

/**
 * Trash entry as seen by the admin layer. Identical fields to the
 * SDK's `TrashRef`, plus the `(type, impl)` that owns it (so a flat
 * list-trash response doesn't need a secondary lookup to know which
 * plugin's `restore` / `hardDelete` to call).
 */
export interface ServiceTrashRef {
  readonly id: string
  readonly type: string
  readonly impl: string
  readonly ownerKind: string
  readonly ownerId: string
  readonly deletedAt: number
  readonly expiresAt: number
  readonly reason?: string
}

export interface ServicesAdminSurface {
  /** Stable registration order. Cheap — no I/O. */
  listPlugins(): ReadonlyArray<ServicePluginDescriptor>
  /**
   * Per-owner snapshot. Returns `null` (NOT throws) when the plugin
   * is loaded but the owner has no data — the admin UI uses this to
   * hide empty rows. Throws on unknown `(type, impl)`.
   */
  describe(target: ServiceTarget): Promise<ServiceSnapshotView | null>
  /**
   * Move the owner's data to trash. The returned ref is what the
   * admin needs to call `restore` / `hardDelete` later. The web
   * layer also publishes the action through the SSE stream
   * (`service_trashed`) — implementations don't need to publish
   * themselves.
   */
  softDelete(
    target: ServiceTarget & { reason?: string; by?: ParticipantId },
  ): Promise<ServiceTrashRef>
  /**
   * Restore. Throws if the original owner slot is currently in use
   * (translated to HTTP 409 by the web layer).
   */
  restore(ref: ServiceTrashRef): Promise<void>
  /** Permanently delete. Irreversible. */
  hardDelete(ref: ServiceTrashRef): Promise<void>
  /**
   * Union of every plugin's trash, tagged by `(type, impl)`. Plugins
   * that don't expose `listTrash` contribute nothing.
   */
  listTrash(): Promise<ReadonlyArray<ServiceTrashRef>>
  /**
   * Trigger an immediate expired-trash sweep. Mostly for the admin
   * "purge expired now" button. Returns the same `{ scanned, purged }`
   * shape as the periodic sweeper. Implementations that don't
   * support manual sweeps may return `{ scanned: 0, purged: 0 }`.
   */
  sweepExpired?(now?: number): Promise<{ scanned: number; purged: number }>
}
