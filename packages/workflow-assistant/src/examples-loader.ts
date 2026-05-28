/**
 * Few-shot example loader for `WorkflowAssistantAgent`.
 *
 * Phase 13 follow-up — the M3 launch shipped an empty `examples` array.
 * Without examples, the LLM relies purely on the schema doc embedded in
 * the system prompt; it works, but real-world prompts (M5 demo proved)
 * still take 40+ seconds and occasionally invent capabilities. With 2-3
 * representative YAMLs in the system prompt, the model has anchors and
 * happy-path latency / accuracy improve noticeably.
 *
 * Two loading paths:
 *
 *   1. `loadBundledExamples()` — sync read of the YAMLs that ship inside
 *      this package's `templates/` directory. Host wires this in by
 *      default. Self-contained: works in single-binary builds, no
 *      external paths.
 *
 *   2. `loadExamplesFromDir(dir)` — sync read of an arbitrary directory.
 *      Useful for operators who want to ship their own few-shot library
 *      (their own workflow conventions, organization-specific
 *      capabilities, etc.) without forking the package.
 *
 * Both paths parse each YAML through `parseWorkflow` to extract the
 * canonical `workflow.description` as the few-shot prompt "User:" line.
 * Files that fail to parse are skipped with a console warning (we do
 * NOT throw — startup must stay robust even if someone drops a broken
 * YAML in the templates dir).
 *
 * Token-cost note: each example is ~30-100 lines of YAML and contributes
 * roughly 300-1500 input tokens per assist call. Bundled set keeps it
 * around 1-2k tokens total — a 2-3× increase from the schema-doc-only
 * baseline (~600 tokens), which is well worth the precision boost.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseWorkflow } from '@aipehub/workflow'

import type { WorkflowExample } from './assistant.js'

// ---------------------------------------------------------------------------
// Bundled templates path
// ---------------------------------------------------------------------------

// `import.meta.url` resolves to the .js file's URL at runtime. From
// dist/examples-loader.js the templates live at ../templates/, identical
// to the src layout. We resolve both candidates and pick whichever
// exists — `dist/` after `pnpm build`, `src/` during ts-node / vitest /
// tsx runs. This keeps the loader working in every harness without
// branching on environment variables.
const HERE = dirname(fileURLToPath(import.meta.url))
const TEMPLATE_CANDIDATES = [
  resolve(HERE, '..', 'templates'),    // dist/ → ../templates/
  resolve(HERE, '..', '..', 'templates'), // src/ → ../../templates/
]

function findBundledTemplatesDir(): string | null {
  for (const candidate of TEMPLATE_CANDIDATES) {
    try {
      const s = statSync(candidate)
      if (s.isDirectory()) return candidate
    } catch {
      // ENOENT — try the next candidate
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load the few-shot examples that ship with this package. Pure sync,
 * idempotent — read 2-3 small YAML files (~6 KB total) at startup.
 *
 * Returns `[]` when the bundled templates dir can't be found (which
 * shouldn't happen in any supported runtime — packed dist, ts-node,
 * vitest, tsx — but we'd rather degrade gracefully than crash startup).
 */
export function loadBundledExamples(): WorkflowExample[] {
  const dir = findBundledTemplatesDir()
  if (!dir) return []
  return loadExamplesFromDir(dir)
}

/**
 * Load `*.yaml` / `*.yml` files from `dir` as few-shot examples.
 * Each file is parsed via `parseWorkflow`; the `workflow.description`
 * (or `workflow.name`, or the file basename as last resort) becomes the
 * "User:" prompt for the few-shot pair.
 *
 * Files that fail to parse are SKIPPED — a `console.warn` is emitted
 * but the loader does not throw, so a single bad file can't take down
 * host startup.
 *
 * Sort order: case-insensitive filename. Stable across runs so the
 * system prompt is deterministic (cache-friendly for LLM providers
 * that hash the system prompt).
 */
export function loadExamplesFromDir(dir: string): WorkflowExample[] {
  let entries: string[]
  try {
    entries = readdirSync(dir).sort((a, b) => a.localeCompare(b))
  } catch (err) {
    console.warn(
      `[workflow-assistant] examples loader: cannot read dir '${dir}': ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
    return []
  }
  const out: WorkflowExample[] = []
  for (const name of entries) {
    if (!name.endsWith('.yaml') && !name.endsWith('.yml')) continue
    const full = join(dir, name)
    let yaml: string
    try {
      yaml = readFileSync(full, 'utf8')
    } catch (err) {
      console.warn(
        `[workflow-assistant] examples loader: cannot read '${full}': ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
      continue
    }
    let description: string
    try {
      const wf = parseWorkflow(yaml)
      description = wf.description ?? wf.name ?? name.replace(/\.ya?ml$/i, '')
    } catch (err) {
      console.warn(
        `[workflow-assistant] examples loader: '${name}' failed parseWorkflow, skipping: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
      continue
    }
    out.push({ description, yaml })
  }
  return out
}
