/**
 * Public type surface for `@aipehub/im-adapter`.
 *
 * The contract is deliberately tiny — concrete bridges
 * (@aipehub/im-telegram, @aipehub/im-matrix, …) implement `ImBridge`
 * and depend on a host-supplied `ImBindingResolver`. The bridge SDK
 * itself has zero runtime deps; the only thing it ships is:
 *
 *   - shape definitions (this file)
 *   - a pure-function command parser (`./command-parser.ts`)
 *
 * Everything else — wallclock, network, persistence — is the concrete
 * bridge's responsibility. Keeping the SDK pure means a bridge can be
 * unit-tested with a fake resolver and a fake message source, no IM
 * accounts required.
 */

// ---------------------------------------------------------------------------
// Wire shapes — what bridges deliver from / send to the IM platform.
// ---------------------------------------------------------------------------

/**
 * One IM-side identity. `platform` is a stable lowercase string
 * picked by the concrete bridge — recommended values:
 *
 *   'telegram' | 'matrix' | 'lark' | 'discord' | 'slack' | 'qq'
 *
 * `platformUserId` is the platform's canonical user id (Telegram's
 * numeric `from.id`, Matrix's `@user:server` mxid, Slack's `U…`, …).
 * Bridges MUST use the canonical form, not the human handle which can
 * change.
 *
 * `displayName` is best-effort: nullable, may be stale, useful only
 * for admin-UI display ("Telegram: Alice").
 */
export interface ImUser {
  platform: string
  platformUserId: string
  displayName?: string | null
}

/**
 * An IM-side attachment that came in with the message. The bridge
 * normalises into one of these three shapes:
 *
 *   - `kind: 'image' | 'audio'` — visual / audio content that the
 *     downstream LlmAgent might want to pass as a multimodal block
 *     (see Phase 9 `LlmImageSource` / `LlmAudioSource`).
 *   - `kind: 'file'` — anything else (PDF, doc, transcript, …) —
 *     stored as an artifact, referenced by `artifact_ref` block.
 *
 * One of `url` or `bytes` MUST be set:
 *
 *   - `url`: the bridge has a CDN-style permalink (Slack, Telegram
 *     file_id resolved via getFile, …). Cheaper — adapter doesn't
 *     hold bytes in memory.
 *   - `bytes`: the bridge fetched the payload itself. Required when
 *     the platform's URL is short-lived or auth-gated.
 *
 * `mime` is best-effort; `null` means "let the consumer sniff."
 * `filename` is best-effort, useful for display.
 */
export interface ImAttachment {
  kind: 'image' | 'audio' | 'file'
  url?: string
  bytes?: Buffer | Uint8Array
  mime?: string | null
  filename?: string | null
}

/**
 * One incoming message handed to the bridge from the IM platform.
 *
 * `chatId` distinguishes group chats from DMs — bridges that want to
 * reply in-thread vs in-DM must consult it. The SDK doesn't interpret
 * it; concrete bridges define their own semantics.
 *
 * `messageId` and `ts` are useful for de-dup / reordering / "reply to
 * the original message" rendering. Both may be undefined if the
 * platform doesn't surface them.
 */
export interface ImMessage {
  from: ImUser
  /** Free-form body. May be empty when `attachments` carries the payload. */
  text: string
  attachments?: ImAttachment[]
  /** Platform-side message id. Useful for "reply to" / de-dup. */
  messageId?: string
  /** Platform-side chat / room id. */
  chatId?: string
  /** Unix ms when the platform claims the message was sent. */
  ts?: number
}

// ---------------------------------------------------------------------------
// Commands — what `parseImCommand(text)` returns. See `./command-parser.ts`.
// ---------------------------------------------------------------------------

/**
 * One parsed command. `kind: 'free'` is the catch-all for plain text
 * the user sent without a leading `/`; bridges typically route it
 * into a Hub dispatch against the user's default agent / workflow.
 */
export type ImCommand =
  | { kind: 'help' }
  | { kind: 'bind'; code: string }
  | { kind: 'unbind' }
  | { kind: 'agents' }
  | { kind: 'workflow'; name: string; args: string }
  | { kind: 'free'; text: string }

