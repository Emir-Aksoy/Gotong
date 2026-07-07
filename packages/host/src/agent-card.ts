/**
 * A2A Agent Card (R3 — A2A alignment; NET-M4 — v1.0 shape + owner curation).
 *
 * Builds the discovery document served at /.well-known/agent-card.json so
 * an A2A client (or a peering hub) can learn this hub's identity and HOW
 * to authenticate to it — the value R1's `PeerAuthScheme` unlocks.
 *
 * ── Card format: A2A v1.0, with 0.2.x transition fields kept ────────────────
 * A2A v1.0 (early 2026) moved the endpoint declaration into a REQUIRED
 * `supportedInterfaces[]` (first entry = preferred; url + protocolBinding +
 * per-interface protocolVersion) and renamed `security` →
 * `securityRequirements`; top-level `url` / `protocolVersion` are gone from
 * the v1.0 schema. This is a PUBLIC ecosystem document mid-transition, so we
 * deliberately DOUBLE-WRITE: v1.0 readers use `supportedInterfaces` /
 * `securityRequirements`, 0.2.x readers keep reading `url` / `protocolVersion`
 * / `security`. Unknown extra fields are harmless JSON to both. The
 * per-interface protocolVersion says '0.2' — the METHOD surface we actually
 * serve is the 0.2.x `message/send` + `tasks/get` subset; a v1.0 card format
 * does not claim the v1.0 method surface (honesty over optics). `provider`
 * was dropped: v1.0 requires url+organization together and a hub has no
 * organization URL to give — half a provider violates the schema.
 *
 * ── Skills: owner curation file > env auto-enumeration > none ───────────────
 * NET-M4 adds a file-first curation seam (`<space>/agent-card.json`): the
 * owner hand-writes displayName / description / skills in the A2A skill
 * shape (id = the dispatch capability an inbound `message/send` targets),
 * and the card advertises EXACTLY that list — never a byte more. When the
 * file is absent, legacy behavior is unchanged: `GOTONG_A2A_ADVERTISE_SKILLS`
 * (off by default) auto-enumerates local capabilities, else no skills. A
 * corrupt curation file warns (throttled) and falls back whole — never half
 * a card. v1.0 made AgentSkill's description/tags REQUIRED, so
 * `buildAgentCard` normalizes every skill (description defaults to the id,
 * tags to []).
 *
 * The `capabilities` flags stay all-false on purpose: the hub serves only the
 * blocking `message/send` A2A method (C-M3), not streaming /
 * push-notifications. False means "we do not stream" — true even with the
 * message endpoint live.
 */

import { readFileSync } from 'node:fs'

import { attachSignature, buildJwks, type AgentCardSigner, type AgentCardSignatureValue } from './agent-card-signing.js'

/** OpenAPI-style security scheme — the subset A2A uses for HTTP bearer. */
export interface AgentCardSecurityScheme {
  type: 'http'
  scheme: 'bearer'
  description?: string
}

export interface AgentCardCapabilities {
  streaming: boolean
  pushNotifications: boolean
  /** 0.2.x transition field — gone from the v1.0 schema, harmless to keep. */
  stateTransitionHistory: boolean
}

/**
 * A2A `AgentInterface` (v1.0, REQUIRED on the card) — one way to reach the
 * agent. First entry in `supportedInterfaces` is the preferred one.
 */
export interface AgentCardInterface {
  /** Absolute URL of the endpoint (request-derived base + /a2a). */
  url: string
  /** Officially 'JSONRPC' | 'GRPC' | 'HTTP+JSON'; ours is JSON-RPC. */
  protocolBinding: string
  /** The A2A protocol version THIS interface speaks (method surface). */
  protocolVersion: string
}

/**
 * A2A `AgentSkill` — the input subset callers hand us. `id` doubles as the
 * dispatch capability an inbound `message/send` targets (see the A2A server),
 * so it is the public, stable handle for a thing this hub can do. v1.0 made
 * description/tags REQUIRED on the wire; `buildAgentCard` normalizes.
 */
export interface AgentCardSkill {
  id: string
  name: string
  description?: string
  tags?: string[]
}

/** The wire shape after normalization — v1.0 requires all four. */
export interface AgentCardSkillWire {
  id: string
  name: string
  description: string
  tags: string[]
}

/**
 * A2A `AgentCardSignature` (v1.0 §8.4) — one detached-payload JWS over the
 * card. Aliased to the shared `@gotong/a2a` wire type (re-exported via
 * `agent-card-signing.ts`) so the host card and the CLI `peer-card` verifier
 * speak the exact same signature shape. See `agent-card-signing.ts`.
 */
