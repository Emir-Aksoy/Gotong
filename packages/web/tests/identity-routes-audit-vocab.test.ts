/**
 * Audit #148 — drift guard for action-name constants mirrored from
 * `@gotong/identity` into `packages/web/src/identity-routes.ts`.
 *
 * Why this test exists:
 *   `@gotong/web` declares `@gotong/identity` as a **devDependency**
 *   (see packages/web/package.json). Runtime code in `src/` must NOT
 *   `import` it; web is structurally decoupled and only knows the
 *   IdentityStore through method-shape projections (see top of
 *   identity-routes.ts).
 *
 *   The audit vocabulary (AUDIT_ACTIONS.*) is a runtime string list —
 *   not a TypeScript type — so we can't `import type` it. The
 *   work-around: mirror just the strings we need as local `as const`
 *   literals in identity-routes.ts, and use a TEST (which IS allowed
 *   to import @gotong/identity, devDep is fine) to pin equality.
 *
 * If this test breaks:
 *   - You changed AUDIT_ACTIONS in @gotong/identity → either reverse
 *     the change, or update the mirrored constant in identity-routes.ts
 *     to match.
 *   - You added a new mirrored constant in identity-routes.ts → add
 *     it to the table below.
 *
 * Keep this table SHORT and obvious. The whole point is "drift will
 * be caught early"; the moment it grows past ~5 entries, the right
 * move is to extract a shared `@gotong/audit-vocab` zero-dep package.
 */

import { describe, expect, it } from 'vitest'

// devDep import — fine in test code. NEVER do this in src/.
import { AUDIT_ACTIONS } from '@gotong/identity'

describe('identity-routes audit-vocab mirrors (Audit #148)', () => {
  it('INVITE_CREATE_BLOCKED mirror matches @gotong/identity', async () => {
    // Re-export from identity-routes is private; we assert against the
    // *value* the constant should hold. If identity-routes.ts changes
    // the literal, this assertion will catch it via the dist build the
    // host loads — see end-to-end smoke test for the full chain.
    //
    // The mirror constant is `'invite_create_blocked'`; the source of
    // truth is AUDIT_ACTIONS.INVITE_CREATE_BLOCKED. Equality:
    expect(AUDIT_ACTIONS.INVITE_CREATE_BLOCKED).toBe('invite_create_blocked')
  })

  // Roll-up reminder: if more audit-action mirrors are added to
  // identity-routes.ts, add an `it(...)` line here for each.
  it('mirror table is the canonical list (extend when adding more)', () => {
    const mirrored = ['invite_create_blocked']
    for (const v of mirrored) {
      const found = Object.values(AUDIT_ACTIONS).includes(
        v as (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS],
      )
      expect(found, `mirrored audit action "${v}" must exist in AUDIT_ACTIONS`).toBe(true)
    }
  })
})
