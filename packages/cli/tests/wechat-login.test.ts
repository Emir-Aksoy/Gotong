/**
 * WX-M2c — `gotong wechat-login` flow state machine, driven by a scripted
 * fake client (no network, no TTY, no real timers: sleep is a no-op and the
 * clock is a counter). Mirrors the official plugin's login-qr semantics.
 */

import { describe, expect, it } from 'vitest'

import {
  renderEnvLines,
  renderSuccessHint,
  runWechatLoginFlow,
  wechatLogin,
  type WechatLoginClient,
  type WechatLoginFlowDeps,
  type WechatLoginOutcome,
} from '../src/commands/wechat-login.js'

type StatusPage = Awaited<ReturnType<WechatLoginClient['pollQrcodeStatus']>>

/** Scripted client:每次 poll 消费一页;记录调用参数;二维码可多次签发。 */
function makeClient(pages: StatusPage[], qrKeys: string[] = ['QR-1', 'QR-2', 'QR-3']) {
  let qrIndex = 0
  const polls: Array<{ qrcode: string; verifyCode?: string; baseUrlOverride?: string }> = []
  const client: WechatLoginClient = {
    async fetchBotQrcode() {
      const key = qrKeys[Math.min(qrIndex, qrKeys.length - 1)]!
      qrIndex++
      return { qrcode: key, qrcode_img_content: `https://weixin.qq.com/x/${key}` }
    },
    async pollQrcodeStatus(params) {
      polls.push({ ...params })
      const page = pages.shift()
      if (!page) throw new Error('poll script exhausted')
      return page
    },
  }
  return { client, polls, qrIssued: () => qrIndex }
}

function makeDeps(
  client: WechatLoginClient,
  over: Partial<WechatLoginFlowDeps> = {},
): WechatLoginFlowDeps & { infos: string[]; qrShows: Array<{ url?: string; attempt: number }> } {
  const infos: string[] = []
  const qrShows: Array<{ url?: string; attempt: number }> = []
  let clock = 0
  return {
    client,
    showQr: async (url, attempt) => {
      qrShows.push({ url, attempt })
    },
    promptDigits: async () => null,
    info: (line) => infos.push(line),
    // 每次 sleep 记 1 秒虚拟时间;默认预算 480s 内测试永不超时。
    sleep: async () => {
      clock += 1000
    },
    now: () => clock,
    infos,
    qrShows,
    ...over,
  }
}

const ok = (outcome: WechatLoginOutcome): Extract<WechatLoginOutcome, { ok: true }> => {
  if (!outcome.ok) throw new Error(`expected ok, got ${outcome.reason}`)
  return outcome
}

