/**
 * Phase 12 M6 — Slack message → ImMessage mapper + signature verifier.
 *
 * Pure-function tests; no network. HMAC computed locally with
 * node:crypto so tests stay hermetic.
 */

import { createHmac } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
  parseSlackFileUri,
  slackExtractAttachments,
  slackFileUri,
  slackToImMessage,
  stripSlackBotMentions,
  verifySlackSignature,
  SLACK_FILE_URI_PREFIX,
} from '../src/message.js'
import type { SlackMessageEvent } from '../src/types.js'

const BOT_USER_ID = 'UBOT0001'
const USER_ID = 'U2222ALICE'
const CHANNEL_ID = 'C9999ROOM'
const SIGNING_SECRET = 'shhhh-secret-not-real'

function makeEvent(over: Partial<SlackMessageEvent> = {}): SlackMessageEvent {
  return {
    type: 'message',
    user: USER_ID,
    channel: CHANNEL_ID,
    ts: '1748345600.000100',
    text: 'hello',
    team: 'T0001',
    ...over,
  }
}

describe('slackFileUri / parseSlackFileUri', () => {
  it('round-trips a file id', () => {
    const uri = slackFileUri('F123ABC')
    expect(uri).toBe(`${SLACK_FILE_URI_PREFIX}F123ABC`)
    expect(parseSlackFileUri(uri)).toEqual({ fileId: 'F123ABC' })
  })

  it('rejects non-prefixed strings', () => {
    expect(parseSlackFileUri('https://example.com/file.png')).toBeNull()
    expect(parseSlackFileUri('')).toBeNull()
  })

  it('rejects an empty file id after the prefix', () => {
    expect(parseSlackFileUri(SLACK_FILE_URI_PREFIX)).toBeNull()
  })

  it('rejects non-string input', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(parseSlackFileUri(null as any)).toBeNull()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(parseSlackFileUri(42 as any)).toBeNull()
  })
})

describe('stripSlackBotMentions', () => {
  it('strips a leading <@BOT_ID> mention', () => {
    expect(stripSlackBotMentions(`<@${BOT_USER_ID}> /help`, BOT_USER_ID)).toBe('/help')
  })

  it('strips mentions anywhere in the body', () => {
    expect(
      stripSlackBotMentions(`tell <@${BOT_USER_ID}> hi`, BOT_USER_ID),
    ).toBe('tell hi')
  })

  it('leaves other-user mentions intact', () => {
    expect(
      stripSlackBotMentions(`<@${USER_ID}> are you the bot?`, BOT_USER_ID),
    ).toBe(`<@${USER_ID}> are you the bot?`)
  })

  it('returns empty string when only the bot mention is present', () => {
    expect(stripSlackBotMentions(`<@${BOT_USER_ID}>`, BOT_USER_ID)).toBe('')
  })

  it('passes through unchanged when no bot id is supplied', () => {
    expect(stripSlackBotMentions('hello <@UXX>', null)).toBe('hello <@UXX>')
  })

  it('returns empty string for non-string input', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(stripSlackBotMentions(null as any, BOT_USER_ID)).toBe('')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(stripSlackBotMentions(undefined as any, BOT_USER_ID)).toBe('')
  })
})

describe('slackExtractAttachments', () => {
  it('returns [] when no files', () => {
    expect(slackExtractAttachments(makeEvent())).toEqual([])
  })

  it('classifies image/* MIME as image', () => {
    const out = slackExtractAttachments(
      makeEvent({
        files: [
          { id: 'F1', name: 'pic.png', mimetype: 'image/png' },
        ],
      }),
    )
    expect(out).toEqual([
      {
        kind: 'image',
        url: slackFileUri('F1'),
        mime: 'image/png',
        filename: 'pic.png',
      },
    ])
  })

  it('classifies audio/* MIME as audio', () => {
    const out = slackExtractAttachments(
      makeEvent({ files: [{ id: 'F2', name: 'voice.m4a', mimetype: 'audio/m4a' }] }),
    )
    expect(out[0]!.kind).toBe('audio')
  })

  it('classifies other MIME as file', () => {
    const out = slackExtractAttachments(
      makeEvent({ files: [{ id: 'F3', name: 'paper.pdf', mimetype: 'application/pdf' }] }),
    )
    expect(out[0]!.kind).toBe('file')
  })

  it('falls back to file when mimetype is absent', () => {
    const out = slackExtractAttachments(
      makeEvent({ files: [{ id: 'F4', name: 'mystery.bin' }] }),
    )
    expect(out[0]!.kind).toBe('file')
    expect(out[0]!.mime).toBeNull()
  })

  it('drops malformed entries lacking an id', () => {
    const out = slackExtractAttachments(
      makeEvent({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        files: [{ name: 'broken' } as any, { id: 'F5', name: 'ok.png', mimetype: 'image/png' }],
      }),
    )
    expect(out).toHaveLength(1)
    expect(out[0]!.url).toBe(slackFileUri('F5'))
  })

  it('preserves all valid attachments in order', () => {
    const out = slackExtractAttachments(
      makeEvent({
        files: [
          { id: 'F1', name: 'a.png', mimetype: 'image/png' },
          { id: 'F2', name: 'b.pdf', mimetype: 'application/pdf' },
        ],
      }),
    )
    expect(out).toHaveLength(2)
    expect(out[0]!.kind).toBe('image')
    expect(out[1]!.kind).toBe('file')
  })
})