export type AgentCardSignature = AgentCardSignatureValue

/** The A2A Agent Card document (v1.0 shape + 0.2.x transition fields). */
export interface AgentCard {
  name: string
  description: string
  /** 0.2.x transition field (v1.0 readers use supportedInterfaces[0].url). */
  url: string
  version: string
  /** 0.2.x transition field (v1.0 moved this per-interface). */
  protocolVersion: string
  /** v1.0 REQUIRED — first entry is the preferred interface. */
  supportedInterfaces: AgentCardInterface[]
  capabilities: AgentCardCapabilities
  defaultInputModes: string[]
  defaultOutputModes: string[]
  /**
   * `[]` unless the owner curated a list or the operator opted into
   * auto-enumeration (see `BuildAgentCardOpts.skills`).
   */
  skills: AgentCardSkillWire[]
  securitySchemes?: Record<string, AgentCardSecurityScheme>
  /** 0.2.x transition name; v1.0 readers use securityRequirements. */
  security?: Array<Record<string, string[]>>
  /** v1.0 name for the same requirement list (double-written). */
  securityRequirements?: Array<Record<string, string[]>>
  /**
   * STD-M1 — JWS signatures over this card (§8.4). Present only when the
   * operator opted into signing (`GOTONG_A2A_SIGN_CARD`); excluded from the
   * canonical payload it signs. See `agent-card-signing.ts`.
   */
  signatures?: AgentCardSignature[]
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
 * 0.2.x transition value for the card's legacy top-level `protocolVersion`
 * (v1.0 removed that field; kept for 0.2.x readers).
 */
export const A2A_PROTOCOL_VERSION = '0.2.5'
/**
 * What our ONE interface honestly speaks: the 0.2.x blocking `message/send`
 * + `tasks/get` subset. Bumps only when the METHOD surface does.
 */
export const A2A_INTERFACE_PROTOCOL_VERSION = '0.2'

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
    // v1.0 REQUIRED — the single JSON-RPC endpoint the web layer serves at
    // /a2a (see server.ts). First (only) entry = preferred.
    supportedInterfaces: [
      {
        url: `${opts.url}/a2a`,
        protocolBinding: 'JSONRPC',
        protocolVersion: A2A_INTERFACE_PROTOCOL_VERSION,
      },
    ],
    // Honest-by-default: we serve only the blocking message/send method,
    // so streaming/push stay false. They flip when the method surface grows.
    capabilities: {
      streaming: false,
      pushNotifications: false,
      stateTransitionHistory: false,
    },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    // Conservative: `[]` unless the owner curated a list or explicitly opted
    // into enumeration — this endpoint is public. v1.0 requires
    // description/tags on every skill, so normalize here (one seam covers
    // both the curation and the env-enumeration path).
    skills: (opts.skills ?? []).map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description && s.description.trim() ? s.description : s.id,
      tags: s.tags ? [...s.tags] : [],
    })),
  }

  // R1 — declare the bearer scheme so an A2A peer knows it must present a
  // (pre-shared peer) bearer token to federate with us. Requirement list is
  // double-written under both the 0.2.x and the v1.0 field name.
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
    card.securityRequirements = [{ bearer: [] }]
  }

  return card
}

// ─── NET-M4 — owner curation file (`<space>/agent-card.json`) ────────────────

/** What the owner may curate. Skills use the A2A shape (id = capability). */
export interface AgentCardCuration {
  displayName?: string
  description?: string
  skills: AgentCardSkill[]
}

/** Throttle repeated corrupt-file warnings (public endpoint, scanners). */
const CURATION_WARN_INTERVAL_MS = 60_000
const lastCurationWarnAt = new Map<string, number>()

function warnThrottled(
  log: { warn: (msg: string, meta?: Record<string, unknown>) => void },
  file: string,
  msg: string,
  meta?: Record<string, unknown>,
): void {
  const now = Date.now()
  const last = lastCurationWarnAt.get(file) ?? 0
  if (now - last < CURATION_WARN_INTERVAL_MS) return
  lastCurationWarnAt.set(file, now)
  log.warn(msg, meta)
}

/**
 * Read + validate the owner's curation file. Absent → null, silently (the
 * legacy env path applies). Corrupt / invalid → warn (throttled) + null —
 * the WHOLE file is rejected, never half a card: a curated card either says
 * exactly what the owner wrote or nothing new at all.
 *
 * Sync on purpose: the card route's surface is `json(baseUrl): string` and
 * the file is tiny; reading per request keeps owner edits live without a
 * restart or a cache-invalidation story.
 */
