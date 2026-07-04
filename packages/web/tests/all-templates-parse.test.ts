/**
 * Repo-wide template validation gate (pre-launch checklist item 5).
 *
 * Every per-example template test (cafe-ops-template.test.ts, …) pins ONE
 * file's specifics. This gate is the opposite: it sweeps EVERY
 * `gotong.template/v1` manifest in the repo — the shipped flagship examples AND
 * any community submission under templates/community/templates/ — through the
 * REAL parseTemplate, and every embedded workflow block through the REAL
 * parseWorkflow.
 *
 * It is the merge bar a contributor's `pnpm check:templates` runs locally and
 * (opt-in) CI runs on a template PR. A submission whose manifest is malformed,
 * or that carries a workflow block that isn't valid gotong.workflow/v1, fails
 * HERE — named by file — instead of blowing up on someone's hub at one-click
 * install. That's the whole point: GitHub hosts the substance (templates are
 * files), so the only gate a template PR needs is "license-clear + actually
 * parses", and this is the second half made executable.
 *
 * STRUCTURE only, never "non-empty agents": child-desk ships ZERO agents (零订阅
 * — the child hub calls the parent's subscription), so a universal
 * agents.length > 0 would be wrong. The bar is: parses as a manifest, every
 * embedded workflow block parses, and no literal secret was pasted in.
 *
 * Scope note: the OLDER templates/community/{agents,teams}/ contributions are
 * single-agent / team manifests that go through different parsers — they are
 * out of scope for THIS gate, which is specifically the `gotong.template/v1`
 * one-file-装一整套 format the gallery installs.
 */

import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseWorkflow } from '@gotong/workflow'

import { parseTemplate } from '../src/template-manifest.js'

// packages/web/tests/ → repo root is three levels up.
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return [] // a missing dir (e.g. no community submissions yet) is fine.
  }
}

function walk(dir: string, onFile: (abs: string) => void): void {
  for (const name of safeReaddir(dir)) {
    const abs = join(dir, name)
    let isDir = false
    try {
      isDir = statSync(abs).isDirectory()
    } catch {
      continue
    }
    if (isDir) walk(abs, onFile)
    else onFile(abs)
  }
}

// The two roots that hold gotong.template/v1 manifests:
//   examples/*/template/*.template.yaml  — the shipped flagship templates
//   templates/community/templates/**     — where community submissions land
function collectTemplateFiles(): string[] {
  const out: string[] = []

  const examplesDir = join(REPO_ROOT, 'examples')
  for (const ex of safeReaddir(examplesDir)) {
    const tdir = join(examplesDir, ex, 'template')
    for (const f of safeReaddir(tdir)) {
      if (f.endsWith('.template.yaml') || f.endsWith('.template.yml')) out.push(join(tdir, f))
    }
  }

  walk(join(REPO_ROOT, 'templates', 'community', 'templates'), (abs) => {
    if (abs.endsWith('.yaml') || abs.endsWith('.yml')) out.push(abs)
  })

  return out.sort()
}

const templateFiles = collectTemplateFiles()

// A submission must wire credentials as ${ENV} placeholders, never paste a real
// provider secret. Conservative patterns — they match the shapes real keys take
// (OpenAI/Anthropic sk-…, AWS AKIA…, GitHub gh[pousr]_…) and never match a
// ${OBSIDIAN_API_KEY}-style placeholder, so a correctly-authored template can't
// false-positive.
const SECRET_LITERAL = /\b(sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,})\b/

describe('repo-wide gotong.template/v1 validation gate', () => {
  it('finds the shipped template manifests (sanity — the sweep is non-empty)', () => {
    // If this drops to zero the glob broke and the gate would pass vacuously.
    // The repo ships at least the flagship examples; pin a floor, not an exact
    // count, so adding an example doesn't force a test edit.
    expect(templateFiles.length).toBeGreaterThanOrEqual(11)
  })

  it.each(templateFiles.map((abs) => [relative(REPO_ROOT, abs), abs] as const))(
    '%s — parseTemplate + every workflow block parseWorkflow',
    (rel, abs) => {
      const text = readFileSync(abs, 'utf8')

      // Parses as a real manifest (throws ManifestError otherwise — named here).
      const t = parseTemplate(text)
      expect(t.version, `${rel} version`).toBe(1)
      expect(t.name.length, `${rel} name`).toBeGreaterThan(0)

      // Every embedded workflow block is itself valid gotong.workflow/v1 — the
      // SAME parser the host runs on import, so the opaque-blob round-trip holds
      // and a broken block fails loudly instead of importing a dead workflow.
      for (const w of t.workflows) {
        const def = parseWorkflow(w.yaml)
        expect(def.id, `${rel} workflow ${w.id}`).toBe(w.id)
      }

      // No literal secret pasted in — credentials ride as ${ENV} placeholders.
      expect(
        SECRET_LITERAL.test(text),
        `${rel} must not embed a literal secret — wire it as \${ENV}`,
      ).toBe(false)
    },
  )
})
