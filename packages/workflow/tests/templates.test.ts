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

describe('member-facing workflow templates declare a valid surface.me (Phase 14)', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const repoRoot = join(here, '..', '..', '..')
  const wfDir = join(repoRoot, 'templates', 'workflows')

  // Each shipped member-facing template, with the contract /me relies on:
  // the effective scope key (undefined → me-routes defaults it to case_id)
  // and the member input fields — which must NEVER include the scope key.
  // The scope key is forced server-side; surfacing it as a member field
  // would invite spoofing. The admin trigger form may still expose it.
  const cases = [
    {
      file: 'personal-growth-flow.yaml',
      scopeKey: 'case_id',
      fields: ['present_state', 'aspirations', 'struggles', 'focus_request'],
    },
    {
      file: 'daily-reflection-flow.yaml',
      scopeKey: undefined, // omitted → defaults to case_id downstream
      fields: ['highlights', 'lowlights', 'tomorrow_focus'],
    },
    {
      file: 'weekly-goal-checkin-flow.yaml',
      scopeKey: 'owner_user_id', // exercises an alternate scope key
      fields: ['goals', 'blockers'],
    },
  ]

  for (const c of cases) {
    it(`${c.file}: enabled, ${c.fields.length} member fields, scope=${c.scopeKey ?? '(default case_id)'}`, async () => {
      const wf = parseWorkflow(await readFile(join(wfDir, c.file), 'utf8'))
      const me = wf.surface?.me
      expect(me?.enabled).toBe(true)
      expect(me?.userScopeField).toBe(c.scopeKey)
      const ids = (me?.inputSchema ?? []).map((f) => f.id)
      expect(ids).toEqual(c.fields)
      expect(ids).not.toContain(c.scopeKey ?? 'case_id')
    })
  }
})
