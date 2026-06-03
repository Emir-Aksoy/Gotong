/**
 * ResearcherAgent — "ask-your-wiki" (Karpathy's pattern), the deterministic
 * stand-in. Given a question, it searches the COMPILED wiki notes (keyword
 * overlap), synthesizes an answer citing the top matches, and — the compounding
 * bit — files the answer back as a new note under wiki/answers/, so future
 * questions can find it. Swap for a real LlmAgent and the loop is the same.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { AgentParticipant, type Task } from '@aipehub/core'

import {
  answersDir,
  firstParagraph,
  keywords,
  listWikiNotes,
  readWiki,
  slugify,
  type KnowledgeBase,
} from './knowledge-base.js'

export class ResearcherAgent extends AgentParticipant {
  constructor(private readonly kb: KnowledgeBase) {
    super({ id: 'researcher', capabilities: ['research'] })
  }

  protected async handleTask(task: Task): Promise<unknown> {
    const question = String((task.payload as { question?: unknown })?.question ?? '')
    if (!question) throw new Error('research task needs payload.question')

    // ask-your-wiki: score compiled notes by keyword overlap, cite the top ones.
    const kws = keywords(question)
    const scored = listWikiNotes(this.kb)
      .map((name) => {
        const body = readWiki(this.kb, name).toLowerCase()
        const score = kws.reduce((s, k) => s + (body.includes(k) ? 1 : 0), 0)
        return { slug: name.replace(/\.md$/, ''), body: readWiki(this.kb, name), score }
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
    const cited = scored.slice(0, 2)

    const answer = cited.length
      ? `依据 ${cited.map((c) => `[[${c.slug}]]`).join('、')}:` +
        cited.map((c) => firstParagraph(c.body)).join(' ')
      : '知识库里没有相关笔记。'

    // File the answer back as a new note — knowledge compounds.
    mkdirSync(answersDir(this.kb), { recursive: true })
    const slug = slugify(question).slice(0, 40)
    writeFileSync(
      join(answersDir(this.kb), `${slug}.md`),
      [`# Q: ${question}`, '', answer, '', '## 引用', ...cited.map((c) => `- [[${c.slug}]]`), ''].join('\n'),
    )

    return { answer, cited: cited.map((c) => c.slug), filedAs: `answers/${slug}.md` }
  }
}
