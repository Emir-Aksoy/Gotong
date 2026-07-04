/**
 * Reference resolver — substitutes `$ref` strings inside a payload tree
 * with values from earlier steps / the trigger.
 *
 * Reference syntax (string-form, the only form we accept):
 *
 *   $trigger.payload                 → entire inbound payload
 *   $trigger.payload.foo             → field on it
 *   $trigger.payload.foo.bar         → nested field (dot-walk)
 *   $stepId.output                   → entire output of an earlier simple step
 *   $stepId.output.something         → nested field on it
 *   $stepId.branchId.output          → output of one branch inside a parallel step
 *   $stepId.branchId.output.field    → nested field on that branch output
 *
 * Resolution rules:
 *
 *   1. If a leaf value in the payload tree is a string that is exactly a `$ref`,
 *      it's replaced by the *referenced value* (preserving its type — object,
 *      array, number, etc. — not stringified).
 *   2. If a leaf is a string that *contains* `$ref`s inline (e.g.
 *      "请审稿: $draft.output"), each occurrence is replaced by
 *      `JSON.stringify` of the referenced value, then concatenated. This makes
 *      it easy to template prompts.
 *   3. Anything else is passed through untouched.
 *
 * The resolver does **not** introduce new functions, conditionals, or
 * arithmetic — it's deliberately limited to "look up a path and substitute".
 * If a referenced path doesn't exist, the resolver throws `WorkflowRefError`
 * with a helpful message that names the bad ref.
 */

import type { AncestryNode } from '@gotong/core'

import { WorkflowRefError } from './types.js'

export interface ResolutionContext {
  /** The triggering task's payload. */
  triggerPayload: unknown
  /**
   * Optional: the `from` ParticipantId of the task that triggered
   * this run. When set, workflow yaml can reference `$trigger.from`
   * to thread the originating admin id through to a step's payload
   * — used by HITL flows so an agent can ask follow-up questions
   * of the user who started the run. Resume of older pre-v2.5 run
   * files leaves this `undefined`; refs against `$trigger.from`
   * then throw a helpful WorkflowRefError.
   */
  triggerFrom?: string
  /**
   * B2.2.2 — `task.origin` from the triggering dispatch, if any.
   * Not exposed via `$ref` syntax (no workflow yaml needs it) — the
   * runner reads it directly in `dispatchOne` and re-stamps every
   * inner dispatch so org-level quota gates see the original
   * dispatcher's `userId`, not the synthetic workflow runner id.
   */
  triggerOrigin?: { orgId: string; userId: string; userRole?: string; userEmail?: string }
  /** The Hub task id that started this workflow run. */
  triggerTaskId?: string
  /** The ancestry carried by the triggering task, if any. */
  triggerAncestry?: readonly AncestryNode[]
  /**
   * Map from step id to the *resolved output* of that step.
   * For simple steps, the value is whatever the step returned.
   * For parallel steps, the value is `{ branchId → branchOutput }`.
   */
  stepOutputs: Map<string, unknown>
}

/**
 * Resolve a payload tree. Returns a new structure with all references
 * substituted. The input is not mutated.
 */
export function resolveRefs(value: unknown, ctx: ResolutionContext): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') {
    return resolveStringValue(value, ctx)
  }
  if (Array.isArray(value)) {
    return value.map((v) => resolveRefs(v, ctx))
  }
  if (typeof value === 'object') {
    // H1 — prototype-pollution defence. `JSON.parse('{"__proto__":{…}}')`
    // produces a parsed object whose OWN-property key is literally
    // `__proto__`, and `Object.entries` faithfully enumerates it. The
    // pre-3.4 code then did `out[k] = …`, which on a regular `{}`
    // *delegates through the `__proto__` setter on Object.prototype* —
    // every object in the realm starts inheriting the attacker's fields.
    //
    // `triggerPayload` here is agent-controlled (it's the body of an
    // inbound TASK passed through the workflow runner), so the path is
    // reachable in production. Defence is layered:
    //
    //   1. Create `out` with a NULL prototype so accidental assignment
    //      lands as a plain own-property rather than reaching the
    //      Object.prototype setter — i.e. even if someone forgets the
    //      denylist below, the prototype chain is sealed.
    //   2. Skip the three carriers (`__proto__` / `constructor` /
    //      `prototype`) outright. A workflow legitimately wanting one
    //      of those names as a data key has no unambiguous expression
    //      in our payload language anyway, so the denylist costs
    //      nothing real.
    //
    // See AUDIT-v3.3.md finding H1.
    const out = Object.create(null) as Record<string, unknown>
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') {
        continue
      }
      out[k] = resolveRefs(v, ctx)
    }
    return out
  }
  // number / boolean / bigint / function — passed through
  return value
}

/**
 * The `$ref` regex. Matches a single ref, including the trailing dot-path.
 * The path body allows letters, digits, _, -, ., :, but stops at whitespace,
 * `{`, `}`, `,`, `"`, `\``, or `$`.
 */
const REF_RE = /\$[a-zA-Z0-9_][a-zA-Z0-9_.:-]*/g

