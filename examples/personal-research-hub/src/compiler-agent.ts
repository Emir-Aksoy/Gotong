/**
 * CompilerAgent — "LLM as compiler" (Karpathy's pattern), the deterministic
 * stand-in. Given a raw source filename, it reads raw/<source>, writes a
 * compiled wiki note (title + summary + a [[index]] backlink), and appends a
 * link line to the wiki home. The transform here is deterministic so the demo
 * is a smoke test; swap this for a real LlmAgent (a provider that writes the
 * summary + backlinks) and the hub wiring is identical.
 */

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { AgentParticipant, type Task } from '@aipehub/core'

import { firstParagraph, slugify, type KnowledgeBase } from './knowledge-base.js'

export class CompilerAgent extends AgentParticipant {
  constructor(private readonly kb: KnowledgeBase) {
    super({ id: 'compiler', capabilities: ['compile'] })
  }

  protected async handleTask(task: Task): Promise<unknown> {
    const source = String((task.payload as { source?: unknown })?.source ?? '')
    if (!source) throw new Error('compile task needs payload.source (a raw/ filename)')

    const raw = readFileSync(join(this.kb.rawDir, source), 'utf8')
    const title = (raw.match(/^#\s+(.+)$/m)?.[1] ?? source.replace(/\.md$/, '')).trim()
    const slug = slugify(source)
    const note =
      [
        `# ${title}`,
        '',
        `> 编译自 raw/${source}(LLM-as-compiler)。`,
        '',
        '## 摘要',
        firstParagraph(raw),
        '',
        '## Backlinks',
        '- [[index]]',
        '',
      ].join('\n')

    writeFileSync(join(this.kb.wikiDir, `${slug}.md`), note)
    // Append to the compiled wiki home — the interlinked index grows per note.
    appendFileSync(join(this.kb.wikiDir, 'index.md'), `- [[${slug}]] — ${title}\n`)

    return { note: `${slug}.md`, title, backlinks: ['index'] }
  }
}
