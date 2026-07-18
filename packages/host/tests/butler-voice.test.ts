/**
 * VOICE-M1 — the TTS pure core (docs/zh/ATONG-VOICE.md).
 *
 * What must hold:
 *  ① opt-in: `butlerVoiceFromEnv` returns undefined unless ALL FOUR env vars
 *    are set (model/voice are required wire params — no silent defaults).
 *  ② fail-soft: `synthesize` NEVER throws — content problems are `skipped`,
 *    infra problems (HTTP / timeout / missing ffmpeg / bad exit) are `failed`,
 *    and both mean "send text".
 *  ③ credential discipline: the key travels ONLY in the Authorization header —
 *    never in the URL, never in ffmpeg argv.
 *  ④ the wire is the OpenAI `/audio/speech` shape and the transcode is the
 *    Lark-required ogg/opus mono 16k.
 */

import { describe, it, expect } from 'vitest'

import {
  VOICE_MAX_CHARS,
  buildButlerVoice,
  butlerVoiceFromEnv,
  prepareSpeechText,
  toOpusVoice,
  type ButlerVoiceConfig,
  type FfmpegRunner,
} from '../src/butler-voice.js'

const MP3 = Buffer.from('mp3-bytes-from-tts')
const OPUS = Buffer.from('OggS-opus-bytes')

function okFetch(calls: Array<{ url: string; init: RequestInit }>): typeof fetch {
  return (async (url: unknown, init?: unknown) => {
    calls.push({ url: String(url), init: (init ?? {}) as RequestInit })
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => MP3.buffer.slice(MP3.byteOffset, MP3.byteOffset + MP3.byteLength),
    }
  }) as unknown as typeof fetch
}

function okRunner(calls: Array<{ args: readonly string[]; input: Buffer }>): FfmpegRunner {
  return async (args, input) => {
    calls.push({ args, input })
    return { code: 0, stdout: OPUS, stderr: '' }
  }
}

function config(over: Partial<ButlerVoiceConfig> = {}): ButlerVoiceConfig {
  return {
    baseUrl: 'https://tts.example.com/v1',
    apiKey: 'sk-secret-voice-key',
    model: 'speech-02-hd',
    voice: 'Chinese (Mandarin)_Gentle_Senior',
    ...over,
  }
}

describe('VOICE-M1 prepareSpeechText — 朗读前清洗', () => {
  it('strips links / bold / inline code / headers / list markers down to prose', () => {
    const raw = '## 今天的安排\n\n- **上午**:去[银行](https://bank.example)办事\n- 下午:跑 `pnpm test` 看结果\n'
    expect(prepareSpeechText(raw)).toBe('今天的安排\n\n上午:去银行办事\n下午:跑 pnpm test 看结果')
  })

  it('refuses fenced code blocks (nothing speakable)', () => {
    expect(prepareSpeechText('看这段:\n```ts\nconst a = 1\n```')).toBeUndefined()
  })

  it('refuses whitespace-only input', () => {
    expect(prepareSpeechText('  \n\n  ')).toBeUndefined()
  })

  it('strips *italic* but leaves snake_case identifiers alone', () => {
    expect(prepareSpeechText('这个 *很重要*:字段叫 user_id 和 org_id')).toBe('这个 很重要:字段叫 user_id 和 org_id')
  })
})

describe('VOICE-M1 butlerVoiceFromEnv — ① opt-in 四缺一不可', () => {
  const FULL = {
    GOTONG_BUTLER_VOICE_URL: 'https://tts.example.com/v1',
    GOTONG_BUTLER_VOICE_KEY: 'sk-k',
    GOTONG_BUTLER_VOICE_MODEL: 'speech-02-hd',
    GOTONG_BUTLER_VOICE_VOICE: 'Chinese (Mandarin)_Gentle_Senior',
  }

  it('all four set → defined, disclosure names model/voice/host + off-box truth', () => {
    const v = butlerVoiceFromEnv({ ...FULL })
    expect(v).toBeDefined()
    expect(v!.dataLeavesBox).toBe(true)
    expect(v!.disclosure).toContain('speech-02-hd')
    expect(v!.disclosure).toContain('Gentle_Senior')
    expect(v!.disclosure).toContain('tts.example.com')
    expect(v!.disclosure).toContain('发往该主机')
    // Credential discipline: the disclosure never carries the key.
    expect(v!.disclosure).not.toContain('sk-k')
  })

  it.each(Object.keys(FULL))('missing %s → undefined (voice leg does not exist)', (k) => {
    const env = { ...FULL } as Record<string, string>
    delete env[k]
    expect(butlerVoiceFromEnv(env)).toBeUndefined()
  })

  it('a loopback URL is honest about staying on-box', () => {
    const v = butlerVoiceFromEnv({ ...FULL, GOTONG_BUTLER_VOICE_URL: 'http://127.0.0.1:8880/v1' })
    expect(v!.dataLeavesBox).toBe(false)
    expect(v!.disclosure).toContain('不离盒')
  })
})

