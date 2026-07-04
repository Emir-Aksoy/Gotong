/**
 * personal-butler-workflows.ts — the resident butler's BENIGN "run my workflow"
 * toolset (Stream-1 S1-M1).
 *
 * A member talking to the butler in IM can say "帮我跑每日复盘" and the butler
 * kicks off ONE of THEIR OWN member-facing workflows. It exposes two benign tools
 * (they run inline in the butler's loop, never park):
 *
 *   - `list_my_workflows` — what this member can run right now.
 *   - `run_my_workflow`   — start one, scoped to this member.
 *
 * ── Why this is safe to run inline (not governed) ────────────────────────────
 * Running the member's OWN published, member-facing workflow — scoped to
 * themselves — is exactly what they do by clicking "run" in the `/me` web
 * surface. It's a member self-service action, not a consequential-to-others one,
 * so it doesn't need an approval park. Any RISK inside the workflow (a `human:`
 * step, a cross-hub egress) gates ITSELF via its own inbox / outbound-approval
 * machinery — those parks happen downstream, transparent to this tool.
 *
 * ── The one security gate, mirrored from `/me` ───────────────────────────────
 * This deliberately re-implements the same resolution the web `/api/me/dispatch`
 * route applies (`evaluateMeSurface` in `packages/web/src/me-routes.ts`): a
 * workflow is runnable ONLY when it is `published` (Phase 15 lifecycle) AND
 * declares `surface.me.enabled` (Phase 14) AND allows the caller's role. The
 * scope key (`surface.me.userScopeField`, default `case_id`) is FORCE-SET to the
 * member's own `userId` server-side and dropped from the copyable inputs, so the
 * butler can never run a workflow on another member's behalf. This is a small,
 * pure mirror (with a pinning test) rather than a shared import because `web`
 * deliberately takes no `@aipehub/workflow` runtime dep — keep the two in sync.
 *
 * Host-only: it needs the host workflow surface (`list()`, satisfied by
 * `WorkflowController`) + `hub.dispatch`. Per-user — the router builds one butler
 * (and one of these) per `origin.userId`, bound to that member's id.
 */

import type {
  LlmAgentToolset,
  LlmToolCallResult,
  LlmToolDefinition,
} from '@aipehub/llm'

/**
 * Least-privilege default role for a butler-initiated run. A workflow that
 * restricts `surface.me.allowedRoles` to `['owner']` / `['admin']` stays in the
 * web `/me` surface; the shipped member-facing flows all use the default role set
 * (`owner`/`admin`/`member`), so `member` resolves every one of them. Kept
 * injectable (`ButlerWorkflowsDeps.role`) for a future real role lookup.
 */
const DEFAULT_BUTLER_ROLE = 'member'

/** Mirror of `/me`'s `DEFAULT_ME_ROLES` — the roles a workflow allows when it
 * declares none. Keep in sync with `packages/web/src/me-routes.ts`. */
const DEFAULT_ME_ROLES: readonly string[] = ['owner', 'admin', 'member']

/**
 * Narrow, duck-typed projection of a workflow summary — exactly what the run
 * gate reads. `WorkflowController.list()` satisfies it structurally. Mirror of
 * `MeWorkflowSummaryLike` in `packages/web/src/me-routes.ts`.
 */
export interface ButlerWorkflowSummary {
  id: string
  name?: string
  description?: string
  triggerCapability: string
  /** `surface.me` block (Phase 14) — structurally `MeSurfaceSpec`. */
  surfaceMe?: unknown
  /** Fallback dispatch-form fields when `surface.me.inputSchema` is absent. */
  payloadSchema?: unknown
  /** Phase 15 lifecycle — only `'published'` is member-facing. */
  state?: string
}

/** The host workflow surface the butler reads (published catalog). */
export interface ButlerWorkflowSurface {
  list(): Promise<ButlerWorkflowSummary[]>
}

/** The narrow slice of `Hub.dispatch` the run tool calls. */
export interface ButlerDispatchHub {
  dispatch(input: {
    from: string
    origin: { orgId: string; userId: string }
    strategy: { kind: 'capability'; capabilities: string[] }
    payload: Record<string, unknown>
    title: string
  }): Promise<unknown>
}

export interface ButlerWorkflowsDeps {
  /** The member this butler serves — runs are scoped to and attributed to them. */
  userId: string
  /** Caller role for the `allowedRoles` gate. Defaults to `member` (see above). */
  role?: string
  /** Published-workflow catalog (`WorkflowController`). */
  workflows: ButlerWorkflowSurface
  /** Hub dispatch surface. */
  hub: ButlerDispatchHub
  logger?: { error: (msg: string, meta?: Record<string, unknown>) => void }
}

