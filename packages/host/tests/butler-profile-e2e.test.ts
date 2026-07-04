/**
 * butler-profile-e2e — S2-M1. A member asks their resident butler "你记得我什
 * 么?" over IM and gets the STRUCTURED memory snapshot — read through the REAL
 * `HostButlerMemoryService` (the same object that backs the `/me`「管家记得你
 * 什么」privacy panel), never the model improvising from the frozen block.
 *
 * Claims:
 *   ① the IM answer is the /me projection, structured: tier-grouped 画像 with
 *     honesty tags ((重要) / (已失效)), a 会做的事 section for procedures, a
 *     最近聊到 section, and the right-to-be-forgotten pointer — inline, no park;
 *   ② no-leak: another member gets the friendly empty answer, and never a byte
 *     of the first member's memory (the per-user namespace is the boundary);
 *   ③ the renderer counts overflow honestly instead of silently dropping lines.
 *
 * The LLM is a keyword-scripted provider that RELAYS the tool result verbatim
 * (what the tool description instructs a real model to do); the service, the
 * per-user namespace, the toolset and the butler loop are the real code.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Hub, Space, type Logger } from '@gotong/core'
import { PersonalButlerAgent } from '@gotong/personal-butler'
import type {
  LlmMessage,
  LlmProvider,
  LlmRequest,
  LlmStreamChunk,
} from '@gotong/llm'

import {
  buildButlerProfileToolset,
  renderButlerMemorySnapshot,
} from '../src/personal-butler-profile.js'
import { HostButlerMemoryService } from '../src/butler-memory-service.js'
import { openButlerMemory } from '../src/personal-butler-memory.js'

const silentLogger: Logger = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
  child() {
    return silentLogger
  },
}

// --- deterministic provider ---------------------------------------------------
// "记得我什么" → call show_my_memory; on the tool result, relay its text
// verbatim (exactly what the tool description instructs a real model to do).

function lastUserMessage(req: LlmRequest): LlmMessage | undefined {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    if (req.messages[i]!.role === 'user') return req.messages[i]
  }
  return undefined
}

class ButlerProfileProvider implements LlmProvider {
  readonly name = 'butler-profile-e2e'

  async *stream(req: LlmRequest): AsyncIterable<LlmStreamChunk> {
    const last = lastUserMessage(req)
    const content = last?.content

    if (Array.isArray(content)) {
      const result = content.find((b) => (b as { type?: string }).type === 'tool_result') as
        | { content?: unknown }
        | undefined
      if (result) {
        // The agent flattens tool results to a string; tolerate block arrays too.
        const c = result.content
        const text =
          typeof c === 'string'
            ? c
            : Array.isArray(c)
              ? c
                  .filter((b) => (b as { type?: string }).type === 'text')
                  .map((b) => (b as { text?: string }).text ?? '')
                  .join('\n')
              : ''
        yield { type: 'text', text: text || '(空)' }
        yield { type: 'end', stopReason: 'end_turn' }
        return
      }
    }

    const text = typeof content === 'string' ? content : ''
    if (/记得我|remember/i.test(text)) {
      yield {
        type: 'tool_use',
        toolUse: { type: 'tool_use', id: 'p-1', name: 'show_my_memory', input: {} },
      }
      yield { type: 'end', stopReason: 'tool_use' }
      return
    }

    yield { type: 'text', text: '好的。' }
    yield { type: 'end', stopReason: 'end_turn' }
  }
}

// --- rig ------------------------------------------------------------------------

describe('butler-profile-e2e — S2-M1 (IM "你记得我什么" = the /me snapshot, 同源)', () => {
  let tmp: string
  let memRoot: string
  let hub: Hub
  let svc: HostButlerMemoryService

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'gotong-butler-profile-e2e-'))
    memRoot = join(tmp, 'mem')
    const { space } = await Space.init(tmp, { name: 'butler-profile-e2e' })
    hub = new Hub({ space })
    await hub.start()
    svc = new HostButlerMemoryService({ rootDir: memRoot, logger: silentLogger })
  })
  afterEach(async () => {
    await hub.stop().catch(() => {})
    await rm(tmp, { recursive: true, force: true })
  })

  /** A resident butler wired the way main.ts wires it: the profile tool reads
   *  through the SAME HostButlerMemoryService instance that serves /me. */
  function butlerFor(id: string, userId: string): PersonalButlerAgent {
    return new PersonalButlerAgent({
      id,
      provider: new ButlerProfileProvider(),
      memory: openButlerMemory({ rootDir: memRoot, userId, logger: silentLogger }),
      system: '你是用户的私人管家。',
      benign: [buildButlerProfileToolset({ userId, view: svc, logger: silentLogger })],
      maxToolRounds: 4,
    })
  }

  async function ask(butlerId: string, userId: string, prompt: string): Promise<string> {
    const fired = await hub.dispatch({
      from: `user:${userId}`,
      strategy: { kind: 'explicit', to: butlerId },
      payload: prompt,
      origin: { orgId: 'local', userId },
    })
    if (fired.kind !== 'ok') throw new Error(`expected ok, got: ${JSON.stringify(fired)}`)
    return (fired.output as { text: string }).text
  }

  it('① answers with the structured /me snapshot — tiers, tags, procedures, recents, /me pointer', async () => {
    const m = openButlerMemory({ rootDir: memRoot, userId: 'alice', logger: silentLogger })
    await m.remember({
      kind: 'semantic',
      text: '在做 Gotong 项目',
      meta: { tier: 'projects', importance: 5 },
    })
    await m.remember({ kind: 'semantic', text: '喜欢少糖奶茶', meta: { tier: 'persona' } })
    await m.remember({ kind: 'semantic', text: '曾住吉隆坡', meta: { validFrom: 0, validTo: 200 } })
    await m.remember({
      kind: 'semantic',
      text: '怎么对账',
      meta: { form: 'procedure', steps: ['打开报表', '逐笔核对'] },
    })
    await m.remember({ kind: 'episodic', text: '昨晚说奶茶店珍珠偏甜' })

    hub.register(butlerFor('butler:alice', 'alice'))
    const reply = await ask('butler:alice', 'alice', '你记得我什么?')

    // Structured, tier-grouped, honestly tagged — the /me projection in IM form.
    expect(reply).toContain('【管家记忆】画像 4 条 · 最近 1 条')
    expect(reply).toContain('- [项目] 在做 Gotong 项目(重要)')
    expect(reply).toContain('- [画像] 喜欢少糖奶茶')
    // Untiered fact folds into the default cluster; the closed fact says so.
    expect(reply).toContain('- [其它] 曾住吉隆坡(已失效)')
    // A how-to is its own section, not a 画像 line.
    expect(reply).toContain('■ 会做的事')
    expect(reply).toContain('- 怎么对账')
    expect(reply).toContain('■ 最近聊到')
    expect(reply).toContain('- 昨晚说奶茶店珍珠偏甜')
    // Right to be forgotten — always disclosed.
    expect(reply).toContain('管家记得你什么')

    // 同源: the IM answer and the /me panel read the same bytes.
    const snap = await svc.read('alice')
    expect(snap.profile).toHaveLength(4)
    for (const e of snap.profile) expect(reply).toContain(e.text)
  })

  it('② no-leak: another member gets the friendly empty answer, none of alice\'s bytes', async () => {
    const m = openButlerMemory({ rootDir: memRoot, userId: 'alice', logger: silentLogger })
    await m.remember({ kind: 'semantic', text: '在做 Gotong 项目', meta: { tier: 'projects' } })

    hub.register(butlerFor('butler:bob', 'bob'))
    const reply = await ask('butler:bob', 'bob', '你记得我什么?')

    expect(reply).toContain('还没有存下')
    expect(reply).not.toContain('Gotong')
  })

  it('③ the renderer counts overflow honestly', () => {
    const facts = Array.from({ length: 15 }, (_, i) => ({
      id: `f${i}`,
      kind: 'semantic',
      text: `事实 ${i}`,
      ts: i,
      importance: 3,
    }))
    const out = renderButlerMemorySnapshot({ profile: facts, recent: [] })
    expect(out).toContain('画像 15 条')
    expect(out).toContain('……另有 3 条画像。')
    // Renders exactly the cap, not everything.
    expect(out).toContain('事实 11')
    expect(out).not.toContain('事实 12')
  })
})
