/**
 * procedure.ts — procedural / skill memory (decision G).
 *
 * Episodic memory records WHAT happened; semantic memory records lasting FACTS.
 * Neither captures HOW — the reusable action sequence that got a job done ("how
 * I got an overtime claim approved": draft → assess policy → route to manager →
 * record the decision). G adds that as a third FORM riding on a `semantic`
 * entry — NOT a new `MemoryKind` (kinds gate the storage backend; a procedure is
 * still a durable fact, just shaped as ordered steps). So, like importance /
 * tier / links, it is free-form `meta`: NO schema change.
 *
 *   entry.text         the procedure's name / goal (one line)
 *   meta.form          'procedure'
 *   meta.steps         readonly string[] — the ordered actions
 *
 * # Deterministic half (no LLM)
 *
 * This module is pure accessors + a renderer. The toolset's `remember_procedure`
 * writes the shape; `recall` can filter to `form: 'procedure'` and show the
 * steps inline. G-M2 (opt-in, byte-stable) adds a frozen-block "things I know how
 * to do" section built from these same accessors. Links / importance / tier all
 * compose unchanged — a procedure is an ordinary entry that happens to carry an
 * ordered step list.
 */

import type { MemoryEntry } from '@aipehub/services-sdk'

/** Meta key carrying an entry's FORM discriminator (currently only 'procedure'). */
export const META_FORM = 'form'

/** Meta key carrying a procedure's ordered step list. */
export const META_STEPS = 'steps'

/** The one form this module recognizes. Other values are treated as "no form". */
export const FORM_PROCEDURE = 'procedure'

/** An entry's `meta.form` string, or `fallback` when absent / not a string. */
export function formOf(e: MemoryEntry, fallback = ''): string {
  const f = (e.meta as { form?: unknown } | undefined)?.form
  return typeof f === 'string' ? f : fallback
}

/** Whether `e` is a recorded procedure (a how-to with ordered steps). */
export function isProcedure(e: MemoryEntry): boolean {
  return formOf(e) === FORM_PROCEDURE
}

/**
 * Clean an arbitrary `steps` value into an ordered list of non-empty trimmed
 * strings. Non-array → `[]`; non-string / blank items are dropped; order is
 * preserved. Shared by the toolset (validating tool input) and {@link stepsOf}
 * (reading stored meta) so input and storage are normalized the same way.
 */
export function cleanSteps(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const s of raw) {
    if (typeof s === 'string') {
      const t = s.trim()
      if (t) out.push(t)
    }
  }
  return out
}

/** The ordered, cleaned steps stored on a procedure entry (`[]` if none / not a procedure). */
export function stepsOf(e: MemoryEntry): string[] {
  return cleanSteps((e.meta as { steps?: unknown } | undefined)?.steps)
}

/** A compact one-line numbered rendering of steps, e.g. `1. draft; 2. send`. */
export function formatProcedureSteps(steps: readonly string[]): string {
  return steps.map((s, i) => `${i + 1}. ${s}`).join('; ')
}
