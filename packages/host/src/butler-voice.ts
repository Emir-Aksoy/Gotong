/**
 * butler-voice.ts — VOICE-M1: the opt-in TTS core that turns a butler reply
 * into an opus voice clip for IM delivery (docs/zh/ATONG-VOICE.md).
 *
 * Chain (all pure, injectable, zero framework LLM):
 *
 *   reply text → prepareSpeechText (strip markdown; refuse unspeakable)
 *              → length gate (VOICE_MAX_CHARS — voice bubbles are for SHORT replies)
 *              → POST <base>/audio/speech  (OpenAI-compatible TTS wire, mp3 out)
 *                OR — VOICE-M3b, detected from the model name — Xiaomi MiMo's
 *                chat-wire TTS: POST <base>/chat/completions, audio back as
 *                base64 wav inside choices[0].message.audio.data
 *              → ffmpeg -i pipe:0 -acodec libopus -ac 1 -ar 16000 -f ogg pipe:1
 *                (ffmpeg sniffs mp3 vs wav on stdin — one transcode leg serves both)
 *              → ogg/opus bytes (Lark's upload accepts ONLY file_type=opus)
 *
 * Boundaries held here (the track's, see the doc):
 *  - opt-in, unset = byte-identical: `butlerVoiceFromEnv` needs ALL FOUR of
 *    GOTONG_BUTLER_VOICE_URL/_KEY/_MODEL/_VOICE or returns undefined — model and
 *    voice are REQUIRED params on the wire, and a silently guessed default would
 *    just move the failure to runtime.
 *  - fail-soft, voice never eats a reply: `synthesize` NEVER throws. It returns
 *    `skipped` (content unsuitable by design) or `failed` (infra: HTTP / timeout
 *    / ffmpeg) and the caller sends plain text either way.
 *  - data-leaves-box disclosure: enabling voice sends EVERY reply's text to the
 *    TTS host; the disclosure string names it (M-EMB1 posture).
 *  - legal voices only: the voice id is vendor SYSTEM-voice config. This module
 *    (and this track) never touches real-person voice cloning.
 *  - duration is NOT computed here: it is a property of the ogg bytes (granule
 *    position), so the Lark leg derives it from the container instead of this
 *    module parsing fragile ffmpeg stderr progress lines.
 */

import { spawn } from 'node:child_process'

import { isLocalEmbedderUrl } from './butler-embedder.js'

/**
 * Replies longer than this (AFTER markdown stripping) skip TTS and go out as
 * text. ~240 CJK chars ≈ a minute of speech — the ceiling of what a voice
 * bubble is pleasant for. A constant, not a knob (track boundary ⑤).
 */
export const VOICE_MAX_CHARS = 240

/** TTS request timeout — speech synthesis is slower than embeddings. */
const DEFAULT_TTS_TIMEOUT_MS = 30_000

/** ffmpeg wall-clock cap so a wedged transcode can never hold a reply hostage. */
const FFMPEG_TIMEOUT_MS = 20_000

/** Output cap (Lark's upload limit is 30MB; a voice clip should be ~100KB). */
const MAX_AUDIO_BYTES = 30 * 1024 * 1024

/**
 * Strip markdown down to speakable prose. Returns undefined when the text has
 * no speakable rendering — a fenced code block does not read aloud, and an
 * empty result means there is nothing to say.
 */
