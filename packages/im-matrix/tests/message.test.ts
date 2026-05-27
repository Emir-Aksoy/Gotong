/**
 * Phase 12 M3 — Matrix event → ImMessage mapper coverage.
 *
 * Pure-function tests; no network, no mocks.
 */

import { describe, expect, it } from 'vitest'

import {
  MXC_URI_PREFIX,
  matrixExtractAttachments,
  matrixToImMessage,
  parseMxcUri,
} from '../src/message.js'
import type { MatrixMessageContent, MatrixRoomEvent } from '../src/types.js'

const SENDER = '@alice:matrix.org'
const BOT = '@aipe_bot:matrix.org'
const ROOM = '!abc123:matrix.org'

function makeEvent(over: Partial<MatrixRoomEvent>): MatrixRoomEvent {
  return {
    type: 'm.room.message',
    event_id: '$ev1:matrix.org',
    sender: SENDER,
    origin_server_ts: 1_700_000_000_000,
    content: { msgtype: 'm.text', body: 'hello' } as MatrixMessageContent,
    ...over,
  }
}

describe('parseMxcUri', () => {
  it('parses canonical mxc:// URIs', () => {
    expect(parseMxcUri('mxc://matrix.org/abcdef')).toEqual({
      serverName: 'matrix.org',
      mediaId: 'abcdef',
    })
  })

  it('returns null for non-mxc URIs', () => {
    expect(parseMxcUri('https://example.com/x.jpg')).toBeNull()
    expect(parseMxcUri('mxc://')).toBeNull() // both halves empty
    expect(parseMxcUri('mxc://matrix.org/')).toBeNull() // empty mediaId
    expect(parseMxcUri('mxc:///abc')).toBeNull() // empty serverName
    expect(parseMxcUri('')).toBeNull()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(parseMxcUri(null as any)).toBeNull()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(parseMxcUri(undefined as any)).toBeNull()
  })

  it('uses MXC_URI_PREFIX constant', () => {
    expect(MXC_URI_PREFIX).toBe('mxc://')
  })

  it('handles media ids that contain slashes (Synapse quirk)', () => {
    // Synapse historically issued media ids with embedded slashes
    // when servers were configured to use file-storage paths. We
    // accept them by treating only the first slash as the separator.
    const r = parseMxcUri('mxc://matrix.org/a/b/c')
    expect(r).toEqual({ serverName: 'matrix.org', mediaId: 'a/b/c' })
  })
})

describe('matrixExtractAttachments', () => {
  it('returns [] for text messages', () => {
    expect(matrixExtractAttachments({ msgtype: 'm.text', body: 'hi' })).toEqual([])
  })

  it('extracts m.image as image', () => {
    expect(
      matrixExtractAttachments({
        msgtype: 'm.image',
        body: 'cat.jpg',
        url: 'mxc://matrix.org/img1',
        info: { mimetype: 'image/jpeg', size: 12345, w: 100, h: 100 },
      }),
    ).toEqual([
      {
        kind: 'image',
        url: 'mxc://matrix.org/img1',
        mime: 'image/jpeg',
        filename: 'cat.jpg',
      },
    ])
  })

  it('extracts m.audio as audio with mime from info', () => {
    expect(
      matrixExtractAttachments({
        msgtype: 'm.audio',
        body: 'recording.ogg',
        url: 'mxc://matrix.org/aud1',
        info: { mimetype: 'audio/ogg', duration: 5000 },
      }),
    ).toEqual([
      {
        kind: 'audio',
        url: 'mxc://matrix.org/aud1',
        mime: 'audio/ogg',
        filename: 'recording.ogg',
      },
    ])
  })

  it('extracts m.video as file (no video bucket in ImAttachment)', () => {
    const out = matrixExtractAttachments({
      msgtype: 'm.video',
      body: 'demo.mp4',
      url: 'mxc://matrix.org/v1',
      info: { mimetype: 'video/mp4' },
    })
    expect(out).toEqual([
      {
        kind: 'file',
        url: 'mxc://matrix.org/v1',
        mime: 'video/mp4',
        filename: 'demo.mp4',
      },
    ])
  })

  it('extracts m.file as file with explicit filename override', () => {
    expect(
      matrixExtractAttachments({
        msgtype: 'm.file',
        body: 'fallback-name',
        filename: 'thesis.pdf',
        url: 'mxc://matrix.org/f1',
        info: { mimetype: 'application/pdf' },
      }),
    ).toEqual([
      {
        kind: 'file',
        url: 'mxc://matrix.org/f1',
        mime: 'application/pdf',
        filename: 'thesis.pdf', // explicit filename beats body
      },
    ])
  })

  it('mime is null when info.mimetype is missing', () => {
    const out = matrixExtractAttachments({
      msgtype: 'm.file',
      body: 'unknown.bin',
      url: 'mxc://matrix.org/x',
    })
    expect(out[0]!.mime).toBeNull()
  })

  it('unknown media-ish msgtype is treated as file (forwards-compatible)', () => {
    const out = matrixExtractAttachments({
      msgtype: 'm.sticker' as string,
      body: 'sticker.webp',
      url: 'mxc://matrix.org/sticker1',
      info: { mimetype: 'image/webp' },
    })
    expect(out[0]!.kind).toBe('file')
    expect(out[0]!.url).toBe('mxc://matrix.org/sticker1')
  })

  it('drops empty / missing url', () => {
    expect(
      matrixExtractAttachments({
        msgtype: 'm.image',
        body: 'cat.jpg',
        // no url
      }),
    ).toEqual([])
    expect(
      matrixExtractAttachments({
        msgtype: 'm.image',
        body: 'cat.jpg',
        url: '',
      }),
    ).toEqual([])
  })
})

