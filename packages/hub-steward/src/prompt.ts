/**
 * The steward's prompt + the LLM-reply → `StewardProposal` pipeline.
 *
 * Two halves:
 *   1. `STEWARD_SYSTEM_PROMPT` / `renderStewardUserMessage` — what we send the LLM.
 *   2. `parseStewardProposal` (+ `validateStewardAction`) — how we turn the
 *      reply back into actions. This second half is a SECURITY BOUNDARY: the
 *      LLM's output is untrusted data (ClawWorm lesson), so only well-formed
 *      actions survive validation, and even those are re-classified +
 *      re-authorized server-side before anything executes. Malformed actions
 *      are silently dropped — they never run.
 *
 * Pure (no `@aipehub/llm`): the agent (which uses llm) imports these; the host
 * could too. No prompt knowledge leaks into the classifier or the executor.
 */

import type {
  HubStewardPayload,
  StewardAction,
  StewardAgentFields,
  StewardAgentProvider,
  StewardParseStatus,
  StewardProposal,
  StewardSnapshot,
} from './types.js'

// ---------------------------------------------------------------------------
// System prompt — the steward's contract. Kept in the same voice as the
// workflow assistant's prompt; the `reply` follows the member's language.
// ---------------------------------------------------------------------------

export const STEWARD_SYSTEM_PROMPT = `You are the AipeHub "hub steward" (管家). A member talks to you in plain language to manage THEIR OWN resources on this hub — their managed agents and their workflows. You turn each instruction into a STRUCTURED PROPOSAL. You do NOT execute anything yourself: the host re-checks every action and runs it, and asks the member for a SECOND confirmation on anything dangerous or cross-hub.

# What you return

A single JSON object: { "reply": string, "actions": Action[] }.
  - "reply": a short conversational reply IN THE MEMBER'S LANGUAGE (中文 if they wrote 中文).
  - "actions": zero or more concrete actions. Empty for pure chit-chat or when you need to ask a clarifying question (put the question in "reply").

# Action shapes (discriminated by "kind")

  { "kind": "inspect", "answer": "..." }
      Answer a read-only question about what the member owns. Nothing changes.

  { "kind": "create_agent", "handle": "short-handle", "label": "Human label",
    "provider": "anthropic" | "openai", "model": "optional-model-id",
    "system": "the new agent's system prompt", "capabilities": ["cap-a", "cap-b"] }
      Build a new managed agent for the member. "handle" is a short slug; the host
      turns it into the real id. Choose capability tags that describe what it does.

  { "kind": "edit_agent", "agentId": "me.<user>.<handle>",
    "changes": { "label"?: "...", "system"?: "...", "model"?: "...",
                 "provider"?: "anthropic"|"openai", "capabilities"?: ["..."] } }
      Change an agent the member already owns. Include ONLY the fields that change.
      You cannot change its handle / id.

  { "kind": "delete_agent", "agentId": "me.<user>.<handle>" }
      Remove an agent. THIS IS DANGEROUS — the host requires a SECOND human
      confirmation. Only PROPOSE it; never say it is already done.

  { "kind": "edit_workflow", "workflowId": "...", "instruction": "plain-language change" }
      Change one of the member's workflows. The host hands your "instruction" to the
      workflow editor. If the workflow is CROSS-HUB (flagged in the snapshot), the host
      requires a SECOND human confirmation and its entry/exit (trigger + cross-hub
      steps) stays byte-for-byte locked — you may only change the local parts.

  { "kind": "refuse", "reason": "..." }
      Use for anything OUT OF SCOPE: API credentials / keys, peer (cross-org) trust,
      security settings, access-control grants, billing. You cannot change those here.
      Explain briefly and point the member to the relevant settings page.

# Hard rules

1. DANGEROUS (delete_agent) and CROSS-HUB (edit_workflow on a cross-hub workflow)
   actions: you may only PROPOSE them. They ALWAYS require a second human confirmation
   in the member's inbox. NEVER claim you have already done them — phrase "reply" as
   "I'll prepare … for your confirmation."
2. Credentials / peers / security / RBAC grants / billing are OUT OF SCOPE. Emit a
   "refuse" action — do NOT invent a create/edit/delete action that touches them.
3. Act only on the member's OWN agents / workflows shown in the snapshot. If asked
   about something not listed, say you don't see it (inspect / refuse) — never guess an id.
4. Use the ids and capability names EXACTLY as shown in the snapshot. Don't invent ids.

# Output format

Reply with exactly one \`\`\`json … \`\`\` code fence containing the { "reply", "actions" }
object, and nothing else outside the fence. Do not include any other code fence.`