describe('VOICE-M1 synthesize — 全链路(mock fetch + mock ffmpeg)', () => {
  it('happy path: cleaned text → /audio/speech mp3 → ffmpeg ogg/opus clip', async () => {
    const fetches: Array<{ url: string; init: RequestInit }> = []
    const runs: Array<{ args: readonly string[]; input: Buffer }> = []
    const v = buildButlerVoice(config({ fetchImpl: okFetch(fetches), ffmpeg: okRunner(runs) }))

    const r = await v.synthesize('**好的**,我这就去办。')
    expect(r.kind).toBe('clip')
    expect((r as { bytes: Buffer }).bytes.equals(OPUS)).toBe(true)

    // ④ the wire shape: OpenAI /audio/speech with required model + voice.
    expect(fetches).toHaveLength(1)
    expect(fetches[0]!.url).toBe('https://tts.example.com/v1/audio/speech')
    const body = JSON.parse(String(fetches[0]!.init.body)) as Record<string, unknown>
    expect(body).toEqual({
      model: 'speech-02-hd',
      input: '好的,我这就去办。', // markdown-stripped BEFORE it leaves the box
      voice: 'Chinese (Mandarin)_Gentle_Senior',
      response_format: 'mp3',
    })
    const headers = fetches[0]!.init.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer sk-secret-voice-key')
    // ③ key never in the URL.
    expect(fetches[0]!.url).not.toContain('sk-secret')

    // ④ the transcode shape: libopus mono 16k ogg, fed the mp3 on stdin.
    expect(runs).toHaveLength(1)
    expect(runs[0]!.input.equals(MP3)).toBe(true)
    const argv = runs[0]!.args.join(' ')
    expect(argv).toContain('libopus')
    expect(argv).toContain('-ac 1')
    expect(argv).toContain('-ar 16000')
    expect(argv).toContain('-f ogg')
    // ③ key never in argv.
    expect(argv).not.toContain('sk-secret')
  })

  it('a trailing-slash base URL still hits exactly /audio/speech', async () => {
    const fetches: Array<{ url: string; init: RequestInit }> = []
    const v = buildButlerVoice(config({ baseUrl: 'https://tts.example.com/v1///', fetchImpl: okFetch(fetches), ffmpeg: okRunner([]) }))
    await v.synthesize('短消息')
    expect(fetches[0]!.url).toBe('https://tts.example.com/v1/audio/speech')
  })

  it('② over the length threshold → skipped, ZERO TTS calls (nothing leaves the box)', async () => {
    const fetches: Array<{ url: string; init: RequestInit }> = []
    const v = buildButlerVoice(config({ fetchImpl: okFetch(fetches) }))
    const r = await v.synthesize('长'.repeat(VOICE_MAX_CHARS + 1))
    expect(r.kind).toBe('skipped')
    expect((r as { reason: string }).reason).toContain('阈值')
    expect(fetches).toHaveLength(0)
  })

  it('② a code-fence reply → skipped, zero TTS calls', async () => {
    const fetches: Array<{ url: string; init: RequestInit }> = []
    const v = buildButlerVoice(config({ fetchImpl: okFetch(fetches) }))
    const r = await v.synthesize('改成这样:\n```js\nx()\n```')
    expect(r.kind).toBe('skipped')
    expect(fetches).toHaveLength(0)
  })

  it('② HTTP 500 → failed with the status, ffmpeg never invoked', async () => {
    const runs: Array<{ args: readonly string[]; input: Buffer }> = []
    const failFetch = (async () => ({ ok: false, status: 500, arrayBuffer: async () => new ArrayBuffer(0) })) as unknown as typeof fetch
    const v = buildButlerVoice(config({ fetchImpl: failFetch, ffmpeg: okRunner(runs) }))
    const r = await v.synthesize('短消息')
    expect(r.kind).toBe('failed')
    expect((r as { reason: string }).reason).toContain('500')
    expect(runs).toHaveLength(0)
  })

  it('② a hung TTS endpoint times out into failed (never hangs the reply)', async () => {
    const hangingFetch = ((_u: unknown, init?: { signal?: AbortSignal }) =>
      new Promise((_res, rej) => {
        init?.signal?.addEventListener('abort', () => rej(new Error('This operation was aborted')))
      })) as unknown as typeof fetch
    const v = buildButlerVoice(config({ fetchImpl: hangingFetch, timeoutMs: 10 }))
    const r = await v.synthesize('短消息')
    expect(r.kind).toBe('failed')
    expect((r as { reason: string }).reason).toContain('超时')
  })

  it('② missing ffmpeg (ENOENT) → failed with the honest install hint', async () => {
    const enoent: FfmpegRunner = async () => {
      const e = new Error('spawn ffmpeg ENOENT') as NodeJS.ErrnoException
      e.code = 'ENOENT'
      throw e
    }
    const v = buildButlerVoice(config({ fetchImpl: okFetch([]), ffmpeg: enoent }))
    const r = await v.synthesize('短消息')
    expect(r.kind).toBe('failed')
    expect((r as { reason: string }).reason).toContain('未装 ffmpeg')
  })

  it('② a non-zero ffmpeg exit → failed with the stderr excerpt', async () => {
    const bad: FfmpegRunner = async () => ({ code: 1, stdout: Buffer.alloc(0), stderr: 'pipe:0: Invalid data' })
    const v = buildButlerVoice(config({ fetchImpl: okFetch([]), ffmpeg: bad }))
    const r = await v.synthesize('短消息')
    expect(r.kind).toBe('failed')
    expect((r as { reason: string }).reason).toContain('转码失败')
  })

  it('② synthesize never throws, even when fetch itself explodes', async () => {
    const explode = (() => {
      throw new Error('sync boom')
    }) as unknown as typeof fetch
    const v = buildButlerVoice(config({ fetchImpl: explode }))
    const r = await v.synthesize('短消息')
    expect(r.kind).toBe('failed')
  })
})

