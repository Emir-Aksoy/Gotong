// Library exports for programmatic use. Most users want the bin entry
// (`aipehub-mcp`) instead of importing these.
export { HubClient, HubClientError } from './hub-client.js'
export type { HubClientOptions, HubState, DispatchBody, DispatchResult, Leaderboard } from './hub-client.js'
export { registerTools } from './tools.js'