// ---------------------------------------------------------------------------
// Host-supplied glue — what the IM bridge calls back into.
// ---------------------------------------------------------------------------

/**
 * Resolves IM identities to AipeHub user ids and consumes binding
 * codes. Concrete impl typically wraps `@aipehub/identity`'s
 * `IdentityStore` (sync) and lifts it into Promise form so bridges
 * can `await` uniformly — including future remote / federated
 * resolvers.
 *
 * Failure semantics on `claim`:
 *   - Returns `{ ok: true, userId }` on success.
 *   - Returns `{ ok: false, reason: 'invalid' | 'expired' }` on
 *     known business-logic failure. The bridge maps the reason to a
 *     user-facing IM message (concrete copy lives in the bridge,
 *     not here, so localisations can vary per platform).
 *   - Throws on infrastructure failure (db down, etc.) so the bridge
 *     can surface a generic "try again later" without conflating
 *     with user-correctable issues.
 *
 * This shape — discriminated result, not throw — is deliberate. IM
 * users typing wrong codes is the COMMON path; thrown exceptions on
 * the hot path cost stack-trace cycles and make backpressure on a
 * Telegram bot's update loop fragile.
 */
export interface ImBindingResolver {
  /**
   * Hot-path lookup for routing incoming messages. Returns the
   * AipeHub user id bound to this IM identity, or `null` when the
   * user hasn't bound yet (bridges reply with the "send `/bind
   * <code>`" prompt).
   */
  resolveUserId(platform: string, platformUserId: string): Promise<string | null>

  /** Consume a binding code from an IM `/bind <code>` invocation. */
  claim(input: {
    code: string
    platform: string
    platformUserId: string
    displayName?: string | null
  }): Promise<ClaimResult>
}

export type ClaimResult =
  | { ok: true; userId: string }
  | { ok: false; reason: 'invalid' | 'expired' }

// ---------------------------------------------------------------------------
// Bridge — concrete platforms implement this.
// ---------------------------------------------------------------------------

/**
 * Per-bridge lifecycle and outbound API. The concrete bridge:
 *
 *   1. Knows its `platform` string (stable lowercase, e.g.
 *      'telegram'). Used to scope IM bindings + audit log.
 *   2. Holds whatever it needs to talk to the IM platform (HTTP
 *      polling, websocket gateway, webhook handler, …).
 *   3. Delivers each inbound message via `onMessage`. The host wires
 *      a router that parses the command and acts on it.
 *   4. Exposes `sendMessage` for the host to push replies back into
 *      the same IM client.
 *
 * Why no in-tree router or dispatcher: the bridge SDK stays pure-types
 * so this package has zero side-effecty code paths. The router is a
 * host concern (it knows about the Hub, the BindingResolver, the
 * default agent / workflow set). Future `@aipehub/im-host` may
 * publish a default router; for now each concrete bridge wires its
 * own.
 *
 * Concrete bridges MUST be idempotent on `start` / `stop` — the host
 * may re-issue both during hot-reload.
 */
export interface ImBridge {
  /** Stable lowercase platform id, e.g. 'telegram'. */
  readonly platform: string

  /** Begin receiving messages (polling, gateway connect, webhook bind, …). */
  start(): Promise<void>

  /** Stop and release resources. Must be safe to call when not started. */
  stop(): Promise<void>

  /**
   * Send a message back to the IM platform. `to` MUST be the same
   * `ImUser` shape as `ImMessage.from` (bridges round-trip the
   * platformUserId; the displayName is informational only).
   *
   * `chatId` lets a bridge that distinguishes group from DM reply
   * in the correct surface — passing the inbound `ImMessage.chatId`
   * is the typical wiring.
   */
  sendMessage(
    to: ImUser,
    text: string,
    options?: { attachments?: ImAttachment[]; chatId?: string },
  ): Promise<void>

  /**
   * Subscribe to inbound messages. Bridges MUST guarantee delivery
   * is single-threaded per `ImUser` (i.e. no concurrent calls for the
   * same user). Across users, concurrency is allowed.
   *
   * Returns an unsubscribe function. Replacing the listener is
   * undefined behaviour — subscribe at most once.
   */
  onMessage(listener: (msg: ImMessage) => void | Promise<void>): () => void
}
