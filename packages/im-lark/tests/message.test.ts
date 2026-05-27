/**
 * Phase 12 M4 — Lark event → ImMessage mapper coverage.
 *
 * Pure-function tests; no network, no mocks.
 */

import { describe, expect, it } from 'vitest'

import {
  LARK_URI_PREFIXES,
  larkContentToText,
  larkExtractAttachments,
  larkToImMessage,
  larkUri,
  parseLarkContent,
  parseLarkUri,
  pickLarkReceiveIdType,
  stripLarkMentions,
} from '../src/message.js'
import type { LarkMessage, LarkMessageReceiveEvent } from '../src/types.js'

const SENDER_OPEN_ID = 'ou_alice'
const CHAT_ID = 'oc_room1'

function makeEvent(over: {
  message?: Partial<LarkMessage>
  senderType?: 'user' | 'app' | 'anonymous'
  openId?: string | null
} = {}): LarkMessageReceiveEvent {
  return {
    sender: {
      sender_type: over.senderType ?? 'user',
      sender_id:
        over.openId === null
          ? {}
          : { open_id: over.openId ?? SENDER_OPEN_ID, user_id: 'u_x', union_id: 'on_x' },
      tenant_key: 'tk',
    },
    message: {
      message_id: 'om_1',
      create_time: '1700000000000',
      chat_id: CHAT_ID,
      chat_type: 'p2p',
      message_type: 'text',
      content: JSON.stringify({ text: 'hello' }),
      ...over.message,
    },
  }
}

describe('larkUri / parseLarkUri', () => {
  it('round-trips each kind', () => {
    expect(parseLarkUri(larkUri('image', 'img1'))).toEqual({ kind: 'image', key: 'img1' })
    expect(parseLarkUri(larkUri('audio', 'aud1'))).toEqual({ kind: 'audio', key: 'aud1' })
    expect(parseLarkUri(larkUri('file', 'f1'))).toEqual({ kind: 'file', key: 'f1' })
  })

  it('exposes the prefix constants', () => {
    expect(LARK_URI_PREFIXES.image).toBe('lark-image:')
    expect(LARK_URI_PREFIXES.audio).toBe('lark-audio:')
    expect(LARK_URI_PREFIXES.file).toBe('lark-file:')
  })

  it('returns null for foreign / empty / non-string URIs', () => {
    expect(parseLarkUri('https://example.com/x.jpg')).toBeNull()
    expect(parseLarkUri('telegram-file:abc')).toBeNull()
    expect(parseLarkUri('lark-image:')).toBeNull() // empty key
    expect(parseLarkUri('')).toBeNull()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(parseLarkUri(null as any)).toBeNull()
  })
})

describe('stripLarkMentions', () => {
  it('removes a leading @bot mention', () => {
    expect(stripLarkMentions('<at user_id="ou_bot">@Bot</at> /help')).toBe('/help')
  })

  it('removes multiple mentions', () => {
    expect(
      stripLarkMentions(
        '<at user_id="ou_bot">@Bot</at> ping <at user_id="ou_alice">@Alice</at>',
      ),
    ).toBe('ping')
  })

  it('leaves text alone when no mentions present', () => {
    expect(stripLarkMentions('plain text /command')).toBe('plain text /command')
  })

  it('handles trailing whitespace', () => {
    expect(stripLarkMentions('   <at user_id="x">@x</at>   ')).toBe('')
  })
})

describe('parseLarkContent', () => {
  it('parses valid JSON', () => {
    expect(
      parseLarkContent({
        content: JSON.stringify({ text: 'hi' }),
      } as LarkMessage),
    ).toEqual({ text: 'hi' })
  })

  it('returns null on invalid JSON', () => {
    expect(parseLarkContent({ content: 'not json' } as LarkMessage)).toBeNull()
    expect(parseLarkContent({ content: '' } as LarkMessage)).toBeNull()
  })

  it('returns null on non-string content', () => {
    expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      parseLarkContent({ content: 42 as any } as LarkMessage),
    ).toBeNull()
  })
})

describe('larkExtractAttachments', () => {
  it('returns [] for text messages', () => {
    const msg = { message_type: 'text' } as LarkMessage
    expect(larkExtractAttachments(msg, { text: 'hi' })).toEqual([])
  })

  it('extracts image with hard-coded JPEG mime', () => {
    expect(
      larkExtractAttachments(
        { message_type: 'image' } as LarkMessage,
        { image_key: 'img1' },
      ),
    ).toEqual([
      { kind: 'image', url: 'lark-image:img1', mime: 'image/jpeg', filename: null },
    ])
  })

  it('extracts sticker as image with webp mime', () => {
    expect(
      larkExtractAttachments(
        { message_type: 'sticker' } as LarkMessage,
        { file_key: 'sk1' },
      ),
    ).toEqual([
      { kind: 'image', url: 'lark-image:sk1', mime: 'image/webp', filename: null },
    ])
  })

  it('extracts audio with ogg fallback mime', () => {
    expect(
      larkExtractAttachments(
        { message_type: 'audio' } as LarkMessage,
        { file_key: 'aud1', duration: 5000 },
      ),
    ).toEqual([{ kind: 'audio', url: 'lark-audio:aud1', mime: 'audio/ogg', filename: null }])
  })

  it('extracts file with file_name + null mime', () => {
    expect(
      larkExtractAttachments(
        { message_type: 'file' } as LarkMessage,
        { file_key: 'f1', file_name: 'thesis.pdf', file_size: '12345' },
      ),
    ).toEqual([{ kind: 'file', url: 'lark-file:f1', mime: null, filename: 'thesis.pdf' }])
  })

  it('returns [] when required keys are missing', () => {
    expect(
      larkExtractAttachments({ message_type: 'image' } as LarkMessage, {}),
    ).toEqual([])
    expect(
      larkExtractAttachments({ message_type: 'file' } as LarkMessage, {}),
    ).toEqual([])
  })

  it('returns [] for unknown message types', () => {
    expect(
      larkExtractAttachments(
        { message_type: 'card' } as LarkMessage,
        { foo: 'bar' },
      ),
    ).toEqual([])
  })
})

