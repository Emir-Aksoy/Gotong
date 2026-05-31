/**
 * CSV / JSONL export helpers (Phase 17 — Sprint 4).
 *
 * Shared by the audit-log export (identity-routes) and the usage-ledger
 * export (usage-routes). Rows are already materialised arrays from the
 * store (capped by the query limit), so we format the whole batch to a
 * string and send it as an attachment — no streaming cursor needed at
 * this scale (the cap is 10k rows).
 *
 * CSV follows RFC 4180: a cell is quoted iff it contains a comma, quote,
 * CR or LF; embedded quotes are doubled. Object cells are JSON-encoded.
 */

import type { ServerResponse } from 'node:http'

export type ExportFormat = 'csv' | 'jsonl'

/** A typed CSV column: header label + a value extractor. */
export interface CsvColumn<T> {
  header: string
  value: (row: T) => unknown
}

/** Quote/escape a single CSV cell per RFC 4180. */
export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return ''
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** Format rows to a CSV string (header line + one line per row, LF). */
export function toCsv<T>(columns: ReadonlyArray<CsvColumn<T>>, rows: readonly T[]): string {
  const head = columns.map((c) => csvCell(c.header)).join(',')
  if (rows.length === 0) return `${head}\n`
  const body = rows
    .map((r) => columns.map((c) => csvCell(c.value(r))).join(','))
    .join('\n')
  return `${head}\n${body}\n`
}

/** Format rows to newline-delimited JSON (one object per line). */
export function toJsonl(rows: readonly unknown[]): string {
  if (rows.length === 0) return ''
  return rows.map((r) => JSON.stringify(r)).join('\n') + '\n'
}

/** Parse `?format=` — defaults to csv; only `jsonl` switches. */
export function parseExportFormat(raw: string | null): ExportFormat {
  return raw === 'jsonl' ? 'jsonl' : 'csv'
}

/**
 * Send a formatted export as a file attachment. `baseName` is the
 * filename stem; the extension is derived from the format.
 */
export function sendExport(
  res: ServerResponse,
  format: ExportFormat,
  baseName: string,
  content: string,
): void {
  const contentType =
    format === 'jsonl' ? 'application/x-ndjson' : 'text/csv'
  const ext = format === 'jsonl' ? 'jsonl' : 'csv'
  res.writeHead(200, {
    'content-type': `${contentType}; charset=utf-8`,
    'content-disposition': `attachment; filename="${baseName}.${ext}"`,
    'cache-control': 'no-store',
  })
  res.end(content)
}
