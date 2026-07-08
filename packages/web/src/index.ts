export { serveWeb } from './server.js'
export type { WebServerOptions, WebServerHandle, UploadSurface } from './server.js'
// WIZ-M4 — the host's wizard catalog consumes the SAME built-in preset lists the
// admin UI shows: gallery template cards (per-agent capabilities included) + the
// curated MCP connector directory. Exported so main.ts can feed them into
// `collectCatalogInputs` without re-parsing manifests.
export { buildTemplateCatalog } from './template-routes.js'
export type { TemplateCatalogEntry } from './template-routes.js'
export { BUILTIN_MCP_CONNECTORS } from './builtin-mcp-connectors.js'
export type { BuiltinMcpConnector } from './builtin-mcp-connectors.js'
export type { WorkflowWizardSurface } from './wizard-routes.js'
// Route B P1-M4e/M4f — the host implements these duck-typed surfaces to wire
// SSO login + the admin IdP-provider registry.
export type { OidcLoginSurface } from './server.js'
export type { OidcProviderAdminSurface, OidcProviderView } from './server.js'
// C-M2-M5a — outbound OAuth connector CRUD (host injects the surface).
export type { OAuthConnectorAdminSurface, OAuthConnectorView } from './server.js'
// C-M2-M5b — built-in outbound OAuth connector directory (pure web constant).
export { BUILTIN_OAUTH_CONNECTORS, OAUTH_CONNECTOR_CATEGORIES, OAUTH_CONNECTOR_ADMIN_FIELDS } from './builtin-oauth-connectors.js'
export type { BuiltinOAuthConnector, OAuthConnectorCategory } from './builtin-oauth-connectors.js'
// Route B P1-M5e — public SAML SP login routes (host injects the surface).
export type { SamlLoginSurface } from './server.js'
// Route B P1-M5f — admin SAML provider registry CRUD (host injects the surface).
export type { SamlProviderAdminSurface, SamlProviderView } from './server.js'
// Route B P1-M11c — admin outbound A2A agent registry CRUD (host injects the surface).
export type { A2aAgentAdminSurface, A2aAgentView } from './server.js'
export type { AcpAgentAdminSurface, AcpAgentView } from './server.js'

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