describe('larkContentToText', () => {
  it('returns text body for text messages', () => {
    expect(larkContentToText({ message_type: 'text' } as LarkMessage, { text: 'hi' })).toBe(
      'hi',
    )
  })

  it('returns empty string for image / sticker / audio', () => {
    expect(larkContentToText({ message_type: 'image' } as LarkMessage, { image_key: 'x' })).toBe(
      '',
    )
    expect(larkContentToText({ message_type: 'audio' } as LarkMessage, { file_key: 'x' })).toBe(
      '',
    )
  })

  it('returns file_name as fallback for files', () => {
    expect(
      larkContentToText({ message_type: 'file' } as LarkMessage, {
        file_key: 'x',
        file_name: 'doc.pdf',
      }),
    ).toBe('doc.pdf')
  })

  it('flattens post content', () => {
    const post = {
      title: 'Meeting Notes',
      content: [
        [{ tag: 'text', text: 'line 1 ' }, { tag: 'a', text: 'link', href: 'https://x' }],
        [{ tag: 'text', text: 'line 2' }],
      ],
    }
    const out = larkContentToText({ message_type: 'post' } as LarkMessage, post)
    expect(out).toBe('Meeting Notes\nline 1 link\nline 2')
  })

  it('handles post without title or content', () => {
    expect(larkContentToText({ message_type: 'post' } as LarkMessage, {})).toBe('')
  })
})

describe('larkToImMessage', () => {
  it('maps a text DM', () => {
    const im = larkToImMessage(makeEvent({}))
    expect(im).not.toBeNull()
    expect(im!.from).toEqual({
      platform: 'lark',
      platformUserId: SENDER_OPEN_ID,
      displayName: null,
    })
    expect(im!.text).toBe('hello')
    expect(im!.chatId).toBe(CHAT_ID)
    expect(im!.messageId).toBe('om_1')
    expect(im!.ts).toBe(1_700_000_000_000)
    expect(im!.attachments).toBeUndefined()
  })

  it('strips bot mentions when configured (default)', () => {
    const im = larkToImMessage(
      makeEvent({
        message: {
          message_type: 'text',
          content: JSON.stringify({
            text: '<at user_id="ou_bot">@Bot</at> /help me',
          }),
        },
      }),
      { stripBotMentions: true },
    )
    expect(im!.text).toBe('/help me')
  })

  it('preserves mentions when stripBotMentions is false', () => {
    const im = larkToImMessage(
      makeEvent({
        message: {
          message_type: 'text',
          content: JSON.stringify({
            text: '<at user_id="ou_bot">@Bot</at> /help',
          }),
        },
      }),
      { stripBotMentions: false },
    )
    expect(im!.text).toContain('<at')
  })

  it('attaches an image and leaves text empty', () => {
    const im = larkToImMessage(
      makeEvent({
        message: {
          message_type: 'image',
          content: JSON.stringify({ image_key: 'img1' }),
        },
      }),
    )
    expect(im!.text).toBe('')
    expect(im!.attachments).toHaveLength(1)
    expect(im!.attachments![0]!.kind).toBe('image')
    expect(im!.attachments![0]!.url).toBe('lark-image:img1')
  })

  it('returns null when sender_type is app (anti-loop)', () => {
    expect(larkToImMessage(makeEvent({ senderType: 'app' }))).toBeNull()
  })

  it('returns null when sender_type is anonymous', () => {
    expect(larkToImMessage(makeEvent({ senderType: 'anonymous' }))).toBeNull()
  })

  it('returns null when open_id is missing', () => {
    expect(larkToImMessage(makeEvent({ openId: null }))).toBeNull()
  })

  it('returns null when content is unparseable JSON', () => {
    expect(
      larkToImMessage(
        makeEvent({
          message: { content: '{ not json' },
        }),
      ),
    ).toBeNull()
  })

  it('falls back to Date.now() when create_time is unparseable', () => {
    const before = Date.now()
    const im = larkToImMessage(
      makeEvent({
        message: { create_time: 'not a number' },
      }),
    )
    const after = Date.now()
    expect(im!.ts).toBeGreaterThanOrEqual(before)
    expect(im!.ts).toBeLessThanOrEqual(after)
  })
})

describe('pickLarkReceiveIdType', () => {
  it('classifies chat_id by oc_ prefix', () => {
    expect(pickLarkReceiveIdType('oc_xxx')).toBe('chat_id')
  })

  it('classifies open_id by ou_ prefix', () => {
    expect(pickLarkReceiveIdType('ou_xxx')).toBe('open_id')
  })

  it('classifies union_id by on_ prefix', () => {
    expect(pickLarkReceiveIdType('on_xxx')).toBe('union_id')
  })

  it('classifies email when @ present', () => {
    expect(pickLarkReceiveIdType('alice@example.com')).toBe('email')
  })

  it('falls back to user_id for anything else', () => {
    expect(pickLarkReceiveIdType('abc123')).toBe('user_id')
  })
})
