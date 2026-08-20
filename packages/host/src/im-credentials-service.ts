/**
 * im-credentials-service.ts — HANDS-M3a. The credential face of the IM console:
 * `/setkey <target> <key>` writes a provider API key from a phone, `/keys`
 * shows which slots hold one.
 *
 * Why this exists: a key expires on a Sunday and the only way to replace it is
 * an admin browser session on a laptop. Everything else the operator needs from
 * a phone already works (setting console, approvals, workflows) — the key was
 * the one errand that still required a desk.
 *
 * ── The one rule that shapes every line below ────────────────────────────────
 * The secret must reach `setAgentApiKey` / the vault and NOTHING else. Not the
 * session window, not the transcript, not episodic memory, not a log line, not
 * the reply, not an audit row. So:
 *
 *   - the parser (`@gotong/im-adapter`) claims every shape of the verb, which
 *     keeps the raw text out of the `free` branch that records and replays it;
 *   - this service takes the secret as an argument and returns an OUTCOME with
 *     no secret in it — the router renders text from the outcome, so the
 *     rendering layer never holds the value at all;
 *   - failures are described by CODE, never by echoing what was typed.
 *
 * What this face deliberately does NOT do:
 *   - create agents or providers. Every target must already exist; `/setkey` is
 *     "replace the key of a thing you configured", never "configure a thing".
 *     That keeps the phone face strictly smaller than the admin face.
 *   - write a key that could not take effect. An agent pinned to an env var
 *     (MR-M6 `apiKeyEnv` is EXCLUSIVE) would keep using the server's
 *     environment, so pasting into it and answering "已存入" would be a lie of
 *     the same family as a test button that probes the wrong wallet. We refuse
 *     and say where the real key lives.
 *   - accept `openai-compatible` as a PROVIDER-level target. That tag is an
 *     umbrella over every OpenAI-shaped vendor (DeepSeek, Qwen, MiMo…), so one
 *     shared row would hand a DeepSeek key to a MiMo endpoint and the 401 would
 *     lie about its cause. `me-credentials-service` narrowed member BYO keys on
 *     exactly this reasoning. The per-AGENT form is unambiguous and stays open.
 *
 * Authorisation: owner/admin only, and the predicate is supplied by the
 * assembly layer (`armImBridgeWiring` already derives one for the setting
 * console) so this file never grows a second reading of what a role means.
 * An unauthorised member gets the same "not enabled" reply as a host that never
 * wired the surface — a credential face shouldn't advertise its own existence.
 */

import type { AgentRecord } from '@gotong/core'
import type { VaultEntry, WriteAuditLogInput } from '@gotong/identity'
import { AUDIT_ACTIONS } from '@gotong/identity'

/** The slice of the workspace Space this service touches (real Space satisfies). */
export interface ImCredentialsSpace {
  agents(): Promise<AgentRecord[]>
  /** agentId → updatedAt. Presence only — never decrypts. */
  listAgentApiKeys(): Promise<Record<string, string>>
  /** provider → updatedAt. Presence only — never decrypts. */
  listProviderApiKeys(): Promise<Record<string, string>>
  setAgentApiKey(agentId: string, plaintext: string): Promise<void>
}

/** The slice of IdentityStore this service touches (real store satisfies). */
export interface ImCredentialsIdentity {
  createVaultEntry(input: {
    kind: 'llm_provider'
    ownerKind: 'org'
    ownerId: string | null
    secret: string
    label?: string | null
    metadata?: Record<string, unknown> | null
  }): VaultEntry
  listVaultEntries(query: {
    kind?: 'llm_provider'
    ownerKind?: 'org' | 'user'
    activeOnly?: boolean
  }): VaultEntry[]
  revokeVaultEntry?(id: string): boolean
  writeAuditLog?(input: WriteAuditLogInput): unknown
}

export interface ImCredentialsServiceOptions {
  /** Owner/admin gate, supplied by the assembly layer (one role reading). */
  allowed: (userId: string) => boolean | Promise<boolean>
  space: ImCredentialsSpace
  identity: ImCredentialsIdentity
  /**
   * Restart the agents that would pick up the key we just stored — the SAME
   * `lifecycle.start(record)` the admin face calls right after its own key
   * write, not a second notion of "apply".
   *
   * Why it is load-bearing rather than a nicety: a managed agent resolves its
   * key ONCE, at spawn (`resolveApiKey` → `providerFactory`). Store a key
   * without respawning and the running agent keeps failing with the old one,
   * so "已存入" would read as "fixed" while nothing changed — the same family
   * of lie as a test button probing the wrong wallet. Absent (a host with no
   * lifecycle) → the reply says the key is stored but NOT yet in effect,
   * instead of quietly implying it is.
   */
  restartAgents?: (agentIds: string[]) => Promise<{ restarted: string[]; failed: string[] }>
  /**
   * HANDS-M3b — the other path. Absent (or a hub with no public URL) means
   * `/setkey link` says so rather than printing a link that cannot be opened.
   */
  links?: {
    issue(userId: string): { token: string; expiresAt: number }
    peek(token: unknown): { userId: string; expiresAt: number } | null
    consume(token: unknown): { userId: string } | null
  }
  /** Externally reachable base for the link, already validated. */
  linkBaseUrl?: string
  /** Structured logger. Target/outcome only — this file never logs a secret. */
  log: { info(msg: string, meta?: Record<string, unknown>): void }
}

