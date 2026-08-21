/**
 * LONG-M4a — text-level contract on the admin panel's capture-echo for
 * `longRunModels`.
 *
 * The panel has NO structured editor for the craft-model slots (authoring goes
 * manifest export → edit YAML → re-import, same as fallbacks). But a panel PUT
 * replaces `managed` wholesale, so the form MUST capture the slots on load and
 * echo them on save — otherwise a plain edit (rename, system tweak) silently
 * wipes them. That invariant lives only in `admin-src/managed-agents.js`
 * source; this gate reads the source text (the sdui-ui contract-test posture:
 * web tests may read sibling sources, never import them) and goes red if a
 * future editor rewrite drops either half.
 *
 * Deliberately thin: presence + shape of the two anchors, not behavior — the
 * behavioral half (omission drops, echo keeps) is pinned server-side in
 * agents-route.test.ts's "PUT echoing the slots keeps them" case.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(join(here, '..', 'admin-src', 'managed-agents.js'), 'utf8')

describe('managed-agents panel — longRunModels capture-echo contract (LONG-M4a)', () => {
  it('captures the stored slots into _editingLongRunModels when the edit form opens', () => {
    // The capture must read from the agent's managed spec — a capture that
    // doesn't source `managed.longRunModels` is capturing nothing.
    expect(SRC).toMatch(/_editingLongRunModels\s*=/)
    expect(SRC).toContain('agent?.managed?.longRunModels')
  })

  it('echoes the captured slots into the PUT body on save', () => {
    // The echo is what keeps a plain panel edit from wiping the slots.
    expect(SRC).toContain('body.longRunModels = ma._editingLongRunModels')
  })
})
