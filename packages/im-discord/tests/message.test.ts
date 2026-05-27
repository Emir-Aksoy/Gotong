/**
 * Phase 12 M5 — Discord MESSAGE_CREATE → ImMessage mapper coverage.
 *
 * Pure-function tests; no network, no mocks.
 */

import { describe, expect, it } from 'vitest'

import {
  discordExtractAttachments,
  discordToImMessage,
  stripDiscordBotMentions,
} from '../src/message.js'
import type { DiscordMessage } from '../src/types.js'

const BOT_USER_ID = '999000111222333000'
const USER_ID = '111222333444555000'
const CHANNEL_ID = '777888999000111000'

function makeMessage(over: Partial<DiscordMessage> = {}): DiscordMessage {
  return {
    id: '100200300400500600',
    channel_id: CHANNEL_ID,
    author: {
      id: USER_ID,
      username: 'alice',
      global_name: 'Alice',
      bot: false,
    },
    content: 'hello',
    timestamp: '2026-05-27T10:00:00.000+00:00',
    type: 0,
    ...over,
  }
}

describe('stripDiscordBotMentions', () => {
  it('strips a leading <@BOT_ID> mention', () => {
    expect(stripDiscordBotMentions(`<@${BOT_USER_ID}> /help`, BOT_USER_ID)).toBe('/help')
  })

  it('strips the legacy <@!BOT_ID> nick form', () => {
    expect(stripDiscordBotMentions(`<@!${BOT_USER_ID}> ping`, BOT_USER_ID)).toBe('ping')
  })

  it('strips mentions anywhere in the body', () => {
    expect(
      stripDiscordBotMentions(
        `tell <@${BOT_USER_ID}> hi`,
        BOT_USER_ID,
      ),
    ).toBe('tell  hi'.trim())
  })

  it('leaves other-user mentions intact', () => {
    expect(
      stripDiscordBotMentions(
        `<@${USER_ID}> are you the bot?`,
        BOT_USER_ID,
      ),
    ).toBe(`<@${USER_ID}> are you the bot?`)
  })

  it('returns empty string when only the bot mention is present', () => {
    expect(stripDiscordBotMentions(`<@${BOT_USER_ID}>`, BOT_USER_ID)).toBe('')
  })

  it('passes through unchanged when no bot id is supplied', () => {
    expect(stripDiscordBotMentions('hello <@x>', null)).toBe('hello <@x>')
  })

  it('returns empty string for non-string input', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(stripDiscordBotMentions(null as any, BOT_USER_ID)).toBe('')
  })
})

describe('discordExtractAttachments', () => {
  it('returns [] when no attachments', () => {
    expect(discordExtractAttachments(makeMessage({ content: 'hi' }))).toEqual([])
  })

  it('classifies image/* MIME as image', () => {
    const msg = makeMessage({
      attachments: [
        {
          id: 'a1',
          filename: 'pic.png',
          url: 'https://cdn.discordapp.com/attachments/x/a1/pic.png',
          content_type: 'image/png',
        },
      ],
    })
    expect(discordExtractAttachments(msg)).toEqual([
      {
        kind: 'image',
        url: 'https://cdn.discordapp.com/attachments/x/a1/pic.png',
        mime: 'image/png',
        filename: 'pic.png',
      },
    ])
  })

  it('classifies audio/* MIME as audio', () => {
    const msg = makeMessage({
      attachments: [
        {
          id: 'a2',
          filename: 'voice.ogg',
          url: 'https://cdn.discordapp.com/attachments/x/a2/voice.ogg',
          content_type: 'audio/ogg',
        },
      ],
    })
    expect(discordExtractAttachments(msg)[0]!.kind).toBe('audio')
  })

  it('classifies other MIME as file', () => {
    const msg = makeMessage({
      attachments: [
        {
          id: 'a3',
          filename: 'paper.pdf',
          url: 'https://cdn/a3/paper.pdf',
          content_type: 'application/pdf',
        },
      ],
    })
    expect(discordExtractAttachments(msg)[0]!.kind).toBe('file')
  })

  it('falls back to image when MIME absent + width/height set', () => {
    const msg = makeMessage({
      attachments: [
        {
          id: 'a4',
          filename: 'mystery.bin',
          url: 'https://cdn/a4/mystery.bin',
          width: 640,
          height: 480,
        },
      ],
    })
    expect(discordExtractAttachments(msg)[0]!.kind).toBe('image')
  })

  it('falls back to audio when MIME absent + duration_secs set', () => {
    const msg = makeMessage({
      attachments: [
        {
          id: 'a5',
          filename: 'voice.bin',
          url: 'https://cdn/a5/voice.bin',
          duration_secs: 3.7,
        },
      ],
    })
    expect(discordExtractAttachments(msg)[0]!.kind).toBe('audio')
  })

  it('preserves all attachments in order', () => {
    const msg = makeMessage({
      attachments: [
        {
          id: 'a1',
          filename: 'a.png',
          url: 'u1',
          content_type: 'image/png',
        },
        {
          id: 'a2',
          filename: 'b.pdf',
          url: 'u2',
          content_type: 'application/pdf',
        },
      ],
    })
    const out = discordExtractAttachments(msg)
    expect(out).toHaveLength(2)
    expect(out[0]!.kind).toBe('image')
    expect(out[1]!.kind).toBe('file')
  })
})

