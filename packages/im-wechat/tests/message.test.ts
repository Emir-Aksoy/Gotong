/**
 * WX-M1 — wechatToImMessage mapping, fixture-driven. Fixtures mirror the
 * official `WeixinMessage` shape (Tencent/openclaw-weixin types.ts).
 */

import { describe, expect, it } from 'vitest'

import { wechatContextToken, wechatToImMessage, WECHAT_MEDIA_URI_PREFIX } from '../src/message.js'
import type { WechatMessage } from '../src/types.js'

const inboundText = (over: Partial<WechatMessage> = {}): WechatMessage => ({
  seq: 7,
  message_id: 1001,
  from_user_id: 'wxid-alice',
  to_user_id: 'bot-1',
  create_time_ms: 1_760_000_000_000,
  message_type: 1, // USER
  message_state: 2, // FINISH
  context_token: 'CTX-abc',
  item_list: [{ type: 1, text_item: { text: '早上好' } }],
  ...over,
})

describe('wechatToImMessage', () => {
  it('maps a finished user text message', () => {
    const m = wechatToImMessage(inboundText())!
    expect(m).not.toBeNull()
    expect(m.from).toEqual({ platform: 'wechat', platformUserId: 'wxid-alice', displayName: null })
    expect(m.text).toBe('早上好')
    expect(m.messageId).toBe('1001')
    expect(m.chatId).toBe('wxid-alice') // DM: peer is the chat
    expect(m.ts).toBe(1_760_000_000_000)
    expect(m.attachments).toBeUndefined()
  })

  it('drops bot-authored echoes (message_type 2) — the loop guard', () => {
    expect(wechatToImMessage(inboundText({ message_type: 2 }))).toBeNull()
  })

  it('drops unfinished streaming frames (message_state GENERATING)', () => {
    expect(wechatToImMessage(inboundText({ message_state: 1 }))).toBeNull()
    // …but a message with no state field at all still routes (defensive:
    // the server always sets it on finished frames we've observed, and
    // absent ≠ generating).
    expect(wechatToImMessage(inboundText({ message_state: undefined }))).not.toBeNull()
  })

  it('drops messages with no sender and no consumable content', () => {
    expect(wechatToImMessage(inboundText({ from_user_id: '' }))).toBeNull()
    expect(wechatToImMessage(inboundText({ item_list: [] }))).toBeNull()
    expect(wechatToImMessage(inboundText({ item_list: [{ type: 1, text_item: { text: '' } }] }))).toBeNull()
  })

  it('voice note becomes text via the server transcript', () => {
    const m = wechatToImMessage(
      inboundText({
        item_list: [{ type: 3, voice_item: { encode_type: 6, playtime: 2100, text: '帮我记一下买牛奶' } }],
      }),
    )!
    expect(m.text).toBe('帮我记一下买牛奶')
    expect(m.attachments).toBeUndefined()
  })

  it('media items become honest no-bytes stubs; multiple items concatenate', () => {
    const m = wechatToImMessage(
      inboundText({
        item_list: [
          { type: 1, text_item: { text: '看这个' } },
          { type: 2, msg_id: 'img-9', image_item: { url: 'ignored' } },
          { type: 4, msg_id: 'f-3', file_item: { file_name: 'report.pdf' } },
        ],
      }),
    )!
    expect(m.text).toBe('看这个')
    expect(m.attachments).toHaveLength(2)
    expect(m.attachments![0]).toMatchObject({ kind: 'image', url: `${WECHAT_MEDIA_URI_PREFIX}image:img-9` })
    expect(m.attachments![1]).toMatchObject({
      kind: 'file',
      url: `${WECHAT_MEDIA_URI_PREFIX}file:f-3`,
      filename: 'report.pdf',
    })
  })

  it('a group_id becomes the chatId when the protocol ever opens groups', () => {
    const m = wechatToImMessage(inboundText({ group_id: 'g-42' }))!
    expect(m.chatId).toBe('g-42')
  })
})

describe('wechatContextToken', () => {
  it('extracts the window token and treats blank as absent', () => {
    expect(wechatContextToken(inboundText())).toBe('CTX-abc')
    expect(wechatContextToken(inboundText({ context_token: '  ' }))).toBeNull()
    expect(wechatContextToken(inboundText({ context_token: undefined }))).toBeNull()
  })
})
