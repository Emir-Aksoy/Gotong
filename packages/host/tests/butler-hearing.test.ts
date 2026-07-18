/**
 * ASR-M1 — the speech-to-text pure core (docs/zh/ATONG-VOICE.md).
 *
 * What must hold:
 *  ① opt-in: `butlerHearingFromEnv` returns undefined unless the shared
 *    VOICE_URL/_KEY plus ASR_MODEL are all set (no silent defaults).
 *  ② fail-soft: `transcribe` NEVER throws — input problems are `skipped`,
 *    infra problems (ffmpeg / HTTP / timeout) are `failed`, and both mean
 *    "the message flows on without a transcript".
 *  ③ credential discipline: the key travels ONLY in the Authorization header —
 *    never in the URL, never in the body, never in ffmpeg argv.
 *  ④ the wire: MiMo models ride the chat wire (input_audio base64 wav in a
 *    USER message — live-probed 2026-07-18; the standard transcription route
 *    404s there and ogg is refused by the server), everything else rides the
 *    standard OpenAI `/audio/transcriptions` multipart wire.
 */

import { describe, it, expect } from 'vitest'

import {
  MAX_VOICE_INPUT_BYTES,
  asrTranscribe,
  buildButlerHearing,
  butlerHearingFromEnv,
  isMimoAsrWire,
  toWavSpeech,
  type ButlerHearingConfig,
} from '../src/butler-hearing.js'
import type { FfmpegRunner } from '../src/butler-voice.js'

const OGG = Buffer.from('OggS-opus-voice-note-bytes')
const WAV = Buffer.from('RIFF....WAVEfmt fake-wav-bytes')

function okRunner(calls: Array<{ args: readonly string[]; input: Buffer }>): FfmpegRunner {
  return async (args, input) => {
    calls.push({ args, input })
    return { code: 0, stdout: WAV, stderr: '' }
  }
}

function mimoOkFetch(
  calls: Array<{ url: string; init: RequestInit }>,
  transcript: unknown = '明天上午十点提醒我开会',
): typeof fetch {
  return (async (url: unknown, init?: unknown) => {
    calls.push({ url: String(url), init: (init ?? {}) as RequestInit })
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: transcript } }] }),
    }
  }) as unknown as typeof fetch
}

function config(over: Partial<ButlerHearingConfig> = {}): ButlerHearingConfig {
  return {
    baseUrl: 'https://asr.example.com/v1',
    apiKey: 'sk-secret-hearing-key',
    model: 'mimo-v2.5-asr',
    ...over,
  }
}

describe('ASR-M1 isMimoAsrWire — wire 探测', () => {
  it('matches mimo ASR models (case-insensitive)', () => {
    expect(isMimoAsrWire('mimo-v2.5-asr')).toBe(true)
    expect(isMimoAsrWire('MiMo-V3-ASR')).toBe(true)
  })

  it('does NOT match mimo TTS models or standard ASR models', () => {
    expect(isMimoAsrWire('mimo-v2.5-tts')).toBe(false)
    expect(isMimoAsrWire('whisper-1')).toBe(false)
    expect(isMimoAsrWire('asr-mimo')).toBe(false) // must START with mimo-
  })
})

describe('ASR-M1 toWavSpeech — 转码腿', () => {
  it('passes RIFF (already-wav) input through without invoking ffmpeg', async () => {
    const calls: Array<{ args: readonly string[]; input: Buffer }> = []
    const out = await toWavSpeech(WAV, okRunner(calls))
    expect(out).toBe(WAV)
    expect(calls).toHaveLength(0)
  })

  it('transcodes ogg through ffmpeg with the 16k mono pcm_s16le wav shape', async () => {
    const calls: Array<{ args: readonly string[]; input: Buffer }> = []
    const out = await toWavSpeech(OGG, okRunner(calls))
    expect(out).toBe(WAV)
    expect(calls).toHaveLength(1)
    const args = calls[0].args.join(' ')
    expect(args).toContain('-ac 1')
    expect(args).toContain('-ar 16000')
    expect(args).toContain('-acodec pcm_s16le')
    expect(args).toContain('-f wav')
    expect(calls[0].input).toBe(OGG)
  })

  it('throws on non-zero ffmpeg exit (result, not crash)', async () => {
    const bad: FfmpegRunner = async () => ({ code: 1, stdout: Buffer.alloc(0), stderr: 'boom' })
    await expect(toWavSpeech(OGG, bad)).rejects.toThrow(/exited 1/)
  })

  it('throws when ffmpeg produces no bytes', async () => {
    const empty: FfmpegRunner = async () => ({ code: 0, stdout: Buffer.alloc(0), stderr: '' })
    await expect(toWavSpeech(OGG, empty)).rejects.toThrow(/no audio bytes/)
  })
})