describe('discordToImMessage', () => {
  it('maps a basic guild text message', () => {
    const im = discordToImMessage(makeMessage(), { botUserId: BOT_USER_ID })
    expect(im).not.toBeNull()
    expect(im!.from).toEqual({
      platform: 'discord',
      platformUserId: USER_ID,
      displayName: 'Alice',
    })
    expect(im!.text).toBe('hello')
    expect(im!.chatId).toBe(CHANNEL_ID)
    expect(im!.messageId).toBe('100200300400500600')
    expect(im!.ts).toBe(Date.parse('2026-05-27T10:00:00.000+00:00'))
    expect(im!.attachments).toBeUndefined()
  })

  it('falls back to username when global_name is missing', () => {
    const im = discordToImMessage(
      makeMessage({
        author: { id: USER_ID, username: 'alice', bot: false },
      }),
      { botUserId: BOT_USER_ID },
    )
    expect(im!.from.displayName).toBe('alice')
  })

  it('strips bot mentions by default', () => {
    const im = discordToImMessage(
      makeMessage({ content: `<@${BOT_USER_ID}> /help` }),
      { botUserId: BOT_USER_ID },
    )
    expect(im!.text).toBe('/help')
  })

  it('preserves bot mentions when stripBotMentions is false', () => {
    const im = discordToImMessage(
      makeMessage({ content: `<@${BOT_USER_ID}> /help` }),
      { botUserId: BOT_USER_ID, stripBotMentions: false },
    )
    expect(im!.text).toContain(`<@${BOT_USER_ID}>`)
  })

  it('returns null when author is a bot (anti-loop)', () => {
    const im = discordToImMessage(
      makeMessage({
        author: { id: '12345', username: 'otherbot', bot: true },
      }),
      { botUserId: BOT_USER_ID },
    )
    expect(im).toBeNull()
  })

  it('returns null when author.id matches botUserId (own message)', () => {
    const im = discordToImMessage(
      makeMessage({
        author: { id: BOT_USER_ID, username: 'self', bot: false },
      }),
      { botUserId: BOT_USER_ID },
    )
    expect(im).toBeNull()
  })

  it('returns null when type is non-message (e.g. 7 GUILD_MEMBER_JOIN)', () => {
    const im = discordToImMessage(makeMessage({ type: 7 }), { botUserId: BOT_USER_ID })
    expect(im).toBeNull()
  })

  it('passes through type 19 (REPLY)', () => {
    const im = discordToImMessage(
      makeMessage({
        type: 19,
        content: 'reply text',
        message_reference: { message_id: '1', channel_id: CHANNEL_ID },
      }),
      { botUserId: BOT_USER_ID },
    )
    expect(im).not.toBeNull()
    expect(im!.text).toBe('reply text')
  })

  it('returns null when author has no id', () => {
    const im = discordToImMessage(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeMessage({ author: { username: 'noid' } as any }),
      { botUserId: BOT_USER_ID },
    )
    expect(im).toBeNull()
  })

  it('attaches images and keeps any text content', () => {
    const im = discordToImMessage(
      makeMessage({
        content: 'caption',
        attachments: [
          {
            id: 'a1',
            filename: 'pic.jpg',
            url: 'https://cdn/a1.jpg',
            content_type: 'image/jpeg',
          },
        ],
      }),
      { botUserId: BOT_USER_ID },
    )
    expect(im!.text).toBe('caption')
    expect(im!.attachments).toHaveLength(1)
    expect(im!.attachments![0]!.kind).toBe('image')
    expect(im!.attachments![0]!.url).toBe('https://cdn/a1.jpg')
  })

  it('falls back to Date.now() on unparseable timestamp', () => {
    const before = Date.now()
    const im = discordToImMessage(makeMessage({ timestamp: 'not a date' }), {
      botUserId: BOT_USER_ID,
    })
    const after = Date.now()
    expect(im!.ts).toBeGreaterThanOrEqual(before)
    expect(im!.ts).toBeLessThanOrEqual(after)
  })

  it('still works when botUserId is null (e.g. before READY)', () => {
    // Without a bot id, we can't strip its mention, but other-user
    // messages still flow through.
    const im = discordToImMessage(makeMessage({ content: 'hi' }), { botUserId: null })
    expect(im).not.toBeNull()
    expect(im!.text).toBe('hi')
  })

  it('keeps empty text when an attachment is the only payload', () => {
    const im = discordToImMessage(
      makeMessage({
        content: '',
        attachments: [
          {
            id: 'a',
            filename: 'f.pdf',
            url: 'u',
            content_type: 'application/pdf',
          },
        ],
      }),
      { botUserId: BOT_USER_ID },
    )
    expect(im!.text).toBe('')
    expect(im!.attachments).toHaveLength(1)
  })
})
