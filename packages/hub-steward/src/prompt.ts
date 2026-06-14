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