/**
 * Provider tags a shared (org-pool) row may be written for. Deliberately the
 * two single-vendor tags: see the `openai-compatible` note in the header.
 */
export const IM_SHARED_KEY_PROVIDERS: readonly string[] = ['anthropic', 'openai']

/**
 * Key-shaped enough to be worth storing. We can't validate a vendor's format
 * (they all differ and they all change), so the bounds only catch the two
 * mistakes a phone actually makes: a truncated paste and a wall of text. The
 * character check rejects control bytes — a key never contains one, and a
 * stray newline mid-secret means the paste lost a chunk.
 */
const SECRET_MIN_CHARS = 8
const SECRET_MAX_CHARS = 4096

/** One row of `/keys`. Values never appear — only whether a slot is filled. */
export interface ImKeySlotRow {
  agentId: string
  provider: string
  /** MR-M6 exclusive env pin; when set, no stored key can ever win. */
  envName?: string
  /** Whether that env var actually has a value in the host process. */
  envPresent?: boolean
  /** A per-agent key exists (its updatedAt, never its value). */
  perAgentUpdatedAt?: string
}

export interface ImKeysView {
  agents: ImKeySlotRow[]
  /** provider tag → a shared org-pool row exists. */
  shared: Record<string, boolean>
  /**
   * provider tag → a workspace-level key exists. ONLY anthropic/openai: the
   * workspace and host-env tiers are skipped outright for `openai-compatible`
   * (vendor ambiguity — `resolveApiKey` passes null for both), so listing a
   * workspace row for it would advertise a key that can never be reached.
   */
  workspace: Record<string, boolean>
  /** `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` — the last-resort tier, same scope. */
  hostEnv: Record<string, boolean>
}

/**
 * What became of the respawn. Reported to the member verbatim rather than
 * summarised into "done": which agents took the key is the blast radius of
 * what they just did from a phone, and a partial failure must not read as a
 * clean success.
 */
export interface ImKeyRestartReport {
  restarted: string[]
  failed: string[]
  /** No lifecycle wired → stored but not yet running with it. */
  unavailable?: true
}

export type ImSetKeyOutcome =
  | { ok: true; slot: 'agent'; agentId: string; provider: string; restart: ImKeyRestartReport }
  | {
      ok: true
      slot: 'shared'
      provider: string
      /** Agents on this provider that will NOT pick it up, with the reason. */
      shadowed: Array<{ agentId: string; reason: 'per-agent' | 'env-pinned' }>
      restart: ImKeyRestartReport
    }
  | { ok: false; code: 'bad_secret'; reason: 'too_short' | 'too_long' | 'bad_chars' }
  | { ok: false; code: 'unknown_target'; agents: string[]; providers: string[] }
  /**
   * `target` here is the matched AGENT ID (from our own records), never the raw
   * string the member typed — see the note on `setKey` about why no outcome
   * carries unvalidated input back out.
   */
  | { ok: false; code: 'ambiguous_target'; target: string }
  | { ok: false; code: 'env_pinned'; agentId: string; envName: string }
  | { ok: false; code: 'mock_agent'; agentId: string }
  | { ok: false; code: 'vendor_ambiguous'; agents: string[] }

/**
 * HANDS-M3b — what `/setkey link` answers. `unavailable` covers both shapes of
 * "we cannot hand you a working link" (no store wired, no public address), and
 * it is one code on purpose: the member's next move is the same either way, and
 * telling a chat window which half of the plumbing is missing is operator
 * detail that belongs in the hub log.
 */
export type ImSetKeyLinkOutcome =
  | { ok: true; url: string; expiresAt: number }
  | { ok: false; code: 'unavailable' }

