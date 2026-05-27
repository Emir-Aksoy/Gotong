/**
 * Phase 12 M7 — OneBot v11 mapper coverage.
 *
 * Pure-function tests; no network, no mocks.
 */

import { describe, expect, it } from 'vitest'

import {
  buildQqTextMessage,
  encodeQqChatId,
  oneBotToImMessage,
  parseQqChatId,
  qqExtractAttachments,
  qqSegmentsToText,
  stripQqBotMentions,
} from '../src/message.js'
import type { OneBotMessageEvent, OneBotMessageSegment } from '../src/types.js'

const SELF_ID = 100000
const USER_QQ = 200000
const GROUP_QQ = 500000

function makePrivate(over: Partial<OneBotMessageEvent> = {}): OneBotMessageEvent {
  return {
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    self_id: SELF_ID,
    user_id: USER_QQ,
    message_id: 7777,
    time: 1748345600,
    message: [{ type: 'text', data: { text: 'hello' } }],
    raw_message: 'hello',
    sender: { user_id: USER_QQ, nickname: 'Alice' },
    ...over,
  }
}

function makeGroup(over: Partial<OneBotMessageEvent> = {}): OneBotMessageEvent {
  return {
    ...makePrivate(),
    message_type: 'group',
    group_id: GROUP_QQ,
    sub_type: 'normal',
    ...over,
  }
}

describe('encodeQqChatId / parseQqChatId', () => {
  it('round-trips private:<user_id>', () => {
    const id = encodeQqChatId({ message_type: 'private', user_id: 12345 })
    expect(id).toBe('private:12345')
    expect(parseQqChatId(id)).toEqual({ message_type: 'private', id: 12345 })
  })

  it('round-trips group:<group_id>', () => {
    const id = encodeQqChatId({ message_type: 'group', group_id: 67890 })
    expect(id).toBe('group:67890')
    expect(parseQqChatId(id)).toEqual({ message_type: 'group', id: 67890 })
  })

  it('throws when private without user_id', () => {
    expect(() => encodeQqChatId({ message_type: 'private' })).toThrow(/user_id required/)
  })

  it('throws when group without group_id', () => {
    expect(() => encodeQqChatId({ message_type: 'group' })).toThrow(/group_id required/)
  })

  it('parseQqChatId rejects malformed strings', () => {
    expect(parseQqChatId('')).toBeNull()
    expect(parseQqChatId('private')).toBeNull()
    expect(parseQqChatId(':12345')).toBeNull()
    expect(parseQqChatId('unknown:1')).toBeNull()
    expect(parseQqChatId('private:abc')).toBeNull()
    expect(parseQqChatId('private:-5')).toBeNull()
    expect(parseQqChatId('private:0')).toBeNull()
  })

  it('parseQqChatId rejects non-string input', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(parseQqChatId(null as any)).toBeNull()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(parseQqChatId(123 as any)).toBeNull()
  })
})

describe('stripQqBotMentions', () => {
  it('strips array-form `at` segments targeting self', () => {
    const segs: OneBotMessageSegment[] = [
      { type: 'at', data: { qq: SELF_ID } },
      { type: 'text', data: { text: ' /help' } },
    ]
    const out = stripQqBotMentions(segs, SELF_ID) as OneBotMessageSegment[]
    expect(out).toHaveLength(1)
    expect(out[0]).toEqual({ type: 'text', data: { text: ' /help' } })
  })

  it('preserves array-form `at` segments targeting other users', () => {
    const segs: OneBotMessageSegment[] = [
      { type: 'at', data: { qq: USER_QQ } },
      { type: 'text', data: { text: ' hi' } },
    ]
    const out = stripQqBotMentions(segs, SELF_ID)
    expect(out).toHaveLength(2)
  })

  it('strips CQ-string-form [CQ:at,qq=<self>] from text', () => {
    const text = `[CQ:at,qq=${SELF_ID}] /help`
    expect(stripQqBotMentions(text, SELF_ID)).toBe('/help')
  })

  it('strips CQ-string-form with extra attrs', () => {
    const text = `[CQ:at,qq=${SELF_ID},name=Bot] /help`
    expect(stripQqBotMentions(text, SELF_ID)).toBe('/help')
  })

  it('leaves CQ-string-form other-user mentions intact', () => {
    const text = `[CQ:at,qq=${USER_QQ}] are you the bot?`
    expect(stripQqBotMentions(text, SELF_ID)).toBe(text)
  })

  it('passes through unchanged when selfId is null', () => {
    expect(stripQqBotMentions('hi', null)).toBe('hi')
    const segs: OneBotMessageSegment[] = [{ type: 'at', data: { qq: SELF_ID } }]
    expect(stripQqBotMentions(segs, null)).toEqual(segs)
  })
})

