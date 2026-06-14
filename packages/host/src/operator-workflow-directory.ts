/**
 * operatorStewardWorkflowDirectory — SW-M9 A-M4. The operator-console steward's
 * workflow snapshot: EVERY workflow on the hub, each flagged cross-hub, with NO
 * per-member grant filter.
 *
 * The member directory (built inline in main.ts) lists only the workflows the
 * caller holds an editor+ grant on — `listAll()` filtered by
 * `hasResourceGrant('workflow', id, userPrincipal(userId), 'editor')`. The
 * operator owns the whole site, so the operator directory drops that one filter
 * and lists them all; the `crossHub` flag is derived from the SAME `crossHubSteps`
 * the WFEDIT editor lock + the admin "leaves your hub" preview use, so what the
 * steward tiers `cross_hub` never drifts from what the editor locks.
 *
 * Kept as a pure factory (not inlined like the member adapter) precisely so the
 * defining property — an operator sees workflows a member with no grant would not
 * — is pinned by a unit test rather than buried in the A-M7 e2e snapshot. It
 * closes over nothing but the controller's read slice, so main.ts only has to
 * inject `workflowController` (A-M7).
 */

import type { StewardWorkflowDirectory } from './hub-steward-service.js'

/**
 * The read slice of `WorkflowController` the operator directory needs — just
 * `listAll`, returning each workflow's id + optional name + its cross-hub steps
 * (length > 0 ⇒ the workflow leaves this hub). The real controller satisfies it;
 * a test passes a fake.
 */
export interface OperatorWorkflowListSource {
  listAll(): Promise<
    ReadonlyArray<{ id: string; name?: string; crossHubSteps?: ReadonlyArray<unknown> }>
  >
}

/**
 * Build the operator steward's `StewardWorkflowDirectory`: site-wide, no grant
 * filter. `listForUser` ignores the caller — the operator may edit any workflow
 * (the privilege boundary is that only the operator steward receives this
 * directory; A-M1's disjoint ids + A-M6's `requireAdmin` gate enforce that).
 */
export function operatorStewardWorkflowDirectory(
  source: OperatorWorkflowListSource,
): StewardWorkflowDirectory {
  return {
    async listForUser(_userId: string) {
      const all = await source.listAll()
      return all.map((s) => ({
        id: s.id,
        ...(s.name ? { name: s.name } : {}),
        crossHub: (s.crossHubSteps?.length ?? 0) > 0,
      }))
    },
  }
}
