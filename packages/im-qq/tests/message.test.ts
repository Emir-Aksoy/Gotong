/**
 * QQ official message mapper + chatId helpers — pure functions.
 */

import { describe, expect, it } from 'vitest'

import {
  parseQqChatId,
  pickQqUserId,
  qqToImMessage,
  stripQqGuildMention,
} from '../src/message.js'
import { QQ_OP_DISPATCH, type QqWebhookPayload } from '../src/types.js'

function dispatch(t: string, d: Record<string, unknown>, id = 'EV1'): QqWebhookPayload {
  return { op: QQ_OP_DISPATCH, id, t, d }
}

describe('parseQqChatId', () => {
  it('parses each tagged surface', () => {
    expect(parseQqChatId('group:G1')).toEqual({ kind: 'group', id: 'G1' })
    expect(parseQqChatId('c2c:U1')).toEqual({ kind: 'c2c', id: 'U1' })
    expect(parseQqChatId('channel:C1')).toEqual({ kind: 'channel', id: 'C1' })
    expect(parseQqChatId('dm:GU1')).toEqual({ kind: 'dm', id: 'GU1' })
  })

  it('keeps colons inside the id', () => {
    expect(parseQqChatId('c2c:a:b:c')).toEqual({ kind: 'c2c', id: 'a:b:c' })
  })

  it('returns null on malformed / unknown input', () => {
    expect(parseQqChatId('nope:X')).toBeNull()
    expect(parseQqChatId('group:')).toBeNull()
    expect(parseQqChatId(':X')).toBeNull()
    expect(parseQqChatId('plain')).toBeNull()
    expect(parseQqChatId(123)).toBeNull()
    expect(parseQqChatId(undefined)).toBeNull()
  })
})

describe('pickQqUserId', () => {
  it('prefers union_openid (stable across group + C2C)', () => {
    expect(
      pickQqUserId({ id: 'raw', union_openid: 'UNION', member_openid: 'MEM' }),
    ).toBe('UNION')
  })

  it('falls back member → user → id', () => {
    expect(pickQqUserId({ id: 'raw', member_openid: 'MEM' })).toBe('MEM')
    expect(pickQqUserId({ id: 'raw', user_openid: 'USR' })).toBe('USR')
    expect(pickQqUserId({ id: 'raw' })).toBe('raw')
  })

  it('returns null when nothing usable', () => {
    expect(pickQqUserId(undefined)).toBeNull()
    expect(pickQqUserId({})).toBeNull()
  })
})

describe('stripQqGuildMention', () => {
  it('removes <@!id> and <@id> tags', () => {
    expect(stripQqGuildMention('<@!123> hello')).toBe('hello')
    expect(stripQqGuildMention('<@456> /help')).toBe('/help')
  })

  it('collapses doubled whitespace left behind', () => {
    expect(stripQqGuildMention('<@!1>  spaced  out')).toBe('spaced out')
  })

  it('is a no-op on plain text', () => {
    expect(stripQqGuildMention('just text')).toBe('just text')
  })
})

describe('qqToImMessage', () => {
  it('maps a group @bot message', () => {
    const im = qqToImMessage(
      dispatch('GROUP_AT_MESSAGE_CREATE', {
        id: 'M1',
        content: ' /help', // platform leaves a leading space after the @
        timestamp: '2026-01-02T03:04:05+00:00',
        group_openid: 'G_ABC',
        author: { id: 'raw', union_openid: 'U_UNION', member_openid: 'M_OPEN' },
      }),
    )
    expect(im).not.toBeNull()
    expect(im!.chatId).toBe('group:G_ABC')
    expect(im!.from.platformUserId).toBe('U_UNION')
    expect(im!.text).toBe('/help') // trimmed
    expect(im!.messageId).toBe('M1')
    expect(im!.ts).toBe(Date.parse('2026-01-02T03:04:05+00:00'))
  })

  it('maps a C2C (friend) message and replies to user_openid', () => {
    const im = qqToImMessage(
      dispatch('C2C_MESSAGE_CREATE', {
        id: 'M2',
        content: 'hi',
        author: { id: 'raw', union_openid: 'U_UNION', user_openid: 'U_C2C' },
      }),
    )
    expect(im!.chatId).toBe('c2c:U_C2C') // reply target = user_openid
    expect(im!.from.platformUserId).toBe('U_UNION') // binding id = union
  })

  it('maps a guild channel message and strips the bot mention', () => {
    const im = qqToImMessage(
      dispatch('AT_MESSAGE_CREATE', {
        id: 'M3',
        content: '<@!10001> /agents',
        channel_id: 'CH_1',
        author: { id: 'U_GUILD', username: 'Alice' },
      }),
    )
    expect(im!.chatId).toBe('channel:CH_1')
    expect(im!.text).toBe('/agents')
    expect(im!.from.platformUserId).toBe('U_GUILD')
    expect(im!.from.displayName).toBe('Alice')
  })

  it('maps a guild direct message', () => {
    const im = qqToImMessage(
      dispatch('DIRECT_MESSAGE_CREATE', {
        id: 'M4',
        content: '<@!1> ping',
        guild_id: 'GUILD_9',
        author: { id: 'U_DM' },
      }),
    )
    expect(im!.chatId).toBe('dm:GUILD_9')
    expect(im!.text).toBe('ping')
  })

  it('can preserve guild mentions when asked', () => {
    const im = qqToImMessage(
      dispatch('AT_MESSAGE_CREATE', {
        id: 'M5',
        content: '<@!1> keep',
        channel_id: 'CH',
        author: { id: 'U' },
      }),
      { stripBotMentions: false },
    )
    expect(im!.text).toBe('<@!1> keep')
  })

  it('returns null for non-message / non-dispatch payloads', () => {
    expect(qqToImMessage({ op: 13, d: {} })).toBeNull()
    expect(qqToImMessage(dispatch('GUILD_CREATE', {}))).toBeNull()
    expect(qqToImMessage({ op: QQ_OP_DISPATCH, t: 'GROUP_AT_MESSAGE_CREATE' })).toBeNull()
  })

  it('returns null when the surface id or author id is missing', () => {
    // group event without group_openid
    expect(
      qqToImMessage(dispatch('GROUP_AT_MESSAGE_CREATE', { id: 'M', author: { id: 'A' } })),
    ).toBeNull()
    // author with no usable id
    expect(
      qqToImMessage(
        dispatch('GROUP_AT_MESSAGE_CREATE', { id: 'M', group_openid: 'G', author: {} }),
      ),
    ).toBeNull()
  })
})