/** Allow a custom system prompt at construction; default is the built-in one. */
export function buildStewardSystemPrompt(override?: string): string {
  return override ?? STEWARD_SYSTEM_PROMPT
}

// ---------------------------------------------------------------------------
// Operator console variant (SW-M9 A-M5; sensitive writes graduated in B-M4).
// Same OUTPUT CONTRACT (one ```json fence → { reply, actions }) and the same
// second-confirmation discipline as the member prompt — so `parseStewardProposal`
// handles both unchanged — but the steward now manages the WHOLE hub's resources,
// not one member's. The one create-shape difference: `create_agent.handle` is the
// agent's FULL site-wide id (the operator names agents directly;
// `HostOperatorAgentService.create` uses it verbatim), NOT a slug the host
// namespaces under `me.<user>.`.
//
// Phase B graduates credentials / peers / security from `refuse` (Phase A) to
// operator-only actions: the operator steward MAY propose `set_credential_ref` /
// `revoke_credential` / `set_peer_policy` / `set_security_quota`, but every one is
// the HIGHEST tier and ALWAYS routes through the approval inbox (stricter than a
// delete). The key-safety invariant lives in the prompt too: a credential action
// only ever NAMES a host env var, never a plaintext secret. RBAC grants / billing
// stay out of scope (still a `refuse`). The MEMBER prompt is untouched — those
// four kinds are `forbidden` there, so it never learns the vocabulary.
// ---------------------------------------------------------------------------

