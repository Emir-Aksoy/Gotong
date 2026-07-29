/**
 * panel-schema.ts — SDUI panel config: types + closed component set + fail-closed
 * validator + default panel (SDUI-M1).
 *
 * A member's terminal form (web / PWA / future app shell) is driven by ONE
 * per-member config file: which components, in what order, bound to which named
 * data source. The client ships a CLOSED component catalog; the config only
 * orchestrates. This module is the single source of truth for what a valid
 * config IS — every write path (member PUT, template install, butler
 * `set_panel_layout`) must run {@link validatePanelConfig} ("one validator,
 * no drift", same discipline as web/manifest.ts).
 *
 * # Boundaries (SDUI plan doc, user-settled 2026-07-26)
 *
 * - CLOSED set, open orchestration: configs can never introduce code, URLs, or
 *   unknown components. `source` is a NAMED whitelist (the structural line
 *   against SSRF / data exfiltration — a config cannot point a renderer at an
 *   arbitrary endpoint). `params` are per-component whitelists, fail-closed.
 * - Reserved zone ("orchestrate ≠ impersonate"): `approval-inbox` renders
 *   approval semantics hard-coded client-side. A config may only PLACE it —
 *   any `source`/`params` on a reserved component is rejected outright, so
 *   there is structurally nothing to tamper with.
 * - Validator rejects unknown component types (fail-closed at WRITE time).
 *   The renderer's placeholder-card downgrade is for the OTHER direction — a
 *   stored config newer than the client — not a license to store junk.
 * - Butler-layer, not framework: pure types + validation, zero IO, zero deps.
 *   File placement/atomic-write discipline lives in the M3 store; rendering in
 *   the M2 web module.
 */

/** Config schema version this validator understands. */
export const PANEL_SCHEMA_VERSION = 1

/**
 * Closed component catalog (plan doc §六). `section`/`heading` from that table
 * are expressed as top-level structure (`sections[].heading`), not component
 * types — so the catalog here is the 12 placeable types.
 *
 * SHELL-M3 dropped `image-card`: the validator accepted it, the renderer
 * answered with 「即将上线」 and the butler's cheat-sheet (derived from
 * {@link PANEL_COMPONENT_CONTRACTS}) advertised it as usable — a closed set
 * that promises something no renderer delivers. Implementing it properly needs
 * an image-bytes store with content-type and size validation, which is a
 * milestone rather than a footnote; nothing in the repo referenced it, so the
 * honest fix is to stop listing it. Every entry below has a real renderer, and
 * `sdui-ui-contract.test.ts` now keeps it that way.
 */
export const PANEL_COMPONENT_TYPES = [
  'divider',
  'chat',
  'approval-inbox',
  'card-feed',
  'markdown-card',
  'chart',
  'calendar',
  'list',
  'weather',
  'status-card',
  'schedule-list',
  'quick-actions',
] as const

export type PanelComponentType = (typeof PANEL_COMPONENT_TYPES)[number]

/**
 * Reserved-zone components: semantics + shape are hard-coded in the renderer;
 * configs may only position them. The validator rejects any `source`/`params`
 * so there is no tamperable surface at all.
 */
export const PANEL_RESERVED_TYPES = ['approval-inbox'] as const

/** Named data sources — fixed literals a component may bind. */
export const PANEL_FIXED_SOURCES = [
  'inbox.pending',
  'chat.butler',
  'tasks.mine',
  'schedules.mine',
  'usage.mine',
  'status.hub',
] as const

/**
 * Prefixed data-source families. The suffix is an IDENTIFIER (see
 * {@link PANEL_ID_RE}) — never a URL or path, so `content:../x` or
 * `connector:https://…` cannot pass.
 */
export const PANEL_SOURCE_PREFIXES = ['connector:', 'content:'] as const

/** Quick-action verbs — fixed literals. */
export const PANEL_FIXED_ACTIONS = ['open_chat', 'open_inbox', 'compose_brief'] as const

/** Quick-action prefixed families (suffix = identifier, e.g. a workflow id). */
export const PANEL_ACTION_PREFIXES = ['start_workflow:'] as const

