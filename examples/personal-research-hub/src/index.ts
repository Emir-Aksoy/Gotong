/**
 * personal-research-hub — a case Gotong can carry: Karpathy's LLM knowledge-base
 * loop (raw → compiled wiki → ask-your-wiki) driven by a librarian router that
 * ADAPTS to the wiki's current state.
 *
 * ★ What changed (结合使用者的情况 / 能力分派要合适) ★
 * The librarian no longer runs a fixed "compile both sources, ask one hardcoded
 * question" script. It reads the goal + a snapshot of what's ALREADY compiled and
 * routes accordingly:
 *   · an ingest-only goal       → compile the MISSING sources, no retrieval;
 *   · an ask-only goal (warm)   → skip compile entirely, just ask-your-wiki;
 *   · "ingest new + answer"      → compile ONLY the uncompiled source, then answer.
 * The decision is a PURE function (`planResearch`) the librarian calls; a real
 * librarian LLM makes the same call from the same goal + wiki state.
 *
 * Deterministic, no API key (situation-aware librarian + deterministic workers),
 * but the FILE I/O is real: a real temp knowledge base with raw/ + wiki/. Each
 * scenario pre-seeds the wiki, then asserts how many NEW sources got compiled and
 * whether an answer was filed — proof the dispatch fitted the wiki's state.
 *
 * Run:  pnpm demo:personal-research-hub
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Hub, InMemoryStorage } from '@gotong/core'
import { DispatchToolset, LlmAgent } from '@gotong/llm'

import {
  listAnswers,
  listRaw,
  listWikiNotes,
  readWiki,
  setupKnowledgeBase,
  slugify,
  type KnowledgeBase,
} from './knowledge-base.js'
import { CompilerAgent } from './compiler-agent.js'
import { ResearcherAgent } from './researcher-agent.js'
import { createLibrarianProvider } from './librarian-provider.js'

const LIBRARIAN_SYSTEM =
  'You curate a personal knowledge base and adapt to its CURRENT state — do NOT ' +
  'recompile what is already compiled. Read the goal + the injected wiki snapshot: ' +
  'compile (dispatch compiler) ONLY the raw sources missing from the wiki, and ' +
  'answer questions (dispatch researcher) from the compiled notes. An ask-only goal ' +
  'on a warm wiki skips compilation entirely. Let the wiki carry the links.'

interface ResearchScenario {
  label: string
  goal: string
  /** Raw source filenames to compile BEFORE the librarian runs (= a warm wiki). */
  preCompiled: string[]
  /** New sources the librarian SHOULD compile (beyond preCompiled). */
  expectCompiled: number
  /** Whether the librarian should file an answer (ask-your-wiki). */
  expectAnswered: boolean
}

// Raw seed = karpathy-software-3.0.md + llm-as-compiler.md (knowledge-base.ts).
const SOFTWARE = 'karpathy-software-3.0.md'
const COMPILER = 'llm-as-compiler.md'

const SCENARIOS: ResearchScenario[] = [
  {
    label: '[A] 冷启动:建库 + 提问',
    goal: 'Build the wiki from raw/, then answer what LLM-as-compiler is.',
    preCompiled: [],
    expectCompiled: 2, // both sources missing → compile both
    expectAnswered: true,
  },
  {
    label: '[B] 温库:只提问(跳过编译)',
    goal: 'What is LLM-as-compiler and how does it relate to Software 3.0?',
    preCompiled: [SOFTWARE, COMPILER],
    expectCompiled: 0, // wiki already current → no recompile
    expectAnswered: true,
  },
  {
    label: '[C] 增量:只编译新源 + 提问',
    goal: 'Ingest any new sources, then answer what LLM-as-compiler is.',
    preCompiled: [SOFTWARE],
    expectCompiled: 1, // only llm-as-compiler is missing
    expectAnswered: true,
  },
  {
    label: '[D] 只入库:不提问',
    goal: 'Just compile the raw sources into the wiki.',
    preCompiled: [],
    expectCompiled: 2, // both compiled, but NO retrieval
    expectAnswered: false,
  },
]