/**
 * One entry in the form's target picker.
 *
 * Two decisions live in this shape:
 *
 *   - `value` is the EXPLICIT `agent:` / `provider:` form, so a submit coming
 *     from the form can never hit `ambiguous_target`. The bare-name parse stays
 *     for the chat path, where typing a prefix is friction; here the page has
 *     room to be unambiguous for free.
 *   - `blocked` names a refusal that is knowable BEFORE the write. The page
 *     disables those options — a one-time link should not be spent on a "no"
 *     the hub could already see coming. The server still refuses a crafted
 *     submit: the picker declines to offer the impossible, it does not
 *     authorise the rest.
 *
 * Codes, not prose: every word the member reads is rendered by the web layer,
 * the same split `ImSetKeyOutcome` already uses for the chat replies.
 */
export interface SetKeyLinkTarget {
  value: string
  kind: 'agent' | 'provider'
  /** Bare id / tag, for display. */
  name: string
  /** The agent's provider tag (agents only). */
  provider?: string
  blocked?: 'env-pinned' | 'mock'
  envName?: string
  /** A key is already stored in this slot (presence only, never the value). */
  filled: boolean
}

/** What the form page needs to render. Presence only — no value ever leaves. */
export type SetKeyLinkPage =
  | { ok: true; targets: SetKeyLinkTarget[]; expiresAt: number }
  | { ok: false; code: 'link_invalid' | 'not_allowed' }

/**
 * The submit answer. Reuses `ImSetKeyOutcome` verbatim so the two paths cannot
 * drift in what a refusal MEANS, plus the two failures only the link path has.
 */
export type ImSetKeyLinkSubmitOutcome =
  | ImSetKeyOutcome
  | { ok: false; code: 'link_invalid' }
  | { ok: false; code: 'not_allowed' }

/**
 * The resolution order `/keys` prints. Kept as data (not prose) so the
 * anti-drift test can compare it against what `selectLlmApiKey` actually does
 * — a priority list that quietly disagrees with the selector is worse than no
 * priority list, because a member would act on it.
 *
 * `pinned-env` is the head and it is NOT a tier: MR-M6's `apiKeyEnv` is an
 * EXCLUSIVE branch in `resolveApiKey` that returns before the tier list is
 * ever consulted (a missing value means "no key", never a fall-through). The
 * tail — from `per-agent` down — IS `selectLlmApiKey`'s order verbatim, and
 * the gate derives it from the real selector rather than trusting this array.
 * Note the two are different things wearing the word "env": the pin at the top
 * names a variable the spec author chose; `env` at the bottom is the fixed
 * `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` last resort.
 */
export const IM_KEY_PRIORITY: readonly string[] = [
  'pinned-env',
  'per-agent',
  'org-pool',
  'user-pool',
  'workspace',
  'env',
]

export class ImCredentialsService {
  private readonly opts: ImCredentialsServiceOptions

  constructor(opts: ImCredentialsServiceOptions) {
    this.opts = opts
  }

  async allowed(userId: string): Promise<boolean> {
    return Boolean(await this.opts.allowed(userId))
  }

  /** Slot inventory. Presence only — nothing here decrypts a stored secret. */
  async list(): Promise<ImKeysView> {
    const [agents, perAgent, workspaceKeys] = await Promise.all([
      this.opts.space.agents(),
      this.opts.space.listAgentApiKeys(),
      this.opts.space.listProviderApiKeys(),
    ])
    const sharedTags = this.sharedProviderTags()
    const rows: ImKeySlotRow[] = []
    for (const a of agents) {
      if (!a.managed) continue // external agents bring their own transport, not our key
      const envName = a.managed.apiKeyEnv
      rows.push({
        agentId: a.id,
        provider: a.managed.provider,
        ...(envName
          ? { envName, envPresent: (process.env[envName] ?? '').trim().length > 0 }
          : {}),
        ...(perAgent[a.id] ? { perAgentUpdatedAt: perAgent[a.id]! } : {}),
      })
    }
    const providersSeen = new Set<string>([
      ...IM_SHARED_KEY_PROVIDERS,
      ...rows.map((r) => r.provider),
      ...sharedTags,
    ])
    providersSeen.delete('mock')
    const shared: Record<string, boolean> = {}
    for (const p of [...providersSeen].sort()) shared[p] = sharedTags.has(p)
    // Workspace + host-env are reported ONLY where those tiers are consulted:
    // `resolveApiKey` passes null for both when the provider is
    // `openai-compatible`, so printing a row there would advertise a key that
    // can never be reached.
    const workspace: Record<string, boolean> = {}
    const hostEnv: Record<string, boolean> = {}
    for (const p of IM_SHARED_KEY_PROVIDERS) {
      workspace[p] = Boolean(workspaceKeys[p])
      const envName = p === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'
      hostEnv[p] = (process.env[envName] ?? '').trim().length > 0
    }
    return { agents: rows, shared, workspace, hostEnv }
  }