describe('ASR-M1 asrTranscribe — ④ wire 形状 + ③ 凭证纪律', () => {
  it('mimo wire: POSTs chat/completions with input_audio base64 wav in a USER message', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const text = await asrTranscribe(config({ fetchImpl: mimoOkFetch(calls) }), WAV)
    expect(text).toBe('明天上午十点提醒我开会')
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://asr.example.com/v1/chat/completions')
    const body = JSON.parse(String(calls[0].init.body)) as {
      model: string
      messages: Array<{ role: string; content: Array<{ type: string; input_audio: { data: string; format: string } }> }>
    }
    expect(body.model).toBe('mimo-v2.5-asr')
    expect(body.messages).toHaveLength(1)
    expect(body.messages[0].role).toBe('user')
    expect(body.messages[0].content[0].type).toBe('input_audio')
    expect(body.messages[0].content[0].input_audio.format).toBe('wav')
    expect(Buffer.from(body.messages[0].content[0].input_audio.data, 'base64').equals(WAV)).toBe(true)
  })

  it('③ the key rides ONLY in the Authorization header — URL and body are clean', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    await asrTranscribe(config({ fetchImpl: mimoOkFetch(calls) }), WAV)
    const headers = calls[0].init.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer sk-secret-hearing-key')
    expect(calls[0].url).not.toContain('sk-secret-hearing-key')
    expect(String(calls[0].init.body)).not.toContain('sk-secret-hearing-key')
  })

  it('mimo wire: joins array-of-blocks content (defensive against block replies)', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const blocks = [{ type: 'text', text: '你好,' }, { type: 'text', text: '阿同' }]
    const text = await asrTranscribe(config({ fetchImpl: mimoOkFetch(calls, blocks) }), WAV)
    expect(text).toBe('你好,阿同')
  })

  it('mimo wire: throws when the response carries no transcript', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    await expect(asrTranscribe(config({ fetchImpl: mimoOkFetch(calls, null) }), WAV)).rejects.toThrow(
      /no transcript/,
    )
  })

  it('throws on non-2xx', async () => {
    const fetch401 = (async () => ({ ok: false, status: 401 })) as unknown as typeof fetch
    await expect(asrTranscribe(config({ fetchImpl: fetch401 }), WAV)).rejects.toThrow(/HTTP 401/)
  })

  it('standard wire: POSTs /audio/transcriptions as multipart and reads json.text', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const stdFetch = (async (url: unknown, init?: unknown) => {
      calls.push({ url: String(url), init: (init ?? {}) as RequestInit })
      return { ok: true, status: 200, json: async () => ({ text: '标准转写结果' }) }
    }) as unknown as typeof fetch
    const text = await asrTranscribe(config({ model: 'whisper-1', fetchImpl: stdFetch }), WAV)
    expect(text).toBe('标准转写结果')
    expect(calls[0].url).toBe('https://asr.example.com/v1/audio/transcriptions')
    expect(calls[0].init.body).toBeInstanceOf(FormData)
    const form = calls[0].init.body as FormData
    expect(form.get('model')).toBe('whisper-1')
    const headers = calls[0].init.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer sk-secret-hearing-key')
  })
})