describe('VOICE-M1 toOpusVoice — 转码合同', () => {
  it('empty ffmpeg output is a loud error, not a silent empty clip', async () => {
    const empty: FfmpegRunner = async () => ({ code: 0, stdout: Buffer.alloc(0), stderr: '' })
    await expect(toOpusVoice(MP3, empty)).rejects.toThrow(/no audio bytes/)
  })
})

/**
 * VOICE-M3b — the Xiaomi MiMo chat-wire variant. Same four knobs; the model
 * name (`mimo-*tts*`) selects the wire. What must hold:
 *  - the wire is POST <base>/chat/completions with the SPEAK text in an
 *    ASSISTANT message and `audio: {format, voice}` — never /audio/speech;
 *  - audio comes back base64 in choices[0].message.audio.data and feeds the
 *    SAME ffmpeg leg (wav sniffed on stdin);
 *  - all M1 contracts carry over: key only in the Authorization header,
 *    fail-soft, content gates fire BEFORE any network call;
 *  - the `-voiceclone` model family is refused at construction (红线: 民法典
 *    1023 声音权 — vendor system voices only).
 */
describe('VOICE-M3b synthesize — 小米 MiMo chat wire', () => {
  const WAV = Buffer.from('RIFF-wav-bytes-from-mimo')

  function mimoConfig(over: Partial<ButlerVoiceConfig> = {}): ButlerVoiceConfig {
    return config({
      baseUrl: 'https://api.xiaomimimo.com/v1',
      model: 'mimo-v2.5-tts',
      voice: '茉莉',
      ...over,
    })
  }

  function mimoOkFetch(calls: Array<{ url: string; init: RequestInit }>): typeof fetch {
    return (async (url: unknown, init?: unknown) => {
      calls.push({ url: String(url), init: (init ?? {}) as RequestInit })
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { audio: { data: WAV.toString('base64') } } }],
        }),
      }
    }) as unknown as typeof fetch
  }

  it('happy path: chat/completions wire, text in the ASSISTANT message, base64 wav → opus clip', async () => {
    const fetches: Array<{ url: string; init: RequestInit }> = []
    const runs: Array<{ args: readonly string[]; input: Buffer }> = []
    const v = buildButlerVoice(mimoConfig({ fetchImpl: mimoOkFetch(fetches), ffmpeg: okRunner(runs) }))

    const r = await v.synthesize('**好的**,我这就去办。')
    expect(r.kind).toBe('clip')
    expect((r as { bytes: Buffer }).bytes.equals(OPUS)).toBe(true)

    // The wire: chat/completions, NOT /audio/speech.
    expect(fetches).toHaveLength(1)
    expect(fetches[0]!.url).toBe('https://api.xiaomimimo.com/v1/chat/completions')
    const body = JSON.parse(String(fetches[0]!.init.body)) as Record<string, unknown>
    expect(body).toEqual({
      model: 'mimo-v2.5-tts',
      // user = optional style slot (empty ⇒ the system voice's own persona);
      // the text to SPEAK rides in the assistant message, markdown-stripped.
      messages: [
        { role: 'user', content: '' },
        { role: 'assistant', content: '好的,我这就去办。' },
      ],
      audio: { format: 'wav', voice: '茉莉' },
    })
    const headers = fetches[0]!.init.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer sk-secret-voice-key')
    expect(fetches[0]!.url).not.toContain('sk-secret')

    // The DECODED wav (not the base64 string) feeds the same ffmpeg leg.
    expect(runs).toHaveLength(1)
    expect(runs[0]!.input.equals(WAV)).toBe(true)
  })

  it('missing / empty audio.data in the response → failed, ffmpeg never invoked', async () => {
    for (const payload of [
      {},
      { choices: [] },
      { choices: [{ message: {} }] },
      { choices: [{ message: { audio: { data: '' } } }] },
    ]) {
      const runs: Array<{ args: readonly string[]; input: Buffer }> = []
      const noAudio = (async () => ({ ok: true, status: 200, json: async () => payload })) as unknown as typeof fetch
      const v = buildButlerVoice(mimoConfig({ fetchImpl: noAudio, ffmpeg: okRunner(runs) }))
      const r = await v.synthesize('短消息')
      expect(r.kind).toBe('failed')
      expect((r as { reason: string }).reason).toContain('no audio data')
      expect(runs).toHaveLength(0)
    }
  })

  it('content gates fire before the wire: code-fence / over-length reply → zero mimo calls', async () => {
    const fetches: Array<{ url: string; init: RequestInit }> = []
    const v = buildButlerVoice(mimoConfig({ fetchImpl: mimoOkFetch(fetches) }))
    expect((await v.synthesize('```js\nx()\n```')).kind).toBe('skipped')
    expect((await v.synthesize('长'.repeat(VOICE_MAX_CHARS + 1))).kind).toBe('skipped')
    expect(fetches).toHaveLength(0)
  })

  it('HTTP 500 on the mimo wire → failed with the status (fail-soft carries over)', async () => {
    const failFetch = (async () => ({ ok: false, status: 500, json: async () => ({}) })) as unknown as typeof fetch
    const v = buildButlerVoice(mimoConfig({ fetchImpl: failFetch }))
    const r = await v.synthesize('短消息')
    expect(r.kind).toBe('failed')
    expect((r as { reason: string }).reason).toContain('500')
  })

  it('非 mimo 模型名照走 /audio/speech 老 wire(探测只认 mimo-*tts* 形状)', async () => {
    const fetches: Array<{ url: string; init: RequestInit }> = []
    const v = buildButlerVoice(config({ fetchImpl: okFetch(fetches), ffmpeg: okRunner([]) }))
    await v.synthesize('短消息')
    expect(fetches[0]!.url).toBe('https://tts.example.com/v1/audio/speech')
  })

  it('红线: voiceclone 模型在构造时当场拒(真人克隆音色永不接)', () => {
    expect(() => buildButlerVoice(mimoConfig({ model: 'mimo-v2.5-tts-voiceclone' }))).toThrow(/声音克隆|1023/)
    expect(
      butlerVoiceFromEnv.bind(undefined, {
        GOTONG_BUTLER_VOICE_URL: 'https://api.xiaomimimo.com/v1',
        GOTONG_BUTLER_VOICE_KEY: 'sk-k',
        GOTONG_BUTLER_VOICE_MODEL: 'mimo-v2.5-tts-voiceclone',
        GOTONG_BUTLER_VOICE_VOICE: '茉莉',
      }),
    ).toThrow(/声音克隆|1023/)
  })
})
