/**
 * butler-seeing.test.ts — VIS-M1 视觉纯核承重门(镜像 butler-hearing.test.ts):
 *  ① opt-in 三缺一不可(butlerSeeingFromEnv 未配 undefined = 字节不变);
 *  ② fail-soft 三态合同(describe 永不抛;skipped=设计内静音 / failed=基建);
 *  ③ 凭证纪律(key 只进 Authorization 头,URL/body 全净);
 *  ④ wire 形状(标准 OpenAI vision:chat/completions + image_url data URI +
 *    固定中文指令 + max_tokens 上限——一条 wire 盖 MiMo-VL/Qwen-VL/GPT-4o,
 *    刻意无模型名嗅探)。
 */

import { describe, expect, it } from 'vitest'

import {
  MAX_IMAGE_INPUT_BYTES,
  VISION_MAX_TOKENS,
  VISION_PROMPT,
  buildButlerSeeing,
  butlerSeeingFromEnv,
  visionDescribe,
  type ButlerSeeingConfig,
} from '../src/butler-seeing.js'

/** 抓请求的假 fetch:回放注入的响应,记录 url/init 供断言。 */
function captureFetch(response: {
  status?: number
  json?: unknown
}): { fetchImpl: typeof fetch; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    return {
      ok: (response.status ?? 200) >= 200 && (response.status ?? 200) < 300,
      status: response.status ?? 200,
      json: async () => response.json ?? {},
    } as Response
  }) as typeof fetch
  return { fetchImpl, calls }
}

const JPEG = Buffer.from('fake-jpeg-bytes')

function cfg(over: Partial<ButlerSeeingConfig> = {}): ButlerSeeingConfig {
  return {
    baseUrl: 'https://vision.example.com/v1',
    apiKey: 'sk-vision-secret',
    model: 'mimo-v2.5-vl',
    ...over,
  }
}

describe('VIS-M1 visionDescribe — ④ wire 形状 + ③ 凭证纪律', () => {
  it('POSTs chat/completions with prompt + image_url data URI in ONE user message', async () => {
    const { fetchImpl, calls } = captureFetch({
      json: { choices: [{ message: { content: '一张超市小票,合计 RM 45.80' } }] },
    })
    const text = await visionDescribe(cfg({ fetchImpl }), JPEG, 'image/jpeg')
    expect(text).toBe('一张超市小票,合计 RM 45.80')

    expect(calls.length).toBe(1)
    expect(calls[0]!.url).toBe('https://vision.example.com/v1/chat/completions')
    const body = JSON.parse(String(calls[0]!.init.body)) as {
      model: string
      max_tokens: number
      messages: Array<{ role: string; content: Array<Record<string, unknown>> }>
    }
    expect(body.model).toBe('mimo-v2.5-vl')
    expect(body.max_tokens).toBe(VISION_MAX_TOKENS)
    expect(body.messages.length).toBe(1)
    expect(body.messages[0]!.role).toBe('user')
    const [textBlock, imageBlock] = body.messages[0]!.content
    expect(textBlock).toEqual({ type: 'text', text: VISION_PROMPT })
    expect(imageBlock!.type).toBe('image_url')
    const url = (imageBlock!.image_url as { url: string }).url
    expect(url).toBe(`data:image/jpeg;base64,${JPEG.toString('base64')}`)
  })

  it('③ the key rides ONLY in the Authorization header — URL and body are clean', async () => {
    const { fetchImpl, calls } = captureFetch({
      json: { choices: [{ message: { content: 'ok' } }] },
    })
    await visionDescribe(cfg({ fetchImpl }), JPEG, 'image/png')
    const { url, init } = calls[0]!
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-vision-secret')
    expect(url).not.toContain('sk-vision-secret')
    expect(String(init.body)).not.toContain('sk-vision-secret')
  })

  it('empty key sends NO auth header (local server posture)', async () => {
    const { fetchImpl, calls } = captureFetch({
      json: { choices: [{ message: { content: 'ok' } }] },
    })
    await visionDescribe(cfg({ apiKey: '', fetchImpl }), JPEG, 'image/png')
    expect('authorization' in (calls[0]!.init.headers as Record<string, string>)).toBe(false)
  })

  it('joins array-of-blocks content (defensive against block replies)', async () => {
    const { fetchImpl } = captureFetch({
      json: { choices: [{ message: { content: [{ type: 'text', text: '左半' }, { type: 'text', text: '右半' }] } }] },
    })
    expect(await visionDescribe(cfg({ fetchImpl }), JPEG, 'image/jpeg')).toBe('左半右半')
  })

  it('throws when the response carries no description', async () => {
    const { fetchImpl } = captureFetch({ json: { choices: [{ message: {} }] } })
    await expect(visionDescribe(cfg({ fetchImpl }), JPEG, 'image/jpeg')).rejects.toThrow(
      /no description/,
    )
  })

  it('throws on non-2xx', async () => {
    const { fetchImpl } = captureFetch({ status: 429 })
    await expect(visionDescribe(cfg({ fetchImpl }), JPEG, 'image/jpeg')).rejects.toThrow(/HTTP 429/)
  })
})