// ---------------------------------------------------------------------------
// Pure resolution gate — mirror of web/me-routes.ts evaluateMeSurface.
// ---------------------------------------------------------------------------

interface MeSurfaceView {
  enabled: boolean
  label?: string
  description?: string
  inputSchema?: unknown[]
  allowedRoles?: string[]
  userScopeField?: string
}

/** A workflow resolved as runnable for a specific member. Exported (with
 * {@link evaluateRunnable}) for the LIFE-L1 workflow-schedule sweeper — a
 * scheduled run goes through the SAME member-facing gate as the butler tool,
 * one implementation, two consumers. */
export interface RunnableWorkflow {
  workflowId: string
  capability: string
  label: string
  description?: string
  inputSchema: unknown[]
  /** Field ids the run tool copies from `inputs` (scope key excluded). */
  inputFieldIds: string[]
  /** The payload key force-set to the member's own userId. */
  userScopeField: string
}

function readMeSurface(raw: unknown): MeSurfaceView | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const m = raw as Record<string, unknown>
  if (typeof m.enabled !== 'boolean') return null
  const view: MeSurfaceView = { enabled: m.enabled }
  if (typeof m.label === 'string') view.label = m.label
  if (typeof m.description === 'string') view.description = m.description
  if (Array.isArray(m.inputSchema)) view.inputSchema = m.inputSchema
  if (Array.isArray(m.allowedRoles)) {
    view.allowedRoles = m.allowedRoles.filter((r): r is string => typeof r === 'string')
  }
  if (typeof m.userScopeField === 'string') view.userScopeField = m.userScopeField
  return view
}

function fieldIds(schema: unknown[]): string[] {
  const ids: string[] = []
  for (const f of schema) {
    if (f && typeof f === 'object' && typeof (f as { id?: unknown }).id === 'string') {
      ids.push((f as { id: string }).id)
    }
  }
  return ids
}

/**
 * Decide whether `summary` is runnable for `role`. Returns null when the
 * workflow isn't published, isn't member-facing, or excludes the role. Pure
 * mirror of `evaluateMeSurface` — see file header.
 */
export function evaluateRunnable(
  summary: ButlerWorkflowSummary,
  role: string,
): RunnableWorkflow | null {
  // Phase 15: only a PUBLISHED workflow is member-facing. `state` absent only on
  // a legacy host predating lifecycle — there we let surface.me gate it.
  if (summary.state !== undefined && summary.state !== 'published') return null
  const me = readMeSurface(summary.surfaceMe)
  if (!me || me.enabled !== true) return null
  const allowedRoles = me.allowedRoles ?? DEFAULT_ME_ROLES
  if (!allowedRoles.includes(role)) return null
  const inputSchema = me.inputSchema ?? (Array.isArray(summary.payloadSchema) ? summary.payloadSchema : []) ?? []
  const userScopeField = me.userScopeField ?? 'case_id'
  const out: RunnableWorkflow = {
    workflowId: summary.id,
    capability: summary.triggerCapability,
    label: me.label ?? summary.name ?? summary.id,
    inputSchema,
    // The scope key is forced server-side — never copyable from the model's args.
    inputFieldIds: fieldIds(inputSchema).filter((id) => id !== userScopeField),
    userScopeField,
  }
  const description = me.description ?? summary.description
  if (description !== undefined) out.description = description
  return out
}

// ---------------------------------------------------------------------------
// Toolset
// ---------------------------------------------------------------------------

const RUN_TOOLS: LlmToolDefinition[] = [
  {
    name: 'list_my_workflows',
    description:
      '列出这个成员现在可以运行的工作流(已发布、对成员开放的）。先用它看看有哪些、需要哪些输入，再决定跑哪个。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'run_my_workflow',
    description:
      '替这个成员运行他自己的一个工作流(只能为他本人跑）。长任务在后台跑，跑完可在 /me 的「最近运行」看结果。运行前先用 list_my_workflows 确认 workflowId 和输入字段。',
    inputSchema: {
      type: 'object',
      properties: {
        workflowId: { type: 'string', description: '要运行的工作流 id(见 list_my_workflows）' },
        inputs: {
          type: 'object',
          description: '工作流的输入字段(字段名见 list_my_workflows）。不用填成员身份，会自动以本人身份运行。',
        },
      },
      required: ['workflowId'],
      additionalProperties: false,
    },
  },
]