/**
 * Identifier shape for prefixed source/action suffixes. Deliberately strict:
 * no `/`, no `..` (single dots allowed but not consecutive), no whitespace —
 * suffixes end up as ids handed to hub APIs, never as paths or URLs.
 * Exported (C1-c): the content store keys files by this SAME rule, so any
 * `content:<fileId>` a validated config carries is a servable file id.
 */
export const PANEL_ID_RE = /^(?!.*\.\.)[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$/

/** Explicit caps — refuse loudly instead of silently truncating. */
export const PANEL_LIMITS = {
  maxSections: 8,
  /** Across ALL sections. */
  maxComponents: 24,
  maxTitleChars: 40,
  maxHeadingChars: 40,
  /** Any whitelisted string param (placeholder …). */
  maxParamStringChars: 120,
  /** quick-actions buttons per component. */
  maxActions: 6,
  /** Validation stops collecting after this many errors. */
  maxErrors: 20,
  /** On-disk cap, enforced by the M3 store (kept here as the one contract). */
  maxFileBytes: 32 * 1024,
  /** C1-c content files (butler-written display markdown) — store-enforced.
   * Display cards, not knowledge: deliberately far below the LIB 32KB tier. */
  maxContentBytes: 8 * 1024,
  /** Per-member content file count — store-enforced (overwrites always pass). */
  maxContentFiles: 24,
} as const

export interface PanelComponent {
  type: PanelComponentType
  /** Named data source (whitelisted; some components require/forbid it). */
  source?: string
  /** Per-component whitelisted display params. */
  params?: Record<string, unknown>
}

export interface PanelSection {
  heading?: string
  components: PanelComponent[]
}

export interface PanelConfig {
  schemaVersion: typeof PANEL_SCHEMA_VERSION
  title?: string
  sections: PanelSection[]
}

/** One param's validation rule. */
type ParamRule =
  | { kind: 'string'; maxChars: number }
  | { kind: 'int'; min: number; max: number }
  | { kind: 'enum'; values: readonly string[] }
  | { kind: 'actions' }

interface ComponentContract {
  /**
   * Source policy: 'forbidden' (reserved zone / layout), 'optional' with a
   * default the renderer applies, or 'required'.
   */
  source: 'forbidden' | 'optional' | 'required'
  /** Which sources are acceptable when one is given: literals and/or prefixes. */
  sources?: readonly string[]
  /** Param whitelist; absent = no params accepted at all. */
  params?: Readonly<Record<string, ParamRule>>
}

/**
 * Per-component contract table (exported for the renderer + anti-rot tests).
 * v1 stays deliberately narrow — every param here appeared in a preset panel;
 * widening a contract is additive, narrowing is a breaking change.
 */
export const PANEL_COMPONENT_CONTRACTS: Readonly<Record<PanelComponentType, ComponentContract>> = {
  divider: { source: 'forbidden' },
  chat: {
    source: 'optional',
    sources: ['chat.butler'],
    params: { placeholder: { kind: 'string', maxChars: PANEL_LIMITS.maxParamStringChars } },
  },
  // Reserved zone: nothing to bind, nothing to tune, nothing to fake.
  'approval-inbox': { source: 'forbidden' },
  'card-feed': {
    source: 'required',
    sources: ['connector:'],
    params: { limit: { kind: 'int', min: 1, max: 20 } },
  },
  'markdown-card': { source: 'required', sources: ['content:'] },
  chart: {
    source: 'required',
    sources: ['usage.mine'],
    params: { range: { kind: 'enum', values: ['week', 'month'] } },
  },
  calendar: {
    source: 'required',
    sources: ['schedules.mine', 'connector:'],
    params: { view: { kind: 'enum', values: ['day', 'week', 'month'] } },
  },
  list: {
    source: 'required',
    sources: ['tasks.mine'],
    params: { limit: { kind: 'int', min: 1, max: 20 } },
  },
  weather: {
    source: 'required',
    sources: ['connector:'],
    params: { days: { kind: 'int', min: 1, max: 7 } },
  },
  'status-card': { source: 'required', sources: ['status.hub'] },
  'schedule-list': {
    source: 'required',
    sources: ['schedules.mine'],
    params: { limit: { kind: 'int', min: 1, max: 10 } },
  },
  'quick-actions': { source: 'forbidden', params: { actions: { kind: 'actions' } } },
}

export type PanelValidationResult =
  | { ok: true; config: PanelConfig }
  | { ok: false; errors: string[] }

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  // Pin the prototype: an Object.create({schemaVersion:1,…}) shell passes
  // own-key checks yet serializes to {} — inherited fields must not validate.
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

// Display copy travels from config into member-facing UI verbatim. Control
// chars and bidi overrides have no legitimate use there and are the raw
// material of spoofing (RTL flips, invisible padding) — reject, don't strip.
// eslint-disable-next-line no-control-regex
const HOSTILE_TEXT_RE = /[\u0000-\u001F\u007F\u202A-\u202E\u2066-\u2069]/

function hostileText(s: string): boolean {
  return HOSTILE_TEXT_RE.test(s)
}

function validSource(source: string, allowed: readonly string[]): boolean {
  for (const a of allowed) {
    if (a.endsWith(':')) {
      if (source.startsWith(a) && PANEL_ID_RE.test(source.slice(a.length))) return true
    } else if (source === a) {
      return true
    }
  }
  return false
}

function validAction(action: string): boolean {
  if ((PANEL_FIXED_ACTIONS as readonly string[]).includes(action)) return true
  for (const p of PANEL_ACTION_PREFIXES) {
    if (action.startsWith(p) && PANEL_ID_RE.test(action.slice(p.length))) return true
  }
  return false
}

/**
 * Validate an untrusted value as a panel config. Fail-closed: unknown keys,
 * unknown component types, out-of-whitelist sources/params/actions and
 * over-cap sizes are all rejected. Collects up to `maxErrors` problems (a
 * butler retrying a hallucinated layout should see them all in one round).
 */
export function validatePanelConfig(value: unknown): PanelValidationResult {
  const errors: string[] = []
  const err = (msg: string): void => {
    if (errors.length < PANEL_LIMITS.maxErrors) errors.push(msg)
  }

  if (!isPlainObject(value)) return { ok: false, errors: ['config: must be a JSON object'] }

  for (const k of Object.keys(value)) {
    if (k !== 'schemaVersion' && k !== 'title' && k !== 'sections') err(`config: unknown key "${k}"`)
  }
  if (value.schemaVersion !== PANEL_SCHEMA_VERSION) {
    err(`schemaVersion: must be ${PANEL_SCHEMA_VERSION}`)
  }
  if (value.title !== undefined) {
    if (typeof value.title !== 'string' || value.title.length === 0) err('title: must be a non-empty string')
    else if (value.title.length > PANEL_LIMITS.maxTitleChars) {
      err(`title: over ${PANEL_LIMITS.maxTitleChars} chars`)
    } else if (hostileText(value.title)) {
      err('title: control or bidi-override characters are not allowed')
    }
  }

  const sections = value.sections
  if (!Array.isArray(sections) || sections.length === 0) {
    err('sections: must be a non-empty array')
  } else if (sections.length > PANEL_LIMITS.maxSections) {
    err(`sections: over ${PANEL_LIMITS.maxSections}`)
  } else {
    let componentCount = 0
    const reservedCounts = new Map<string, number>()
    sections.forEach((section, si) => {
      const at = `sections[${si}]`
      if (!isPlainObject(section)) {
        err(`${at}: must be an object`)
        return
      }
      for (const k of Object.keys(section)) {
        if (k !== 'heading' && k !== 'components') err(`${at}: unknown key "${k}"`)
      }
      if (section.heading !== undefined) {
        if (typeof section.heading !== 'string' || section.heading.length === 0) {
          err(`${at}.heading: must be a non-empty string`)
        } else if (section.heading.length > PANEL_LIMITS.maxHeadingChars) {
          err(`${at}.heading: over ${PANEL_LIMITS.maxHeadingChars} chars`)
        } else if (hostileText(section.heading)) {
          err(`${at}.heading: control or bidi-override characters are not allowed`)
        }
      }
      const components = section.components
      if (!Array.isArray(components) || components.length === 0) {
        err(`${at}.components: must be a non-empty array`)
        return
      }
      componentCount += components.length
      components.forEach((component, ci) => {
        validateComponent(component, `${at}.components[${ci}]`, err)
        const t = isPlainObject(component) ? component.type : undefined
        if (typeof t === 'string' && (PANEL_RESERVED_TYPES as readonly string[]).includes(t)) {
          reservedCounts.set(t, (reservedCounts.get(t) ?? 0) + 1)
        }
      })
    })
    if (componentCount > PANEL_LIMITS.maxComponents) {
      err(`components: ${componentCount} total, over ${PANEL_LIMITS.maxComponents}`)
    }
    // Reserved-zone components carry system semantics — duplicates have no
    // legitimate use and only serve visual-noise spoofing. At most one each.
    for (const [t, n] of reservedCounts) {
      if (n > 1) err(`components: reserved "${t}" may appear at most once (found ${n})`)
    }
  }

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, config: value as unknown as PanelConfig }
}