describe('qqSegmentsToText', () => {
  it('extracts text from array segments', () => {
    const out = qqSegmentsToText([
      { type: 'text', data: { text: 'hello ' } },
      { type: 'at', data: { qq: 1 } },
      { type: 'text', data: { text: 'world' } },
    ])
    expect(out).toBe('hello world')
  })

  it('passes through legacy string form verbatim', () => {
    expect(qqSegmentsToText('[CQ:at,qq=1] /help')).toBe('[CQ:at,qq=1] /help')
  })

  it('returns empty string when no text segments', () => {
    expect(qqSegmentsToText([{ type: 'image', data: { url: 'u' } }])).toBe('')
  })

  it('handles malformed input', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(qqSegmentsToText(null as any)).toBe('')
  })
})

describe('qqExtractAttachments', () => {
  it('returns [] for string-form messages (CQ codes not parsed in M7)', () => {
    expect(qqExtractAttachments('[CQ:image,file=x.jpg,url=https://a/x.jpg]')).toEqual([])
  })

  it('extracts image segments with url', () => {
    const out = qqExtractAttachments([
      { type: 'image', data: { url: 'https://cdn.qq/x.jpg', file: 'x.jpg' } },
    ])
    expect(out).toEqual([
      { kind: 'image', url: 'https://cdn.qq/x.jpg', mime: null, filename: 'x.jpg' },
    ])
  })

  it('extracts record segments as audio with audio/silk', () => {
    const out = qqExtractAttachments([
      { type: 'record', data: { url: 'https://cdn.qq/v.silk' } },
    ])
    expect(out[0]!.kind).toBe('audio')
    expect(out[0]!.mime).toBe('audio/silk')
  })

  it('extracts file segments', () => {
    const out = qqExtractAttachments([
      { type: 'file', data: { url: 'https://cdn.qq/f.pdf', name: 'paper.pdf' } },
    ])
    expect(out[0]!.kind).toBe('file')
    expect(out[0]!.filename).toBe('paper.pdf')
  })

  it('skips segments missing url (local-only)', () => {
    const out = qqExtractAttachments([
      { type: 'image', data: { file: 'local.jpg' } },
    ])
    expect(out).toEqual([])
  })

  it('skips unknown segment types', () => {
    const out = qqExtractAttachments([
      { type: 'face', data: { id: 1 } },
      { type: 'image', data: { url: 'https://cdn.qq/x.jpg' } },
    ])
    expect(out).toHaveLength(1)
    expect(out[0]!.kind).toBe('image')
  })

  it('preserves order across attachment types', () => {
    const out = qqExtractAttachments([
      { type: 'image', data: { url: 'a' } },
      { type: 'file', data: { url: 'b' } },
    ])
    expect(out.map((a) => a.kind)).toEqual(['image', 'file'])
  })
})

