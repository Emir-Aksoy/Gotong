/**
 * Deterministic stand-in participants for the warband-club runnable demo.
 *
 * In the loadable template these capabilities are served by KB-backed
 * `LlmAgent`s (archivist / herald on DeepSeek + mcp-obsidian). Here we
 * substitute deterministic stand-ins that serve the SAME capabilities against a
 * real, shared, on-disk archive — so the demo runs with no API key and the
 * "collaboration over a shared resource" story is actually exercised: one
 * member's contribution lands in the same directory another member queries.
 *
 * The shared archive directory IS the point. Unlike battle-monk's per-trainee
 * Codex, this is one library the whole warband reads and writes — single-hub
 * shared resources (no federation), which is the org model the user locked.
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { AgentParticipant, type Task } from '@gotong/core'

/** Slug a title into a filesystem-safe base (ascii kept, everything else → '-'). */
function slug(title: string, fallback: string): string {
  const s = title.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  return s.length > 0 ? s : fallback
}

/** Character bigrams of a string (whitespace stripped) — CJK-friendly matching. */
function bigrams(s: string): Set<string> {
  const clean = s.replace(/\s+/g, '')
  const out = new Set<string>()
  for (let i = 0; i < clean.length - 1; i++) out.add(clean.slice(i, i + 2))
  return out
}

function overlap(a: Set<string>, b: Set<string>): number {
  let n = 0
  for (const g of a) if (b.has(g)) n++
  return n
}

/**
 * Serves `warband.file-contribution` + `warband.consult-archive` — the司库
 * (archivist). Both touch the SAME shared archive directory, so a contribution
 * filed by one member is discoverable by every other member's query.
 */
export class ArchivistStandin extends AgentParticipant {
  constructor(private readonly archiveDir: string) {
    super({ id: 'archivist', capabilities: ['warband.file-contribution', 'warband.consult-archive'] })
  }

  protected async handleTask(task: Task): Promise<unknown> {
    const cap = task.strategy.kind === 'capability' ? task.strategy.capabilities[0] : undefined
    if (cap === 'warband.consult-archive') return this.consult(task)
    return this.file(task)
  }

  /** Append a contribution into the shared archive as a markdown note. */
  private file(task: Task): unknown {
    const { kind, title, body, contributor } = (task.payload ?? {}) as {
      kind?: string
      title?: string
      body?: string
      contributor?: string
    }
    const base = slug(String(title ?? 'entry'), `entry-${Date.now()}`)
    const file = `${kind ?? 'note'}--${base}.md`
    const md =
      `# ${title}\n\n` +
      `- kind: ${kind}\n` +
      `- contributor: ${contributor}\n\n` +
      `${body ?? ''}\n`
    writeFileSync(join(this.archiveDir, file), md, 'utf8')
    return { filed: true, kind, title, file, note: `已归档「${title}」进战团共享档案库, 全团可查。` }
  }

  /** Search the shared archive for the entry that best matches the question. */
  private consult(task: Task): unknown {
    const { question } = (task.payload ?? {}) as { question?: string }
    const q = bigrams(String(question ?? ''))
    const files = readdirSync(this.archiveDir).filter((f) => f.endsWith('.md'))

    let best: { file: string; title: string; contributor: string; score: number; snippet: string } | undefined
    for (const f of files) {
      const text = readFileSync(join(this.archiveDir, f), 'utf8')
      const score = overlap(q, bigrams(text))
      if (score > 0 && (!best || score > best.score)) {
        const title = (text.match(/^#\s+(.*)$/m)?.[1] ?? f).trim()
        const contributor = (text.match(/contributor:\s*(.*)$/m)?.[1] ?? '?').trim()
        const snippet = text.split('\n').filter((l) => l && !l.startsWith('#') && !l.startsWith('-')).join(' ').slice(0, 80)
        best = { file: f, title, contributor, score, snippet }
      }
    }

    if (!best) {
      return { found: false, answer: '档案库里暂时没有相关条目, 不妨你来贡献第一份。', sources: [] }
    }
    return {
      found: true,
      answer: `据「${best.title}」(由 ${best.contributor} 贡献): ${best.snippet}…`,
      sources: [{ title: best.title, contributor: best.contributor, file: best.file }],
    }
  }
}

/** Serves `warband.draft-muster` — the 传令官 (herald) who turns a proposal into a charter. */
export class HeraldStandin extends AgentParticipant {
  constructor() {
    super({ id: 'herald', capabilities: ['warband.draft-muster'] })
  }

  protected async handleTask(task: Task): Promise<unknown> {
    const { title, kind, when, notes } = (task.payload ?? {}) as {
      title?: string
      kind?: string
      when?: string
      notes?: string
    }
    const kindLabel =
      kind === 'battle-night' ? '对战夜' : kind === 'paint-session' ? '涂装会' : kind === 'tournament' ? '锦标赛' : String(kind)
    return {
      title,
      kind: kindLabel,
      when,
      agenda: [`集合: ${when}`, `形式: ${kindLabel}`, notes ? `备注: ${notes}` : '备注: (无)'],
      note: `集结章程已拟好 (${kindLabel} · ${when}), 待战团长确认纳入日程。`,
    }
  }
}