export function prepareSpeechText(raw: string): string | undefined {
  if (raw.includes('```')) return undefined
  let t = raw
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, '') // images: nothing to speak
  t = t.replace(/\[([^\]]+)\]\(([^)]*)\)/g, '$1') // links: speak the label
  t = t.replace(/`([^`\n]*)`/g, '$1') // inline code: bare text
  t = t.replace(/(\*\*|__)([^\n]*?)\1/g, '$2') // bold
  // Italic: asterisks only — underscores live inside identifiers (user_id) far
  // too often for a symmetric strip to be safe.
  t = t.replace(/\*([^*\n]+)\*/g, '$1')
  t = t.replace(/^#{1,6}\s+/gm, '')
  t = t.replace(/^>\s?/gm, '')
  t = t.replace(/^[ \t]*([-*+]|\d+\.)[ \t]+/gm, '')
  t = t.replace(/^[ \t]*([-*_])[ \t]*(\1[ \t]*){2,}$/gm, '') // horizontal rules
  t = t.replace(/[ \t]+/g, ' ')
  t = t.replace(/\n{3,}/g, '\n\n').trim()
  return t.length > 0 ? t : undefined
}

/** Result of one ffmpeg invocation — exit code + captured streams. */
export interface FfmpegResult {
  code: number
  stdout: Buffer
  stderr: string
}

/**
 * Run `ffmpeg <args>` feeding `input` on stdin. Injectable so tests transcode
 * without a real binary. Non-zero exit is a RESULT; only a spawn failure
 * (ffmpeg missing → ENOENT) rejects — mirroring butler-memory-git's GitRunner.
 */
export type FfmpegRunner = (args: readonly string[], input: Buffer) => Promise<FfmpegResult>

/** Default runner: the real `ffmpeg` via child_process, stdin→stdout piping. */
export const spawnFfmpegRunner: FfmpegRunner = (args, input) =>
  new Promise<FfmpegResult>((resolve, reject) => {
    const child = spawn('ffmpeg', args as string[], { stdio: ['pipe', 'pipe', 'pipe'] })
    const out: Buffer[] = []
    const err: Buffer[] = []
    let outBytes = 0
    let settled = false
    const timer = setTimeout(() => {
      settled = true
      child.kill('SIGKILL')
      reject(new Error(`ffmpeg timed out after ${FFMPEG_TIMEOUT_MS}ms`))
    }, FFMPEG_TIMEOUT_MS)
    child.on('error', (e) => {
      // ENOENT (no ffmpeg installed) lands here — the caller turns it into an
      // honest "未装 ffmpeg" failure, never a crash.
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(e)
    })
    child.stdout.on('data', (c: Buffer) => {
      outBytes += c.length
      if (outBytes > MAX_AUDIO_BYTES) {
        settled = true
        clearTimeout(timer)
        child.kill('SIGKILL')
        reject(new Error('ffmpeg output exceeded the 30MB audio cap'))
        return
      }
      out.push(c)
    })
    child.stderr.on('data', (c: Buffer) => {
      err.push(c)
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString('utf8') })
    })
    child.stdin.on('error', () => {
      /* EPIPE when ffmpeg exits early — the close handler reports the real story */
    })
    child.stdin.end(input)
  })

/**
 * Transcode TTS output (mp3) to the ogg/opus shape Lark's voice upload demands
 * (community-established: libopus, mono, 16 kHz). Throws on any failure — the
 * synthesize wrapper maps ENOENT to the honest "未装 ffmpeg" line.
 */
export async function toOpusVoice(input: Buffer, runner: FfmpegRunner = spawnFfmpegRunner): Promise<Buffer> {
  const args = [
    '-hide_banner',
    '-loglevel', 'error',
    '-i', 'pipe:0',
    '-acodec', 'libopus',
    '-ac', '1',
    '-ar', '16000',
    '-f', 'ogg',
    'pipe:1',
  ] as const
  const res = await runner(args, input)
  if (res.code !== 0) {
    throw new Error(`ffmpeg exited ${res.code}: ${res.stderr.slice(0, 200)}`)
  }
  if (res.stdout.length === 0) throw new Error('ffmpeg produced no audio bytes')
  return res.stdout
}

/**
 * VOICE-M3b — Xiaomi MiMo's TTS speaks an OpenAI CHAT wire, not `/audio/speech`:
 * the text to speak rides in an ASSISTANT message and the audio comes back as
 * base64 inside the JSON response. Detected from the model name (`mimo-*tts*`)
 * so the SAME four knobs cover both vendors — URL+MODEL decide the wire, no
 * fifth knob. (Wire shape cross-verified from official client sources 2026-07-17.)
 */
export function isMimoTtsWire(model: string): boolean {
  return /^mimo-/i.test(model) && /tts/i.test(model)
}

export interface ButlerVoiceConfig {
  /** OpenAI-compatible base, e.g. `https://api.minimax.io/v1` or `https://api.xiaomimimo.com/v1`. */
  baseUrl: string
  /** Bearer key (TTS vendors require one; '' sends no auth header for local servers). */
  apiKey: string
  /** TTS model id, e.g. `speech-02-hd`. Required on the wire — no default. */
  model: string
  /** Vendor SYSTEM voice id (e.g. `Chinese (Mandarin)_Gentle_Senior`). Required. */
  voice: string
  /** TTS request timeout (ms). Default 30_000. */
  timeoutMs?: number
  /** Injectable for tests (defaults to global `fetch`). */
  fetchImpl?: typeof fetch
  /** Injectable transcoder (tests run without a real ffmpeg). */
  ffmpeg?: FfmpegRunner
}

