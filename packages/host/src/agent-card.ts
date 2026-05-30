/**
 * A2A Agent Card (R3 — A2A alignment).
 *
 * Builds the discovery document served at /.well-known/agent-card.json so
 * an A2A client (or a peering hub) can learn this hub's identity and HOW
 * to authenticate to it — the value R1's `PeerAuthScheme` unlocks. The
 * card follows the A2A Agent Card shape (a2a-protocol.org).
 *
 * Conservative by deliberate operator choice: the card advertises
 * identity + auth scheme but NO skills — it never enumerates the hub's
 * participants / managed-agent capabilities on a public, unauthenticated
 * endpoint. Skill advertisement is a future explicit opt-in.
 *
 * The `capabilities` flags are all `false` because the hub does not yet
 * serve the A2A message API (its federation transport is the AipeHub ws
 * mesh, not A2A JSON-RPC). They flip when A2A method serving lands — the
 * card is honest about what it serves today.
 */

/** OpenAPI-style security scheme — the subset A2A uses for HTTP bearer. */
export interface AgentCardSecurityScheme {
  type: 'http'
  scheme: 'bearer'
  description?: string
}

export interface AgentCardCapabilities {
  streaming: boolean
  pushNotifications: boolean
  stateTransitionHistory: boolean
}

/** The A2A Agent Card document (subset we emit). */
export interface AgentCard {
  name: string
  description: string
  url: string
  version: string
  protocolVersion: string
  provider?: { organization: string }
  capabilities: AgentCardCapabilities
  defaultInputModes: string[]
  defaultOutputModes: string[]
  /** Always `[]` in the conservative card (no public capability enumeration). */
  skills: unknown[]
  securitySchemes?: Record<string, AgentCardSecurityScheme>
  security?: Array<Record<string, string[]>>
}

export interface BuildAgentCardOpts {
  /** Public-facing name (the space name). */
  name: string
  /** This hub instance's software version. */
  version: string
  /** Request-derived base URL the card is served from (e.g. https://hub.example.com). */
  url: string
  /** Optional human description; a sensible default is used when absent/empty. */
  description?: string
  /**
   * Auth scheme kinds the hub accepts for inbound federation. 'bearer'
   * (the R1 default) maps to an A2A http/bearer security scheme. Empty =
   * no auth advertised (open hub / federation disabled).
   */
  authSchemes?: readonly string[]
}

/**
 * The A2A protocol version whose Agent Card FORMAT this document follows.
 * (Declares card-format compatibility, not that we serve every A2A
 * method — see the capabilities note above.)
 */
export const A2A_PROTOCOL_VERSION = '0.2.5'

export function buildAgentCard(opts: BuildAgentCardOpts): AgentCard {
  const description =
    opts.description && opts.description.trim().length > 0
      ? opts.description
      : `AipeHub federation hub "${opts.name}" — humans and agents on one Participant bus.`

  const card: AgentCard = {
    name: opts.name,
    description,
    url: opts.url,
    version: opts.version,
    protocolVersion: A2A_PROTOCOL_VERSION,
    provider: { organization: opts.name },
    // Honest-by-default: the hub does not yet serve the A2A message API,
    // so every capability flag is false. They flip when A2A method
    // serving is added (a separate milestone).
    capabilities: {
      streaming: false,
      pushNotifications: false,
      stateTransitionHistory: false,
    },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    // Conservative: never enumerate participant capabilities on a public
    // endpoint. Skill advertisement is a future explicit opt-in.
    skills: [],
  }

  // R1 — declare the bearer scheme so an A2A peer knows it must present a
  // (pre-shared peer) bearer token to federate with us.
  if ((opts.authSchemes ?? []).includes('bearer')) {
    card.securitySchemes = {
      bearer: {
        type: 'http',
        scheme: 'bearer',
        description:
          'Pre-shared peer token presented as a bearer credential on the hub-mesh handshake.',
      },
    }
    card.security = [{ bearer: [] }]
  }

  return card
}
