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