/**
 * One TTS call → raw audio bytes (mp3 on the `/audio/speech` wire, wav on the
 * MiMo chat wire — ffmpeg sniffs either on stdin). Throws on HTTP / timeout /
 * empty body; the key travels ONLY in the Authorization header (never URL,
 * never argv).
 */
export async function ttsSpeech(config: ButlerVoiceConfig, text: string): Promise<Buffer> {
  const base = config.baseUrl.replace(/\/+$/, '')
  const mimo = isMimoTtsWire(config.model)
  const url = mimo ? `${base}/chat/completions` : `${base}/audio/speech`
  // MiMo wire: the USER message carries an optional style instruction (empty =
  // the system voice's own default persona — persona is the voice id's job, not
  // a knob); the text to SPEAK rides in the ASSISTANT message.
  const body = mimo
    ? {
        model: config.model,
        messages: [
          { role: 'user', content: '' },
          { role: 'assistant', content: text },
        ],
        audio: { format: 'wav', voice: config.voice },
      }
    : {
        model: config.model,
        input: text,
        voice: config.voice,
        response_format: 'mp3',
      }
  const doFetch = config.fetchImpl ?? fetch
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), config.timeoutMs ?? DEFAULT_TTS_TIMEOUT_MS)
  try {
    const res = await doFetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: ac.signal,
    })
    if (!res.ok) throw new Error(`TTS HTTP ${res.status}`)
    let bytes: Buffer
    if (mimo) {
      const json = (await res.json()) as {
        choices?: Array<{ message?: { audio?: { data?: unknown } } }>
      }
      const b64 = json?.choices?.[0]?.message?.audio?.data
      if (typeof b64 !== 'string' || b64.length === 0) {
        throw new Error('TTS returned no audio data (mimo wire)')
      }
      bytes = Buffer.from(b64, 'base64')
    } else {
      bytes = Buffer.from(await res.arrayBuffer())
    }
    if (bytes.length === 0) throw new Error('TTS returned no audio bytes')
    if (bytes.length > MAX_AUDIO_BYTES) throw new Error('TTS audio exceeded the 30MB cap')
    return bytes
  } finally {
    clearTimeout(timer)
  }
}

/**
 * What one synthesis attempt produced.
 *  - `clip`: ogg/opus bytes ready for the IM attachment leg.
 *  - `skipped`: the CONTENT is unsuitable by design (code / too long / empty) —
 *    expected and quiet.
 *  - `failed`: an INFRA problem (HTTP / timeout / ffmpeg) — worth a warn.
 * Either non-clip kind means: send the reply as plain text, unchanged.
 */
export type VoiceSynthesis =
  | { kind: 'clip'; bytes: Buffer }
  | { kind: 'skipped'; reason: string }
  | { kind: 'failed'; reason: string }

