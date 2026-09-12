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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
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
  new ButlerSessionWindow({ rootDir: dir, now: () => clock, timeZone: 'UTC', logger: { warn: () => {} } })

const tagged = (text: string, time = '1970-01-01 00:16') => `[${time} UTC] ${text}`

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gotong-session-window-'))
  clock = 1_000_000
})

afterEach(() => {
  vi.restoreAllMocks()
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
      { role: 'user', content: tagged('帮我查一下明天吉隆坡的天气') },
      { role: 'assistant', content: tagged('要不要我顺便查后天的?') },
    ])
  })

  it('isolates members: one user\'s turns never leak into another\'s history', async () => {
    const w = makeWindow()
    await w.append('u1', 'user', 'alpha')
    await w.append('u1', 'assistant', 'beta')
    await w.append('u2', 'user', 'gamma')
    expect(await w.history('u2')).toEqual([]) // trailing user dropped → empty
    const h1 = await w.history('u1')
    expect(h1.map((m) => m.content)).toEqual([tagged('alpha'), tagged('beta')])
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
      { role: 'user', content: tagged('今天的新话', '1970-01-01 01:16') },
      { role: 'assistant', content: tagged('今天的回复', '1970-01-01 01:16') },
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
      { role: 'user', content: tagged('你好') },
      { role: 'assistant', content: `${tagged('结果出来了:一切正常')}\n\n${tagged('「专家」办完了你转派的事:报告在此')}` },
    ])
  })

  it('drops a trailing user entry so history always ends on assistant', async () => {
    const w = makeWindow()
    await w.append('u1', 'user', '第一句')
    await w.append('u1', 'assistant', '第一答')
    await w.append('u1', 'user', '模型崩了没回复的那句')
    const h = await w.history('u1')
    expect(h[h.length - 1]).toEqual({ role: 'assistant', content: tagged('第一答') })
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
    expect((await w.history('u1')).map((m) => m.content)).toEqual([tagged('after'), tagged('reply')])
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
      { role: 'user', content: tagged('早') },
      { role: 'assistant', content: tagged('早上好') },
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

describe('session time evidence', () => {
  const file = () => join(dir, 'u1.json')
  const stored = () => JSON.parse(readFileSync(file(), 'utf8')) as {
    turns: { role: string; text: string; at: number; timeZone?: string }[]
  }

  it('persists the injected time and zone through both writing paths, without changing text', async () => {
    clock = Date.parse('2026-09-11T06:59:00Z')
    const w = new ButlerSessionWindow({ rootDir: dir, now: () => clock, timeZone: 'America/Los_Angeles' })
    await w.beginTurn('u1', '今天')
    clock += 60_000
    await w.append('u1', 'assistant', '明天')
    expect(stored().turns).toEqual([
      { role: 'user', text: '今天', at: Date.parse('2026-09-11T06:59:00Z'), timeZone: 'America/Los_Angeles' },
      { role: 'assistant', text: '明天', at: clock, timeZone: 'America/Los_Angeles' },
    ])

    // Reading later in another server zone must not reinterpret saved turns.
    clock += 60_000
    const restarted = new ButlerSessionWindow({ rootDir: dir, now: () => clock, timeZone: 'Asia/Tokyo' })
    const expected = [
      { role: 'user', content: '[2026-09-10 23:59 America/Los_Angeles] 今天' },
      { role: 'assistant', content: '[2026-09-11 00:00 America/Los_Angeles] 明天' },
    ]
    expect(await restarted.history('u1')).toEqual(expected)
    expect(await restarted.beginTurn('u1', '下一句')).toEqual(expected)
    expect(stored().turns[2]).toMatchObject({ at: clock, timeZone: 'Asia/Tokyo' })
  })

  it('resolves the default server zone for each new turn', async () => {
    const w = new ButlerSessionWindow({ rootDir: dir, now: () => clock })
    const resolved = new Intl.DateTimeFormat().resolvedOptions()
    const spy = vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions')
      .mockReturnValueOnce({ ...resolved, timeZone: 'Asia/Tokyo' })
      .mockReturnValueOnce({ ...resolved, timeZone: 'UTC' })
    await w.append('u1', 'user', 'a')
    await w.append('u1', 'assistant', 'b')
    spy.mockRestore()
    expect(stored().turns.map((t) => t.timeZone)).toEqual(['Asia/Tokyo', 'UTC'])
  })

  it('uses the actual Intl server zone when no override is supplied', async () => {
    const w = new ButlerSessionWindow({ rootDir: dir, now: () => clock })
    await w.beginTurn('u1', 'hello')
    expect(stored().turns[0]!.timeZone).toBe(new Intl.DateTimeFormat().resolvedOptions().timeZone)
  })

  it.each(['throws', 'empty'] as const)('explicitly saves UTC when server zone resolution %s', async (failure) => {
    const w = new ButlerSessionWindow({ rootDir: dir, now: () => clock })
    const resolved = new Intl.DateTimeFormat().resolvedOptions()
    const spy = vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions')
    if (failure === 'throws') spy.mockImplementation(() => { throw new RangeError('Intl unavailable') })
    else spy.mockReturnValue({ ...resolved, timeZone: '' })
    await w.beginTurn('u1', 'a')
    await w.append('u1', 'assistant', 'b')
    spy.mockRestore()
    expect(stored().turns.map((t) => t.timeZone)).toEqual(['UTC', 'UTC'])
    expect(await w.history('u1')).toEqual([
      { role: 'user', content: tagged('a') },
      { role: 'assistant', content: tagged('b') },
    ])
  })

  it.each(['not/a-zone', ''])('falls back to UTC for invalid override %j', async (timeZone) => {
    const w = new ButlerSessionWindow({ rootDir: dir, now: () => clock, timeZone })
    await w.append('u1', 'assistant', 'hello')
    expect(stored().turns[0]!.timeZone).toBe('UTC')
    expect(await w.history('u1')).toEqual([{ role: 'assistant', content: tagged('hello') }])
  })

  it('still saves and renders explicit UTC if Intl itself is unavailable', async () => {
    const w = new ButlerSessionWindow({ rootDir: dir, now: () => clock })
    vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(() => { throw new RangeError('Intl unavailable') })
    await w.beginTurn('u1', 'a')
    await w.append('u1', 'assistant', 'b')
    expect(stored().turns.map((t) => t.timeZone)).toEqual(['UTC', 'UTC'])
    expect(await w.history('u1')).toEqual([
      { role: 'user', content: tagged('a') },
      { role: 'assistant', content: tagged('b') },
    ])
  })

  it('uses the saved instant across the daylight-saving jump', async () => {
    clock = Date.parse('2026-03-08T09:59:00Z')
    const w = new ButlerSessionWindow({ rootDir: dir, now: () => clock, timeZone: 'America/Los_Angeles' })
    await w.beginTurn('u1', 'before')
    clock += 60_000
    await w.append('u1', 'assistant', 'after')
    expect(await w.history('u1')).toEqual([
      { role: 'user', content: '[2026-03-08 01:59 America/Los_Angeles] before' },
      { role: 'assistant', content: '[2026-03-08 03:00 America/Los_Angeles] after' },
    ])
  })

  it('leaves old records and their rendering untouched, including after a new append', async () => {
    const turns = [
      { role: 'user', text: 'legacy question', at: clock },
      { role: 'assistant', text: 'legacy reply', at: clock },
      { role: 'assistant', text: 'legacy follow-up', at: clock },
    ]
    const bytes = JSON.stringify({ v: 1, turns })
    writeFileSync(file(), bytes)
    const w = makeWindow()
    expect(await w.history('u1')).toEqual([
      { role: 'user', content: 'legacy question' },
      { role: 'assistant', content: 'legacy reply\n\nlegacy follow-up' },
    ])
    expect(readFileSync(file(), 'utf8')).toBe(bytes)
    await w.append('u1', 'assistant', 'new reply')
    expect(stored().turns.slice(0, 3)).toEqual(turns)
    expect(await w.history('u1')).toEqual([
      { role: 'user', content: 'legacy question' },
      { role: 'assistant', content: `legacy reply\n\nlegacy follow-up\n\n${tagged('new reply')}` },
    ])
  })

  it('counts the label against the single-message cap on the beginTurn path', async () => {
    const w = makeWindow()
    await w.beginTurn('u1', 'x'.repeat(SESSION_TURN_MAX_CHARS))
    await w.append('u1', 'assistant', 'ok')
    const [message] = await w.history('u1')
    const prefix = tagged('')
    expect(message!.content).toBe(prefix + 'x'.repeat(SESSION_TURN_MAX_CHARS - prefix.length - 1) + '…')
  })

  describe.each(['history', 'beginTurn'] as const)('%s with malformed persisted turns', (method) => {
    it.each(['1e20', '-1e20', '1e400', '-1e400'])('keeps text without inventing a label for date %s', async (at) => {
      // JSON exponent overflow is accepted as Infinity; JSON.stringify would replace it with null.
      const bytes = `{"v":1,"turns":[{"role":"user","text":"unknown time","at":${at},"timeZone":"UTC"},{"role":"assistant","text":"valid reply","at":${clock},"timeZone":"UTC"}]}`
      writeFileSync(file(), bytes)
      const w = makeWindow()
      const history = method === 'history'
        ? await w.history('u1')
        : await w.beginTurn('u1', 'next question')
      expect(history).toEqual([
        { role: 'user', content: 'unknown time' },
        { role: 'assistant', content: tagged('valid reply') },
      ])
      if (method === 'history') expect(readFileSync(file(), 'utf8')).toBe(bytes)
      else expect(stored().turns.at(-1)).toMatchObject({ text: 'next question', at: clock, timeZone: 'UTC' })
    })

    it('bounds an oversized same-role file to the newest turns before formatting', async () => {
      const turns = Array.from({ length: 1000 }, (_, i) => ({
        role: 'assistant', text: `turn-${i}`, at: clock, timeZone: 'UTC',
      }))
      const bytes = JSON.stringify({ v: 1, turns })
      writeFileSync(file(), bytes)
      const w = makeWindow()
      const history = method === 'history'
        ? await w.history('u1')
        : await w.beginTurn('u1', '')
      expect(history).toHaveLength(1)
      expect(history[0]!.content.length).toBeLessThanOrEqual(SESSION_TURN_MAX_CHARS)
      expect(history[0]!.content).toBe(turns.slice(-SESSION_MAX_TURNS).map((t) => tagged(t.text)).join('\n\n'))
      expect(readFileSync(file(), 'utf8')).toBe(bytes)
    })
  })

  it('caps merged messages without losing any constituent time label', async () => {
    const w = makeWindow()
    for (let i = 0; i < SESSION_MAX_TURNS; i++) {
      await w.append('u1', 'assistant', String.fromCharCode(65 + i).repeat(SESSION_TURN_MAX_CHARS))
      clock += 60_000
    }
    const history = await w.history('u1')
    expect(history).toHaveLength(1)
    expect(history[0]!.content.length).toBeLessThanOrEqual(SESSION_TURN_MAX_CHARS)
    const parts = history[0]!.content.split('\n\n')
    expect(parts).toHaveLength(SESSION_MAX_TURNS)
    for (let i = 0; i < SESSION_MAX_TURNS; i++) {
      expect(parts[i]).toMatch(new RegExp(`^\\[1970-01-01 00:${16 + i} UTC\\] ${String.fromCharCode(65 + i)}+…$`))
    }
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
