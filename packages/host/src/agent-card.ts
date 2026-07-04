/**
 * A2A Agent Card (R3 — A2A alignment).
 *
 * Builds the discovery document served at /.well-known/agent-card.json so
 * an A2A client (or a peering hub) can learn this hub's identity and HOW
 * to authenticate to it — the value R1's `PeerAuthScheme` unlocks. The
 * card follows the A2A Agent Card shape (a2a-protocol.org).
 *
 * Conservative by default: the card advertises identity + auth scheme and
 * NO skills unless the operator explicitly opts in (C-M1 — host gates skill
 * advertisement behind `GOTONG_A2A_ADVERTISE_SKILLS`, off by default, because
 * this endpoint is public + unauthenticated). It never auto-enumerates the
 * hub's participants / managed-agent capabilities.
 *
 * The `capabilities` flags are all `false` on purpose: the hub serves only
 * the blocking `message/send` A2A method (C-M3), not streaming /
 * push-notifications / state-transition history. They stay honest about
 * exactly what is served — false here means "we do not stream", and that is
 * true even with the message endpoint live.
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

/**
 * A2A `AgentSkill` (0.2.5) — the minimal subset we emit. `id` doubles as the
 * dispatch capability an inbound `message/send` targets (see the A2A server),
 * so it is the public, stable handle for a thing this hub can do.
 */
export interface AgentCardSkill {
  id: string
  name: string
  description?: string
  tags?: string[]
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
  /**
   * `[]` unless the operator explicitly opts into skill advertisement (see
   * `BuildAgentCardOpts.skills`). Never auto-enumerated.
   */
  skills: AgentCardSkill[]
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
  /**
   * C-M1 — skills to advertise. DEFAULTS TO `[]`: the card never enumerates
   * the hub's capabilities unless the operator explicitly passes them (an
   * opt-in, because this endpoint is public + unauthenticated). The host
   * derives these from its local capability manifest only when
   * `GOTONG_A2A_ADVERTISE_SKILLS` is on.
   */
  skills?: readonly AgentCardSkill[]
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
      : `Gotong federation hub "${opts.name}" — humans and agents on one Participant bus.`

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
    // Conservative: `[]` unless the caller explicitly opts in. The host gates
    // that behind GOTONG_A2A_ADVERTISE_SKILLS — this endpoint is public.
    skills: opts.skills ? [...opts.skills] : [],
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
