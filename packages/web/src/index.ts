export { serveWeb } from './server.js'
export type { WebServerOptions, WebServerHandle, UploadSurface } from './server.js'
// Route B P1-M4e/M4f — the host implements these duck-typed surfaces to wire
// SSO login + the admin IdP-provider registry.
export type { OidcLoginSurface } from './server.js'
export type { OidcProviderAdminSurface, OidcProviderView } from './server.js'
// Route B P1-M5e — public SAML SP login routes (host injects the surface).
export type { SamlLoginSurface } from './server.js'
// Route B P1-M5f — admin SAML provider registry CRUD (host injects the surface).
export type { SamlProviderAdminSurface, SamlProviderView } from './server.js'
// Route B P1-M11c — admin outbound A2A agent registry CRUD (host injects the surface).
export type { A2aAgentAdminSurface, A2aAgentView } from './server.js'

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
