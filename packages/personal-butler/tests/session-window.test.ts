/**
 * Session window — the per-member rolling conversation transcript that rides
 * `payload.history` (the "查一下 → 查什么?" continuity fix).
 *
 * Pins the load-bearing properties: (1) file-first round-trip — a fresh
 * instance over the same rootDir sees the prior turns; (2) idle rollover —
 * an hour of silence starts a fresh conversation, and the next append clears
 * the stale turns; (3) provider-safe rendering — consecutive same-role
 * entries merge, a trailing user entry is dropped (the current sentence
 * follows right behind in `buildRequest`), so history + current always
 * alternates; (4) bounded — max turns trims oldest-first, per-entry clip;
 * (5) honest failure — corrupt file quarantined (bytes preserved), window
 * restarts empty, append never throws.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Task } from '@gotong/core'

import {
  ButlerSessionWindow,
  SESSION_IDLE_MS,
  SESSION_MAX_TURNS,
  SESSION_TURN_MAX_CHARS,
  SESSION_RECALL_HINT,
  buildButlerSessionHintProbe,
} from '../src/index.js'

let dir: string
let clock: number

const makeWindow = () =>
  new ButlerSessionWindow({ rootDir: dir, now: () => clock, logger: { warn: () => {} } })

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gotong-session-window-'))
  clock = 1_000_000
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('ButlerSessionWindow', () => {
  it('starts empty and round-trips turns across instances (file-first)', async () => {
    const w = makeWindow()
    expect(await w.history('u1')).toEqual([])

    await w.append('u1', 'user', '帮我查一下明天吉隆坡的天气')
    await w.append('u1', 'assistant', '要不要我顺便查后天的?')

    // A FRESH instance over the same rootDir sees the same conversation.
    const w2 = makeWindow()
    expect(await w2.history('u1')).toEqual([
      { role: 'user', content: '帮我查一下明天吉隆坡的天气' },
      { role: 'assistant', content: '要不要我顺便查后天的?' },
    ])
  })

  it('isolates members: one user\'s turns never leak into another\'s history', async () => {
    const w = makeWindow()
    await w.append('u1', 'user', 'alpha')
    await w.append('u1', 'assistant', 'beta')
    await w.append('u2', 'user', 'gamma')
    expect(await w.history('u2')).toEqual([]) // trailing user dropped → empty
    const h1 = await w.history('u1')
    expect(h1.map((m) => m.content)).toEqual(['alpha', 'beta'])
  })

  it('rolls over after the idle gap: stale history reads empty', async () => {
    const w = makeWindow()
    await w.append('u1', 'user', '早上的话')
    await w.append('u1', 'assistant', '早上的回复')
    clock += SESSION_IDLE_MS + 1
    expect(await w.history('u1')).toEqual([])
  })

  it('a post-gap append clears the stale turns (fresh conversation)', async () => {
    const w = makeWindow()
    await w.append('u1', 'user', '昨天的话')
    await w.append('u1', 'assistant', '昨天的回复')
    clock += SESSION_IDLE_MS + 1
    await w.append('u1', 'user', '今天的新话')
    await w.append('u1', 'assistant', '今天的回复')
    expect(await w.history('u1')).toEqual([
      { role: 'user', content: '今天的新话' },
      { role: 'assistant', content: '今天的回复' },
    ])
  })

  it('within the idle gap the conversation continues', async () => {
    const w = makeWindow()
    await w.append('u1', 'user', '第一句')
    await w.append('u1', 'assistant', '第一答')
    clock += SESSION_IDLE_MS - 1000
    await w.append('u1', 'user', '第二句')
    await w.append('u1', 'assistant', '第二答')
    expect((await w.history('u1')).length).toBe(4)
  })

  it('merges consecutive same-role entries into one message', async () => {
    const w = makeWindow()
    await w.append('u1', 'user', '你好')
    await w.append('u1', 'assistant', '结果出来了:一切正常')
    await w.append('u1', 'assistant', '「专家」办完了你转派的事:报告在此')
    const h = await w.history('u1')
    expect(h).toEqual([
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '结果出来了:一切正常\n\n「专家」办完了你转派的事:报告在此' },
    ])
  })

  it('drops a trailing user entry so history always ends on assistant', async () => {
    const w = makeWindow()
    await w.append('u1', 'user', '第一句')
    await w.append('u1', 'assistant', '第一答')
    await w.append('u1', 'user', '模型崩了没回复的那句')
    const h = await w.history('u1')
    expect(h[h.length - 1]).toEqual({ role: 'assistant', content: '第一答' })
  })

  it('trims to the last SESSION_MAX_TURNS entries, oldest first', async () => {
    const w = makeWindow()
    for (let i = 0; i < SESSION_MAX_TURNS + 4; i++) {
      await w.append('u1', i % 2 === 0 ? 'user' : 'assistant', `t${i}`)
    }
    const raw = JSON.parse(
      readFileSync(join(dir, `${encodeURIComponent('u1')}.json`), 'utf8'),
    ) as { turns: { text: string }[] }
    expect(raw.turns.length).toBe(SESSION_MAX_TURNS)
    expect(raw.turns[0]!.text).toBe('t4') // t0..t3 dropped
  })

  it('clips a pasted wall of text to the per-entry cap', async () => {
    const w = makeWindow()
    await w.append('u1', 'user', 'x'.repeat(SESSION_TURN_MAX_CHARS * 2))
    await w.append('u1', 'assistant', 'ok')
    const h = await w.history('u1')
    expect(h[0]!.content.length).toBe(SESSION_TURN_MAX_CHARS)
    expect(h[0]!.content.endsWith('…')).toBe(true)
  })

  it('ignores empty/whitespace appends', async () => {
    const w = makeWindow()
    await w.append('u1', 'user', '   \n  ')
    expect(await w.history('u1')).toEqual([])
    expect(existsSync(join(dir, `${encodeURIComponent('u1')}.json`))).toBe(false)
  })

  it('quarantines a corrupt file (bytes preserved) and restarts empty', async () => {
    const w = makeWindow()
    await w.append('u1', 'user', 'before')
    const file = join(dir, `${encodeURIComponent('u1')}.json`)
    writeFileSync(file, '{not json!!!')

    expect(await w.history('u1')).toEqual([])
    const quarantined = readdirSync(dir).find((f) => f.includes('.corrupt-'))
    expect(quarantined).toBeDefined()
    expect(readFileSync(join(dir, quarantined!), 'utf8')).toBe('{not json!!!')

    // And the window keeps working after quarantine.
    await w.append('u1', 'user', 'after')
    await w.append('u1', 'assistant', 'reply')
    expect((await w.history('u1')).map((m) => m.content)).toEqual(['after', 'reply'])
  })

  it('append never throws even when rootDir is unwritable', async () => {
    const w = new ButlerSessionWindow({
      rootDir: join(dir, 'nope\0bad'), // invalid path → mkdir fails
      now: () => clock,
      logger: { warn: () => {} },
    })
    await expect(w.append('u1', 'user', 'hello')).resolves.toBeUndefined()
  })

  it('serializes concurrent appends for the same user (no lost turns)', async () => {
    const w = makeWindow()
    await Promise.all([
      w.append('u1', 'user', 'a'),
      w.append('u1', 'assistant', 'b'),
      w.append('u1', 'user', 'c'),
      w.append('u1', 'assistant', 'd'),
    ])
    const raw = JSON.parse(
      readFileSync(join(dir, `${encodeURIComponent('u1')}.json`), 'utf8'),
    ) as { turns: { text: string }[] }
    expect(raw.turns.map((t) => t.text)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('beginTurn returns prior history and records the turn in one atomic step', async () => {
    const w = makeWindow()
    await w.append('u1', 'user', '早')
    await w.append('u1', 'assistant', '早上好')

    const history = await w.beginTurn('u1', '帮我订位')
    // Returned history = the state BEFORE this turn (buildRequest appends it).
    expect(history).toEqual([
      { role: 'user', content: '早' },
      { role: 'assistant', content: '早上好' },
    ])
    // …and the turn IS recorded (visible to the next reader).
    const raw = JSON.parse(
      readFileSync(join(dir, `${encodeURIComponent('u1')}.json`), 'utf8'),
    ) as { turns: { text: string }[] }
    expect(raw.turns.map((t) => t.text)).toEqual(['早', '早上好', '帮我订位'])
  })

  it('beginTurn: a concurrent assistant push-back is visible to the turn queued after it', async () => {
    // The race the split history()+append() pair allows: a bare history()
    // read never joins the write chain, so it can run while an out-of-band
    // assistant push-back (escalation result / broadcast) is mid-append and
    // miss the line the butler just said. beginTurn JOINS the chain: what a
    // turn sees = everything queued before it, deterministically.
    const w = makeWindow()
    await w.append('u1', 'user', '转派给专家')
    await w.append('u1', 'assistant', '好,已转派')
    const [, h] = await Promise.all([
      w.append('u1', 'assistant', '「专家」办完了'),
      w.beginTurn('u1', '结果如何?'),
    ])
    expect(h.map((m) => m.content).join('\n')).toContain('「专家」办完了')
    // All four prior entries + the new user turn are on disk, in queue order.
    const raw = JSON.parse(
      readFileSync(join(dir, `${encodeURIComponent('u1')}.json`), 'utf8'),
    ) as { turns: { text: string }[] }
    expect(raw.turns.map((t) => t.text)).toEqual([
      '转派给专家',
      '好,已转派',
      '「专家」办完了',
      '结果如何?',
    ])
  })

  it('beginTurn: an un-replied sibling user turn stays invisible (alternation rule, by design)', async () => {
    // Two group members talking at once: the second's history renders the
    // first's turn as a TRAILING user group, which render() drops so the
    // appended current sentence never breaks user/assistant alternation.
    // Both turns still land on disk — nothing is lost, only deferred until
    // the assistant replies.
    const w = makeWindow()
    const [h1, h2] = await Promise.all([
      w.beginTurn('room', 'Alice: 今晚吃什么?'),
      w.beginTurn('room', 'Bob: 火锅吧'),
    ])
    expect(h1).toEqual([])
    expect(h2).toEqual([])
    const raw = JSON.parse(
      readFileSync(join(dir, `${encodeURIComponent('room')}.json`), 'utf8'),
    ) as { turns: { text: string }[] }
    expect(raw.turns.map((t) => t.text)).toEqual(['Alice: 今晚吃什么?', 'Bob: 火锅吧'])
  })

  it('beginTurn with empty text returns history without recording anything', async () => {
    const w = makeWindow()
    await w.append('u1', 'user', '你好')
    await w.append('u1', 'assistant', '你好!')
    const h = await w.beginTurn('u1', '   ')
    expect(h).toHaveLength(2)
    const raw = JSON.parse(
      readFileSync(join(dir, `${encodeURIComponent('u1')}.json`), 'utf8'),
    ) as { turns: unknown[] }
    expect(raw.turns).toHaveLength(2)
  })

  it('beginTurn never throws even when rootDir is unwritable', async () => {
    const w = new ButlerSessionWindow({
      rootDir: join(dir, 'not-a-dir-file'),
      now: () => clock,
      logger: { warn: () => {} },
    })
    writeFileSync(join(dir, 'not-a-dir-file'), 'block the mkdir')
    await expect(w.beginTurn('u1', '会丢但不能炸')).resolves.toEqual([])
  })

  it('encodes hostile userIds into safe filenames (no traversal)', async () => {
    const w = makeWindow()
    await w.append('../../evil', 'user', 'x')
    await w.append('../../evil', 'assistant', 'y')
    const files = readdirSync(dir)
    expect(files.length).toBe(1)
    expect(files[0]!.includes('..%2F')).toBe(true)
    expect((await w.history('../../evil')).length).toBe(2)
  })
})

describe('buildButlerSessionHintProbe', () => {
  const probe = buildButlerSessionHintProbe()
  const task = (payload: unknown): Task =>
    ({ id: 't1', from: 'im:lark:u1', title: 'im:lark', payload }) as unknown as Task

  it('fires the recall hint when the turn rides a non-empty history', async () => {
    const hint = await probe(
      task({ prompt: '查一下', history: [{ role: 'user', content: '帮我看看机票' }] }),
    )
    expect(hint).toBe(SESSION_RECALL_HINT)
    // 文案与常量互相咬住:窗多大、指哪个工具、空手怎么办 —— 三件事都得在。
    expect(hint).toContain(String(SESSION_MAX_TURNS))
    expect(hint).toContain('recall')
    expect(hint).toContain('记不清')
  })

  it('stays silent on every non-windowed shape (byte-identical contract)', async () => {
    // 与 LlmAgent.buildRequest 同一个形状测试:不是非空数组就不算带窗。
    expect(await probe(task({ prompt: '你好' }))).toBeNull() // 无 history 键
    expect(await probe(task({ prompt: '你好', history: [] }))).toBeNull() // 空数组
    expect(await probe(task({ prompt: '你好', history: '早上聊过' }))).toBeNull() // 非数组
    expect(await probe(task('一句纯字符串 payload'))).toBeNull()
    expect(await probe(task(null))).toBeNull()
    expect(await probe(task(undefined))).toBeNull()
  })
})