export function readAgentCardCurationSync(
  file: string,
  log: { warn: (msg: string, meta?: Record<string, unknown>) => void },
): AgentCardCuration | null {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') warnThrottled(log, file, 'agent-card curation unreadable', { file, code })
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    warnThrottled(log, file, 'agent-card curation is not valid JSON — ignoring the whole file', { file })
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    warnThrottled(log, file, 'agent-card curation must be a JSON object — ignoring', { file })
    return null
  }
  const obj = parsed as Record<string, unknown>
  const rawSkills = obj.skills
  if (rawSkills !== undefined && !Array.isArray(rawSkills)) {
    warnThrottled(log, file, 'agent-card curation `skills` must be an array — ignoring the whole file', { file })
    return null
  }
  const skills: AgentCardSkill[] = []
  const seen = new Set<string>()
  for (const entry of rawSkills ?? []) {
    const s = entry as Record<string, unknown> | null
    const id = s && typeof s.id === 'string' ? s.id.trim() : ''
    if (!id) {
      warnThrottled(log, file, 'agent-card curation: a skill is missing a string `id` — ignoring the whole file', { file })
      return null
    }
    if (seen.has(id)) {
      warnThrottled(log, file, 'agent-card curation: duplicate skill id — keeping the first', { file, id })
      continue
    }
    seen.add(id)
    skills.push({
      id,
      name: typeof s!.name === 'string' && s!.name.trim() ? (s!.name as string) : id,
      ...(typeof s!.description === 'string' && (s!.description as string).trim()
        ? { description: s!.description as string }
        : {}),
      ...(Array.isArray(s!.tags) ? { tags: (s!.tags as unknown[]).filter((t): t is string => typeof t === 'string') } : {}),
    })
  }
  return {
    ...(typeof obj.displayName === 'string' && obj.displayName.trim() ? { displayName: obj.displayName } : {}),
    ...(typeof obj.description === 'string' && obj.description.trim() ? { description: obj.description } : {}),
    skills,
  }
}

// ─── Card surface factory (host↔web duck) ────────────────────────────────────

/**
 * Everything the `/.well-known/agent-card.json` (+ `/.well-known/jwks.json`)
 * renderers need, injected by the host so this module stays free of the
 * manifest / hub / registry types. Extracted from main.ts so the assembly
 * layer stays within its line budget (factory precedent).
 */
export interface AgentCardSurfaceDeps {
  /** Owner curation file path (`<space>/agent-card.json`). Read per request. */
  curationFile: string
  /** Fallback display name when curation gives none. */
  nameFallback: string
  /** This hub's software version. */
  version: string
  /** Optional description fallback when curation gives none. */
  description?: string
  /** Whether inbound peer auth is on → advertise the bearer scheme. */
  hasPeerRegistry: boolean
  /** `GOTONG_A2A_ADVERTISE_SKILLS` — enumerate local caps when no curation. */
  advertiseSkills: boolean
  /** Enumerate local capabilities as skills (host wraps its manifest). */
  enumerateSkills: () => AgentCardSkill[]
  /** STD-M1 — present only when `GOTONG_A2A_SIGN_CARD` is on. */
  signer: AgentCardSigner | null
  log: { warn: (msg: string, meta?: Record<string, unknown>) => void }
}

/**
 * Build the `{ json, jwks }` surface the web layer serves. `json` is
 * request-derived (the card's `url` and any signature `jku` reflect how the
 * client reached us); `jwks` is null unless signing is on.
 */
export function createAgentCardSurface(deps: AgentCardSurfaceDeps): {
  json: (baseUrl: string) => string
  jwks: () => string | null
} {
  return {
    json: (baseUrl: string): string => {
      const curation = readAgentCardCurationSync(deps.curationFile, deps.log)
      const skills = curation ? curation.skills : deps.advertiseSkills ? deps.enumerateSkills() : []
      let card = buildAgentCard({
        name: curation?.displayName ?? deps.nameFallback,
        version: deps.version,
        url: baseUrl,
        description: curation?.description ?? deps.description,
        authSchemes: deps.hasPeerRegistry ? ['bearer'] : [],
        ...(skills.length > 0 ? { skills } : {}),
      })
      if (deps.signer) {
        card = attachSignature(card, deps.signer, { jku: `${baseUrl}/.well-known/jwks.json` })
      }
      return JSON.stringify(card, null, 2)
    },
    jwks: (): string | null => (deps.signer ? buildJwks(deps.signer) : null),
  }
}
