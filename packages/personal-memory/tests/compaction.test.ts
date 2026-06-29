/**
 * Save-before-compact (decision H / 用户 Q1「不丢上下文」那一面) — extract the
 * durable facts from a conversation about to be dropped, then persist them.
 *
 * Deterministic fakes only: the summarizer returns the facts JSON, so the
 * extraction-and-persist logic is provable without an LLM.
 */

import { describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_IMPORTANCE,
  META_COMPACTED,
  META_IMPORTANCE,
  extractDurableFacts,
  importanceOf,
  saveBeforeCompact,
  type CompactionMessage,
  type DurableFact,
} from '../src/index.js'
import { makeFakeMemory, type FakeMemory } from './fake-memory.js'

/** A summarizer that always returns the given facts as `{"facts":[...]}`. */
const factsSummarizer = (facts: Array<DurableFact | string>) => async () =>
  JSON.stringify({ facts })
/** A summarizer returning a fixed raw string (for parse / fail-soft tests). */
const rawSummarizer = (raw: string) => async () => raw

const msg = (role: string, content: unknown): CompactionMessage => ({ role, content })

/** A small multi-turn working context the way `LlmAgent.__llmMessages` looks. */
const conversation = (): CompactionMessage[] => [
  msg('user', '我上周从吉隆坡搬到了槟城'),
  msg('assistant', '记下了，恭喜搬新家。'),
  msg('user', '帮我每天早上九点提醒喝水'),
  msg('assistant', '好的。'),
]

const semanticTexts = (mem: FakeMemory) =>
  mem.entries.filter((e) => e.kind === 'semantic').map((e) => e.text).sort()

describe('extractDurableFacts', () => {
  it('extracts facts (text + importance) from a {"facts":[...]} response', async () => {
    const facts = await extractDurableFacts({
      summarize: factsSummarizer([
        { text: '住在槟城（上周从吉隆坡搬来）', importance: 4 },
        { text: '想每天早上九点被提醒喝水', importance: 2 },
      ]),
      messages: conversation(),
    })
    expect(facts).toHaveLength(2)
    expect(facts[0]).toMatchObject({ text: '住在槟城（上周从吉隆坡搬来）', importance: 4 })
    expect(facts[1]?.importance).toBe(2)
  })

  it('accepts a bare array of strings', async () => {
    const facts = await extractDurableFacts({
      summarize: rawSummarizer('["fact one","fact two"]'),
      messages: conversation(),
    })
    expect(facts.map((f) => f.text)).toEqual(['fact one', 'fact two'])
    // bare strings carry no importance — the persist path defaults it.
    expect(facts[0]?.importance).toBeUndefined()
  })

  it('accepts a bare array of {text} objects', async () => {
    const facts = await extractDurableFacts({
      summarize: rawSummarizer('[{"text":"a"},{"text":"b","importance":5}]'),
      messages: conversation(),
    })
    expect(facts.map((f) => f.text)).toEqual(['a', 'b'])
    expect(facts[1]?.importance).toBe(5)
  })

  it('returns [] for an empty message list — and never calls the model', async () => {
    const summarize = vi.fn(factsSummarizer([{ text: 'x' }]))
    expect(await extractDurableFacts({ summarize, messages: [] })).toEqual([])
    expect(summarize).not.toHaveBeenCalled()
  })

  it('fail-soft: an unusable response yields no facts', async () => {
    expect(
      await extractDurableFacts({
        summarize: rawSummarizer('sorry, I cannot do that'),
        messages: conversation(),
      }),
    ).toEqual([])
  })

  it('fail-soft: a throwing summarizer is caught (no facts)', async () => {
    expect(
      await extractDurableFacts({
        summarize: async () => {
          throw new Error('network down')
        },
        messages: conversation(),
      }),
    ).toEqual([])
  })

  it('renders readable text only — flattens content blocks, skips tool_use args', async () => {
    let seenUser = ''
    const summarize = async ({ user }: { system: string; user: string }) => {
      seenUser = user
      return JSON.stringify({ facts: [] })
    }
    await extractDurableFacts({
      summarize,
      messages: [
        msg('user', '我搬到了槟城'),
        msg('assistant', [
          { type: 'text', text: '好的，已记录。' },
          { type: 'tool_use', name: 'remember', input: { secret: 'TOOL_ARG_LEAK' } },
        ]),
        // tool_result text IS durable context and should be flattened in.
        msg('tool', [{ type: 'tool_result', content: '提醒已创建：每天 09:00' }]),
      ],
    })
    expect(seenUser).toContain('我搬到了槟城')
    expect(seenUser).toContain('好的，已记录。')
    expect(seenUser).toContain('提醒已创建')
    expect(seenUser).not.toContain('TOOL_ARG_LEAK') // tool_use input never rendered
  })

  it('caps the transcript to maxChars, keeping the most recent context', async () => {
    let seenUser = ''
    const summarize = async ({ user }: { system: string; user: string }) => {
      seenUser = user
      return JSON.stringify({ facts: [] })
    }
    const filler = Array.from({ length: 20 }, (_, i) => msg('user', `filler line ${i} ${'x'.repeat(50)}`))
    await extractDurableFacts({
      summarize,
      messages: [msg('user', 'OLDEST_MARKER'), ...filler, msg('user', 'NEWEST_MARKER')],
      maxChars: 400,
    })
    expect(seenUser).toContain('NEWEST_MARKER') // recent kept
    expect(seenUser).not.toContain('OLDEST_MARKER') // oldest dropped under the cap
  })
})