describe('VIS-M1 describe — ② fail-soft 三态合同', () => {
  it('returns text on the happy path (trimmed)', async () => {
    const { fetchImpl } = captureFetch({
      json: { choices: [{ message: { content: '  一只橘猫趴在键盘上  ' } }] },
    })
    const seeing = buildButlerSeeing(cfg({ fetchImpl }))
    expect(await seeing.describe(JPEG, 'image/jpeg')).toEqual({
      kind: 'text',
      text: '一只橘猫趴在键盘上',
    })
  })

  it('skips empty input', async () => {
    const seeing = buildButlerSeeing(cfg())
    const r = await seeing.describe(Buffer.alloc(0), 'image/jpeg')
    expect(r.kind).toBe('skipped')
  })

  it('skips oversized input (cap is a constant, not a knob)', async () => {
    const seeing = buildButlerSeeing(cfg())
    const r = await seeing.describe(Buffer.alloc(MAX_IMAGE_INPUT_BYTES + 1), 'image/jpeg')
    expect(r.kind).toBe('skipped')
    expect((r as { reason: string }).reason).toContain('上限')
  })

  it('skips a non-image mime (design, not infra)', async () => {
    const seeing = buildButlerSeeing(cfg())
    const r = await seeing.describe(JPEG, 'application/pdf')
    expect(r.kind).toBe('skipped')
    expect((r as { reason: string }).reason).toContain('application/pdf')
  })

  it('skips a blank description (model saw nothing to say)', async () => {
    const { fetchImpl } = captureFetch({ json: { choices: [{ message: { content: '   ' } }] } })
    const seeing = buildButlerSeeing(cfg({ fetchImpl }))
    expect((await seeing.describe(JPEG, 'image/jpeg')).kind).toBe('skipped')
  })

  it('fails (never throws) on HTTP errors', async () => {
    const { fetchImpl } = captureFetch({ status: 500 })
    const seeing = buildButlerSeeing(cfg({ fetchImpl }))
    const r = await seeing.describe(JPEG, 'image/jpeg')
    expect(r.kind).toBe('failed')
    expect((r as { reason: string }).reason).toContain('HTTP 500')
  })

  it('maps an aborted request to an honest timeout reason', async () => {
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('This operation was aborted')))
      })
    }) as typeof fetch
    const seeing = buildButlerSeeing(cfg({ fetchImpl, timeoutMs: 5 }))
    const r = await seeing.describe(JPEG, 'image/jpeg')
    expect(r.kind).toBe('failed')
    expect((r as { reason: string }).reason).toContain('超时')
  })
})

describe('VIS-M1 butlerSeeingFromEnv — ① opt-in 三缺一不可', () => {
  const FULL = {
    GOTONG_BUTLER_VOICE_URL: 'https://vision.example.com/v1',
    GOTONG_BUTLER_VOICE_KEY: 'sk-x',
    GOTONG_BUTLER_VISION_MODEL: 'mimo-v2.5-vl',
  }

  it('builds when the shared URL/KEY plus VISION_MODEL are all set', () => {
    const seeing = butlerSeeingFromEnv({ ...FULL } as NodeJS.ProcessEnv)
    expect(seeing).toBeDefined()
    expect(seeing!.dataLeavesBox).toBe(true)
  })

  it.each(Object.keys(FULL))('returns undefined when %s is missing (byte-identical)', (k) => {
    const env = { ...FULL } as Record<string, string>
    delete env[k]
    expect(butlerSeeingFromEnv(env as NodeJS.ProcessEnv)).toBeUndefined()
  })

  it('treats whitespace-only values as missing', () => {
    expect(
      butlerSeeingFromEnv({ ...FULL, GOTONG_BUTLER_VISION_MODEL: '   ' } as NodeJS.ProcessEnv),
    ).toBeUndefined()
  })

  it('does NOT require the TTS/ASR-side knobs (vision gates on its own)', () => {
    const seeing = butlerSeeingFromEnv({ ...FULL } as NodeJS.ProcessEnv)
    expect(seeing).toBeDefined()
  })
})

describe('VIS-M1 disclosure — 数据离盒披露', () => {
  it('remote endpoint: names host + that photos are sent there; never the key', () => {
    const seeing = buildButlerSeeing(cfg())
    expect(seeing.disclosure).toContain('vision.example.com')
    expect(seeing.disclosure).toContain('远程视觉')
    expect(seeing.disclosure).not.toContain('sk-vision-secret')
    expect(seeing.dataLeavesBox).toBe(true)
  })

  it('loopback endpoint: says images stay in the box', () => {
    const seeing = buildButlerSeeing(cfg({ baseUrl: 'http://127.0.0.1:8080/v1' }))
    expect(seeing.disclosure).toContain('不离盒')
    expect(seeing.dataLeavesBox).toBe(false)
  })
})
