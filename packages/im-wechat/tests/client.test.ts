/**
 * WX-M1 — WechatIlinkClient coverage with injected fetch. Wire shapes are
 * fixtures copied from the official plugin source (types.ts / api.ts /
 * login-qr.ts, 2026-07-09); no request ever leaves the process.
 */

import { describe, expect, it, vi } from 'vitest'

import {
  buildIlinkClientVersion,
  createWechatIlinkClient,
  randomWechatUin,
  STALE_TOKEN_ERRCODE,
  WechatIlinkError,
} from '../src/client.js'

type Call = { url: string; init: RequestInit }

function mockFetch(
  handler: (url: string, init: RequestInit) => { status?: number; body: unknown },
): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = []
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url)
    calls.push({ url: u, init: init ?? {} })
    const r = handler(u, init ?? {})
    return new Response(JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

describe('header + version plumbing', () => {
  it('buildIlinkClientVersion packs 0x00MMNNPP like the official plugin', () => {
    // Official example: "1.0.11" -> 0x0001000B = 65547
    expect(buildIlinkClientVersion('1.0.11')).toBe(65547)
    expect(buildIlinkClientVersion('2.4.6')).toBe((2 << 16) | (4 << 8) | 6)
    expect(buildIlinkClientVersion('0.0.0')).toBe(0)
  })

  it('randomWechatUin is base64 of the decimal string of a uint32', () => {
    const fixed = (n: number) => Buffer.from([0x00, 0x00, 0x01, 0x02]).subarray(0, n)
    const uin = randomWechatUin(fixed)
    expect(Buffer.from(uin, 'base64').toString('utf-8')).toBe(String(0x00000102))
  })

  it('POST carries auth trio + app-id headers and base_info in the body', async () => {
    const { fetchImpl, calls } = mockFetch(() => ({ body: { ret: 0, msgs: [] } }))
    const c = createWechatIlinkClient({
      token: 'BOT_TOKEN',
      baseUrl: 'https://ilink.example.test',
      fetchImpl,
      botAgent: 'Gotong/9.9',
    })
    await c.getUpdates()
    expect(calls).toHaveLength(1)
    const { url, init } = calls[0]!
    expect(url).toBe('https://ilink.example.test/ilink/bot/getupdates')
    const h = init.headers as Record<string, string>
    expect(h.Authorization).toBe('Bearer BOT_TOKEN')
    expect(h.AuthorizationType).toBe('ilink_bot_token')
    expect(h['iLink-App-Id']).toBe('bot')
    expect(typeof h['X-WECHAT-UIN']).toBe('string')
    expect(Number(Buffer.from(h['X-WECHAT-UIN']!, 'base64').toString('utf-8'))).not.toBeNaN()
    const body = JSON.parse(init.body as string)
    expect(body.get_updates_buf).toBe('')
    expect(body.base_info.bot_agent).toBe('Gotong/9.9')
    expect(typeof body.base_info.channel_version).toBe('string')
  })
})

describe('getUpdates', () => {
  it('passes the cursor through and returns the parsed page', async () => {
    const { fetchImpl, calls } = mockFetch(() => ({
      body: {
        ret: 0,
        msgs: [{ from_user_id: 'u1', item_list: [{ type: 1, text_item: { text: 'hi' } }] }],
        get_updates_buf: 'CURSOR-2',
        longpolling_timeout_ms: 35000,
      },
    }))
    const c = createWechatIlinkClient({ token: 't', fetchImpl })
    const page = await c.getUpdates({ getUpdatesBuf: 'CURSOR-1' })
    expect(JSON.parse(calls[0]!.init.body as string).get_updates_buf).toBe('CURSOR-1')
    expect(page.get_updates_buf).toBe('CURSOR-2')
    expect(page.msgs).toHaveLength(1)
  })

  it('external abort returns an empty page with the cursor unchanged', async () => {
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const e = new Error('aborted')
            e.name = 'AbortError'
            reject(e)
          })
        }),
    ) as unknown as typeof fetch
    const ctrl = new AbortController()
    const c = createWechatIlinkClient({ token: 't', fetchImpl })
    const p = c.getUpdates({ getUpdatesBuf: 'KEEP', abortSignal: ctrl.signal })
    ctrl.abort()
    const page = await p
    expect(page).toEqual({ ret: 0, msgs: [], get_updates_buf: 'KEEP' })
  })

  it('surfaces the -14 stale-session errcode for the caller to cool down on', async () => {
    const { fetchImpl } = mockFetch(() => ({
      body: { ret: -1, errcode: STALE_TOKEN_ERRCODE, errmsg: 'session timeout' },
    }))
    const c = createWechatIlinkClient({ token: 't', fetchImpl })
    const page = await c.getUpdates()
    expect(page.errcode).toBe(-14)
  })
})