describe('saveBeforeCompact', () => {
  it('extracts and appends durable facts as semantic (default), with importance + provenance', async () => {
    const mem = makeFakeMemory([])
    const r = await saveBeforeCompact({
      memory: mem,
      summarize: factsSummarizer([
        { text: '住在槟城', importance: 4 },
        { text: '每天九点提醒喝水', importance: 2 },
      ]),
      messages: conversation(),
    })
    expect(r).toMatchObject({ extracted: 2, saved: 2 })
    expect(semanticTexts(mem)).toEqual(['住在槟城', '每天九点提醒喝水'])
    const penang = mem.entries.find((e) => e.text === '住在槟城')!
    expect(importanceOf(penang)).toBe(4)
    expect((penang.meta as Record<string, unknown>)[META_COMPACTED]).toBe(true)
  })

  it('defaults importance when the model omitted it', async () => {
    const mem = makeFakeMemory([])
    await saveBeforeCompact({
      memory: mem,
      summarize: rawSummarizer('["a bare fact"]'),
      messages: conversation(),
    })
    expect(importanceOf(mem.entries.find((e) => e.text === 'a bare fact')!)).toBe(DEFAULT_IMPORTANCE)
  })

  it('returns null below minMessages — and never calls the model', async () => {
    const mem = makeFakeMemory([])
    const summarize = vi.fn(factsSummarizer([{ text: 'x' }]))
    const r = await saveBeforeCompact({
      memory: mem,
      summarize,
      messages: [msg('user', 'just one message')],
    })
    expect(r).toBeNull()
    expect(summarize).not.toHaveBeenCalled()
    expect(mem.entries.length).toBe(0)
  })

  it('counts only readable messages toward minMessages (blank content ignored)', async () => {
    const mem = makeFakeMemory([])
    const summarize = vi.fn(factsSummarizer([{ text: 'x' }]))
    // 3 entries but only 1 has readable text → below default min (2).
    const r = await saveBeforeCompact({
      memory: mem,
      summarize,
      messages: [msg('user', 'real'), msg('assistant', ''), msg('tool', [])],
    })
    expect(r).toBeNull()
    expect(summarize).not.toHaveBeenCalled()
  })

  it('returns null when nothing durable was extracted', async () => {
    const mem = makeFakeMemory([])
    const r = await saveBeforeCompact({
      memory: mem,
      summarize: factsSummarizer([]),
      messages: conversation(),
    })
    expect(r).toBeNull()
    expect(mem.entries.length).toBe(0)
  })

  it('honors a kind override (episodic)', async () => {
    const mem = makeFakeMemory([])
    await saveBeforeCompact({
      memory: mem,
      summarize: factsSummarizer([{ text: 'happened today' }]),
      messages: conversation(),
      kind: 'episodic',
    })
    expect(mem.entries.find((e) => e.text === 'happened today')?.kind).toBe('episodic')
  })

  it('carries entryMeta onto every saved fact (per-user no-leak scope)', async () => {
    const mem = makeFakeMemory([])
    await saveBeforeCompact({
      memory: mem,
      summarize: factsSummarizer([{ text: 'alice fact' }]),
      messages: conversation(),
      entryMeta: { user: 'alice' },
    })
    const saved = mem.entries.find((e) => e.text === 'alice fact')!
    expect((saved.meta as { user?: string }).user).toBe('alice')
    expect((saved.meta as Record<string, unknown>)[META_IMPORTANCE]).toBeDefined()
  })

  it('skips empty-text facts (saved reflects only what was written)', async () => {
    const mem = makeFakeMemory([])
    const r = await saveBeforeCompact({
      memory: mem,
      summarize: factsSummarizer([{ text: 'kept' }, { text: '   ' }]),
      messages: conversation(),
    })
    // The blank fact is dropped by the parser already; only the real one persists.
    expect(r).toMatchObject({ saved: 1 })
    expect(semanticTexts(mem)).toEqual(['kept'])
  })

  it('the saved facts are exactly the candidates reconcile would consume', async () => {
    // H feeds A: extractDurableFacts → candidates → reconcile. Prove the shape
    // lines up by round-tripping the extracted text list.
    const facts = await extractDurableFacts({
      summarize: factsSummarizer([{ text: 'fact A', importance: 3 }, { text: 'fact B' }]),
      messages: conversation(),
    })
    const candidates = facts.map((f) => f.text)
    expect(candidates).toEqual(['fact A', 'fact B'])
  })
})
