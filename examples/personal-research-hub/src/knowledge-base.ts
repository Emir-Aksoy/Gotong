/**
 * The on-disk knowledge base — Karpathy's two-tier structure:
 *
 *   raw/    source material (only added to, never rewritten)
 *   wiki/   the COMPILED layer the agents write: interlinked markdown notes,
 *           an index home, and answers/ (ask-your-wiki results filed back).
 *
 * Gotong never stores knowledge — this is a real directory the agents read and
 * write (same idea as personal-coding-hub's shared repo). The demo seeds two
 * tiny raw sources; the compiler turns them into wiki notes.
 */

import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export interface KnowledgeBase {
  dir: string
  rawDir: string
  wikiDir: string
}

/** Tiny raw fixtures (the demo's seed). Real use drops your own clippings here. */
const RAW_SOURCES: Record<string, string> = {
  'karpathy-software-3.0.md':
    '# Software 3.0\n\n' +
    'Karpathy 把软件分三代:1.0 手写代码,2.0 神经网络权重,3.0 用自然语言 prompt ' +
    '编程。LLM 是一种用英文编程的新计算机,markdown 规范成了 AI 时代的源代码。\n',
  'llm-as-compiler.md':
    '# LLM as compiler\n\n' +
    'Karpathy 的知识 wiki:raw 源材料用 LLM 编译成互链 markdown —— agent 写摘要、' +
    '建 backlink、归类。到规模后 ask-your-wiki:agent 研究自己的笔记、跟链接、综合' +
    '答案,再归档回去,知识复利增长。\n',
}

export function setupKnowledgeBase(dir: string): KnowledgeBase {
  const rawDir = join(dir, 'raw')
  const wikiDir = join(dir, 'wiki')
  mkdirSync(rawDir, { recursive: true })
  mkdirSync(wikiDir, { recursive: true })
  for (const [name, body] of Object.entries(RAW_SOURCES)) writeFileSync(join(rawDir, name), body)
  // The compiled wiki home — the compiler appends a link line per note.
  writeFileSync(
    join(wikiDir, 'index.md'),
    '# Wiki 首页\n\n> 编译笔记索引(LLM 从 raw/ 编译而来)。\n\n',
  )
  return { dir, rawDir, wikiDir }
}

/** Raw source filenames available to compile. */
export function listRaw(kb: KnowledgeBase): string[] {
  return readdirSync(kb.rawDir).filter((f) => f.endsWith('.md')).sort()
}

/** Compiled wiki notes — EXCLUDING the index home and answers/ (ask results). */
export function listWikiNotes(kb: KnowledgeBase): string[] {
  return readdirSync(kb.wikiDir)
    .filter((f) => f.endsWith('.md') && f !== 'index.md')
    .sort()
}

export function readWiki(kb: KnowledgeBase, name: string): string {
  return readFileSync(join(kb.wikiDir, name), 'utf8')
}

export function answersDir(kb: KnowledgeBase): string {
  return join(kb.wikiDir, 'answers')
}

/** Answer notes filed back by ask-your-wiki, as `answers/<file>` paths. */
export function listAnswers(kb: KnowledgeBase): string[] {
  const dir = answersDir(kb)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => join('answers', f))
    .sort()
}

// ── tiny shared text helpers (deterministic, no NLP) ───────────────────────

/** First non-heading, non-blank paragraph of a markdown doc. */
export function firstParagraph(md: string): string {
  for (const line of md.split('\n')) {
    const t = line.trim()
    if (t && !t.startsWith('#') && !t.startsWith('>')) return t
  }
  return ''
}

/** `My Title.md` → `my-title` — a stable slug for a note filename. */
export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/\.md$/, '')
      .replace(/[^a-z0-9一-鿿]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'note'
  )
}

/**
 * ASCII keyword tokens (len ≥ 3) from a query — enough to match technical
 * terms ("llm", "compiler", "software") across notes without a CJK tokenizer.
 */
export function keywords(q: string): string[] {
  return q.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []
}