describe('runWechatLoginFlow', () => {
  it('happy path: wait → scaned → confirmed, credentials extracted', async () => {
    const { client, polls } = makeClient([
      { status: 'wait' },
      { status: 'scaned' },
      {
        status: 'confirmed',
        bot_token: 'BT-9',
        ilink_bot_id: 'bot-9',
        baseurl: 'https://sh.ilinkai.weixin.qq.com',
        ilink_user_id: 'wxid-me',
      },
    ])
    const deps = makeDeps(client)
    const outcome = ok(await runWechatLoginFlow(deps))
    expect(outcome).toEqual({
      ok: true,
      botToken: 'BT-9',
      botId: 'bot-9',
      baseUrl: 'https://sh.ilinkai.weixin.qq.com',
      userId: 'wxid-me',
    })
    expect(deps.qrShows).toEqual([{ url: 'https://weixin.qq.com/x/QR-1', attempt: 1 }])
    expect(deps.infos.filter((l) => l.includes('已扫码'))).toHaveLength(1)
    expect(polls.every((p) => p.qrcode === 'QR-1')).toBe(true)
  })

  it('IDC redirect switches the polling host for every later poll', async () => {
    const { client, polls } = makeClient([
      { status: 'scaned_but_redirect', redirect_host: 'sz.ilinkai.weixin.qq.com' },
      { status: 'scaned' },
      { status: 'confirmed', bot_token: 't', ilink_bot_id: 'b' },
    ])
    const outcome = ok(await runWechatLoginFlow(makeDeps(client)))
    expect(outcome.botToken).toBe('t')
    expect(polls[0]!.baseUrlOverride).toBeUndefined()
    expect(polls[1]!.baseUrlOverride).toBe('https://sz.ilinkai.weixin.qq.com')
    expect(polls[2]!.baseUrlOverride).toBe('https://sz.ilinkai.weixin.qq.com')
  })

  it('need_verifycode: digits ride the next poll; acceptance (scaned) clears them', async () => {
    const { client, polls } = makeClient([
      { status: 'need_verifycode' },
      { status: 'scaned' },
      { status: 'confirmed', bot_token: 't', ilink_bot_id: 'b' },
    ])
    const prompts: string[] = []
    const deps = makeDeps(client, {
      promptDigits: async (msg) => {
        prompts.push(msg)
        return '1234'
      },
    })
    ok(await runWechatLoginFlow(deps))
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).not.toContain('不匹配')
    expect(polls[1]!.verifyCode).toBe('1234') // carried immediately
    expect(polls[2]!.verifyCode).toBeUndefined() // cleared once accepted
  })

  it('wrong digits re-prompt with the mismatch wording', async () => {
    const { client, polls } = makeClient([
      { status: 'need_verifycode' },
      { status: 'need_verifycode' }, // still asking = previous digits wrong
      { status: 'confirmed', bot_token: 't', ilink_bot_id: 'b' },
    ])
    const prompts: string[] = []
    let n = 0
    const deps = makeDeps(client, {
      promptDigits: async (msg) => {
        prompts.push(msg)
        return ++n === 1 ? '1111' : '2222'
      },
    })
    ok(await runWechatLoginFlow(deps))
    expect(prompts[1]).toContain('不匹配')
    expect(polls[2]!.verifyCode).toBe('2222')
  })

  it('need_verifycode without a TTY fails honestly', async () => {
    const { client } = makeClient([{ status: 'need_verifycode' }])
    const outcome = await runWechatLoginFlow(makeDeps(client))
    expect(outcome).toMatchObject({ ok: false, reason: 'no_tty' })
  })

  it('expired refreshes the QR (new key polled, re-rendered); cap → give up', async () => {
    const { client, polls } = makeClient([
      { status: 'expired' },
      { status: 'confirmed', bot_token: 't', ilink_bot_id: 'b' },
    ])
    const deps = makeDeps(client)
    ok(await runWechatLoginFlow(deps))
    expect(deps.qrShows.map((s) => s.attempt)).toEqual([1, 2])
    expect(polls[1]!.qrcode).toBe('QR-2')

    // Exhaust the cap: every page expired.
    const worn = makeClient([{ status: 'expired' }, { status: 'expired' }, { status: 'expired' }])
    const outcome = await runWechatLoginFlow(makeDeps(worn.client))
    expect(outcome).toMatchObject({ ok: false, reason: 'expired' })
    expect(worn.qrIssued()).toBe(3) // initial + 2 refreshes, never a 4th
  })

  it('verify_code_blocked refreshes; repeated blocks give up', async () => {
    const { client } = makeClient([
      { status: 'verify_code_blocked' },
      { status: 'confirmed', bot_token: 't', ilink_bot_id: 'b' },
    ])
    ok(await runWechatLoginFlow(makeDeps(client)))

    const worn = makeClient([
      { status: 'verify_code_blocked' },
      { status: 'verify_code_blocked' },
      { status: 'verify_code_blocked' },
    ])
    const outcome = await runWechatLoginFlow(makeDeps(worn.client))
    expect(outcome).toMatchObject({ ok: false, reason: 'blocked' })
  })

  it('binded_redirect = token lives elsewhere; no new credential, honest guidance', async () => {
    const { client } = makeClient([{ status: 'binded_redirect' }])
    const outcome = await runWechatLoginFlow(makeDeps(client))
    expect(outcome).toMatchObject({ ok: false, reason: 'already_bound' })
    if (!outcome.ok) expect(outcome.message).toContain('解除旧绑定')
  })

  it('confirmed without a bot_token is a protocol failure, not a success', async () => {
    const { client } = makeClient([{ status: 'confirmed', ilink_bot_id: 'b' }])
    const outcome = await runWechatLoginFlow(makeDeps(client))
    expect(outcome).toMatchObject({ ok: false, reason: 'protocol' })
  })

  it('times out when nothing happens before the budget', async () => {
    const pages: StatusPage[] = Array.from({ length: 10 }, () => ({ status: 'wait' }) as StatusPage)
    const { client } = makeClient(pages)
    const outcome = await runWechatLoginFlow(makeDeps(client, { timeoutMs: 5000 }))
    expect(outcome).toMatchObject({ ok: false, reason: 'timeout' })
  })

  it('an unknown status is reported and skipped (forward compat)', async () => {
    const { client } = makeClient([
      { status: 'mystery_state' as StatusPage['status'] },
      { status: 'confirmed', bot_token: 't', ilink_bot_id: 'b' },
    ])
    const deps = makeDeps(client)
    ok(await runWechatLoginFlow(deps))
    expect(deps.infos.some((l) => l.includes('mystery_state'))).toBe(true)
  })
})

describe('renderEnvLines / renderSuccessHint', () => {
  const outcome = {
    ok: true as const,
    botToken: 'BT-1',
    botId: 'bot-1',
    baseUrl: 'https://sh.ilinkai.weixin.qq.com',
    userId: 'wxid-me',
  }

  it('stdout payload is exactly the env lines the host gate reads', () => {
    expect(renderEnvLines(outcome)).toBe(
      'GOTONG_WECHAT_BOT_TOKEN=BT-1\nGOTONG_WECHAT_BASE_URL=https://sh.ilinkai.weixin.qq.com\n',
    )
    expect(renderEnvLines({ ok: true, botToken: 'BT-2', botId: 'b' })).toBe(
      'GOTONG_WECHAT_BOT_TOKEN=BT-2\n',
    )
  })

  it('the hint teaches restart + /bind and warns about secret + passive-reply', () => {
    const hint = renderSuccessHint(outcome)
    expect(hint).toContain('重启 host')
    expect(hint).toContain('/bind')
    expect(hint).toContain('secret')
    expect(hint).toContain('被动回复')
  })
})

describe('wechatLogin argument handling (no network before validation)', () => {
  it('--help exits 0', async () => {
    expect(await wechatLogin(['--help'])).toBe(0)
  })
  it('unknown flag / stray arg / bad values exit 2', async () => {
    expect(await wechatLogin(['--nope'])).toBe(2)
    expect(await wechatLogin(['stray'])).toBe(2)
    expect(await wechatLogin(['--base-url=http://insecure.example'])).toBe(2)
    expect(await wechatLogin(['--timeout=5'])).toBe(2)
    expect(await wechatLogin(['--timeout=abc'])).toBe(2)
  })
})