export const OPERATOR_STEWARD_SYSTEM_PROMPT = `You are the AipeHub "hub steward" (管家) running in the OPERATOR console. The hub operator (an administrator) talks to you in plain language to manage THE WHOLE HUB'S resources — every managed agent and every workflow on this hub, not one member's. You turn each instruction into a STRUCTURED PROPOSAL. You do NOT execute anything yourself: the host re-checks every action and runs it, and asks for a SECOND confirmation on anything dangerous or cross-hub.

# What you return

A single JSON object: { "reply": string, "actions": Action[] }.
  - "reply": a short conversational reply IN THE OPERATOR'S LANGUAGE (中文 if they wrote 中文).
  - "actions": zero or more concrete actions. Empty for pure chit-chat or when you need to ask a clarifying question (put the question in "reply").

# Action shapes (discriminated by "kind")

  { "kind": "inspect", "answer": "..." }
      Answer a read-only question about the hub's agents / workflows. Nothing changes.

  { "kind": "create_agent", "handle": "site-wide-agent-id", "label": "Human label",
    "provider": "anthropic" | "openai", "model": "optional-model-id",
    "system": "the new agent's system prompt", "capabilities": ["cap-a", "cap-b"] }
      Build a new managed agent for the hub. "handle" is the agent's FULL id
      (e.g. "support-bot" or "ops.mailer") — it is used VERBATIM, not namespaced.
      Choose capability tags that describe what it does.

  { "kind": "edit_agent", "agentId": "<id from the snapshot>",
    "changes": { "label"?: "...", "system"?: "...", "model"?: "...",
                 "provider"?: "anthropic"|"openai", "capabilities"?: ["..."] } }
      Change an existing managed agent. Include ONLY the fields that change. You
      cannot change its id.

  { "kind": "delete_agent", "agentId": "<id from the snapshot>" }
      Remove a managed agent. THIS IS DANGEROUS — the host requires a SECOND human
      confirmation in the operator's inbox. Only PROPOSE it; never say it is done.

  { "kind": "edit_workflow", "workflowId": "...", "instruction": "plain-language change" }
      Change one of the hub's workflows. The host hands your "instruction" to the
      workflow editor. If the workflow is CROSS-HUB (flagged in the snapshot), the host
      requires a SECOND human confirmation and its entry/exit (trigger + cross-hub
      steps) stays byte-for-byte locked — you may only change the local parts.

  { "kind": "set_credential_ref", "provider": "anthropic" | "openai",
    "envVarName": "NAME_OF_A_HOST_ENV_VAR", "label": "optional human label" }
      Register a hub-wide LLM provider credential. You NAME the host env var that holds
      the secret — you NEVER write the secret itself. The operator sets that env var on
      the host out of band; the host reads it at apply time. SENSITIVE — always a second
      confirmation.

  { "kind": "revoke_credential", "credentialId": "<id from an inspect>" }
      Revoke a hub-wide provider credential by id. SENSITIVE — always a second confirmation.

  { "kind": "set_peer_policy", "peerId": "<peer id>",
    "allowedDataClasses"?: ["public", "..."], "perLinkQuotaBudget"?: 1000,
    "shareSummary"?: true }
      Change a cross-org peer link's trust contract: which data classes may leave, its
      per-link quota, whether to share the control-plane summary. Include ONLY the fields
      that change. SENSITIVE — always a second confirmation.

  { "kind": "set_security_quota", "scope": "hub" | "<userId>",
    "metric": "llm_tokens" | "llm_cost_micros" | "...",
    "period": "hourly" | "daily" | "monthly" | "total", "limit": 1000 }
      Set a usage quota. scope "hub" caps the whole hub; any other scope is a specific
      user. SENSITIVE — always a second confirmation.

  { "kind": "refuse", "reason": "..." }
      Use for anything OUT OF SCOPE HERE: access-control (RBAC) grants and billing.
      Explain briefly and point to the relevant admin settings page.

# Hard rules

1. SECOND-CONFIRMATION actions — delete_agent (DANGEROUS), edit_workflow on a cross-hub
   workflow (CROSS-HUB), and ALL FOUR sensitive writes (set_credential_ref /
   revoke_credential / set_peer_policy / set_security_quota): you may only PROPOSE them.
   Every one ALWAYS requires a second human confirmation in the operator's inbox — the
   sensitive writes are the highest-risk, stricter than a delete. NEVER claim you have
   already done them — phrase "reply" as "I'll prepare … for your confirmation."
2. NEVER put a plaintext secret / key / token / password in ANY action. A credential is
   registered by NAMING the host env var that holds it (envVarName); the operator sets
   that env var out of band and the host reads it at apply time. A field that looks like
   a secret gets the whole action rejected.
3. RBAC access-control grants and billing are OUT OF SCOPE here — emit a "refuse" for
   those. (Credentials / peers / security quotas are now IN scope, via the actions above.)
4. Act only on the agents / workflows / peers shown in the snapshot or surfaced by an
   inspect. If asked about something not listed, say you don't see it (inspect / refuse)
   — never guess an id.
5. Use the ids and capability names EXACTLY as shown in the snapshot. Don't invent ids.

# Output format

Reply with exactly one \`\`\`json … \`\`\` code fence containing the { "reply", "actions" }
object, and nothing else outside the fence. Do not include any other code fence.`

/** The operator console steward's system prompt (wired via the `systemOverride` seam). */
export function buildOperatorStewardSystemPrompt(): string {
  return OPERATOR_STEWARD_SYSTEM_PROMPT
}

// ---------------------------------------------------------------------------
// User message — the instruction + a compact render of the owned-resource
// snapshot. Stable formatting so test snapshots don't churn.
// ---------------------------------------------------------------------------

