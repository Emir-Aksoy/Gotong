/**
 * A1 待办审批提醒 — a zero-LLM per-turn card that makes the butler AWARE the
 * member still has items parked in their `/me` inbox awaiting their OWN
 * decision: a governed action the butler proposed but cannot self-approve
 * (change hub / spend / send / delete), or a workflow human step.
 *
 * # Why the butler needs this
 *
 * Governed actions PARK to `/me` (`SuspendTaskError` → inbox) and the member is
 * pinged once at park time — but on a LATER conversation the butler otherwise
 * has no idea anything is still waiting, so a forgotten approval just rots. This
 * card lets the butler nudge naturally ("你还有 N 件事等确认哦") whenever the
 * member next talks to it.
 *
 * # How it stays cheap + safe
 *
 *  - Rides the SAME per-turn `contextProbe` tail as the clock / onboarding cards
 *    (`composeContextProbes`), so the byte-stable frozen block — the prompt-cache
 *    prefix — is untouched. An empty inbox → `null` → nothing injected → the
 *    prompt is byte-identical to today.
 *  - The framework runs no model here — it's a count + a few titles.
 *  - READ-ONLY: the probe never resolves anything. Approval stays the member's
 *    own act via the `/me` panel; the butler only reminds, never self-approves
 *    (the whole point of the governed park).
 *  - Every failure path returns `null` (advisory — a sick inbox read must never
 *    take normal chat down with it).
 */

/** One parked item, projected to just what the card needs (matches the shape of
 *  `HostInboxService.listPending`'s rows — kind + prompt, title optional). */
export interface ButlerPendingItem {
  /** `'approval'` | `'choice'` | `'edit'` — the human-step kind. */
  kind: string
  title?: string
  prompt: string
}

/** The narrow read surface the probe needs: the member's pending inbox items.
 *  `HostInboxService` satisfies it structurally (no import → no coupling). */
export interface ButlerPendingSource {
  listPending(userId: string): Promise<ButlerPendingItem[]>
}

export interface ButlerPendingProbeDeps {
  userId: string
  /** LAZY source getter (main.ts builds the inbox service after the factory). */
  pending: () => ButlerPendingSource | undefined
  logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void }
  /** Max items spelled out by title; the rest are summed as "还有 N 件". Default 3. */
  maxListed?: number
}

/** A short zh label per human-step kind (most butler parks are `approval`). */
function kindLabel(kind: string): string {
  if (kind === 'approval') return '待批准'
  if (kind === 'choice') return '待选择'
  if (kind === 'edit') return '待修改'
  return '待处理'
}

/** One line per shown item: `[待批准] <title or trimmed prompt>`. */
function summarize(it: ButlerPendingItem): string {
  const body = (it.title ?? it.prompt ?? '').replace(/\s+/g, ' ').trim()
  const short = body.length > 48 ? `${body.slice(0, 48)}…` : body || '(无标题)'
  return `[${kindLabel(it.kind)}] ${short}`
}

/**
 * Render the reminder card. Lists up to `maxListed` items by title and sums the
 * rest, so a big backlog stays one compact tail. NEVER called with an empty
 * list (the probe short-circuits to `null` first).
 */
export function buildPendingCard(items: ButlerPendingItem[], maxListed = 3): string {
  const n = items.length
  const shown = items.slice(0, Math.max(1, maxListed))
  const lines = shown.map((it, i) => `${i + 1}. ${summarize(it)}`)
  const more = n > shown.length ? `（还有 ${n - shown.length} 件未列出）` : ''
  return [
    `【待办提醒 · 系统注入】用户在 /me 收件箱还有 ${n} 件事在等他本人确认（管家提议过、但这一步得用户点头，你替不了）:`,
    ...lines,
    ...(more ? [more] : []),
    '规则:对话合适时自然提醒用户去 /me 处理这些待办;这是系统提示,别说成是用户说的话,也别假装你已经替他确认了。',
  ].join('\n')
}

/**
 * Build the per-turn probe. Cheap-first: the lazy source getter short-circuits
 * to `null` when the inbox isn't wired; a read fault also degrades to `null`.
 * Returns `() => Promise<string | null>` so it drops straight into
 * `composeContextProbes` next to the clock + onboarding probes.
 */
export function buildButlerPendingProbe(deps: ButlerPendingProbeDeps): () => Promise<string | null> {
  const maxListed = deps.maxListed ?? 3
  return async () => {
    const source = deps.pending()
    if (!source) return null // inbox not wired (no identity) — nothing to nudge about
    let items: ButlerPendingItem[]
    try {
      items = await source.listPending(deps.userId)
    } catch (err) {
      deps.logger?.warn('butler pending: listPending failed — skipping injection', { err })
      return null
    }
    if (!items || items.length === 0) return null
    return buildPendingCard(items, maxListed)
  }
}
