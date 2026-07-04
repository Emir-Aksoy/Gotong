/**
 * WFEDIT-M1 — the cross-hub **boundary lock** for member natural-language
 * workflow editing.
 *
 * WHY this exists. A member editing a workflow in plain language (`/me`, the
 * OpenClaw-style NL editor) may freely reshape the LOCAL logic of a workflow —
 * step prompts, `when:` conditions, `human:` text, add/remove local steps. But a
 * workflow that reaches ANOTHER hub carries a governed contract at its edges:
 *   - 入口 (ingress): the `trigger` capability — how the workflow is invoked.
 *   - 出口 (egress): each step that dispatches to a capability only an off-hub
 *     destination serves (a mesh peer or an external A2A agent), together with
 *     the data classes that node carries across the per-link contract.
 * These edges are the North Star's "工作流跨边界, 但凭证/数据/计费各归各家" —
 * the per-link trust contract, the outbound approval gate, the data-class闸 all
 * key off them. A member must NOT be able to silently repoint, add, drop, or
 * re-classify a cross-hub hop while "just tweaking the workflow". So the NL edit
 * is gated: the boundary must be byte-for-byte invariant across the edit; only
 * "自己这边" (the local part) may change.
 *
 * This module is PURE — no Hub, no LLM, no versioning. It is the single place
 * that decides "did this edit touch the cross-hub boundary?", so the host edit
 * service (WFEDIT-M2) and the `/me` route (M3) gate on exactly one definition of
 * the boundary. Cross-hub detection itself is delegated to {@link crossHubStepsOf}
 * (the SAME detector the admin pre-launch visibility uses) so there is no drift
 * between "what the UI flags as cross-hub" and "what the editor locks".
 *
 * Honest MVP boundary: egress detection consults the LIVE peer-capability view
 * (a step is "cross-hub" iff a peer currently advertises its cap and no local
 * participant serves it). If the destination peer is OFFLINE at edit time the
 * workflow reads as purely-local and the egress lock cannot see it — only the
 * ingress (trigger) lock, which needs no peer view, still fires. Persisting a
 * sticky "this workflow has cross-hub steps" marker to lock egress even while a
 * peer is down is a deliberate follow-up, not in this pass.
 */

import type { DispatchSpec, WorkflowDefinition } from '@gotong/workflow'

import { crossHubStepsOf } from './workflow-controller.js'

/**
 * One off-hub capability entry — the exact shape {@link crossHubStepsOf} takes,
 * re-exported here so callers thread one type through. The host builds these
 * from connected mesh peers (joined with each wrapper's advertised caps) and
 * live external A2A agents; see `PeerCapabilityView` in `workflow-controller.ts`.
 */
export interface PeerCapEntry {
  peer: string
  label: string | null
  capabilities: readonly string[]
  /** Off-hub destination kind; defaults to `'peer'` when omitted. */
  kind?: 'peer' | 'a2a'
}

/** One cross-hub egress edge of a workflow: where it leaves the hub, carrying what. */
export interface EgressStep {
  /** Step id, or `${stepId}/${branchId}` for a parallel branch (matches {@link crossHubStepsOf}). */
  stepId: string
  /** The off-hub capability this step dispatches to. */
  capability: string
  /** The node-level data classes carried across the per-link contract (canonical: deduped + sorted). */
  dataClasses: string[]
}

/**
 * The governed cross-hub boundary of a workflow — the part a member NL edit must
 * leave untouched. `trigger` is always present (ingress); `egress` is empty for a
 * purely-local workflow (or one whose peer is offline — see the module note).
 */
export interface WorkflowBoundary {
  /** Ingress: the trigger capability. */
  trigger: string
  /** Egress: every cross-hub hop, in definition order. */
  egress: EgressStep[]
}

export type BoundaryViolationKind =
  | 'trigger_changed'
  | 'egress_added'
  | 'egress_removed'
  | 'egress_retargeted'
  | 'egress_dataclass_changed'

