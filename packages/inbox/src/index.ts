/**
 * `@aipehub/inbox` — member task inbox.
 *
 * Public surface:
 *   - protocol constants (capability, broker id, never-resume sentinel)
 *   - inbox types + the `InboxStore` contract
 *   - `FileInboxStore` (default file-first backend)
 *
 * `HumanInboxParticipant` (the broker) is added in M2.
 */

export * from './constants.js'
export * from './types.js'
export { FileInboxStore } from './file-inbox-store.js'
