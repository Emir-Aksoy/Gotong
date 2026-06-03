/**
 * personal-research-hub — a case AipeHub can carry: Karpathy's LLM knowledge-base
 * loop (raw → compiled wiki → ask-your-wiki) driven by a librarian router.
 *
 * The story (deterministic, no API key — mock LLM + deterministic worker agents,
 * but the FILE I/O is real: a real temp knowledge base with raw/ + wiki/):
 *
 *   [1] a person hands ONE goal to a librarian LlmAgent. It actively decides what
 *       to ingest vs retrieve and dispatches across two worker agents:
 *       compiler ×2 (raw source → compiled wiki note + backlink), then
 *       researcher ×1 (ask-your-wiki: search the notes → synthesize → file back).
 *   [2] the compiled wiki carries one note PER raw source, each backlinked to the
 *       index home; the index lists them — the interlinked wiki Karpathy describes.
 *   [3] the researcher's answer is filed back as a NEW note under wiki/answers/,
 *       citing the notes it used — so the knowledge compounds.
 *
 * To drive it for real: swap the deterministic compiler/researcher for real
 * LlmAgents (a provider that writes the summary / answer) and the mock librarian
 * provider for a real one — the hub wiring is identical. Point the wiki at your
 * Obsidian vault via mcp-obsidian (see the loadable template + README).
 *
 * Run:  pnpm demo:personal-research-hub
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Hub, InMemoryStorage } from '@aipehub/core'
import { DispatchToolset, LlmAgent } from '@aipehub/llm'

import {
  listAnswers,
  listRaw,
  listWikiNotes,
  readWiki,
  setupKnowledgeBase,
} from './knowledge-base.js'
import { CompilerAgent } from './compiler-agent.js'
import { ResearcherAgent } from './researcher-agent.js'
import { createLibrarianProvider } from './librarian-provider.js'

async function main(): Promise<void> {
  // A real knowledge base on disk: raw/ (seed sources) + wiki/ (compiled home).
  const dir = mkdtempSync(join(tmpdir(), 'aipe-research-hub-'))
  const kb = setupKnowledgeBase(dir)

  const hub = new Hub({ storage: new InMemoryStorage() })
  await hub.start()

  // Two worker agents — both read/write the SAME knowledge base on disk.
  hub.register(new CompilerAgent(kb))
  hub.register(new ResearcherAgent(kb))

  // The librarian: an LlmAgent that actively decides ingest vs retrieve and
  // dispatches by agentId through its DispatchToolset (allow-list = the workers).
  const librarianId = 'librarian'
  hub.register(
    new LlmAgent({
      id: librarianId,
      capabilities: ['route'],
      provider: createLibrarianProvider(),
      system:
        'You curate a personal knowledge base. Compile raw sources into the wiki ' +
        '(dispatch compiler), and answer questions from the compiled notes ' +
        '(dispatch researcher). Let the wiki carry the links.',
      tools: DispatchToolset.create({
        hub,
        selfId: librarianId,
        allowedAgents: ['compiler', 'researcher'],
      }),
    }),
  )

  console.log('\n=== AipeHub case: personal-research-hub ===\n')
  console.log(`  knowledge base: ${kb.dir}`)
  console.log(`  raw sources:    ${listRaw(kb).join(', ')}`)

  // --- [1] the librarian compiles the wiki, then answers from it -------------
  section('[1] librarian: raw → compiled wiki → ask-your-wiki')
  const result = await hub.dispatch({
    from: 'human',
    strategy: { kind: 'capability', capabilities: ['route'] },
    payload: { prompt: 'Build the wiki from raw/, then answer what LLM-as-compiler is.' },
    title: 'curate + answer',
  })
  if (result.kind !== 'ok') throw new Error(`librarian failed: ${JSON.stringify(result)}`)
  console.log(`\n  📚 librarian: ${(result.output as { text?: string }).text ?? '(no text)'}`)

  // --- [2] the compiled, interlinked wiki ------------------------------------
  section('[2] compiled wiki — one note per source, all backlinked')
  const notes = listWikiNotes(kb)
  for (const n of notes) {
    const backlinked = readWiki(kb, n).includes('[[index]]')
    console.log(`  wiki/${n}   backlink→index: ${backlinked ? 'yes' : 'NO'}`)
  }
  console.log('\n  wiki/index.md (the interlinked home):')
  for (const line of readWiki(kb, 'index.md').trimEnd().split('\n')) console.log(`    │ ${line}`)

  // --- [3] ask-your-wiki: the answer is filed back as a new note -------------
  section('[3] the answer, filed back as a new note (knowledge compounds)')
  const answerFiles = listAnswers(kb)
  if (answerFiles.length === 0) throw new Error('expected the researcher to file an answer note')
  const answerFile = answerFiles[0]!
  console.log(`  wiki/${answerFile}:`)
  for (const line of readWiki(kb, answerFile).trimEnd().split('\n')) console.log(`    │ ${line}`)

  // Self-assert (this example doubles as a smoke test): the wiki was built from
  // every raw source, each note backlinks the index, and the ask result was
  // filed back citing a note.
  if (notes.length < listRaw(kb).length) {
    throw new Error('expected one compiled note per raw source')
  }
  if (!notes.every((n) => readWiki(kb, n).includes('[[index]]'))) {
    throw new Error('expected every compiled note to backlink the index')
  }
  const answerBody = readWiki(kb, answerFile)
  if (!answerBody.includes('[[')) {
    throw new Error('expected the filed answer to cite a wiki note')
  }

  await hub.stop()
  rmSync(dir, { recursive: true, force: true })
  section('done')
  console.log('  Librarian built the wiki from raw, then answered from it; the answer compounds.\n')
  process.exit(0)
}

function section(title: string): void {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 56 - title.length))}`)
}

main().catch((err) => {
  console.error('[personal-research-hub] fatal:', err)
  process.exit(1)
})
