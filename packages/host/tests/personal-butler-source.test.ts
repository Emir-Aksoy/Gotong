/**
 * A4 来源渠道感知 — the zero-LLM card that tells the butler which IM channel a
 * message came on, so it shapes the reply for a chat bubble (plain text) instead
 * of a Markdown wall.
 *
 * Pins: (1) platform parse off the IM router's `from`/`title` id convention,
 * with the non-IM turns (web console / reminder) reading as null; (2) friendly
 * names with a raw-id fallback; (3) the probe injects only on a known IM turn.
 */

import type { Task } from '@gotong/core'

import { describe, expect, it } from 'vitest'

import {
  buildButlerSourceProbe,
  buildSourceCard,
  parseImPlatform,
  platformDisplayName,
} from '../src/personal-butler-source.js'

/** A minimal task carrying only the fields the probe reads. */
const task = (fields: Partial<Pick<Task, 'from' | 'title'>>): Task =>
  ({ from: '', title: undefined, ...fields }) as Task

describe('parseImPlatform', () => {
  it('reads the platform from `from` (im:<platform>:<userId>)', () => {
    expect(parseImPlatform(task({ from: 'im:telegram:12345' }))).toBe('telegram')
    expect(parseImPlatform(task({ from: 'im:lark:ou_abc' }))).toBe('lark')
  })

  it('falls back to `title` (im:<platform>) when `from` is not an im id', () => {
    expect(parseImPlatform(task({ from: 'agent:butler', title: 'im:slack' }))).toBe('slack')
  })

  it('tolerates a title with a trailing segment (im:<platform>:workflow:x)', () => {
    expect(parseImPlatform(task({ from: 'x', title: 'im:discord:workflow:brief' }))).toBe('discord')
  })

  it('null for a non-IM turn (web console / reminder / proactive push)', () => {
    expect(parseImPlatform(task({ from: 'agent:butler', title: 'chat' }))).toBeNull()
    expect(parseImPlatform(task({ from: '', title: undefined }))).toBeNull()
    expect(parseImPlatform(task({ from: 'im:', title: undefined }))).toBeNull() // empty platform
  })
})

describe('platformDisplayName', () => {
  it('gives friendly names for the bridged platforms', () => {
    expect(platformDisplayName('telegram')).toBe('Telegram')
    expect(platformDisplayName('lark')).toContain('飞书')
    expect(platformDisplayName('qq')).toBe('QQ')
    expect(platformDisplayName('wechat')).toContain('微信')
  })
  it('falls back to the raw id for an unknown platform (never fabricates)', () => {
    expect(platformDisplayName('signal')).toBe('signal')
  })
})

describe('buildSourceCard', () => {
  it('names the channel and steers toward plain, chat-shaped replies', () => {
    const card = buildSourceCard('telegram')
    expect(card).toContain('Telegram')
    expect(card).toContain('纯文本')
    expect(card).toContain('别用表格')
  })
})

describe('buildButlerSourceProbe', () => {
  it('injects the card on a known IM turn', async () => {
    const probe = buildButlerSourceProbe()
    expect(await probe(task({ from: 'im:telegram:42' }))).toContain('Telegram')
  })
  it('null on a non-IM turn (byte-identical prompt)', async () => {
    const probe = buildButlerSourceProbe()
    expect(await probe(task({ from: 'agent:butler', title: 'chat' }))).toBeNull()
  })
})