/**
 * Statically collect the *heads* of every `$ref` that appears anywhere in a
 * value tree, WITHOUT resolving them against a live run. The head is the first
 * dot-segment after `$` — `trigger` for `$trigger.payload.x`, or a step id for
 * `$draft.output` / `$fan.branchA.output` (a parallel ref's head is the
 * parallel STEP id, not the branch).
 *
 * Used by the read-only graph projection ({@link projectWorkflowGraph}) to draw
 * data-dependency edges — "which earlier steps does this step's payload read".
 * Mirrors {@link lookupRef}'s head parsing + the same {@link REF_RE} the
 * resolver uses, so the static view never disagrees with runtime resolution
 * about what a ref's source is. A match whose head isn't a real step id is
 * harmless: the caller filters against the known step set before drawing.
 */
export function collectRefHeads(value: unknown): {
  steps: Set<string>
  usesTrigger: boolean
} {
  const steps = new Set<string>()
  let usesTrigger = false
  const visit = (v: unknown): void => {
    if (typeof v === 'string') {
      const matches = v.match(REF_RE)
      if (!matches) return
      for (const ref of matches) {
        const head = ref.slice(1).split('.')[0]
        if (!head) continue
        if (head === 'trigger') usesTrigger = true
        else steps.add(head)
      }
      return
    }
    if (Array.isArray(v)) {
      for (const x of v) visit(x)
      return
    }
    if (v && typeof v === 'object') {
      for (const x of Object.values(v)) visit(x)
    }
  }
  visit(value)
  return { steps, usesTrigger }
}

function resolveStringValue(s: string, ctx: ResolutionContext): unknown {
  // Fast path: whole string is exactly a single ref → preserve type.
  const trimmed = s.trim()
  if (trimmed.startsWith('$') && !/\s/.test(trimmed)) {
    const single = trimmed.match(REF_RE)
    if (single && single.length === 1 && single[0] === trimmed) {
      return lookupRef(trimmed, ctx)
    }
  }
  // Otherwise: inline templating — replace each ref with JSON.stringify.
  if (!s.includes('$')) return s
  return s.replace(REF_RE, (ref) => {
    const v = lookupRef(ref, ctx)
    if (v === undefined) return ''
    if (typeof v === 'string') return v
    try {
      return JSON.stringify(v)
    } catch {
      return String(v)
    }
  })
}

/**
 * Look up one `$...` path against the context. Throws `WorkflowRefError`
 * on any failure.
 */
export function lookupRef(ref: string, ctx: ResolutionContext): unknown {
  if (!ref.startsWith('$') || ref.length < 2) {
    throw new WorkflowRefError(`bad ref '${ref}'`)
  }
  const parts = ref.slice(1).split('.')
  const head = parts[0]
  if (head === 'trigger') {
    if (parts[1] === 'payload') {
      return walkPath(ctx.triggerPayload, parts.slice(2), ref)
    }
    if (parts[1] === 'from') {
      // `$trigger.from` is a scalar — no further dot-walk allowed.
      // It resolves to the ParticipantId of whoever started the run.
      // Older run files (pre-v2.5) don't carry triggerFrom; explain.
      if (parts.length > 2) {
        throw new WorkflowRefError(
          `bad ref '${ref}' — '$trigger.from' is a scalar, no further path allowed`,
        )
      }
      if (ctx.triggerFrom === undefined) {
        throw new WorkflowRefError(
          `bad ref '${ref}' — triggerFrom is unset (pre-v2.5 run state or non-Task entry point)`,
        )
      }
      return ctx.triggerFrom
    }
    throw new WorkflowRefError(
      `bad ref '${ref}' — only '$trigger.payload[.…]' or '$trigger.from' are supported`,
    )
  }
  // step ref
  const stepId = head
  if (!stepId || !ctx.stepOutputs.has(stepId)) {
    throw new WorkflowRefError(
      `bad ref '${ref}' — step '${stepId}' has not produced output yet (or doesn't exist)`,
    )
  }
  const stepValue = ctx.stepOutputs.get(stepId)
  // Two grammars: $stepId.output[.…]  or  $stepId.branchId.output[.…]
  if (parts[1] === 'output') {
    // simple step
    return walkPath(stepValue, parts.slice(2), ref)
  }
  // parallel: parts[1] is branch id, parts[2] should be 'output'
  if (parts[2] !== 'output') {
    throw new WorkflowRefError(
      `bad ref '${ref}' — expected '$${stepId}.output[.…]' or '$${stepId}.<branchId>.output[.…]'`,
    )
  }
  const branchId = parts[1]
  if (
    !stepValue ||
    typeof stepValue !== 'object' ||
    !(branchId! in (stepValue as Record<string, unknown>))
  ) {
    throw new WorkflowRefError(
      `bad ref '${ref}' — step '${stepId}' has no branch '${branchId}'`,
    )
  }
  const branchOutput = (stepValue as Record<string, unknown>)[branchId!]
  return walkPath(branchOutput, parts.slice(3), ref)
}

/** Walk a dot-path on an object. Empty `path` returns `value` as-is. */
function walkPath(value: unknown, path: string[], originalRef: string): unknown {
  let cur: unknown = value
  for (const seg of path) {
    if (cur === null || cur === undefined) {
      throw new WorkflowRefError(
        `bad ref '${originalRef}' — got null/undefined before reaching '${seg}'`,
      )
    }
    if (typeof cur !== 'object') {
      throw new WorkflowRefError(
        `bad ref '${originalRef}' — cannot read '${seg}' from non-object`,
      )
    }
    cur = (cur as Record<string, unknown>)[seg]
  }
  return cur
}