describe('oneBotToImMessage', () => {
  it('maps a basic private text message', () => {
    const im = oneBotToImMessage(makePrivate(), { selfId: SELF_ID })
    expect(im).not.toBeNull()
    expect(im!.from).toEqual({
      platform: 'qq',
      platformUserId: String(USER_QQ),
      displayName: 'Alice',
    })
    expect(im!.text).toBe('hello')
    expect(im!.chatId).toBe(`private:${USER_QQ}`)
    expect(im!.messageId).toBe('7777')
    expect(im!.ts).toBe(1748345600000)
    expect(im!.attachments).toBeUndefined()
  })

  it('maps a group message and encodes chatId as group:<group_id>', () => {
    const im = oneBotToImMessage(makeGroup(), { selfId: SELF_ID })
    expect(im!.chatId).toBe(`group:${GROUP_QQ}`)
  })

  it('prefers sender.card over sender.nickname for displayName', () => {
    const im = oneBotToImMessage(
      makeGroup({ sender: { user_id: USER_QQ, nickname: 'Nick', card: 'Bob' } }),
      { selfId: SELF_ID },
    )
    expect(im!.from.displayName).toBe('Bob')
  })

  it('falls back to null when neither card nor nickname is set', () => {
    const im = oneBotToImMessage(
      makePrivate({ sender: { user_id: USER_QQ } }),
      { selfId: SELF_ID },
    )
    expect(im!.from.displayName).toBeNull()
  })

  it('strips bot mentions by default', () => {
    const im = oneBotToImMessage(
      makeGroup({
        message: [
          { type: 'at', data: { qq: SELF_ID } },
          { type: 'text', data: { text: ' /help' } },
        ],
      }),
      { selfId: SELF_ID },
    )
    expect(im!.text).toBe('/help')
  })

  it('preserves bot mentions when stripBotMentions is false', () => {
    // Without strip the `at` segment remains but qqSegmentsToText still
    // ignores it (only text segments contribute) — so the visible text
    // is just the trailing fragment. That's the expected behaviour.
    const im = oneBotToImMessage(
      makeGroup({
        message: [
          { type: 'at', data: { qq: SELF_ID } },
          { type: 'text', data: { text: ' /help' } },
        ],
      }),
      { selfId: SELF_ID, stripBotMentions: false },
    )
    expect(im!.text).toBe('/help')
  })

  it('returns null when user_id matches self_id (anti-loop)', () => {
    const im = oneBotToImMessage(
      makePrivate({ user_id: SELF_ID }),
      { selfId: SELF_ID },
    )
    expect(im).toBeNull()
  })

  it('returns null on non-message post_type', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const im = oneBotToImMessage({ post_type: 'notice' } as any, { selfId: SELF_ID })
    expect(im).toBeNull()
  })

  it('returns null on non-numeric user_id', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const im = oneBotToImMessage(makePrivate({ user_id: 'abc' as any }), { selfId: SELF_ID })
    expect(im).toBeNull()
  })

  it('uses event.self_id when options.selfId is null', () => {
    // user_id === self_id should still trip anti-loop.
    const im = oneBotToImMessage(
      makePrivate({ user_id: SELF_ID, self_id: SELF_ID }),
      { selfId: null },
    )
    expect(im).toBeNull()
  })

  it('attaches images and keeps text', () => {
    const im = oneBotToImMessage(
      makePrivate({
        message: [
          { type: 'text', data: { text: 'caption' } },
          { type: 'image', data: { url: 'https://cdn/x.jpg', file: 'x.jpg' } },
        ],
      }),
      { selfId: SELF_ID },
    )
    expect(im!.text).toBe('caption')
    expect(im!.attachments).toHaveLength(1)
    expect(im!.attachments![0]!.kind).toBe('image')
  })

  it('falls back to Date.now() on time=0', () => {
    const before = Date.now()
    const im = oneBotToImMessage(makePrivate({ time: 0 }), { selfId: SELF_ID })
    const after = Date.now()
    expect(im!.ts).toBeGreaterThanOrEqual(before)
    expect(im!.ts).toBeLessThanOrEqual(after)
  })

  it('handles message as raw string (legacy CQ form)', () => {
    const im = oneBotToImMessage(
      makePrivate({ message: '[CQ:at,qq=100000] /help', raw_message: '[CQ:at,qq=100000] /help' }),
      { selfId: SELF_ID },
    )
    // strip default true; CQ string strip works in the message body.
    expect(im!.text).toBe('/help')
  })
})

describe('buildQqTextMessage', () => {
  it('wraps a string in a single text segment', () => {
    expect(buildQqTextMessage('hi')).toEqual([{ type: 'text', data: { text: 'hi' } }])
  })

  it('preserves empty string', () => {
    expect(buildQqTextMessage('')).toEqual([{ type: 'text', data: { text: '' } }])
  })
})