/** One reason an edit was rejected for touching the cross-hub boundary. */
export interface BoundaryViolation {
  kind: BoundaryViolationKind
  /** The affected step id (composite for a branch), when the violation is step-scoped. */
  stepId?: string
  /** Human-readable (zh) explanation, surfaced to the member verbatim. */
  detail: string
}

export type EditBoundaryResult = { ok: true } | { ok: false; violations: BoundaryViolation[] }

/**
 * Map every step (and parallel branch) to its `DispatchSpec`, keyed by the SAME
 * composite id {@link crossHubStepsOf} emits (`stepId` or `${stepId}/${branchId}`).
 * Lets us look up an egress step's data classes without re-parsing the composite.
 */
function dispatchByStepId(def: WorkflowDefinition): Map<string, DispatchSpec> {
  const m = new Map<string, DispatchSpec>()
  for (const step of def.steps) {
    if (step.kind === 'parallel') {
      for (const b of step.branches) m.set(`${step.id}/${b.id}`, b.dispatch)
    } else {
      m.set(step.id, step.dispatch)
    }
  }
  return m
}

/** Canonicalize a data-class list: stringify, dedupe, sort — so order/dupes never read as a change. */
function canonClasses(dc?: readonly string[]): string[] {
  if (!dc) return []
  return [...new Set(dc.map((c) => String(c)))].sort()
}

function sameClasses(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((c, i) => c === b[i])
}

/** The synthetic peer id used to reactivate sticky (offline-peer) egress caps. */
const STICKY_OFFLINE_PEER = '__gotong_sticky_offline__'

/**
 * Reactivate sticky cross-hub capabilities as one synthetic OFFLINE peer entry.
 *
 * WHY. Egress is detected against the CURRENTLY-connected peers, so a destination
 * peer that's offline right now reads as not-cross-hub and its hop would slip the
 * lock (the WFEDIT MVP gap). The host persists a per-workflow sticky set of
 * capabilities ever seen leaving the workflow off-hub (`CrossHubMarkerStore`); we
 * feed them here as a synthetic peer so {@link crossHubStepsOf} re-flags any step
 * that STILL dispatches such a capability — reusing the EXACT detector (zero
 * drift) and inheriting its "served locally ⇒ not egress" guard (so a capability
 * brought in-house auto-deactivates). Appended LAST so a genuinely-online peer
 * keeps attribution when both advertise the same capability.
 */
function withStickyOfflinePeer(
  peerEntries: ReadonlyArray<PeerCapEntry>,
  stickyCapabilities?: readonly string[],
): ReadonlyArray<PeerCapEntry> {
  if (!stickyCapabilities || stickyCapabilities.length === 0) return peerEntries
  return [
    ...peerEntries,
    { peer: STICKY_OFFLINE_PEER, label: null, capabilities: [...new Set(stickyCapabilities)] },
  ]
}

/**
 * Compute a workflow's cross-hub boundary. `egress` is derived via the canonical
 * {@link crossHubStepsOf} detector (so "cross-hub" means exactly what it means
 * everywhere else), then annotated with each node's data classes.
 *
 * `stickyCapabilities` (optional) are capabilities the host recorded as off-hub
 * for THIS workflow while peers were connected; they reactivate the egress lock
 * even when the destination peer is offline at edit time (see
 * {@link withStickyOfflinePeer}). Data classes are always read fresh from the
 * live definition, so the sticky set carries no data-class state.
 */
export function workflowBoundary(
  def: WorkflowDefinition,
  localCapabilities: ReadonlySet<string>,
  peerEntries: ReadonlyArray<PeerCapEntry>,
  stickyCapabilities?: readonly string[],
): WorkflowBoundary {
  const dispatches = dispatchByStepId(def)
  const egress: EgressStep[] = crossHubStepsOf(
    def,
    localCapabilities,
    withStickyOfflinePeer(peerEntries, stickyCapabilities),
  ).map((e) => ({
    stepId: e.stepId,
    capability: e.capability,
    dataClasses: canonClasses(dispatches.get(e.stepId)?.dataClasses),
  }))
  return { trigger: def.trigger.capability, egress }
}