export function renderStewardUserMessage(payload: HubStewardPayload): string {
  const lines: string[] = [payload.instruction.trim()]
  const snap = payload.snapshot
  if (snap) {
    const ctx = renderSnapshot(snap)
    if (ctx.length > 0) {
      lines.push('')
      lines.push('---')
      lines.push(...ctx)
    }
  }
  return lines.join('\n')
}

function renderSnapshot(snap: StewardSnapshot): string[] {
  const ctx: string[] = []
  if (snap.agents && snap.agents.length > 0) {
    ctx.push('Your agents:')
    for (const a of snap.agents) {
      const caps = a.capabilities.join(', ')
      const label = a.label ? ` "${a.label}"` : ''
      const prov = a.provider ? ` (${a.provider})` : ''
      ctx.push(`  - ${a.id}${label} [${caps}]${prov}`)
    }
  } else {
    ctx.push('Your agents: (none yet)')
  }
  if (snap.workflows && snap.workflows.length > 0) {
    ctx.push('Your workflows:')
    for (const w of snap.workflows) {
      const name = w.name ? ` "${w.name}"` : ''
      const tag = w.crossHub ? ' [CROSS-HUB — edits need a second confirmation]' : ''
      ctx.push(`  - ${w.id}${name}${tag}`)
    }
  }
  if (snap.providers && snap.providers.length > 0) {
    ctx.push(`Providers you can use: ${snap.providers.join(', ')}`)
  }
  return ctx
}

// ---------------------------------------------------------------------------
// Reply → proposal pipeline. The security boundary.
// ---------------------------------------------------------------------------

/**
 * Extract + parse a `StewardProposal` from the raw LLM reply.
 *
 * Tries, in order: a ```json fence, a first-`{`-to-last-`}` brace span, the
 * whole trimmed text if it starts with `{`. The first candidate that
 * `JSON.parse`s into a plain object wins. Each action in `actions[]` is run
 * through {@link validateStewardAction}; only well-formed ones survive.
 *
 * Never throws — a refusal / clarifying-question / botched-JSON reply all come
 * back as `{ reply: <raw>, actions: [] }` with the appropriate status.
 */
export function parseStewardProposal(raw: string): {
  proposal: StewardProposal
  status: StewardParseStatus
} {
  for (const candidate of jsonCandidates(raw)) {
    let parsed: unknown
    try {
      parsed = JSON.parse(candidate)
    } catch {
      continue
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { proposal: proposalFromObject(parsed as Record<string, unknown>, raw), status: 'ok' }
    }
  }
  // Nothing parsed. A stray '{' means the model tried JSON and botched it
  // ('invalid'); no brace at all means it just chatted in prose ('no_json').
  const status: StewardParseStatus = raw.includes('{') ? 'invalid' : 'no_json'
  return { proposal: { reply: raw.trim(), actions: [] }, status }
}

/** Ordered JSON-text candidates pulled from a raw reply. */
function jsonCandidates(raw: string): string[] {
  const out: string[] = []
  const fence = /```(?:json)?\s*\n([\s\S]*?)```/i.exec(raw)
  if (fence?.[1]) out.push(fence[1].trim())
  const first = raw.indexOf('{')
  const last = raw.lastIndexOf('}')
  if (first !== -1 && last > first) out.push(raw.slice(first, last + 1).trim())
  const trimmed = raw.trim()
  if (trimmed.startsWith('{')) out.push(trimmed)
  return out
}

function proposalFromObject(obj: Record<string, unknown>, raw: string): StewardProposal {
  const reply = isStr(obj.reply) ? obj.reply.trim() : raw.trim()
  const actions: StewardAction[] = []
  if (Array.isArray(obj.actions)) {
    for (const a of obj.actions) {
      const v = validateStewardAction(a)
      if (v) actions.push(v)
    }
  }
  return { reply, actions }
}

/** The providers a steward-built agent may name. Host re-validates vs live keys. */
const STEWARD_PROVIDERS: readonly StewardAgentProvider[] = ['anthropic', 'openai', 'mock']

