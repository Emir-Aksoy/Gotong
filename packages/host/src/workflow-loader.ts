/**
 * `workflow-loader` — scans a directory for `aipehub.workflow/v1` files and
 * parses each one into a `WorkflowDefinition`. It does NOT register runners:
 * since Phase 15 the `WorkflowVersioning` service is the single authority that
 * adopts a definition (allocating its revision + lifecycle record) and registers
 * the resolver-backed runner. The loader's only job is "turn the files on disk
 * into parsed definitions, robustly".
 *
 * Triggered from the host's startup. Stays out of the Hub's hot path — if a
 * workflow file is malformed, we log a warning and skip it; the host boot
 * continues.
 *
 * Conventions:
 *   - Default directory: `<spaceRoot>/workflows/definitions/` (mirrors how
 *     `RunStore` puts run-state under `<spaceRoot>/workflows/runs/`).
 *   - File patterns: `*.yaml`, `*.yml`, `*.json`.
 *   - Hidden / dotfile names are skipped.
 *   - Duplicate workflow ids inside the same directory are rejected — the
 *     second one fails (alphabetical order; the first one wins).
 *
 * The loader returns a report so `main.ts` can print a one-line summary and the
 * controller can adopt each parsed definition through the versioning service.
 */

import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

import type { ParticipantId } from '@aipehub/core'
import {
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
  /** Successfully parsed definitions. */
  loaded: LoadedWorkflow[]
  /** Files that failed to parse (or collided on id). */
  failed: LoadFailure[]
}

export interface LoadWorkflowsOptions {
  /** Directory to scan for `*.yaml` / `*.json` workflow files. */
  dir: string
}

/**
 * Walk `opts.dir` and parse every workflow file. Logs nothing itself; never
 * throws — a bad file becomes a `LoadFailure` row in the returned report.
 *
 * If `opts.dir` doesn't exist, the loader returns an empty report. Treating "no
 * dir" as a silent no-op keeps the default host boot quiet for users who aren't
 * using workflows yet.
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

  // Dedupe ids within the directory ourselves — the loader no longer registers,
  // so it can't lean on `hub.register` throwing on a collision.
  const seenIds = new Set<string>()

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

    if (seenIds.has(def.id)) {
      report.failed.push({
        file: filePath,
        error: `duplicate workflow id '${def.id}' — already loaded from an earlier file`,
      })
      continue
    }
    seenIds.add(def.id)
    report.loaded.push({
      file: filePath,
      participantId: workflowParticipantId(def.id),
      definition: def,
    })
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
