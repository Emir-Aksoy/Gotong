// Deployment profile — the entry-surface *lens*, not a behavior fork.
//
// AipeHub's real dividing line is "within one hub" vs "across hubs", but the
// entry UX still frames things as the old "individual vs organization" axis
// (缺口 1). A hub is the node unit: one person + their agents is a sovereign
// hub; a cluster of agents can be a non-sovereign hub; workflows run inside a
// hub OR across hubs. Teams and organizations are BOTH just "cross-hub".
//
// `AIPE_PROFILE` lets a deployer pick which mental model the entry surface
// leads with:
//   - hub         → foreground within-hub work (one node)
//   - federation  → foreground cross-hub work (many nodes linked)
//   - unset       → byte-identical to today (no profile line, nothing reordered)
//
// This is a PRESENTATION lens only. It reorders/annotates the entry banner and
// docs; it does NOT enable or disable any code path. Federation code runs the
// same under `hub`, and single-hub code runs the same under `federation` — the
// profile just decides what to *show first*. Everything here is pure and
// injectable so it unit-tests without booting a host. No core/protocol/identity
// behavior changes.

export type ProfileId = 'hub' | 'federation'

export interface ProfileDescriptor {
  id: ProfileId
  /** Short name for the active lens. */
  labelZh: string
  labelEn: string
  /** One line: the mental model this lens leads with. */
  taglineZh: string
  taglineEn: string
  /** The "within-hub vs cross-hub" framing correction, one line. */
  framingZh: string
  framingEn: string
  /** Capability groups this lens foregrounds (bilingual short labels). */
  leadsZh: string[]
  leadsEn: string[]
  /** Where to read more for this lens (repo-relative). */
  docPath: string
}

export const PROFILES: Record<ProfileId, ProfileDescriptor> = {
  hub: {
    id: 'hub',
    labelZh: 'hub 内（单节点）',
    labelEn: 'within-hub (single node)',
    taglineZh: '一个节点：你和你的 agent 在同一个 hub 内协作。',
    taglineEn: 'One node: you and your agents collaborate inside a single hub.',
    framingZh: '一个人 + 自己的 agent = 主权 hub；多 agent 也能组成非主权 hub。工作在 hub 内完成。',
    framingEn: 'One person + their agents = a sovereign hub; agents alone can form a non-sovereign one. Work happens inside the hub.',
    leadsZh: ['个人管家', '模板画廊一键装', 'hub 内工作流', '/me 收件箱', 'MCP 连接器'],
    leadsEn: ['personal butler', 'template gallery', 'in-hub workflows', '/me inbox', 'MCP connectors'],
    docPath: 'docs/zh/HANDS-ON-HUBS.md',
  },
  federation: {
    id: 'federation',
    labelZh: '跨 hub（多节点相连）',
    labelEn: 'cross-hub (many nodes linked)',
    taglineZh: '多个 hub 相连：团队 / 组织都是「跨 hub」，凭证与数据各归各家。',
    taglineEn: 'Many hubs linked: teams and orgs are both "cross-hub"; credentials and data stay with each.',
    framingZh: '真正的分界是「hub 内 vs 跨 hub」，不是「个人 vs 组织」——团队和组织都归跨 hub。',
    framingEn: 'The real divide is "within-hub vs cross-hub", not "individual vs organization" — teams and orgs both fold into cross-hub.',
    leadsZh: ['peer 注册与信任契约', '跨 hub 工作流编排', '出站 A2A', '联邦能力 manifest', '两机操作员 runbook'],
    leadsEn: ['peers & trust contracts', 'cross-hub orchestration', 'outbound A2A', 'federation manifest', 'two-host runbook'],
    docPath: 'docs/zh/FEDERATION-RUNBOOK.md',
  },
}

/** Canonical forms plus a few forgiving aliases → the two profile ids. Anything
 *  else (including unset/empty) is NOT a profile — see {@link resolveProfileEnv}. */
const ALIASES: Record<string, ProfileId> = {
  hub: 'hub',
  node: 'hub',
  single: 'hub',
  'single-node': 'hub',
  local: 'hub',
  personal: 'hub',
  federation: 'federation',
  fed: 'federation',
  'cross-hub': 'federation',
  crosshub: 'federation',
  team: 'federation',
  org: 'federation',
  organization: 'federation',
}

/**
 * Pure parse of `AIPE_PROFILE`. Returns the profile id for a recognized value,
 * or `undefined` for unset / empty / unrecognized. Deliberately case- and
 * whitespace-insensitive; underscores normalize to hyphens so `single_node`
 * works too.
 *
 * This function cannot tell "unset" from "typo" — both are `undefined`. Callers
 * that want to warn on a typo should use {@link resolveProfileEnv}, which
 * distinguishes the two.
 */
export function parseProfileEnv(raw: string | undefined): ProfileId | undefined {
  const key = (raw ?? '').trim().toLowerCase().replace(/_/g, '-')
  if (key === '') return undefined
  return ALIASES[key]
}

export interface ResolvedProfile {
  /** The active profile id, if one was recognized. */
  id?: ProfileId
  /** The descriptor for {@link id}, if recognized. */
  descriptor?: ProfileDescriptor
  /** Set only when a NON-EMPTY value was given but matched no profile — i.e. a
   *  likely typo the caller should warn about. Absent when the value was unset. */
  unrecognized?: string
}

/**
 * Resolve `AIPE_PROFILE` into a lens decision, distinguishing three cases:
 *   - unset / empty        → `{}`                    (byte-identical default)
 *   - recognized value     → `{ id, descriptor }`
 *   - non-empty but bad     → `{ unrecognized: raw }` (caller warns, then defaults)
 *
 * The default case returns an empty object on purpose: the wiring layer treats
 * "no id" as "render exactly like today", so an unset profile changes nothing.
 */
export function resolveProfileEnv(raw: string | undefined): ResolvedProfile {
  const id = parseProfileEnv(raw)
  if (id) return { id, descriptor: PROFILES[id] }
  const trimmed = (raw ?? '').trim()
  if (trimmed === '') return {} // unset — the byte-identical default
  return { unrecognized: trimmed } // set-but-unknown — a typo worth surfacing
}

/**
 * The entry-banner lines for an active lens — bilingual, width-safe (no
 * box-drawing so CJK double-width glyphs don't misalign). Returns `[]` for the
 * unset default so the caller can spread it into today's banner and add nothing.
 *
 * Presentation only; the wiring layer (PRO-M2) decides where these slot in.
 */
export function profileBannerLines(resolved: ResolvedProfile): string[] {
  const d = resolved.descriptor
  if (!d) return []
  return [
    ``,
    `视角 / Profile:  ${d.labelZh}  ·  ${d.labelEn}`,
    `  ${d.taglineZh}`,
    `  ${d.taglineEn}`,
    `  先看 / leads with:  ${d.leadsZh.join(' · ')}`,
    `  读 / read:  ${d.docPath}`,
  ]
}