function validateComponent(value: unknown, at: string, err: (msg: string) => void): void {
  if (!isPlainObject(value)) {
    err(`${at}: must be an object`)
    return
  }
  for (const k of Object.keys(value)) {
    if (k !== 'type' && k !== 'source' && k !== 'params') err(`${at}: unknown key "${k}"`)
  }
  const type = value.type
  if (typeof type !== 'string' || !(PANEL_COMPONENT_TYPES as readonly string[]).includes(type)) {
    err(`${at}.type: unknown component "${String(type)}"`)
    return
  }
  const contract = PANEL_COMPONENT_CONTRACTS[type as PanelComponentType]

  const source = value.source
  if (source !== undefined) {
    if (contract.source === 'forbidden') {
      err(`${at}.source: "${type}" takes no source`)
    } else if (typeof source !== 'string') {
      err(`${at}.source: must be a string`)
    } else if (!validSource(source, contract.sources ?? [])) {
      err(`${at}.source: "${source}" not allowed for "${type}"`)
    }
  } else if (contract.source === 'required') {
    err(`${at}.source: required for "${type}"`)
  }

  const params = value.params
  if (params === undefined) return
  if (!isPlainObject(params)) {
    err(`${at}.params: must be an object`)
    return
  }
  const rules = contract.params
  if (!rules) {
    err(`${at}.params: "${type}" takes no params`)
    return
  }
  for (const [key, raw] of Object.entries(params)) {
    const rule = rules[key]
    if (!rule) {
      err(`${at}.params.${key}: unknown param for "${type}"`)
      continue
    }
    validateParam(raw, rule, `${at}.params.${key}`, err)
  }
}