  /**
   * Write one key. `target` is `agent:<id>` / `provider:<tag>` / a bare name
   * that must resolve to exactly one of the two.
   *
   * Order matters and is fail-closed: shape of the secret → what the target IS
   * → whether the write could TAKE EFFECT → write. The effectiveness check sits
   * before the write, not after, so a refusal costs the member nothing but the
   * message they still have to delete.
   *
   * NO outcome carries `target` back out verbatim, and that is a rule, not an
   * oversight: `/setkey <key> <agent>` — the arguments in the order a hurried
   * person types them — parses as target=<key>, so an outcome that echoed the
   * target would print a live key into the chat on the very mistake this face
   * exists to be forgiving about. Every string an outcome carries comes from
   * OUR records (an agent id, a provider tag, an env var name), so the renderer
   * never has to decide whether member text is safe to repeat.
   */
  async setKey(args: {
    userId: string
    target: string
    secret: string
    /** Channel for the audit row, e.g. `im:lark`. Never carries the value. */
    via: string
  }): Promise<ImSetKeyOutcome> {
    const bad = secretProblem(args.secret)
    if (bad) return { ok: false, code: 'bad_secret', reason: bad }

    const agents = (await this.opts.space.agents()).filter((a) => a.managed)
    const explicit = splitExplicitTarget(args.target)
    const agentHit =
      explicit.kind === 'provider' ? undefined : agents.find((a) => a.id === explicit.name)
    const providerHit =
      explicit.kind === 'agent'
        ? undefined
        : this.knownProviderTags(agents).has(explicit.name)
          ? explicit.name
          : undefined

    // `agentHit.id`, not `args.target`: identical strings today, but taking it
    // from the record is what makes "outcomes never carry member text" a
    // property of the shape rather than of this line staying correct.
    if (agentHit && providerHit) return { ok: false, code: 'ambiguous_target', target: agentHit.id }
    if (agentHit) return this.setAgentKey(agentHit, args)
    if (providerHit) return this.setSharedKey(providerHit, agents, args)
    return {
      ok: false,
      code: 'unknown_target',
      agents: agents.map((a) => a.id).sort(),
      providers: [...IM_SHARED_KEY_PROVIDERS],
    }
  }

  // ── HANDS-M3b: the link path ──────────────────────────────────────────────

  /**
   * Whether a link would actually work here. Read by the PASTE replies before
   * they offer the alternative — advice that fails when taken is worse than no
   * advice, especially in the sentence right after "your key is in your chat
   * history now".
   */
  linkAvailable(): boolean {
    return Boolean(this.opts.links && this.opts.linkBaseUrl)
  }

  /**
   * Mint a one-time link. The caller has already been through `allowed()`.
   *
   * Both halves of "no link" collapse to one refusal, and the log line is where
   * the operator learns which half — a member reading a chat reply cannot act
   * on "GOTONG_PUBLIC_URL is unset" any differently than on "no store wired".
   */
  issueLink(userId: string): ImSetKeyLinkOutcome {
    const base = this.opts.linkBaseUrl
    if (!this.opts.links || !base) {
      this.opts.log.info('im setkey link unavailable', {
        hasStore: Boolean(this.opts.links),
        hasBaseUrl: Boolean(base),
      })
      return { ok: false, code: 'unavailable' }
    }
    const link = this.opts.links.issue(userId)
    this.opts.log.info('im setkey link issued', { userId, expiresAt: link.expiresAt })
    return { ok: true, url: `${base}/setkey/${link.token}`, expiresAt: link.expiresAt }
  }

  /**
   * What the form page may show. A peek, not a claim: opening the page twice
   * (a mis-tap, a preview fetch by the IM client) must not cost the link.
   *
   * The role is re-read here and again at submit rather than trusted from mint
   * time — same reason the hands toolset re-asks at execute: a link can sit on
   * a screen for minutes, and the write happens on behalf of whoever the member
   * is NOW.
   */
  async linkPage(token: unknown): Promise<SetKeyLinkPage> {
    const held = this.opts.links?.peek(token)
    if (!held) return { ok: false, code: 'link_invalid' }
    if (!(await this.allowed(held.userId))) return { ok: false, code: 'not_allowed' }
    const view = await this.list()
    const targets: SetKeyLinkTarget[] = []
    for (const a of view.agents) {
      targets.push({
        value: `agent:${a.agentId}`,
        kind: 'agent',
        name: a.agentId,
        provider: a.provider,
        ...(a.provider === 'mock'
          ? { blocked: 'mock' as const }
          : a.envName
            ? { blocked: 'env-pinned' as const, envName: a.envName }
            : {}),
        filled: Boolean(a.perAgentUpdatedAt),
      })
    }
    // Shared rows only for the tags a shared key can honestly serve — the
    // `openai-compatible` umbrella is never offered here, which is what makes
    // `vendor_ambiguous` unreachable from the form rather than merely refused.
    for (const p of IM_SHARED_KEY_PROVIDERS) {
      targets.push({ value: `provider:${p}`, kind: 'provider', name: p, filled: Boolean(view.shared[p]) })
    }
    return { ok: true, targets, expiresAt: held.expiresAt }
  }

