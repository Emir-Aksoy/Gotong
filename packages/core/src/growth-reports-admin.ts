/**
 * `GrowthReportsAdminSurface` — the narrowed contract the web layer
 * uses to render & serve the personal-growth workflow's synthesis
 * reports.
 *
 * Why a separate surface (instead of bolting onto `ServicesAdminSurface`):
 *
 *   - The growth-reports view is intentionally workflow-specific.
 *     Folding it into the generic services admin would leak
 *     "synthesis" / "case" vocabulary into a contract that's meant
 *     to be plugin-agnostic.
 *   - It's optional. Hosts that never load the personal-growth team
 *     simply pass `undefined`; the web layer's growth-reports route
 *     returns 503 the same way it does for `services` when the host
 *     hasn't wired Hub Services at all.
 *   - It's narrow enough (list + read) that no SDK types leak in.
 *     `@gotong/web` can read this surface without growing a
 *     dependency on `@gotong/services-sdk`.
 *
 * The host's implementation walks the synthesist agent's live
 * `artifact` handle (and optionally its `datastore['growth-runs']`)
 * to build the list and serve individual files. Implementations
 * MUST be safe to call concurrently — the admin UI polls the list
 * endpoint when the user opens the panel.
 */

export interface GrowthReportSummary {
  /**
   * Artifact-relative path of the report, e.g.
   * `reports/self/2026-05-22T14-30-45.md`. Pass back to `read`
   * verbatim — callers should not parse it for routing decisions.
   */
  readonly path: string
  /**
   * Case scope the report was written under. The personal-growth
   * v0.2 hardcodes `'self'`; future versions that let one admin
   * coach multiple coachees will surface the human-readable id here.
   */
  readonly caseId: string
  /** Epoch ms of last write. Newest-first ordering is the caller's. */
  readonly ts: number
  /** Byte size of the rendered markdown. */
  readonly sizeBytes: number
  /**
   * Optional one-line preview pulled from the synthesist's output —
   * "what's the main track" snippet, around 100-200 chars. Helps the
   * admin UI render meaningful rows without reading the full file.
   */
  readonly preview?: string
}

export interface GrowthReportsAdminSurface {
  /**
   * Every saved synthesis report, newest-first. Returns `[]` (NOT
   * throws) when the synthesist is not currently spawned or has not
   * produced any report yet — the admin UI uses that to render an
   * empty state.
   */
  list(): Promise<ReadonlyArray<GrowthReportSummary>>
  /**
   * Read one report's raw markdown by its `path` from `list()`.
   * Throws if the path is unknown or the synthesist's artifact handle
   * is currently unavailable — the web layer translates the throw to
   * a 404 / 503.
   */
  read(path: string): Promise<{ readonly markdown: string }>
}