/**
 * Validate one untrusted action object into a typed `StewardAction`, or `null`
 * if it's malformed. This is the gate: anything the LLM emits that doesn't match
 * a known shape is dropped (never executed). Conservative on purpose — a missing
 * required field rejects the whole action rather than executing a half-formed one.
 */
export function validateStewardAction(x: unknown): StewardAction | null {
  if (!x || typeof x !== 'object') return null
  const o = x as Record<string, unknown>
  switch (o.kind) {
    case 'inspect':
      return isStr(o.answer) ? { kind: 'inspect', answer: o.answer } : null
    case 'create_agent': {
      const fields = validateAgentFields(o)
      return fields ? { kind: 'create_agent', ...fields } : null
    }
    case 'edit_agent': {
      if (!isNonEmptyStr(o.agentId)) return null
      const changes = validatePartialAgentFields(o.changes)
      return changes ? { kind: 'edit_agent', agentId: o.agentId.trim(), changes } : null
    }
    case 'delete_agent':
      return isNonEmptyStr(o.agentId) ? { kind: 'delete_agent', agentId: o.agentId.trim() } : null
    case 'edit_workflow':
      return isNonEmptyStr(o.workflowId) && isNonEmptyStr(o.instruction)
        ? { kind: 'edit_workflow', workflowId: o.workflowId.trim(), instruction: o.instruction.trim() }
        : null
    // ── Phase B sensitive writes ──────────────────────────────────────────────
    // Every sensitive-kind validation FIRST rejects the whole action if it
    // carries a key-shaped field. A steward action must never transport a
    // plaintext secret (it only ever NAMES an env var); a model that put one
    // here misunderstood the contract, so we don't trust the rest of it either.
    case 'set_credential_ref': {
      if (hasSecretShapedField(o)) return null
      if (!isNonEmptyStr(o.provider) || !isNonEmptyStr(o.envVarName)) return null
      const a: Extract<StewardAction, { kind: 'set_credential_ref' }> = {
        kind: 'set_credential_ref',
        provider: o.provider.trim(),
        envVarName: o.envVarName.trim(),
      }
      if (isNonEmptyStr(o.label)) a.label = o.label.trim()
      return a
    }
    case 'revoke_credential':
      if (hasSecretShapedField(o)) return null
      return isNonEmptyStr(o.credentialId)
        ? { kind: 'revoke_credential', credentialId: o.credentialId.trim() }
        : null
    case 'set_peer_policy': {
      if (hasSecretShapedField(o)) return null
      if (!isNonEmptyStr(o.peerId)) return null
      const a: Extract<StewardAction, { kind: 'set_peer_policy' }> = {
        kind: 'set_peer_policy',
        peerId: o.peerId.trim(),
      }
      if ('allowedDataClasses' in o) {
        if (!isStrArray(o.allowedDataClasses)) return null
        a.allowedDataClasses = o.allowedDataClasses
      }
      if ('perLinkQuotaBudget' in o) {
        if (!isNonNegNumber(o.perLinkQuotaBudget)) return null
        a.perLinkQuotaBudget = o.perLinkQuotaBudget
      }
      if ('shareSummary' in o) {
        if (typeof o.shareSummary !== 'boolean') return null
        a.shareSummary = o.shareSummary
      }
      // A policy change with no actual field is a pointless approval — reject it.
      if (
        a.allowedDataClasses === undefined &&
        a.perLinkQuotaBudget === undefined &&
        a.shareSummary === undefined
      )
        return null
      return a
    }
    case 'set_security_quota':
      if (hasSecretShapedField(o)) return null
      return isNonEmptyStr(o.scope) &&
        isNonEmptyStr(o.metric) &&
        isNonEmptyStr(o.period) &&
        isNonNegNumber(o.limit)
        ? {
            kind: 'set_security_quota',
            scope: o.scope.trim(),
            metric: o.metric.trim(),
            period: o.period.trim(),
            limit: o.limit,
          }
        : null
    case 'refuse':
      return isNonEmptyStr(o.reason) ? { kind: 'refuse', reason: o.reason.trim() } : null
    default:
      return null
  }
}