/**
 * The boundary lock. Returns `{ ok: true }` iff `edited` preserves `original`'s
 * cross-hub boundary EXACTLY: same trigger (ingress), and the same set of egress
 * edges — same step ids, same target capabilities, same data classes. Any drift
 * is a typed violation with a member-readable zh detail.
 *
 * The trigger is ALWAYS locked (it needs no peer view and is the workflow's
 * invocation contract); egress is locked per the live peer view (empty for a
 * purely-local edit ⇒ only the trigger is enforced, which is the minimal lock).
 */
export function enforceEditBoundary(
  original: WorkflowDefinition,
  edited: WorkflowDefinition,
  localCapabilities: ReadonlySet<string>,
  peerEntries: ReadonlyArray<PeerCapEntry>,
  stickyCapabilities?: readonly string[],
): EditBoundaryResult {
  const violations: BoundaryViolation[] = []

  // --- Ingress: the trigger capability must not change. ---
  if (edited.trigger.capability !== original.trigger.capability) {
    violations.push({
      kind: 'trigger_changed',
      detail: `入口(trigger)能力从 "${original.trigger.capability}" 改成 "${edited.trigger.capability}" — 工作流的入口不可改, 只能改步骤内容。`,
    })
  }

  // --- Egress: the set of cross-hub hops must be identical. Sticky caps reactivate
  //     an egress whose peer is offline at edit time, so the lock holds either way. ---
  const origEgress = workflowBoundary(original, localCapabilities, peerEntries, stickyCapabilities).egress
  const editEgress = workflowBoundary(edited, localCapabilities, peerEntries, stickyCapabilities).egress
  const keyOf = (e: EgressStep): string => `${e.stepId}::${e.capability}`
  const origMap = new Map(origEgress.map((e) => [keyOf(e), e]))
  const editMap = new Map(editEgress.map((e) => [keyOf(e), e]))
  const origStepIds = new Set(origEgress.map((e) => e.stepId))
  const editStepIds = new Set(editEgress.map((e) => e.stepId))

  for (const [k, before] of origMap) {
    const after = editMap.get(k)
    if (after) {
      // Same endpoint survives — only its data contract could have drifted.
      if (!sameClasses(before.dataClasses, after.dataClasses)) {
        violations.push({
          kind: 'egress_dataclass_changed',
          stepId: before.stepId,
          detail: `出口步骤 "${before.stepId}"(→ ${before.capability})的数据分类从 [${before.dataClasses.join(', ') || '空'}] 改成 [${after.dataClasses.join(', ') || '空'}] — 跨 hub 出口的数据契约不可改。`,
        })
      }
    } else if (editStepIds.has(before.stepId)) {
      // Same step id still leaves the hub, but to a different capability.
      violations.push({
        kind: 'egress_retargeted',
        stepId: before.stepId,
        detail: `出口步骤 "${before.stepId}" 的跨 hub 目标能力被改(原 → ${before.capability})— 出口去哪个 hub 不可改。`,
      })
    } else {
      violations.push({
        kind: 'egress_removed',
        stepId: before.stepId,
        detail: `出口步骤 "${before.stepId}"(→ ${before.capability})被删掉或改成不再跨 hub — 跨 hub 出口不可改。`,
      })
    }
  }

  for (const [k, after] of editMap) {
    if (origMap.has(k)) continue
    // Already reported as a retarget on the original side — don't double-count.
    if (origStepIds.has(after.stepId)) continue
    violations.push({
      kind: 'egress_added',
      stepId: after.stepId,
      detail: `新增了一个跨 hub 出口步骤 "${after.stepId}"(→ ${after.capability})— 成员不能新增对外出口。`,
    })
  }

  return violations.length ? { ok: false, violations } : { ok: true }
}
