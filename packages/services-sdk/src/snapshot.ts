/**
 * Admin UI snapshot — what a plugin returns from `describe(owner)`.
 *
 * This is the read-only side of a service: enough for the admin to
 * see "service X is using 4.2 MB for agent Y, last touched yesterday,
 * here's a preview of the first kilobyte." Plugins decide how to
 * compute size / itemCount / preview; the Hub never inspects payload.
 */
export interface ServiceSnapshot {
  /** Total on-disk bytes attributable to this owner. */
  sizeBytes: number
  /**
   * Items the plugin holds (rows in a SQLite table, lines in a jsonl,
   * files in a directory). Optional — some services have no natural
   * "item" abstraction.
   */
  itemCount?: number
  /** Epoch ms of the last read/write. Plugins are free to skip this. */
  lastAccess?: number
  /**
   * Small content preview for the admin UI. Plugins cap themselves at
   * 32 KB (`PREVIEW_MAX_BYTES`) to keep the API response cheap.
   * Larger content shows as `truncated: true`.
   */
  preview?: PreviewBlob
}

/**
 * One preview chunk. Either text (rendered as <pre>) or base64
 * (rendered as an image / binary fallback). Plugins pick whichever
 * makes sense — markdown / jsonl plugins pick text; image artifact
 * plugin picks base64.
 */
export interface PreviewBlob {
  /** Best-guess MIME. Used by the UI to pick a renderer. */
  mime: string
  /** Plain text content. Mutually exclusive with `base64`. */
  text?: string
  /** Base64 content for binary previews. Mutually exclusive with `text`. */
  base64?: string
  /** True if the underlying content was clipped to fit the cap. */
  truncated?: boolean
}

/** Maximum preview payload size. Plugins MUST respect this. */
export const PREVIEW_MAX_BYTES = 32 * 1024