describe('matrixToImMessage', () => {
  it('maps a plain text message', () => {
    const im = matrixToImMessage(makeEvent({}), ROOM, BOT)
    expect(im).not.toBeNull()
    expect(im!.from).toEqual({
      platform: 'matrix',
      platformUserId: SENDER,
      displayName: null,
    })
    expect(im!.text).toBe('hello')
    expect(im!.messageId).toBe('$ev1:matrix.org')
    expect(im!.chatId).toBe(ROOM)
    // Matrix uses ms natively — no *1000 conversion.
    expect(im!.ts).toBe(1_700_000_000_000)
    expect(im!.attachments).toBeUndefined()
  })

  it('maps m.notice and m.emote as text too', () => {
    for (const msgtype of ['m.notice', 'm.emote']) {
      const im = matrixToImMessage(
        makeEvent({ content: { msgtype, body: 'hi from ' + msgtype } as MatrixMessageContent }),
        ROOM,
        BOT,
      )
      expect(im!.text).toBe('hi from ' + msgtype)
    }
  })

  it('attaches an image and uses body as caption text', () => {
    const im = matrixToImMessage(
      makeEvent({
        content: {
          msgtype: 'm.image',
          body: 'IMG_0042.jpg',
          url: 'mxc://matrix.org/img1',
          info: { mimetype: 'image/jpeg' },
        } as MatrixMessageContent,
      }),
      ROOM,
      BOT,
    )
    expect(im!.text).toBe('IMG_0042.jpg') // body doubles as text/caption
    expect(im!.attachments).toHaveLength(1)
    expect(im!.attachments![0]!.kind).toBe('image')
    expect(im!.attachments![0]!.url).toBe('mxc://matrix.org/img1')
  })

  it('returns null for non-m.room.message events', () => {
    expect(
      matrixToImMessage(makeEvent({ type: 'm.room.member' }), ROOM, BOT),
    ).toBeNull()
    expect(
      matrixToImMessage(makeEvent({ type: 'm.reaction' }), ROOM, BOT),
    ).toBeNull()
    expect(
      matrixToImMessage(makeEvent({ type: 'm.room.encrypted' }), ROOM, BOT),
    ).toBeNull()
  })

  it('returns null when sender is the bot (anti-loop)', () => {
    expect(
      matrixToImMessage(makeEvent({ sender: BOT }), ROOM, BOT),
    ).toBeNull()
  })

  it('null botUserId disables self-filter (passes own messages through)', () => {
    const im = matrixToImMessage(makeEvent({ sender: BOT }), ROOM, null)
    expect(im).not.toBeNull()
    expect(im!.from.platformUserId).toBe(BOT)
  })

  it('returns null for missing or non-object content', () => {
    expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      matrixToImMessage(makeEvent({ content: null as any }), ROOM, BOT),
    ).toBeNull()
    expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      matrixToImMessage(makeEvent({ content: 'string' as any }), ROOM, BOT),
    ).toBeNull()
    expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      matrixToImMessage(makeEvent({ content: undefined as any }), ROOM, BOT),
    ).toBeNull()
  })

  it('returns null for content missing msgtype or body', () => {
    expect(
      matrixToImMessage(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        makeEvent({ content: { body: 'no msgtype' } as any }),
        ROOM,
        BOT,
      ),
    ).toBeNull()
    expect(
      matrixToImMessage(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        makeEvent({ content: { msgtype: 'm.text' } as any }),
        ROOM,
        BOT,
      ),
    ).toBeNull()
  })

  it('passes the room id from the sync envelope (not from the event)', () => {
    // Timeline events don't carry their own room id; sync groups them.
    const im = matrixToImMessage(makeEvent({}), '!different:server.org', BOT)
    expect(im!.chatId).toBe('!different:server.org')
  })
})