function validateParam(raw: unknown, rule: ParamRule, at: string, err: (msg: string) => void): void {
  switch (rule.kind) {
    case 'string':
      if (typeof raw !== 'string' || raw.length === 0) err(`${at}: must be a non-empty string`)
      else if (raw.length > rule.maxChars) err(`${at}: over ${rule.maxChars} chars`)
      else if (hostileText(raw)) err(`${at}: control or bidi-override characters are not allowed`)
      return
    case 'int':
      if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < rule.min || raw > rule.max) {
        err(`${at}: must be an integer in [${rule.min}, ${rule.max}]`)
      }
      return
    case 'enum':
      if (typeof raw !== 'string' || !rule.values.includes(raw)) {
        err(`${at}: must be one of ${rule.values.join(' | ')}`)
      }
      return
    case 'actions': {
      if (!Array.isArray(raw) || raw.length === 0) {
        err(`${at}: must be a non-empty array`)
        return
      }
      if (raw.length > PANEL_LIMITS.maxActions) {
        err(`${at}: over ${PANEL_LIMITS.maxActions} actions`)
        return
      }
      raw.forEach((a, i) => {
        if (typeof a !== 'string' || !validAction(a)) {
          err(`${at}[${i}]: unknown action "${String(a)}"`)
        }
      })
      return
    }
  }
}