describe('sendTextMessage', () => {
  it('builds the official WeixinMessage envelope (BOT + FINISH + context_token)', async () => {
    const { fetchImpl, calls } = mockFetch(() => ({ body: { ret: 0 } }))
    const c = createWechatIlinkClient({ token: 't', fetchImpl })
    await c.sendTextMessage({ toUserId: 'u1@im.wechat', text: '你好', contextToken: 'CTX-1', clientId: 'cid-1' })
    const body = JSON.parse(calls[0]!.init.body as string)
    expect(calls[0]!.url).toMatch(/\/ilink\/bot\/sendmessage$/)
    expect(body.msg).toEqual({
      to_user_id: 'u1@im.wechat',
      client_id: 'cid-1',
      message_type: 2,
      message_state: 2,
      context_token: 'CTX-1',
      item_list: [{ type: 1, text_item: { text: '你好' } }],
    })
  })

  it('generates a UUID client_id when none is given', async () => {
    const { fetchImpl, calls } = mockFetch(() => ({ body: { ret: 0 } }))
    const c = createWechatIlinkClient({ token: 't', fetchImpl })
    await c.sendTextMessage({ toUserId: 'u1', text: 'x', contextToken: 'ctx' })
    const body = JSON.parse(calls[0]!.init.body as string)
    expect(body.msg.client_id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('hard-fails on ret !== 0 (the official silent-fail bug, issue #197)', async () => {
    const { fetchImpl } = mockFetch(() => ({ body: { ret: -2, errmsg: 'media cooldown' } }))
    const c = createWechatIlinkClient({ token: 't', fetchImpl })
    await expect(c.sendTextMessage({ toUserId: 'u', text: 'x', contextToken: 'c' })).rejects.toThrow(
      WechatIlinkError,
    )
    await expect(
      c.sendTextMessage({ toUserId: 'u', text: 'x', contextToken: 'c' }),
    ).rejects.toMatchObject({ ret: -2 })
  })

  it('wraps HTTP-level failure with the status as ret', async () => {
    const { fetchImpl } = mockFetch(() => ({ status: 401, body: { error: 'expired' } }))
    const c = createWechatIlinkClient({ token: 't', fetchImpl })
    await expect(
      c.sendTextMessage({ toUserId: 'u', text: 'x', contextToken: 'c' }),
    ).rejects.toMatchObject({ ret: 401 })
  })
})

describe('QR login flow', () => {
  it('fetchBotQrcode POSTs (not GETs) with bot_type in the query and local_token_list in the body', async () => {
    const { fetchImpl, calls } = mockFetch(() => ({
      body: { qrcode: 'QRKEY', qrcode_img_content: 'https://weixin.qq.com/x/QRKEY' },
    }))
    const c = createWechatIlinkClient({ fetchImpl })
    const r = await c.fetchBotQrcode()
    expect(r.qrcode).toBe('QRKEY')
    const { url, init } = calls[0]!
    expect(init.method).toBe('POST')
    expect(url).toMatch(/\/ilink\/bot\/get_bot_qrcode\?bot_type=3$/)
    expect(JSON.parse(init.body as string)).toEqual({ local_token_list: [] })
  })

  it('pollQrcodeStatus GETs with the qrcode key and parses a confirmed login', async () => {
    const { fetchImpl, calls } = mockFetch(() => ({
      body: {
        status: 'confirmed',
        bot_token: 'BT-1',
        ilink_bot_id: 'bot-1',
        baseurl: 'https://sh.ilinkai.weixin.qq.com',
        ilink_user_id: 'wxid-9',
      },
    }))
    const c = createWechatIlinkClient({ fetchImpl })
    const r = await c.pollQrcodeStatus({ qrcode: 'QR KEY' })
    expect(calls[0]!.init.method).toBe('GET')
    expect(calls[0]!.url).toMatch(/get_qrcode_status\?qrcode=QR%20KEY$/)
    expect(r).toEqual({
      status: 'confirmed',
      bot_token: 'BT-1',
      ilink_bot_id: 'bot-1',
      baseurl: 'https://sh.ilinkai.weixin.qq.com',
      ilink_user_id: 'wxid-9',
    })
  })

  it('carries verify_code (pairing digits) and honours the IDC-redirect host override', async () => {
    const { fetchImpl, calls } = mockFetch(() => ({ body: { status: 'scaned' } }))
    const c = createWechatIlinkClient({ fetchImpl, baseUrl: 'https://ilink.example.test' })
    await c.pollQrcodeStatus({
      qrcode: 'K',
      verifyCode: '1234',
      baseUrlOverride: 'https://sz.ilinkai.weixin.qq.com/',
    })
    expect(calls[0]!.url).toBe(
      'https://sz.ilinkai.weixin.qq.com/ilink/bot/get_qrcode_status?qrcode=K&verify_code=1234',
    )
  })
})
