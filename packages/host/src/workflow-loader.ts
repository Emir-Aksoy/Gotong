/**
 * `workflow-loader` — scans a directory for `aipehub.workflow/v1` files,
 * parses each one, and registers a `WorkflowRunner` on the Hub for it.
 *
 * Triggered from the host's startup. Stays out of the Hub's hot path — if
 * a workflow file is malformed, we log a warning and skip it; the host
 * boot continues.
 *
 * Conventions:
 *   - Default directory: `<spaceRoot>/workflows/definitions/` (mirrors how
 *     `RunStore` puts run-state under `<spaceRoot>/workflows/runs/`).
 *   - File patterns: `*.yaml`, `*.yml`, `*.json`.
 *   - Hidden / dotfile names are skipped.
 *   - Duplicate workflow ids inside the same directory are rejected — the
 *     second one fails its register; the first one wins (alphabetical order).
 *
 * The loader returns a report so `main.ts` can print a one-line summary.
 */

import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

import type { Hub, ParticipantId } from '@aipehub/core'
import {
  RunStore,
  WorkflowRunner,
  parseWorkflow,
  workflowParticipantId,
  type WorkflowDefinition,
} from '@aipehub/workflow'
import { assertNoSelfTriggerCycle } from './workflow-guards.js'

export interface LoadedWorkflow {
  file: string
  participantId: ParticipantId
  definition: WorkflowDefinition
}

export interface LoadFailure {
  file: string
  error: string
}

export interface LoadReport {
  /** Directory that was scanned. */
  dir: string
  /** Successfully registered runners. */
  loaded: LoadedWorkflow[]
  /** Files that failed to parse or register. */
  failed: LoadFailure[]
}

export interface LoadWorkflowsOptions {
  /** Hub the runners attach to. Required. */
  hub: Hub
  /** Directory to scan for `*.yaml` / `*.json` workflow files. */
  dir: string
  /**
   * Space root for `RunStore` persistence (each runner writes its
   * `RunState` files under `<spaceRoot>/workflows/runs/`). Pass `null`
   * to disable on-disk run state (mostly for tests).
   */
  spaceRoot: string | null
}

/**
 * Walk `opts.dir`, parse every workflow file, and `hub.register` a runner
 * for each successful one. Logs progress to stdout/stderr; never throws —
 * a bad file becomes a `LoadFailure` row in the returned report.
 *
 * If `opts.dir` doesn't exist, the loader logs a single "no workflows
 * directory found" line and returns an empty report. Treating "no dir"
 * as a silent no-op keeps the default host boot quiet for users who
 * aren't using workflows yet.
 */
export async function loadWorkflows(
  opts: LoadWorkflowsOptions,
): Promise<LoadReport> {
  const report: LoadReport = {
    dir: opts.dir,
    loaded: [],
    failed: [],
  }

  if (!existsSync(opts.dir)) {
    return report
  }

  let entries: string[]
  try {
    entries = await readdir(opts.dir)
  } catch (err) {
    report.failed.push({
      file: opts.dir,
      error: `cannot read directory: ${err instanceof Error ? err.message : String(err)}`,
    })
    return report
  }

  const files = entries
    .filter((f) => !f.startsWith('.'))
    .filter(
      (f) => f.endsWith('.yaml') || f.endsWith('.yml') || f.endsWith('.json'),
    )
    .sort()

  const runStore = opts.spaceRoot ? new RunStore(opts.spaceRoot) : null

  for (const f of files) {
    const filePath = join(opts.dir, f)
    let body: string
    try {
      body = await readFile(filePath, 'utf8')
    } catch (err) {
      report.failed.push({
        file: filePath,
        error: `read failed: ${err instanceof Error ? err.message : String(err)}`,
      })
      continue
    }

    let def: WorkflowDefinition
    try {
      def = parseWorkflow(body)
      assertNoSelfTriggerCycle(def)
    } catch (err) {
      report.failed.push({
        file: filePath,
        error: `parse failed: ${err instanceof Error ? err.message : String(err)}`,
      })
      continue
    }

    const participantId = workflowParticipantId(def.id)
    // Hub.register throws on id collision — catch it and log so other
    // workflows can still load.
    try {
      const runner = new WorkflowRunner({
        definition: def,
        hub: opts.hub,
        runStore,
      })
      opts.hub.register(runner)
      report.loaded.push({ file: filePath, participantId, definition: def })
    } catch (err) {
      report.failed.push({
        file: filePath,
        error: `register failed: ${err instanceof Error ? err.message : String(err)}`,
      })
    }
  }

  return report
}

/**
 * Format the report for the host's startup log. One line if everything's
 * clean, otherwise multi-line with each failure named.
 */
export function formatLoadReport(report: LoadReport): string {
  if (report.loaded.length === 0 && report.failed.length === 0) {
    // Nothing to say — keep the host boot quiet.
    return ''
  }
  const lines: string[] = []
  if (report.loaded.length > 0) {
    lines.push(
      `[workflows] loaded ${report.loaded.length} from ${report.dir}:`,
    )
    for (const w of report.loaded) {
      lines.push(
        `  · ${w.participantId} (trigger: ${w.definition.trigger.capability}, ${w.definition.steps.length} steps)`,
      )
    }
  }
  if (report.failed.length > 0) {
    lines.push(
      `[workflows] ${report.failed.length} file(s) failed to load:`,
    )
    for (const f of report.failed) {
      lines.push(`  ✗ ${f.file}: ${f.error}`)
    }
  }
  return lines.join('\n')
}