  /**
   * Spend the link and write the key.
   *
   * The order is chosen so the ONE realistic mistake does not cost a round trip
   * to the phone: a truncated paste is caught by the pure shape check BEFORE
   * the link is spent, so the member just pastes again on the same page. That
   * check reads no hub state and reveals nothing, so declining to burn the link
   * for it gives an attacker holding the token exactly nothing — they could
   * already spend it once, and every branch past this point does.
   *
   * Everything else consumes first: the removal is the claim, so two submits
   * racing the same token cannot both reach `setKey`.
   */
  async submitLink(args: {
    token: unknown
    target: string
    secret: string
  }): Promise<ImSetKeyLinkSubmitOutcome> {
    const held = this.opts.links?.peek(args.token)
    if (!held) return { ok: false, code: 'link_invalid' }
    if (!(await this.allowed(held.userId))) return { ok: false, code: 'not_allowed' }
    const bad = secretProblem(args.secret)
    if (bad) return { ok: false, code: 'bad_secret', reason: bad }
    const claimed = this.opts.links?.consume(args.token)
    if (!claimed) return { ok: false, code: 'link_invalid' }
    return this.setKey({
      userId: claimed.userId,
      target: args.target,
      secret: args.secret,
      via: 'setkey-link',
    })
  }

  // ── the two writers ────────────────────────────────────────────────────────

  private async setAgentKey(
    agent: AgentRecord,
    args: { userId: string; secret: string; via: string },
  ): Promise<ImSetKeyOutcome> {
    const managed = agent.managed!
    if (managed.provider === 'mock') return { ok: false, code: 'mock_agent', agentId: agent.id }
    if (managed.apiKeyEnv) {
      return { ok: false, code: 'env_pinned', agentId: agent.id, envName: managed.apiKeyEnv }
    }
    await this.opts.space.setAgentApiKey(agent.id, args.secret)
    this.audit(args.userId, args.via, { slot: 'agent', agentId: agent.id, provider: managed.provider })
    this.opts.log.info('im setkey wrote per-agent key', {
      agentId: agent.id,
      provider: managed.provider,
      via: args.via,
    })
    const restart = await this.restart([agent.id])
    return { ok: true, slot: 'agent', agentId: agent.id, provider: managed.provider, restart }
  }