describe('ASR-M1 transcribe — ② fail-soft 三态合同', () => {
  it('returns text on the happy path (trimmed)', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const h = buildButlerHearing(config({ fetchImpl: mimoOkFetch(calls, '  你好阿同  '), ffmpeg: okRunner([]) }))
    const out = await h.transcribe(OGG)
    expect(out).toEqual({ kind: 'text', text: '你好阿同' })
  })

  it('skips empty input', async () => {
    const h = buildButlerHearing(config({ fetchImpl: mimoOkFetch([]), ffmpeg: okRunner([]) }))
    const out = await h.transcribe(Buffer.alloc(0))
    expect(out.kind).toBe('skipped')
  })

  it('skips oversized input (cap is a constant, not a knob)', async () => {
    const h = buildButlerHearing(config({ fetchImpl: mimoOkFetch([]), ffmpeg: okRunner([]) }))
    const out = await h.transcribe(Buffer.alloc(MAX_VOICE_INPUT_BYTES + 1))
    expect(out.kind).toBe('skipped')
  })

  it('skips a silent note (empty transcript is design, not infra)', async () => {
    const h = buildButlerHearing(config({ fetchImpl: mimoOkFetch([], '   '), ffmpeg: okRunner([]) }))
    const out = await h.transcribe(OGG)
    expect(out.kind).toBe('skipped')
    expect((out as { reason: string }).reason).toContain('静音')
  })

  it('fails honestly when ffmpeg is not installed (ENOENT → 未装 ffmpeg)', async () => {
    const enoent: FfmpegRunner = async () => {
      const err = new Error('spawn ffmpeg ENOENT') as NodeJS.ErrnoException
      err.code = 'ENOENT'
      throw err
    }
    const h = buildButlerHearing(config({ fetchImpl: mimoOkFetch([]), ffmpeg: enoent }))
    const out = await h.transcribe(OGG)
    expect(out.kind).toBe('failed')
    expect((out as { reason: string }).reason).toContain('未装 ffmpeg')
  })

  it('fails (never throws) on HTTP errors', async () => {
    const fetch500 = (async () => ({ ok: false, status: 500 })) as unknown as typeof fetch
    const h = buildButlerHearing(config({ fetchImpl: fetch500, ffmpeg: okRunner([]) }))
    const out = await h.transcribe(OGG)
    expect(out.kind).toBe('failed')
    expect((out as { reason: string }).reason).toContain('HTTP 500')
  })

  it('maps an aborted request to an honest timeout reason', async () => {
    const abortFetch = (async () => {
      throw new Error('The operation was aborted')
    }) as unknown as typeof fetch
    const h = buildButlerHearing(config({ fetchImpl: abortFetch, ffmpeg: okRunner([]) }))
    const out = await h.transcribe(OGG)
    expect(out.kind).toBe('failed')
    expect((out as { reason: string }).reason).toContain('超时')
  })
})

describe('ASR-M1 butlerHearingFromEnv — ① opt-in 三缺一不可', () => {
  const FULL = {
    GOTONG_BUTLER_VOICE_URL: 'https://asr.example.com/v1',
    GOTONG_BUTLER_VOICE_KEY: 'sk-secret-hearing-key',
    GOTONG_BUTLER_ASR_MODEL: 'mimo-v2.5-asr',
  }

  it('builds when the shared URL/KEY plus ASR_MODEL are all set', () => {
    expect(butlerHearingFromEnv({ ...FULL })).toBeDefined()
  })

  it.each(Object.keys(FULL))('returns undefined when %s is missing', (key) => {
    const env = { ...FULL } as Record<string, string>
    delete env[key]
    expect(butlerHearingFromEnv(env)).toBeUndefined()
  })

  it('treats whitespace-only values as missing', () => {
    expect(butlerHearingFromEnv({ ...FULL, GOTONG_BUTLER_ASR_MODEL: '   ' })).toBeUndefined()
  })

  it('does NOT require the TTS-side MODEL/VOICE knobs (ASR gates on its own)', () => {
    // ASR without TTS is a legal deployment: three knobs, not five.
    expect(butlerHearingFromEnv({ ...FULL })).toBeDefined()
  })
})

describe('ASR-M1 disclosure — 数据离盒披露', () => {
  it('remote endpoint: names the host and says voice audio is sent there; never the key', () => {
    const h = buildButlerHearing(config())
    expect(h.dataLeavesBox).toBe(true)
    expect(h.disclosure).toContain('asr.example.com')
    expect(h.disclosure).toContain('mimo-v2.5-asr')
    expect(h.disclosure).toContain('发往该主机转写')
    expect(h.disclosure).not.toContain('sk-secret-hearing-key')
  })

  it('loopback endpoint: says voice stays in the box', () => {
    const h = buildButlerHearing(config({ baseUrl: 'http://127.0.0.1:8000/v1' }))
    expect(h.dataLeavesBox).toBe(false)
    expect(h.disclosure).toContain('不离盒')
  })
})