/** Validate a complete agent spec (for create). */
function validateAgentFields(o: Record<string, unknown>): StewardAgentFields | null {
  if (!isNonEmptyStr(o.handle)) return null
  if (!isNonEmptyStr(o.label)) return null
  if (!isStr(o.provider) || !STEWARD_PROVIDERS.includes(o.provider as StewardAgentProvider)) return null
  if (!isNonEmptyStr(o.system)) return null
  if (!isStrArray(o.capabilities) || o.capabilities.length === 0) return null
  const fields: StewardAgentFields = {
    handle: o.handle.trim(),
    label: o.label.trim(),
    provider: o.provider as StewardAgentProvider,
    system: o.system,
    capabilities: o.capabilities,
  }
  if (isNonEmptyStr(o.model)) fields.model = o.model.trim()
  return fields
}

/** Validate a subset of agent fields (for edit). Must carry at least one change. */
function validatePartialAgentFields(x: unknown): Partial<StewardAgentFields> | null {
  if (!x || typeof x !== 'object') return null
  const o = x as Record<string, unknown>
  const out: Partial<StewardAgentFields> = {}
  if ('label' in o) {
    if (!isNonEmptyStr(o.label)) return null
    out.label = o.label.trim()
  }
  if ('provider' in o) {
    if (!isStr(o.provider) || !STEWARD_PROVIDERS.includes(o.provider as StewardAgentProvider)) return null
    out.provider = o.provider as StewardAgentProvider
  }
  if ('model' in o) {
    if (!isNonEmptyStr(o.model)) return null
    out.model = o.model.trim()
  }
  if ('system' in o) {
    if (!isNonEmptyStr(o.system)) return null
    out.system = o.system
  }
  if ('capabilities' in o) {
    if (!isStrArray(o.capabilities) || o.capabilities.length === 0) return null
    out.capabilities = o.capabilities
  }
  // `handle` is intentionally NOT editable — it's the agent's identity (the host
  // composes the id from it). A model that puts `handle` in `changes` just has it
  // ignored here; the rest of the edit still applies.
  return Object.keys(out).length > 0 ? out : null
}

// --- sensitive-write secret guard -------------------------------------------

/**
 * Field NAMES a sensitive steward action must never carry — a steward only ever
 * names an env var, never a secret. Matched by EXACT normalized name (lowercase,
 * `_`/`-` stripped) so legitimate fields like `credentialId` / `envVarName` /
 * `perLinkQuotaBudget` are not false-positives (substring matching would flag
 * `credentialId` for "credential" and break every revoke). This is the R3
 * mitigation: nothing key-shaped survives into a proposal / inbox / transcript.
 */
const SECRET_FIELD_NAMES: ReadonlySet<string> = new Set([
  'secret',
  'secrets',
  'apikey',
  'apikeys',
  'key',
  'keys',
  'token',
  'tokens',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'sessiontoken',
  'bearer',
  'auth',
  'authorization',
  'password',
  'passwd',
  'pwd',
  'passphrase',
  'privatekey',
  'clientsecret',
  'credential',
  'credentials',
])

function normFieldName(name: string): string {
  return name.toLowerCase().replace(/[_-]/g, '')
}

/** True if `o` has any own field whose normalized name is a known secret name. */
function hasSecretShapedField(o: Record<string, unknown>): boolean {
  for (const name of Object.keys(o)) {
    if (SECRET_FIELD_NAMES.has(normFieldName(name))) return true
  }
  return false
}

// --- tiny type guards -------------------------------------------------------

function isStr(x: unknown): x is string {
  return typeof x === 'string'
}
function isNonEmptyStr(x: unknown): x is string {
  return typeof x === 'string' && x.trim().length > 0
}
function isStrArray(x: unknown): x is string[] {
  return Array.isArray(x) && x.every((e) => typeof e === 'string')
}
function isNonNegNumber(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x) && x >= 0
}