describe('slackToImMessage', () => {
  it('maps a basic channel text message', () => {
    const im = slackToImMessage(makeEvent(), { botUserId: BOT_USER_ID })
    expect(im).not.toBeNull()
    expect(im!.from).toEqual({
      platform: 'slack',
      platformUserId: USER_ID,
      displayName: null,
    })
    expect(im!.text).toBe('hello')
    expect(im!.chatId).toBe(CHANNEL_ID)
    expect(im!.messageId).toBe('1748345600.000100')
    expect(im!.ts).toBe(1748345600000)
    expect(im!.attachments).toBeUndefined()
  })

  it('strips bot mentions by default', () => {
    const im = slackToImMessage(
      makeEvent({ text: `<@${BOT_USER_ID}> /help` }),
      { botUserId: BOT_USER_ID },
    )
    expect(im!.text).toBe('/help')
  })

  it('preserves bot mentions when stripBotMentions is false', () => {
    const im = slackToImMessage(
      makeEvent({ text: `<@${BOT_USER_ID}> /help` }),
      { botUserId: BOT_USER_ID, stripBotMentions: false },
    )
    expect(im!.text).toContain(`<@${BOT_USER_ID}>`)
  })

  it('returns null when bot_id is set (any bot post)', () => {
    const im = slackToImMessage(
      makeEvent({ bot_id: 'B0001', user: undefined }),
      { botUserId: BOT_USER_ID },
    )
    expect(im).toBeNull()
  })

  it('returns null when user matches botUserId (own message)', () => {
    const im = slackToImMessage(
      makeEvent({ user: BOT_USER_ID }),
      { botUserId: BOT_USER_ID },
    )
    expect(im).toBeNull()
  })

  it('returns null for unsupported subtypes (e.g. message_changed)', () => {
    const im = slackToImMessage(
      makeEvent({ subtype: 'message_changed' }),
      { botUserId: BOT_USER_ID },
    )
    expect(im).toBeNull()
  })

  it('returns null for channel_join subtype', () => {
    const im = slackToImMessage(
      makeEvent({ subtype: 'channel_join' }),
      { botUserId: BOT_USER_ID },
    )
    expect(im).toBeNull()
  })

  it('passes through file_share subtype', () => {
    const im = slackToImMessage(
      makeEvent({
        subtype: 'file_share',
        text: 'check this out',
        files: [{ id: 'F1', name: 'pic.png', mimetype: 'image/png' }],
      }),
      { botUserId: BOT_USER_ID },
    )
    expect(im).not.toBeNull()
    expect(im!.text).toBe('check this out')
    expect(im!.attachments).toHaveLength(1)
    expect(im!.attachments![0]!.kind).toBe('image')
  })

  it('returns null when user field is missing', () => {
    const im = slackToImMessage(
      makeEvent({ user: undefined }),
      { botUserId: BOT_USER_ID },
    )
    expect(im).toBeNull()
  })

  it('returns null when channel field is missing', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const im = slackToImMessage(makeEvent({ channel: undefined as any }), {
      botUserId: BOT_USER_ID,
    })
    expect(im).toBeNull()
  })

  it('returns null for non-message events', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const im = slackToImMessage({ type: 'reaction_added' } as any, { botUserId: BOT_USER_ID })
    expect(im).toBeNull()
  })

  it('falls back to Date.now() on unparseable ts', () => {
    const before = Date.now()
    const im = slackToImMessage(makeEvent({ ts: 'not-a-number' }), {
      botUserId: BOT_USER_ID,
    })
    const after = Date.now()
    expect(im!.ts).toBeGreaterThanOrEqual(before)
    expect(im!.ts).toBeLessThanOrEqual(after)
  })

  it('still works when botUserId is null (e.g. before first event)', () => {
    // Without a bot id we can't strip our own mention, but other-user
    // messages still flow through, and the bot_id-based anti-loop
    // still works.
    const im = slackToImMessage(makeEvent({ text: 'hi' }), { botUserId: null })
    expect(im).not.toBeNull()
    expect(im!.text).toBe('hi')
  })

  it('preserves empty text when an attachment is the only payload', () => {
    const im = slackToImMessage(
      makeEvent({
        text: '',
        subtype: 'file_share',
        files: [{ id: 'F1', name: 'f.pdf', mimetype: 'application/pdf' }],
      }),
      { botUserId: BOT_USER_ID },
    )
    expect(im!.text).toBe('')
    expect(im!.attachments).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

function sign(ts: string, body: string): string {
  return `v0=${createHmac('sha256', SIGNING_SECRET).update(`v0:${ts}:${body}`).digest('hex')}`
}

describe('verifySlackSignature', () => {
  it('accepts a freshly-signed request', () => {
    const ts = '1748345600'
    const body = '{"foo":"bar"}'
    const sig = sign(ts, body)
    const r = verifySlackSignature({
      signingSecret: SIGNING_SECRET,
      signature: sig,
      timestamp: ts,
      rawBody: body,
      nowSec: 1748345610,
    })
    expect(r.ok).toBe(true)
  })

  it('rejects when signature header is missing', () => {
    const r = verifySlackSignature({
      signingSecret: SIGNING_SECRET,
      signature: null,
      timestamp: '1748345600',
      rawBody: '{}',
      nowSec: 1748345600,
    })
    expect(r).toEqual({ ok: false, reason: 'missing-headers' })
  })

  it('rejects when timestamp header is missing', () => {
    const r = verifySlackSignature({
      signingSecret: SIGNING_SECRET,
      signature: sign('1748345600', '{}'),
      timestamp: null,
      rawBody: '{}',
      nowSec: 1748345600,
    })
    expect(r).toEqual({ ok: false, reason: 'missing-headers' })
  })

  it('rejects empty-string headers', () => {
    const r = verifySlackSignature({
      signingSecret: SIGNING_SECRET,
      signature: '',
      timestamp: '',
      rawBody: '{}',
      nowSec: 1748345600,
    })
    expect(r).toEqual({ ok: false, reason: 'missing-headers' })
  })

  it('rejects a stale timestamp (> 5 min in the past)', () => {
    const ts = '1748345600'
    const body = '{}'
    const sig = sign(ts, body)
    const r = verifySlackSignature({
      signingSecret: SIGNING_SECRET,
      signature: sig,
      timestamp: ts,
      rawBody: body,
      nowSec: 1748345600 + 301,
    })
    expect(r).toEqual({ ok: false, reason: 'bad-timestamp' })
  })

  it('rejects a future timestamp (> 5 min ahead)', () => {
    const ts = '1748345600'
    const body = '{}'
    const sig = sign(ts, body)
    const r = verifySlackSignature({
      signingSecret: SIGNING_SECRET,
      signature: sig,
      timestamp: ts,
      rawBody: body,
      nowSec: 1748345600 - 301,
    })
    expect(r).toEqual({ ok: false, reason: 'bad-timestamp' })
  })

  it('rejects a non-numeric timestamp', () => {
    const r = verifySlackSignature({
      signingSecret: SIGNING_SECRET,
      signature: sign('1748345600', '{}'),
      timestamp: 'not-a-number',
      rawBody: '{}',
      nowSec: 1748345600,
    })
    expect(r).toEqual({ ok: false, reason: 'bad-timestamp' })
  })

  it('rejects a signature computed with the wrong secret', () => {
    const ts = '1748345600'
    const body = '{}'
    const badSig = `v0=${createHmac('sha256', 'WRONG').update(`v0:${ts}:${body}`).digest('hex')}`
    const r = verifySlackSignature({
      signingSecret: SIGNING_SECRET,
      signature: badSig,
      timestamp: ts,
      rawBody: body,
      nowSec: 1748345600,
    })
    expect(r).toEqual({ ok: false, reason: 'mismatch' })
  })

  it('rejects when body has been tampered with', () => {
    const ts = '1748345600'
    const sig = sign(ts, '{"foo":"bar"}')
    const r = verifySlackSignature({
      signingSecret: SIGNING_SECRET,
      signature: sig,
      timestamp: ts,
      rawBody: '{"foo":"bar","evil":true}',
      nowSec: 1748345600,
    })
    expect(r).toEqual({ ok: false, reason: 'mismatch' })
  })

  it('rejects truncated/extended signatures (length mismatch)', () => {
    const ts = '1748345600'
    const body = '{}'
    const sig = sign(ts, body) + 'extra'
    const r = verifySlackSignature({
      signingSecret: SIGNING_SECRET,
      signature: sig,
      timestamp: ts,
      rawBody: body,
      nowSec: 1748345600,
    })
    expect(r).toEqual({ ok: false, reason: 'mismatch' })
  })

  it('honours a custom toleranceSec', () => {
    const ts = '1748345600'
    const body = '{}'
    const sig = sign(ts, body)
    // 30s in the past, but tolerance is 10s → rejected
    const r = verifySlackSignature({
      signingSecret: SIGNING_SECRET,
      signature: sig,
      timestamp: ts,
      rawBody: body,
      nowSec: 1748345600 + 30,
      toleranceSec: 10,
    })
    expect(r).toEqual({ ok: false, reason: 'bad-timestamp' })
  })
})
