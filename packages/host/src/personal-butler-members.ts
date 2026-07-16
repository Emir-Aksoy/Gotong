/**
 * personal-butler-members.ts — SEN-M5. The butler's BENIGN membership eye:
 * "这台 hub 里有谁、什么角色、指派审批该填谁".
 *
 * Members had NO roster face at all — the family approval flow's "谁来批"
 * field is free text the member fills from out-of-band knowledge, and a
 * member asking Atong "谁是管理员?" got a guess. The disclosure fork was put
 * to the owner (SEN-M5, 2026-07-16) and decided as option A: every member
 * sees the roster as **display name + role + user id** — a hub's membership
 * is directory information inside the trust circle (same posture as
 * list_peers showing the mesh to everyone), and the user id is what a
 * workflow `assignee` actually needs (ids are identifiers, not credentials).
 *
 * ── Red line: email never enters the projection ──────────────────────────────
 * identity's `User` row carries `email` (a login identifier). The surface
 * SELECTs only id/displayName and joins the membership role — the projection
 * row has no email field, so the renderer structurally cannot leak it
 * (list_peers pinnedKid posture).
 *
 * ── Honesty notes ────────────────────────────────────────────────────────────
 * - identity has no user-disable mechanism today, so there is no hidden
 *   filtering — the roster IS everyone (we don't invent a state).
 * - A user whose membership row is missing renders 「(角色未知)」, never a
 *   guessed default; an unknown role string prints as-is.
 * - The per-user role lookup is one indexed query each (`getMembership`);
 *   hub rosters are small (家庭 ~5 / 团队 ~20), so N+1 here is noise.
 */

import type {
  LlmAgentToolset,
  LlmToolCallResult,
  LlmToolDefinition,
} from '@gotong/llm'

/** One member, projected directory-safe (no email / credentials / bindings). */
export interface ButlerMemberRow {
  userId: string
  name: string | null
  /** Membership role; null = row missing (rendered honestly, never guessed). */
  role: string | null
}

/** The roster the toolset reads. */
export interface ButlerMemberSurface {
  listForButler(): Promise<ButlerMemberRow[]>
}

/**
 * The two narrow identity slices the surface joins — duck-typed so the module
 * (and the factory handing these in) never imports IdentityStore, and the
 * email on the real `User` row stays out structurally: the join SELECTs
 * only the declared fields.
 */
export interface ButlerMemberSurfaceDeps {
  users: () => Array<{ id: string; displayName: string | null }>
  membershipRole: (userId: string) => string | null | undefined
}

const ROLE_ORDER: Record<string, number> = { owner: 0, admin: 1, member: 2, viewer: 3 }

/** Join users with their membership role into the member-safe roster. */
export function buildButlerMemberSurface(deps: ButlerMemberSurfaceDeps): ButlerMemberSurface {
  return {
    async listForButler() {
      const rows: ButlerMemberRow[] = deps.users().map((u) => ({
        userId: u.id,
        name: u.displayName,
        role: deps.membershipRole(u.id) ?? null,
      }))
      // Owners first, then by name — a stable, human-scannable order.
      return rows.sort(
        (a, b) =>
          (ROLE_ORDER[a.role ?? ''] ?? 9) - (ROLE_ORDER[b.role ?? ''] ?? 9) ||
          (a.name ?? '').localeCompare(b.name ?? ''),
      )
    },
  }
}

const LIST_TOOL: LlmToolDefinition = {
  name: 'list_members',
  description:
    '看这台 hub 里有哪些成员:各自的名字、角色(owner/admin/member/viewer)和成员 id。成员问「hub 里有谁」「谁是管理员」,或建工作流要指派某个人(审批人/assignee 填的是成员 id)时用它。',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
}

export interface ButlerMembersDeps {
  members: ButlerMemberSurface
  logger?: { error: (msg: string, meta?: Record<string, unknown>) => void }
}

/** Role → 中文括注; an unknown role prints as-is (never mistranslated). */
function roleLabel(role: string | null): string {
  if (role === null) return '(角色未知)'
  const zh: Record<string, string> = { owner: '拥有者', admin: '管理员', member: '成员', viewer: '只读' }
  return zh[role] ? `${role}(${zh[role]})` : role
}

class ButlerMembersToolset implements LlmAgentToolset {
  constructor(private readonly deps: ButlerMembersDeps) {}

  listTools(): LlmToolDefinition[] {
    return [LIST_TOOL]
  }

  async callTool(name: string): Promise<LlmToolCallResult> {
    if (name !== 'list_members') return text(`未知工具:${name}`, true)
    let rows: ButlerMemberRow[]
    try {
      rows = await this.deps.members.listForButler()
    } catch (err) {
      this.deps.logger?.error('butler members: list failed', { err })
      return text('暂时读不到成员列表,稍后再试。', true)
    }
    if (rows.length === 0) return text('这台 hub 还没有任何成员。')
    const lines = rows.map(
      (r) => `- ${r.name ?? '(未设名)'} — ${roleLabel(r.role)};id: ${r.userId}`,
    )
    return text(
      `hub 里的成员(${rows.length} 人):\n${lines.join('\n')}\n提示:工作流要指派某个人(审批人/assignee)时,填 id 那串,不是名字。`,
    )
  }
}

function text(t: string, isError = false): LlmToolCallResult {
  return isError ? { content: [{ type: 'text', text: t }], isError: true } : { content: [{ type: 'text', text: t }] }
}

/**
 * Build the benign membership eye. Directory tier (AFR-M3); the factory drops
 * it when the identity slices are absent (no identity store wired).
 */
export function buildButlerMembersToolset(deps: ButlerMembersDeps): LlmAgentToolset {
  return new ButlerMembersToolset(deps)
}
