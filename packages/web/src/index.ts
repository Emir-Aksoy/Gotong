export { serveWeb } from './server.js'
export type { WebServerOptions, WebServerHandle, UploadSurface } from './server.js'
// Route B P1-M4e — the host implements this duck-typed surface to wire SSO.
export type { OidcLoginSurface } from './server.js'

// Phase 17 (Sprint 4) — export-format primitives + the usage-ledger column
// spec, surfaced so embedders (and the host's E2E acceptance gate) can format
// real ledger rows through the SAME code the admin export routes use, instead
// of re-implementing CSV/JSONL serialisation.
export { toCsv, toJsonl, parseExportFormat } from './export-format.js'
export type { CsvColumn, ExportFormat } from './export-format.js'
export { LEDGER_COLUMNS } from './usage-routes.js'
export type {
  UsageLedgerEntryDTO,
  UsageLedgerAggregateRowDTO,
  UsageLedgerGroupBy,
} from './usage-routes.js'
