/**
 * Shared filename helpers for the workflow package's file-first stores.
 */

/**
 * Convert a workflow id into a safe file base. The id schema is already
 * url-/json-safe (letters / digits / _ . : -), but `:` is allowed inside ids
 * and macOS/Linux tolerates it while Windows does not. Replace it with `__`
 * so the filename works everywhere.
 *
 * This mirrors the host `WorkflowController`'s definitions-file naming so the
 * revision/lifecycle stores key their files identically to `definitions/`.
 */
export function sanitiseFileBase(id: string): string {
  return id.replace(/:/g, '__')
}
