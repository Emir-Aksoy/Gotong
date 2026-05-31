/**
 * `@aipehub/a2a` — Agent2Agent interop primitives.
 *
 * Public surface:
 *   - blocking `message/send` wire types (A2A 0.2.5 subset) + builders
 *   - `a2aSend` — an injectable client that POSTs text and reads the reply
 *
 * The inbound A2A server (host) and the outbound `A2aRemoteParticipant` (also
 * this package, added in C-M4) both consume these so there's one vocabulary.
 */

export * from './types.js'
export * from './client.js'
