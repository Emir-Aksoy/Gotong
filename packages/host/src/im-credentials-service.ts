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
