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
export type OutboundCapabilityVerdict =
  | { ok: true }
  | { ok: false; reason: string }

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
): OutboundCapabilityVerdict {
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
