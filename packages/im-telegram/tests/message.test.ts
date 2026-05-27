/**
 * Phase 12 M2 — Telegram message → ImMessage mapper coverage.
 *
 * Pure-function tests; no network, no mocks.
 */

import { describe, expect, it } from 'vitest'

import {
  parseTelegramFileUri,
  TELEGRAM_FILE_URI_PREFIX,
  telegramDisplayName,
  telegramExtractAttachments,
  telegramFileUri,
  telegramToImMessage,
} from '../src/message.js'
import type { TelegramMessage, TelegramUser } from '../src/types.js'

const baseUser: TelegramUser = {
  id: 42,
  is_bot: false,
  first_name: 'Alice',
  last_name: 'Doe',
  username: 'alice_doe',
}

function makeMsg(over: Partial<TelegramMessage>): TelegramMessage {
  return {
    message_id: 1,
    date: 1_700_000_000,
    chat: { id: 100, type: 'private' },
    from: baseUser,
    ...over,
  }
}

describe('telegramFileUri / parseTelegramFileUri', () => {
  it('round-trips a file id', () => {
    const uri = telegramFileUri('AgACAgUAAxkBA…')
    expect(uri.startsWith(TELEGRAM_FILE_URI_PREFIX)).toBe(true)
    expect(parseTelegramFileUri(uri)).toBe('AgACAgUAAxkBA…')
  })

  it('returns null for non-telegram URIs', () => {
    expect(parseTelegramFileUri('https://example.com/x.jpg')).toBeNull()
    expect(parseTelegramFileUri('telegram-file:')).toBeNull() // empty id
    expect(parseTelegramFileUri('')).toBeNull()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(parseTelegramFileUri(null as any)).toBeNull()
  })
})

describe('telegramDisplayName', () => {
  it('prefers username when present', () => {
    expect(telegramDisplayName(baseUser)).toBe('alice_doe')
  })

  it('falls back to "first last" then "first" then null', () => {
    expect(
      telegramDisplayName({
        id: 1,
        is_bot: false,
        first_name: 'Alice',
        last_name: 'Doe',
      }),
    ).toBe('Alice Doe')
    expect(
      telegramDisplayName({ id: 1, is_bot: false, first_name: 'Alice' }),
    ).toBe('Alice')
    // first_name is required by spec, but defend against missing.
    expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      telegramDisplayName({ id: 1, is_bot: false, first_name: '' as any }),
    ).toBeNull()
  })
})

describe('telegramExtractAttachments', () => {
  it('returns [] for text-only messages', () => {
    expect(telegramExtractAttachments(makeMsg({ text: 'hi' }))).toEqual([])
  })

  it('picks the largest photo variant', () => {
    const msg = makeMsg({
      photo: [
        { file_id: 'small', file_unique_id: 's', width: 90, height: 90 },
        { file_id: 'mid', file_unique_id: 'm', width: 320, height: 320 },
        { file_id: 'large', file_unique_id: 'l', width: 1280, height: 1280 },
      ],
    })
    const out = telegramExtractAttachments(msg)
    expect(out).toEqual([
      {
        kind: 'image',
        url: telegramFileUri('large'),
        mime: 'image/jpeg',
        filename: null,
      },
    ])
  })

  it('extracts voice as audio with mime fallback', () => {
    const out = telegramExtractAttachments(
      makeMsg({
        voice: {
          file_id: 'voice1',
          file_unique_id: 'v1',
          duration: 5,
          // no mime_type set → fallback
        },
      }),
    )
    expect(out).toEqual([
      {
        kind: 'audio',
        url: telegramFileUri('voice1'),
        mime: 'audio/ogg',
        filename: null,
      },
    ])
  })

  it('extracts audio with original mime + title', () => {
    const out = telegramExtractAttachments(
      makeMsg({
        audio: {
          file_id: 'a1',
          file_unique_id: 'ua1',
          duration: 200,
          mime_type: 'audio/mpeg',
          title: 'Imagine',
          performer: 'Lennon',
        },
      }),
    )
    expect(out).toEqual([
      {
        kind: 'audio',
        url: telegramFileUri('a1'),
        mime: 'audio/mpeg',
        filename: 'Imagine',
      },
    ])
  })

  it('extracts document as file', () => {
    const out = telegramExtractAttachments(
      makeMsg({
        document: {
          file_id: 'doc1',
          file_unique_id: 'ud1',
          file_name: 'thesis.pdf',
          mime_type: 'application/pdf',
        },
      }),
    )
    expect(out).toEqual([
      {
        kind: 'file',
        url: telegramFileUri('doc1'),
        mime: 'application/pdf',
        filename: 'thesis.pdf',
      },
    ])
  })

  it('returns multiple attachments when a message carries several', () => {
    const out = telegramExtractAttachments(
      makeMsg({
        photo: [{ file_id: 'p1', file_unique_id: 'up1', width: 1, height: 1 }],
        document: { file_id: 'd1', file_unique_id: 'ud1', mime_type: 'text/plain' },
      }),
    )
    expect(out.length).toBe(2)
    expect(out[0]!.kind).toBe('image')
    expect(out[1]!.kind).toBe('file')
  })
})

describe('telegramToImMessage', () => {
  it('maps a text message', () => {
    const im = telegramToImMessage(makeMsg({ text: 'hello world' }))
    expect(im).not.toBeNull()
    expect(im!.from).toEqual({
      platform: 'telegram',
      platformUserId: '42',
      displayName: 'alice_doe',
    })
    expect(im!.text).toBe('hello world')
    expect(im!.messageId).toBe('1')
    expect(im!.chatId).toBe('100')
    // Telegram date is unix seconds; ImMessage.ts is ms.
    expect(im!.ts).toBe(1_700_000_000 * 1000)
    expect(im!.attachments).toBeUndefined()
  })

  it('uses caption when there is no text but there is a photo', () => {
    const im = telegramToImMessage(
      makeMsg({
        caption: 'see attached',
        photo: [{ file_id: 'p1', file_unique_id: 'u', width: 1, height: 1 }],
      }),
    )
    expect(im!.text).toBe('see attached')
    expect(im!.attachments?.[0]?.kind).toBe('image')
  })

  it('returns null for channel posts (no from)', () => {
    expect(
      telegramToImMessage(makeMsg({ from: undefined, text: 'channel post' })),
    ).toBeNull()
  })

  it('returns null when from.is_bot is true', () => {
    expect(
      telegramToImMessage(
        makeMsg({
          from: { ...baseUser, is_bot: true },
          text: 'hi from another bot',
        }),
      ),
    ).toBeNull()
  })

  it('text-only message has no attachments key', () => {
    const im = telegramToImMessage(makeMsg({ text: 'x' }))
    expect(im!.attachments).toBeUndefined()
  })
})
