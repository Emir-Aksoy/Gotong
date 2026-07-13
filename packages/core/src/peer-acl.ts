/**
 * peer-acl.ts — shared capability-allowlist semantics for federated tasks.
 *
 * Both directions of a mesh edge gate on the SAME notion of "which
 * capabilities is this task asking for":
 *
 *   - inbound  (`peer-link-install` `evaluateAcl`)          — what a peer may
 *                                                             ASK us to run
 *   - outbound (`remote-hub` `checkOutboundCapabilities`)   — what we are
 *                                                             willing to SEND
 *                                                             to a peer
 *
 * Keeping the strategy → required-capabilities extraction in one place is the
 * whole point of the Phase 19 P4-M1 symmetry: if a future `DispatchStrategy`
 * kind appears, both gates learn how to allowlist it at once instead of
 * drifting apart.
 */

import type { DispatchStrategy, Task } from './types.js'

/**
 * The capabilities a task REQUIRES, for allowlist checking — or `null` when
 * the strategy cannot be capability-allowlisted across an org boundary at all:
 *
 *   - `capability` → its declared capabilities.
 *   - `broadcast`  → its capability filter, or `null` when unfiltered
 *                    ("everyone you've got" is un-allowlistable cross-org).
 *   - `explicit`   → `null`: dispatch by an internal participant id leaks
 *                    structure and bypasses the capability contract, so a
 *                    configured allowlist treats it as un-allowlistable.
 */
export function extractRequiredCapabilities(
  strategy: DispatchStrategy,
): readonly string[] | null {
  switch (strategy.kind) {
    case 'capability':
      return strategy.capabilities
    case 'broadcast':
      return strategy.capabilities ?? null
    case 'explicit':
      return null
  }
}

/** Verdict on whether a task may leave this hub toward a peer. */
export type OutboundVerdict = { ok: true } | { ok: false; reason: string }

/**
 * Outbound allowlist gate — symmetric to inbound `evaluateAcl`'s capability
 * check, run inside `RemoteHubViaLink.onTask` right before the task crosses
 * the wire.
 *
 *   - `outboundCaps === null | undefined` → NO allowlist configured →
 *     FAIL-CLOSED: deny every task (GT-M2). An unconfigured edge sends nothing
 *     until its owner declares what may cross. This REVERSES the pre-GT
 *     accept-all default, which silently contradicted both the "every edge is
 *     an explicit contract" stance AND the runbook — FEDERATION-RUNBOOK §4 has
 *     always documented `null` = fail-closed. See docs/zh/GRADED-TRUST.md 问题 1.
 *   - otherwise → the task's required capabilities must ALL be in the
 *     allowlist. A non-allowlistable strategy (explicit / unfiltered
 *     broadcast) is denied outright — letting those past a configured
 *     allowlist would silently bypass it.
 *   - `outboundCaps === []` (explicit empty) → deny everything, the same
 *     verdict as unconfigured now, but a DELIBERATE "send nothing" lockdown.
 */
export function checkOutboundCapabilities(
  task: Task,
  outboundCaps: readonly string[] | null | undefined,
): OutboundVerdict {
  if (outboundCaps === null || outboundCaps === undefined) {
    return { ok: false, reason: 'no_outbound_allowlist' }
  }
  const required = extractRequiredCapabilities(task.strategy)
  if (required === null) {
    return { ok: false, reason: 'strategy_not_allowlisted' }
  }
  const allowed = new Set(outboundCaps)
  for (const c of required) {
    if (!allowed.has(c)) return { ok: false, reason: c }
  }
  return { ok: true }
}

/**
 * Phase 19 P4-M4 — outbound DATA-CLASS gate. The peer's trust contract lists
 * which data classes it's cleared to receive; a task that declares a class
 * outside that set is refused before it crosses the boundary.
 *
 *   - `allowed === null | undefined` → no data-class contract → send anything.
 *   - task declares no classes (`undefined` / `[]`) → nothing to restrict → ok.
 *   - otherwise → every declared class must be in the allowlist; the first
 *     that isn't fails with that class as the reason.
 *
 * This is a gate, not redaction — the payload is never rewritten. The
 * redaction hook that DOES rewrite (strip the offending fields and send a
 * reduced payload) is {@link OutboundRedactor} below; this gate stays the
 * safe default (refuse, not leak) whenever no redactor is configured.
 */
export function checkOutboundDataClasses(
  task: Task,
  allowed: readonly string[] | null | undefined,
): OutboundVerdict {
  if (allowed === null || allowed === undefined) return { ok: true }
  const declared = task.dataClasses
  if (!declared || declared.length === 0) return { ok: true }
  const ok = new Set(allowed)
  for (const c of declared) {
    if (!ok.has(c)) return { ok: false, reason: c }
  }
  return { ok: true }
}

/**
 * Phase 19 P1-M10 — the declared data classes a task carries that are NOT in
 * the peer's allowlist: exactly the classes a redactor must strip for the
 * task to pass. Empty when the task is already clean (or no contract is set).
 * Companion to {@link checkOutboundDataClasses}, which only names the FIRST
 * offender; a redactor wants the full set.
 */
export function disallowedDataClasses(
  task: Task,
  allowed: readonly string[] | null | undefined,
): readonly string[] {
  if (allowed === null || allowed === undefined) return []
  const declared = task.dataClasses
  if (!declared || declared.length === 0) return []
  const ok = new Set(allowed)
  return declared.filter((c) => !ok.has(c))
}

/** Phase 19 P1-M10 — what an {@link OutboundRedactor} returns to replace a refused task. */
export interface RedactionResult {
  /** The reduced payload to send in place of the original. */
  payload: unknown
  /**
   * The data classes the reduced payload now carries. Omit and core prunes
   * the original declaration to the allowed subset (the safe default).
   */
  dataClasses?: readonly string[]
}

/**
 * Phase 19 P1-M10 — OUTBOUND data-class REDACTION hook. When the data-class
 * gate would REFUSE a task (it carries a class the peer isn't cleared for),
 * an optional redactor may instead produce a REDUCED version — offending
 * fields stripped — so a compliant subset still crosses the boundary. This is
 * the seam `checkOutboundDataClasses`'s doc reserved: refusal → graceful
 * degradation for compliance flows that still want partial collaboration.
 *
 * Receives the original task plus `allowed` (the peer's cleared classes) and
 * `disallowed` (the subset that tripped the gate). Returns:
 *   - a {@link RedactionResult} → core re-checks it fail-closed and, if clean,
 *     forwards the reduced task.
 *   - `null` → decline; core falls back to refusing the whole task.
 *
 * Safety contract enforced by core (`RemoteHubViaLink`), NOT by the redactor:
 *   - the redactor controls ONLY payload + data classes; id / from / origin are
 *     preserved from the original, so identity and routing can't be tampered.
 *   - core ALWAYS re-runs `checkOutboundDataClasses` on the result, so a buggy
 *     redactor that leaves a disallowed class can never leak — its result is
 *     rejected and the task refused, exactly as if no redactor were set.
 *   - a redactor that throws is treated as a decline (refuse), never a leak.
 */
export type OutboundRedactor = (
  task: Task,
  ctx: { allowed: readonly string[]; disallowed: readonly string[] },
) => RedactionResult | null | Promise<RedactionResult | null>
