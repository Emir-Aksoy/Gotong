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

/** @deprecated Phase 19 P4-M4 generalised this to {@link OutboundVerdict}. */
export type OutboundCapabilityVerdict = OutboundVerdict

/**
 * Outbound allowlist gate — symmetric to inbound `evaluateAcl`'s capability
 * check, run inside `RemoteHubViaLink.onTask` right before the task crosses
 * the wire.
 *
 *   - `outboundCaps === null | undefined` → no allowlist configured → every
 *     task passes (legacy / accept-all; an unset peer row keeps pre-P4
 *     behaviour).
 *   - otherwise → the task's required capabilities must ALL be in the
 *     allowlist. A non-allowlistable strategy (explicit / unfiltered
 *     broadcast) is denied outright — letting those past a configured
 *     allowlist would silently bypass it.
 *   - `outboundCaps === []` (explicit empty) → deny everything: a legitimate
 *     "send nothing to this peer" lockdown.
 */
export function checkOutboundCapabilities(
  task: Task,
  outboundCaps: readonly string[] | null | undefined,
): OutboundVerdict {
  if (outboundCaps === null || outboundCaps === undefined) return { ok: true }
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
 * This is a gate, not redaction — the payload is never rewritten. A
 * redaction hook (strip the offending fields and send a reduced payload)
 * is a deferred seam; until then the safe default is refuse, not leak.
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