class ButlerWorkflowsToolset implements LlmAgentToolset {
  constructor(private readonly deps: ButlerWorkflowsDeps) {}

  listTools(): LlmToolDefinition[] {
    return RUN_TOOLS
  }

  private get role(): string {
    return this.deps.role ?? DEFAULT_BUTLER_ROLE
  }

  private async runnable(): Promise<RunnableWorkflow[]> {
    let summaries: ButlerWorkflowSummary[]
    try {
      summaries = await this.deps.workflows.list()
    } catch (err) {
      // Fail closed: deny (empty catalog) rather than run on incomplete info.
      this.deps.logger?.error('butler workflows: list failed; denying', { err })
      return []
    }
    const out: RunnableWorkflow[] = []
    for (const s of summaries) {
      const r = evaluateRunnable(s, this.role)
      if (r) out.push(r)
    }
    return out
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<LlmToolCallResult> {
    if (name === 'list_my_workflows') return this.doList()
    if (name === 'run_my_workflow') return this.doRun(args)
    return text(`未知工具:${name}`, true)
  }

  private async doList(): Promise<LlmToolCallResult> {
    const runnable = await this.runnable()
    if (runnable.length === 0) {
      return text('你现在没有可运行的工作流(需要已发布且对成员开放的工作流）。')
    }
    const lines = runnable.map((w) => {
      const fields = w.inputFieldIds.length > 0 ? ` — 输入字段:${w.inputFieldIds.join('、')}` : ' — 无需输入'
      const desc = w.description ? `(${w.description})` : ''
      return `• ${w.label}${desc} [id: ${w.workflowId}]${fields}`
    })
    return text(`你可以运行的工作流:\n${lines.join('\n')}`)
  }

  private async doRun(args: Record<string, unknown>): Promise<LlmToolCallResult> {
    const workflowId = typeof args.workflowId === 'string' ? args.workflowId : ''
    if (!workflowId) return text('缺少 workflowId。先用 list_my_workflows 查看可运行的工作流。', true)

    const runnable = await this.runnable()
    const wf = runnable.find((w) => w.workflowId === workflowId)
    if (!wf) {
      const avail = runnable.map((w) => w.workflowId).join('、') || '(无)'
      return text(
        `工作流「${workflowId}」不可运行(没找到、未发布、或未对成员开放）。可运行的有:${avail}`,
        true,
      )
    }

    // Build the payload from DECLARED input fields only — drop any extra the
    // model passed (including the scope key, which isn't in inputFieldIds).
    const inputsIn =
      args.inputs && typeof args.inputs === 'object' && !Array.isArray(args.inputs)
        ? (args.inputs as Record<string, unknown>)
        : {}
    const payload: Record<string, unknown> = {}
    for (const field of wf.inputFieldIds) {
      if (field in inputsIn) payload[field] = inputsIn[field]
    }
    // Force the scope key to the member's own id — the one security invariant.
    payload[wf.userScopeField] = this.deps.userId

    // Fire-and-forget, mirroring `/me`: a workflow dispatch resolves only when
    // the run finishes (minutes → hours for human steps), so we can't await it
    // inside the butler's tool loop. The run shows up in /me「最近运行」; a later
    // milestone (S1-M3) pushes completion back to IM.
    try {
      void this.deps.hub
        .dispatch({
          from: this.deps.userId,
          origin: { orgId: 'local', userId: this.deps.userId },
          strategy: { kind: 'capability', capabilities: [wf.capability] },
          payload,
          title: `${wf.label} — ${this.deps.userId}`,
        })
        .catch((err) => {
          this.deps.logger?.error('butler workflows: dispatch failed', { err, workflowId })
        })
    } catch (err) {
      return text(`发起失败:${err instanceof Error ? err.message : String(err)}`, true)
    }
    return text(
      `好的，已经开始运行工作流「${wf.label}」。这类任务在后台跑，跑完你可以在 /me 的「最近运行」看结果。`,
    )
  }
}

function text(t: string, isError = false): LlmToolCallResult {
  return isError ? { content: [{ type: 'text', text: t }], isError: true } : { content: [{ type: 'text', text: t }] }
}

/**
 * Build the per-user benign "run my workflow" toolset for a resident butler.
 * Add it to `PersonalButlerAgent({ benign })`.
 */
export function buildButlerWorkflowsToolset(deps: ButlerWorkflowsDeps): LlmAgentToolset {
  return new ButlerWorkflowsToolset(deps)
}