async function main(): Promise<void> {
  console.log('\n=== Gotong case: personal-research-hub ===')
  console.log('  图书管理员按「wiki 当前状态」分派 —— 缺什么编译什么、没问就不检索。\n')

  for (const s of SCENARIOS) await runResearch(s)

  section('done')
  console.log('  库已最新就跳过编译、增量只补缺的源、没问问题就不检索 —— 分派结合了情况。\n')
  process.exit(0)
}

/** Run one scenario in its own knowledge base + hub, assert the dispatch fitted. */
async function runResearch(s: ResearchScenario): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'gotong-research-hub-'))
  const kb = setupKnowledgeBase(dir)
  const hub = new Hub({ storage: new InMemoryStorage() })
  await hub.start()
  hub.register(new CompilerAgent(kb))
  hub.register(new ResearcherAgent(kb))
  const librarianId = 'librarian'
  hub.register(
    new LlmAgent({
      id: librarianId,
      capabilities: ['route'],
      provider: createLibrarianProvider(),
      system: LIBRARIAN_SYSTEM,
      tools: DispatchToolset.create({ hub, selfId: librarianId, allowedAgents: ['compiler', 'researcher'] }),
    }),
  )

  try {
    section(s.label)
    // Pre-seed the wiki with the "already compiled" sources (a warm wiki) by
    // dispatching the real compiler — so the snapshot the librarian sees is real.
    for (const src of s.preCompiled) {
      await hub.dispatch({ from: 'human', strategy: { kind: 'explicit', to: 'compiler' }, payload: { source: src }, title: `seed ${src}` })
    }
    const notesBefore = listWikiNotes(kb)
    const answersBefore = listAnswers(kb).length
    console.log(`  goal: ${s.goal}`)
    console.log(`  wiki 已编译: ${notesBefore.length ? notesBefore.join(', ') : '(空)'}`)

    const result = await hub.dispatch({
      from: 'human',
      strategy: { kind: 'capability', capabilities: ['route'] },
      payload: { prompt: buildPrompt(kb, s.goal) },
      title: s.label,
    })
    if (result.kind !== 'ok') throw new Error(`[${s.label}] librarian failed: ${JSON.stringify(result)}`)
    console.log(`\n  📚 ${(result.output as { text?: string }).text ?? '(no text)'}`)

    // What the librarian caused: new notes compiled + whether an answer was filed.
    const newNotes = listWikiNotes(kb).filter((n) => !notesBefore.includes(n))
    const answered = listAnswers(kb).length > answersBefore
    console.log(`  新编译: ${newNotes.length ? newNotes.join(', ') : '无'}  | 回答: ${answered ? '是' : '否'}`)

    if (newNotes.length !== s.expectCompiled) {
      throw new Error(`[${s.label}] expected ${s.expectCompiled} new note(s), got ${newNotes.length}`)
    }
    if (answered !== s.expectAnswered) {
      throw new Error(`[${s.label}] expected answered=${s.expectAnswered}, got ${answered}`)
    }
  } finally {
    await hub.stop()
    rmSync(dir, { recursive: true, force: true })
  }
}

/** The librarian's prompt = the goal + a snapshot of the wiki's current state. */
function buildPrompt(kb: KnowledgeBase, goal: string): string {
  const snap = {
    rawSources: listRaw(kb).map((file) => ({ file, slug: slugify(file) })),
    compiledSlugs: listWikiNotes(kb).map((n) => n.replace(/\.md$/, '')),
  }
  return `${goal}\n知识库状态: ${JSON.stringify(snap)}`
}

function section(title: string): void {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 52 - title.length))}`)
}

main().catch((err) => {
  console.error('[personal-research-hub] fatal:', err)
  process.exit(1)
})