export interface ButlerVoice {
  /** Full text→opus chain. NEVER throws (fail-soft is the contract). */
  synthesize(text: string): Promise<VoiceSynthesis>
  /** Boot disclosure — names the TTS host + that reply text is sent to it. */
  disclosure: string
  /** True when reply text leaves the box (any non-loopback TTS endpoint). */
  dataLeavesBox: boolean
}

/** Build a {@link ButlerVoice} from explicit config (tests / direct callers). */
export function buildButlerVoice(config: ButlerVoiceConfig): ButlerVoice {
  // 红线(track 边界·民法典 1023 声音权): 真人克隆音色永不接。MiMo 的
  // `-voiceclone` 模型族是「用参考音频克隆一个声音」的入口 — 配置层结构性
  // 拒绝(签名钥「坏钥当场拒」同姿态),装配路径永远配不出克隆腿。
  if (/voiceclone/i.test(config.model)) {
    throw new Error(
      `TTS 模型 '${config.model}' 是声音克隆模型 — 语音腿只接厂商官方系统音色(民法典 1023 声音权),请改用预置音色模型(如 mimo-v2.5-tts)`,
    )
  }
  const local = isLocalEmbedderUrl(config.baseUrl)
  let host = config.baseUrl
  try {
    host = new URL(config.baseUrl).host
  } catch {
    /* keep the raw string for the disclosure */
  }
  const disclosure = local
    ? `阿同语音回复: ${config.model}/${config.voice} @ ${host}（本地 TTS — 回复文本不离盒）`
    : `阿同语音回复: ${config.model}/${config.voice} @ ${host}（远程 TTS — 回复文本会逐条发往该主机合成语音）`
  return {
    disclosure,
    dataLeavesBox: !local,
    async synthesize(text: string): Promise<VoiceSynthesis> {
      const speakable = prepareSpeechText(text)
      if (!speakable) return { kind: 'skipped', reason: '内容不适合朗读(代码块或清洗后为空)' }
      if (speakable.length > VOICE_MAX_CHARS) {
        return { kind: 'skipped', reason: `超过语音条长度阈值(${speakable.length} > ${VOICE_MAX_CHARS} 字)` }
      }
      let mp3: Buffer
      try {
        mp3 = await ttsSpeech(config, speakable)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        const reason = /abort/i.test(msg) ? `TTS 超时(${config.timeoutMs ?? DEFAULT_TTS_TIMEOUT_MS}ms)` : `TTS 失败: ${msg}`
        return { kind: 'failed', reason }
      }
      try {
        const bytes = await toOpusVoice(mp3, config.ffmpeg)
        return { kind: 'clip', bytes }
      } catch (err) {
        const e = err as NodeJS.ErrnoException
        if (e?.code === 'ENOENT') {
          return { kind: 'failed', reason: '未装 ffmpeg — 语音需要它转码 opus,已退回文本' }
        }
        return { kind: 'failed', reason: `转码失败: ${e instanceof Error ? e.message : String(err)}` }
      }
    },
  }
}

/**
 * Construct the opt-in butler voice from env. ALL FOUR of
 * `GOTONG_BUTLER_VOICE_URL` / `_KEY` / `_MODEL` / `_VOICE` must be set, or this
 * returns undefined and the whole voice leg does not exist (byte-identical
 * behavior). Pure — no logging; the caller surfaces the disclosure.
 */
export function butlerVoiceFromEnv(env: NodeJS.ProcessEnv = process.env): ButlerVoice | undefined {
  const baseUrl = (env.GOTONG_BUTLER_VOICE_URL ?? '').trim()
  const apiKey = (env.GOTONG_BUTLER_VOICE_KEY ?? '').trim()
  const model = (env.GOTONG_BUTLER_VOICE_MODEL ?? '').trim()
  const voice = (env.GOTONG_BUTLER_VOICE_VOICE ?? '').trim()
  if (!baseUrl || !apiKey || !model || !voice) return undefined
  return buildButlerVoice({ baseUrl, apiKey, model, voice })
}
