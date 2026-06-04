/**
 * research-plan — the PURE planner that turns a research goal + the wiki's
 * CURRENT state into a dispatch decision. This is the assertable core of
 * 结合使用者的情况 / 能力分派要合适: the librarian must adapt to what's already
 * compiled, not blindly recompile every raw source every time.
 *
 *   · ingest-only goal ("just compile…")        → compile the UNCOMPILED sources,
 *                                                  no retrieval;
 *   · ask-only goal on a warm wiki ("what is…")  → skip compile entirely, retrieve;
 *   · incremental ("ingest new + answer…")       → compile ONLY the missing source,
 *                                                  then retrieve.
 *
 * Keyword heuristics stand in for an LLM's judgement so the demo is deterministic;
 * a real librarian reads the same goal + the same wiki state and makes the same
 * call. The classifier is a pure function so the routing is inspectable and the
 * demo can assert it (one compile per MISSING source, retrieval only when asked).
 */

/** A raw source the librarian could compile, with its compiled-note slug. */
export interface RawRef {
  file: string
  slug: string
}

/** The wiki's state the librarian reads before deciding (= 使用者的情况). */
export interface KbSnapshot {
  /** raw/ sources available to compile. */
  rawSources: RawRef[]
  /** slugs of notes already in the wiki (so we don't recompile them). */
  compiledSlugs: string[]
}

export type ResearchStep =
  | { kind: 'compile'; source: string }
  | { kind: 'retrieve'; question: string }

export interface ResearchPlan {
  /** Ordered dispatch — compile the missing sources, then (if asked) retrieve. */
  steps: ResearchStep[]
  /** Goal asked to ingest/build the wiki. */
  ingest: boolean
  /** Effective: a question was asked (or the goal isn't a pure ingest command). */
  retrieve: boolean
  rationale: string
}

/**
 * "Build / compile / ingest raw into the wiki" → the librarian should compile.
 * Anchored to ACTION phrases (compile/build *the raw/sources/wiki*) so the topic
 * word "compiler" in a question ("what is LLM-as-compiler") does NOT read as an
 * ingest command — otherwise an ask-only goal would wrongly recompile on a cold wiki.
 */
const INGEST = [
  /\bingest\b/i,
  /\bfrom raw\b/i,
  /\binto the wiki\b/i,
  /\bbuild\b[\s\S]*\bwiki\b/i,
  /\bcompile\b[\s\S]*\b(raw|sources?|wiki)\b/i,
  /\bupdate\b[\s\S]*\bwiki\b/i,
  /入库/, /建.*wiki/, /编译.*(源|raw|wiki|库)/, /整理.*(源|库)/,
]

/** "Answer / what is / explain / a question" → the librarian should retrieve. */
const ANSWER = [/answer/i, /question/i, /what\s+is/i, /how\s+does/i, /explain/i, /什么是/, /解释/, /回答/, /问/, /\?/, /？/]

export function planResearch(goal: string, snap: KbSnapshot): ResearchPlan {
  const g = goal.trim()
  const ingest = INGEST.some((re) => re.test(g))
  const askedQuestion = ANSWER.some((re) => re.test(g))
  // A goal that isn't a pure ingest command is treated as a question — the most
  // common case is "tell me X", and an empty/odd goal should still try the wiki.
  const retrieve = askedQuestion || !ingest

  // Compile ONLY the sources missing from the wiki — the situational core. A warm
  // wiki (everything already compiled) yields zero compile steps.
  const compiled = new Set(snap.compiledSlugs)
  const missing = snap.rawSources.filter((r) => !compiled.has(r.slug))

  const steps: ResearchStep[] = []
  if (ingest) for (const r of missing) steps.push({ kind: 'compile', source: r.file })
  if (retrieve) steps.push({ kind: 'retrieve', question: g })

  return { steps, ingest, retrieve, rationale: rationale(ingest, retrieve, missing.length) }
}

function rationale(ingest: boolean, retrieve: boolean, missing: number): string {
  if (ingest && missing === 0 && retrieve) return 'wiki 已是最新 → 跳过编译,直接从已编译的笔记回答'
  if (ingest && retrieve) return `有 ${missing} 个源未编译 → 先编译缺的,再从 wiki 回答`
  if (ingest && !retrieve) return `只要求入库 → 编译 ${missing} 个缺的源,不做检索`
  return '只问问题 → 跳过编译,直接 ask-your-wiki(wiki 已覆盖)'
}
