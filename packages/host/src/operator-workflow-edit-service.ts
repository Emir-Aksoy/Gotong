/**
 * OperatorWorkflowEditService — SW-M9 A-M3. The OPERATOR-console steward's
 * workflow-edit executor: the SAME `MeWorkflowEditService` pipeline (★ cross-hub
 * 出入口 lock ★ + structure hard-gate + run-drift-safe versioning + line diff),
 * but SITE-WIDE — the per-workflow editor-grant gate is the ONE thing dropped.
 *
 * WHY a wrapper, not a fork. The member editor's `edit` runs an eleven-step
 * pipeline; only its OPENING step — `hasWorkflowGrant(… 'editor')` — is
 * member-specific. Everything after it is a GOVERNANCE contract that binds an
 * operator exactly as much as a member: an operator who owns the whole site STILL
 * may not silently repoint / drop / re-classify a cross-hub egress, because that
 * edge is ANOTHER org's data boundary, not this hub's RBAC. So instead of copying
 * the pipeline (which would drift from the member editor the instant either side
 * changes), this service constructs a `MeWorkflowEditService` with an
 * ALWAYS-EDITOR grant view. The single behavioral difference IS exactly the
 * dropped RBAC line; the boundary lock and every other step run byte-for-byte the
 * member code.
 *
 * The privilege gap is bounded by WHERE this is wired, not by a runtime flag: it
 * is only ever constructed for the operator steward (`OPERATOR_STEWARD_IDS`,
 * A-M1) behind `requireAdmin` + a server-resolved operator userId (A-M6). The
 * member steward NEVER receives it — it gets the real grant-gated
 * `MeWorkflowEditService` — so a member's chat input can't reach a grant-free
 * edit even if the classifier missed something (defense in depth, the same shape
 * as A-M2's site-wide agent executor).
 *
 * Satisfies `StewardWorkflowEditor`, so it drops straight into
 * `performStewardAction` with ZERO changes to the chokepoint.
 */

import {
  MeWorkflowEditService,
  type MeWorkflowEditableResult,
  type MeWorkflowEditDeps,
  type MeWorkflowEditRequest,
  type MeWorkflowEditResult,
  type WorkflowGrantView,
} from './me-workflow-edit-service.js'
import type { StewardWorkflowEditor } from './hub-steward-service.js'

/**
 * Operator deps = the member edit deps MINUS the per-workflow RBAC source. The
 * boundary inputs (`workflows` / `assist` / `participants` / `peerCapabilities` /
 * `crossHubMarkers`) are identical — the cross-hub lock is computed the same way
 * for an operator as for a member.
 */
export type OperatorWorkflowEditDeps = Omit<MeWorkflowEditDeps, 'grants'>

/**
 * An editor-grant view that always grants editor+. The operator bypasses
 * per-workflow RBAC entirely (they own the site); it is the boundary lock — NOT
 * this view — that still constrains a federated workflow's edges.
 */
const ALWAYS_EDITOR: WorkflowGrantView = { hasWorkflowGrant: () => true }

export class OperatorWorkflowEditService implements StewardWorkflowEditor {
  private readonly inner: MeWorkflowEditService

  constructor(deps: OperatorWorkflowEditDeps) {
    // The ONLY divergence from the member editor: the RBAC gate always passes.
    // Everything else — the cross-hub 出入口 lock included — is the member
    // pipeline verbatim, so "what the operator can edit" and "what stays locked"
    // can never drift from the member editor.
    this.inner = new MeWorkflowEditService({ ...deps, grants: ALWAYS_EDITOR })
  }

  /**
   * Apply an operator's plain-language change site-wide, with the cross-hub
   * 出入口 still locked. Same discriminated result the member editor returns.
   */
  edit(req: MeWorkflowEditRequest): Promise<MeWorkflowEditResult> {
    return this.inner.edit(req)
  }

  /**
   * The editor view for the operator console — same shape as the member's, never
   * gated on a grant (so the operator always sees the current YAML + the governed
   * boundary for any workflow).
   */
  editableView(workflowId: string, userId: string): Promise<MeWorkflowEditableResult> {
    return this.inner.editableView(workflowId, userId)
  }
}