  private async setSharedKey(
    provider: string,
    agents: AgentRecord[],
    args: { userId: string; secret: string; via: string },
  ): Promise<ImSetKeyOutcome> {
    if (!IM_SHARED_KEY_PROVIDERS.includes(provider)) {
      return {
        ok: false,
        code: 'vendor_ambiguous',
        agents: agents.filter((a) => a.managed!.provider === provider).map((a) => a.id).sort(),
      }
    }
    // Overwrite hygiene, verbatim from the setup wizard's org-key step: revoke
    // prior active rows carrying the same tag so re-runs don't pile up. Not
    // required for correctness (the pool picks the newest active row) — but a
    // vault full of a member's superseded keys is its own small hazard.
    try {
      const prior = this.opts.identity
        .listVaultEntries({ kind: 'llm_provider', ownerKind: 'org', activeOnly: true })
        .filter((e) => providerTagOf(e) === provider)
      if (typeof this.opts.identity.revokeVaultEntry === 'function') {
        for (const e of prior) this.opts.identity.revokeVaultEntry(e.id)
      }
    } catch {
      /* cleanup is best-effort; the write below is the thing that matters */
    }
    this.opts.identity.createVaultEntry({
      kind: 'llm_provider',
      ownerKind: 'org',
      ownerId: null,
      secret: args.secret,
      label: `${provider} (IM)`,
      // Non-secret context only — the same shape the wizard writes.
      metadata: { provider, registeredBy: 'im-setkey' },
    })
    // No manual pool invalidation: createVaultEntry fires the IdentityStore
    // vault-mutation hook the OrgApiPool subscribes to at construction.
    const shadowed: Array<{ agentId: string; reason: 'per-agent' | 'env-pinned' }> = []
    const willUse: string[] = []
    const perAgent = await this.opts.space.listAgentApiKeys()
    for (const a of agents) {
      if (a.managed!.provider !== provider) continue
      if (a.managed!.apiKeyEnv) shadowed.push({ agentId: a.id, reason: 'env-pinned' })
      else if (perAgent[a.id]) shadowed.push({ agentId: a.id, reason: 'per-agent' })
      else willUse.push(a.id)
    }
    this.audit(args.userId, args.via, { slot: 'shared', provider })
    this.opts.log.info('im setkey wrote shared provider key', { provider, via: args.via })
    // Only the agents that would actually resolve to this row — restarting a
    // shadowed one would interrupt a working agent to change nothing.
    const restart = await this.restart(willUse)
    return { ok: true, slot: 'shared', provider, shadowed, restart }
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  /**
   * Respawn so the stored key is the one actually in use. Never throws: the
   * key IS written by the time we get here, and turning a restart hiccup into
   * a failed `/setkey` would tell the member to paste their secret a second
   * time — the one instruction we must not give wrongly.
   */
  private async restart(agentIds: string[]): Promise<ImKeyRestartReport> {
    if (agentIds.length === 0) return { restarted: [], failed: [] }
    if (!this.opts.restartAgents) return { restarted: [], failed: [], unavailable: true }
    try {
      const out = await this.opts.restartAgents(agentIds)
      return { restarted: [...out.restarted], failed: [...out.failed] }
    } catch {
      return { restarted: [], failed: [...agentIds] }
    }
  }

  /**
   * A credential changed, on whose say-so, through which channel. The metadata
   * carries the SLOT, never the value — same discipline as the wizard's
   * `SETUP_OWNER_LLM_KEY` row. Best-effort: a store without an audit sink (or
   * one that throws) must not cost the member the write they just made.
   *
   * HANDS-M3b — why `actorSource: 'im'` is still true when the secret arrived
   * through the WEB form. `actorSource` is a small closed enum and it answers
   * "how was the actor established", not "which keyboard did the bytes cross":
   * there is no session and no bearer here, the member never logged in, and we
   * know exactly who they are — because the one-time token was minted to an IM
   * binding. The browser is only a keyboard; the authority is the IM identity.
   * (The IMA precedent is the same shape: one coarse enum value, the detail in
   * metadata, because a finer string would be clamped to `system` on read and
   * lose the fact it was trying to record.)
   *
   * The distinction that actually matters — did this secret cross a chat window
   * or not — lives in `via`: `im:<platform>` for a paste, `setkey-link` for the
   * form. That is the load-bearing field, and a test pins that the two paths
   * can never become indistinguishable. Do not "fix" this by widening the enum
   * without first deciding what a reader loses.
   */
  private audit(userId: string, via: string, meta: Record<string, unknown>): void {
    try {
      this.opts.identity.writeAuditLog?.({
        action: AUDIT_ACTIONS.VAULT_CREATE,
        actorSource: 'im',
        actorUserId: userId,
        metadata: { ...meta, via, face: 'im-setkey' },
      })
    } catch {
      /* audit is best-effort */
    }
  }

  private sharedProviderTags(): Set<string> {
    const out = new Set<string>()
    try {
      for (const e of this.opts.identity.listVaultEntries({
        kind: 'llm_provider',
        ownerKind: 'org',
        activeOnly: true,
      })) {
        const tag = providerTagOf(e)
        if (tag) out.add(tag)
      }
    } catch {
      /* an unreadable vault means "we can't say a shared row exists" */
    }
    return out
  }

  /** Provider tags a bare target may name: what agents actually run, plus the
   *  two shared tags (so `/setkey openai …` still resolves on a hub whose only
   *  agent is Anthropic — and then refuses honestly if it fits nothing). */
  private knownProviderTags(agents: AgentRecord[]): Set<string> {
    const out = new Set<string>(IM_SHARED_KEY_PROVIDERS)
    for (const a of agents) {
      if (a.managed!.provider !== 'mock') out.add(a.managed!.provider)
    }
    return out
  }
}

/**
 * The restart leg, built from the same two things the admin key-write path
 * uses: the workspace (to re-read the record) and the agent lifecycle. Kept
 * here rather than inline in `main.ts` so the assembly line stays one line and
 * the "which lifecycle" question has one answer.
 *
 * Per-agent failures are collected, not thrown: three agents share a shared
 * provider row, one fails to respawn, and the member must be told exactly that
 * — not "restart failed" for all three, and not silence.
 */
export function buildAgentRestarter(
  space: { agents(): Promise<AgentRecord[]> },
  lifecycle: { start(record: AgentRecord): Promise<void> },
): (agentIds: string[]) => Promise<{ restarted: string[]; failed: string[] }> {
  return async (agentIds) => {
    const restarted: string[] = []
    const failed: string[] = []
    const records = new Map((await space.agents()).map((a) => [a.id, a]))
    for (const id of agentIds) {
      const rec = records.get(id)
      if (!rec) {
        failed.push(id)
        continue
      }
      try {
        await lifecycle.start(rec)
        restarted.push(id)
      } catch {
        failed.push(id)
      }
    }
    return { restarted, failed }
  }
}

function providerTagOf(entry: VaultEntry): string | undefined {
  const meta = entry.metadata as Record<string, unknown> | null | undefined
  const tag = meta?.['provider']
  return typeof tag === 'string' && tag.length > 0 ? tag : undefined
}

function splitExplicitTarget(raw: string): { kind: 'agent' | 'provider' | 'either'; name: string } {
  const lower = raw.toLowerCase()
  if (lower.startsWith('agent:')) return { kind: 'agent', name: raw.slice('agent:'.length) }
  if (lower.startsWith('provider:')) return { kind: 'provider', name: raw.slice('provider:'.length) }
  return { kind: 'either', name: raw }
}

/**
 * Control characters are checked by code point, not by a regex literal: this
 * repo has landed raw control bytes in source three times by writing escaped
 * control characters through an editing tool, and a corrupted character class here
 * would silently stop rejecting the thing it was written to reject.
 */
function secretProblem(secret: string): 'too_short' | 'too_long' | 'bad_chars' | null {
  if (secret.length < SECRET_MIN_CHARS) return 'too_short'
  if (secret.length > SECRET_MAX_CHARS) return 'too_long'
  for (const ch of secret) {
    const cp = ch.codePointAt(0)!
    if (cp < 32 || cp === 127) return 'bad_chars'
  }
  return null
}

// ── HANDS-M3a/M3b · the copy this face renders ───────────────────────────────
//
// HANDS-M7 —— 这段文案从 im-bridge.ts 搬到这里,理由是**它穷尽 switch 的那个联合
// 就定义在本文件里**。给 `ImSetKeyOutcome` 加一支失败码,编译器该在**一个**地方
// 报错;分居两个文件时,那个「一处」全靠人记得两边一起改。搬家零行为改动——既有
// im-bridge 测试逐字断言这些句子,它们是这次搬运的门。
//
// 副作用之一是它现在能被 host 的子路径导出够到,capstone 因此渲染的是**生产那
// 一份字节**,而不是在 demo 里手抄一份看起来一样的话(M3b 的教训:一条缝,如果
// 它的测试全都自己手搭对面那一半,那它就是没测过)。

/**
 * Printed on EVERY `/setkey` reply, success or failure. The trade-off of the
 * paste path is exactly this line, and it is not a footnote: we can promise
 * the key never enters the hub's conversation record, and we cannot touch the
 * copy sitting in the member's own chat history on the platform's servers.
 */
export const DELETE_YOUR_MESSAGE =
  '⚠ 请手动删除你刚才那条消息 —— key 不会进阿同的对话记录/记忆,但它还留在聊天平台上。\n' +
  '/ Delete your own message — the key never enters Atong\'s memory, but the platform still has your copy.'

/**
 * HANDS-M3b — the fork answer was "keep the paste path AND add the link path,
 * and tell the member the trade-off of each". This is that sentence, and it is
 * written as a comparison rather than a recommendation on purpose: which one is
 * right depends on something we cannot see (is this a group chat? a work
 * account someone else administers? are you standing in a queue with no time to
 * open a browser?). Stating both costs honestly beats picking for them.
 */
const SETKEY_TWO_PATHS = [
  '两种方式,各有代价:',
  '  ① 直接贴  /setkey <目标> <key>',
  '     快,不用离开聊天窗;但 key 会留在聊天平台的记录里,你得自己删,而且删之前它已经过了平台的服务器。',
  '  ② 一次性链接  /setkey link',
  '     key 从不进聊天窗——你在浏览器里直接填给 hub;但要点开网页,链接 10 分钟内有效、只能用一次。',
  '/ ① paste = fast, but the key sits in your chat history. ② /setkey link = the key never enters the chat.',
].join('\n')

export const SETKEY_USAGE = [
  '用法:/setkey <目标> <key>',
  '',
  '  目标 = agent 的 id(如 assistant),或共享池 provider(anthropic / openai)',
  '  例:  /setkey assistant sk-xxxxxxxx',
  '',
  '先发 /keys 看有哪些槽位、哪些还空着。',
  '/ Usage: /setkey <agent-id|anthropic|openai> <key> — send /keys to see the slots.',
  '',
  SETKEY_TWO_PATHS,
  '',
  DELETE_YOUR_MESSAGE,
].join('\n')

/**
 * `/setkey` — text from an outcome, and ONLY from an outcome.
 *
 * This function deliberately does not take the raw target. `/setkey <key>
 * <agent>` (the arguments in the order a hurried person types them) parses as
 * target=<key>, so echoing "不认识目标「…」" would print a live key back into
 * the chat on exactly the slip this face should be forgiving about. Every
 * string below comes from the hub's own records instead, which is why there is
 * no sanitiser call here to get wrong: there is nothing member-supplied to
 * sanitise.
 *
 * `linkAvailable` decides whether the tail offers the other path. Pointing at
 * `/setkey link` on a hub that cannot mint one would be advice that fails when
 * taken — worse than not mentioning it, because the member is being told this
 * right after learning their key is now in their chat history.
 */
export function renderSetKeyOutcome(out: ImSetKeyOutcome, linkAvailable: boolean): string {
  // Appended to EVERY reply on this path, success or failure: the moment a
  // member reads "delete your own message" is the moment the alternative is
  // worth knowing about.
  const tail = linkAvailable
    ? `${DELETE_YOUR_MESSAGE}\n  想避免这一条?下次发 /setkey link,key 就不进聊天窗了。/ Or use /setkey link next time.`
    : DELETE_YOUR_MESSAGE
  if (!out.ok) {
    const head = ((): string => {
      switch (out.code) {
        case 'bad_secret':
          return out.reason === 'too_short'
            ? '✗ 没存 —— 这串太短,不像一把完整的 key(多半是粘贴时被截断了)。'
            : out.reason === 'too_long'
              ? '✗ 没存 —— 这串太长,不像一把 key。'
              : '✗ 没存 —— 这串里有换行/控制字符,多半是粘贴时带进了别的东西。'
        case 'unknown_target':
          // 刻意不回显你打的那个词——万一顺序打反了,那个词就是 key 本身。
          return (
            '✗ 没存 —— 第一个词不是这台 hub 认识的目标(注意顺序是「先目标后 key」)。\n' +
            `  可用的 agent:${out.agents.length > 0 ? out.agents.join('、') : '(无)'}\n` +
            `  可用的共享 provider:${out.providers.join('、')}`
          )
        case 'ambiguous_target':
          return (
            `✗ 没存 —— 「${out.target}」既是 agent 也是 provider,分不清你要改哪个。\n` +
            `  请写明:/setkey agent:${out.target} <key> 或 /setkey provider:${out.target} <key>`
          )
        case 'env_pinned':
          // Refusing here IS the honest answer: writing would have "succeeded"
          // and changed nothing, because an apiKeyEnv pin is exclusive.
          return (
            `✗ 没存 —— ${out.agentId} 的 key 被钉在服务器环境变量 ${out.envName} 上,` +
            '存进来的 key 永远轮不上。\n' +
            '  要换它,请在服务器上改那个环境变量并重启;或先在网页把这个 agent 的 apiKeyEnv 去掉。'
          )
        case 'mock_agent':
          return `✗ 没存 —— ${out.agentId} 是 mock provider,不用 key。`
        case 'vendor_ambiguous':
          return (
            '✗ 没存 —— openai-compatible 是一堆不同厂商共用的标签(DeepSeek / Qwen / MiMo …),' +
            '存一把共享 key 会被发给错的端点。\n' +
            `  请改成按 agent 存:${
              out.agents.length > 0
                ? out.agents.map((a) => `/setkey ${a} <key>`).join('  或  ')
                : '/setkey <agent-id> <key>'
            }`
          )
      }
    })()
    return `${head}\n\n${tail}`
  }

  const lines: string[] =
    out.slot === 'agent'
      ? [`✓ 已存入 —— ${out.agentId} 的专属 key(provider: ${out.provider})`]
      : [`✓ 已存入 —— 共享池的 ${out.provider} key`]
  if (out.slot === 'shared' && out.shadowed.length > 0) {
    lines.push(
      '  用不到它的:' +
        out.shadowed
          .map((s) => `${s.agentId}(${s.reason === 'per-agent' ? '有专属 key' : '钉了环境变量'})`)
          .join('、'),
    )
  }
  // Effect, stated exactly. A stored key that isn't running yet is not "done".
  const r = out.restart
  if (r.restarted.length > 0) {
    lines.push(`  已重启并生效:${r.restarted.join('、')}`)
  }
  if (r.failed.length > 0) {
    lines.push(`  ⚠ 重启失败:${r.failed.join('、')} —— key 已存好,但要等它下次启动才生效。`)
  }
  if (r.unavailable) {
    lines.push('  ⚠ 这台 host 没接 agent 重启,key 已存好,但要等下次启动才生效。')
  }
  if (r.restarted.length === 0 && r.failed.length === 0 && !r.unavailable) {
    lines.push('  (当前没有 agent 会用到它,存着备用。)')
  }
  return `${lines.join('\n')}\n\n${tail}`
}
