import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { parseWorkflow } from '../src/index.js'

/**
 * Smoke-test every workflow YAML the repo ships under `templates/workflows/`.
 *
 * Mirrors `packages/web/tests/manifest.test.ts` for agents / teams. If
 * someone adds a new workflow file but breaks its schema, CI catches it
 * here — no extra test wiring required.
 */
describe('repo workflows parse cleanly', async () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const repoRoot = join(here, '..', '..', '..')
  const dir = join(repoRoot, 'templates', 'workflows')

  let files: string[] = []
  try {
    files = await readdir(dir)
  } catch {
    // Directory may not exist in some checkouts (slim clones, etc.) —
    // a clean miss is fine; we just have nothing to smoke.
  }
  const yamlFiles = files.filter(
    (f) => f.endsWith('.yaml') || f.endsWith('.yml') || f.endsWith('.json'),
  )

  // Generate one `it` block per file so the failure message names the file.
  for (const f of yamlFiles) {
    it(`parses ${f}`, async () => {
      const body = await readFile(join(dir, f), 'utf8')
      const wf = parseWorkflow(body)
      expect(wf.id.length).toBeGreaterThan(0)
      expect(wf.trigger.capability.length).toBeGreaterThan(0)
      expect(wf.steps.length).toBeGreaterThan(0)
    })
  }

  if (yamlFiles.length === 0) {
    it.skip('no workflow files found — nothing to smoke', () => {
      /* no-op */
    })
  }
})

describe('personal-growth-flow declares a member-facing surface.me (Phase 14)', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const repoRoot = join(here, '..', '..', '..')
  const file = join(repoRoot, 'templates', 'workflows', 'personal-growth-flow.yaml')

  it('parses surface.me with the 4 free-form fields and case_id scope', async () => {
    const wf = parseWorkflow(await readFile(file, 'utf8'))
    const me = wf.surface?.me
    expect(me?.enabled).toBe(true)
    expect(me?.userScopeField).toBe('case_id')
    // The member form omits case_id on purpose — it's the scope key, forced
    // server-side, so a member can only ever run for themselves. (The admin
    // trigger form DOES expose case_id, via trigger.payloadSchema.)
    const ids = (me?.inputSchema ?? []).map((f) => f.id)
    expect(ids).toEqual(['present_state', 'aspirations', 'struggles', 'focus_request'])
    expect(ids).not.toContain('case_id')
  })
})