/* ── Version negotiation (SHELL-M3) ────────────────────────────────────────
 *
 * Until the shell exists, renderer and hub ship in the same artifact and the
 * version number is decoration. From SHELL-M5 on, the app is released on its
 * own clock and the hub upgrades on the operator's — so `schemaVersion` has to
 * start carrying weight BEFORE the first shell is built (plan §五 边界③:
 * 契约先于第二渲染器).
 *
 * Two rules define the protocol:
 *
 *   1. A renderer MUST render any config whose schemaVersion is ≤ its own.
 *      That is what the number buys: newer renderers stay backwards
 *      compatible, so `client_ahead` is a normal, fully-working state.
 *   2. A renderer MUST NOT guess at a config NEWER than its own. Same-major
 *      unknown COMPONENTS already degrade one card at a time (placeholder
 *      cards); an unknown SCHEMA can change the meaning of fields it does
 *      recognise, so the honest answer is a whole-panel downgrade + a loud
 *      notice, not a best-effort render.
 *
 * The verdict is computed HERE — server-side, one authority — rather than left
 * to each renderer, mirroring how severity (derivePatrolCards) and isButler are
 * server-computed elsewhere. A client that lies about its version only changes
 * what IT is told, never what it is served.
 *
 * Deliberately NOT part of the declaration: the client's component list. The
 * server has no use for it — unknown components already degrade locally, and
 * the butler's cheat-sheet is built at spawn time from the hub's own catalog,
 * so a per-request declaration could not reach it anyway (and a member may be
 * on two clients at once). Version only keeps the surface one integer wide.
 */

/** What an absent/garbled declaration is assumed to be: the oldest renderer
 * that exists. 「协商缺席时按最低集」 = judge against the least capable client,
 * NOT serve it a narrowed config (see {@link panelContract}). */
export const PANEL_BASELINE_CLIENT_SCHEMA_VERSION = 1

export type PanelContractVerdict =
  /** Client can render this schema (client ≥ server). */
  | 'ok'
  /** Server schema is newer than the client — whole-panel downgrade. */
  | 'client_outdated'
  /** Client is newer than this hub. Renders normally (rule 1); reported so the
   * member can be told which side is behind if anything looks off. */
  | 'client_ahead'

export interface PanelContract {
  /** Schema version this hub writes and validates. */
  server: number
  /** Echo of the normalized client declaration (baseline when absent). */
  client: number
  verdict: PanelContractVerdict
  /** The hub's closed catalog — lets a client name what it could not render. */
  componentTypes: readonly PanelComponentType[]
}

/**
 * The rule itself, over an arbitrary version pair.
 *
 * Split out from {@link panelContract} because the server side is a constant:
 * while PANEL_SCHEMA_VERSION is 1 and declarations normalize to ≥1, the
 * `client_outdated` branch is unreachable through the public entry point — yet
 * it is the branch the whole milestone exists for. Taking both versions as
 * arguments makes the v2-hub-vs-v1-shell case testable years before a v2 hub
 * exists, which is the point: the mechanism has to be proven while divergence
 * is still hypothetical.
 */
export function panelContractVerdict(server: number, client: number): PanelContractVerdict {
  if (client < server) return 'client_outdated'
  if (client > server) return 'client_ahead'
  return 'ok'
}

/**
 * Compute the contract block for one panel response.
 *
 * The declaration NEVER filters the served config. Dropping components the
 * client didn't claim would silently show the member less than they configured
 * — the opposite of the placeholder-card discipline (「永不空白」) — and would
 * put a client-supplied claim in the path of what data the hub serves. The
 * config bytes are identical for every declared version; only the verdict moves.
 */
export function panelContract(clientDeclared?: unknown): PanelContract {
  const n = Number(clientDeclared)
  const client = Number.isInteger(n) && n >= 1 ? n : PANEL_BASELINE_CLIENT_SCHEMA_VERSION
  return {
    server: PANEL_SCHEMA_VERSION,
    client,
    verdict: panelContractVerdict(PANEL_SCHEMA_VERSION, client),
    componentTypes: PANEL_COMPONENT_TYPES,
  }
}

/**
 * Default panel — the no-config-file form (today's /me equivalent: chat first,
 * then pending approvals + tasks, then hub status). Structure only: no
 * `title`/`heading` strings here, display copy is the renderer's (i18n lives
 * in the render layer, not in stored config).
 */
export const DEFAULT_PANEL: PanelConfig = {
  schemaVersion: PANEL_SCHEMA_VERSION,
  sections: [
    { components: [{ type: 'chat' }] },
    { components: [{ type: 'approval-inbox' }, { type: 'list', source: 'tasks.mine' }] },
    {
      components: [
        { type: 'status-card', source: 'status.hub' },
        { type: 'schedule-list', source: 'schedules.mine' },
      ],
    },
  ],
}
