/**
 * butler-hearing.ts — ASR-M1: the opt-in speech-to-text core that turns a
 * member's IM voice note into text for the butler (docs/zh/ATONG-VOICE.md).
 *
 * Chain (pure, injectable, zero framework LLM — ASR is transcription-as-a-
 * service, the butler's own model never hears audio):
 *
 *   voice bytes (Lark notes are ogg/opus) → ffmpeg → wav 16k mono pcm_s16le
 *   → POST <base>/audio/transcriptions  (OpenAI-compatible multipart wire)
 *     OR — detected from the model name (`mimo-*asr*`), mirroring the TTS
 *     M3b posture — Xiaomi MiMo's chat wire: the audio rides base64 in a
 *     USER message's `input_audio` block and the transcript comes back as
 *     `choices[0].message.content`.
 *   → transcript text
 *
 * Wire facts probed against the live API (2026-07-18, token-plan-cn host):
 *   - `/audio/transcriptions` → 404 (MiMo does not serve the standard wire);
 *   - chat `input_audio` → 200, transcript echoed verbatim;
 *   - `input_audio.format must be one of: wav, mp3` (server's own words) —
 *     ogg/opus is REFUSED, hence the ffmpeg leg is load-bearing, not optional.
 *
 * Boundaries (same track, same rules as butler-voice):
 *  - opt-in, unset = byte-identical: `butlerHearingFromEnv` needs the shared
 *    GOTONG_BUTLER_VOICE_URL/_KEY plus GOTONG_BUTLER_ASR_MODEL, else undefined.
 *  - fail-soft: `transcribe` NEVER throws — `skipped` (unsuitable by design) /
 *    `failed` (infra) both mean the message flows on un-transcribed.
 *  - data-leaves-box disclosure: enabling hearing sends every voice note's
 *    audio to the ASR host; the disclosure string names it.
 *  - key travels ONLY in the Authorization header — never URL, never argv.
 */

import type { FfmpegRunner } from './butler-voice.js'
import { spawnFfmpegRunner } from './butler-voice.js'
import { isLocalEmbedderUrl } from './butler-embedder.js'

/** ASR request timeout — transcription is roughly TTS-speed. */
const DEFAULT_ASR_TIMEOUT_MS = 30_000

/**
 * Input cap for one voice note. An IM voice note is ≤60s ≈ ~100KB of opus;
 * 8MB is already far beyond anything a chat bubble produces, and the base64
 * JSON body stays bounded. A constant, not a knob.
 */
export const MAX_VOICE_INPUT_BYTES = 8 * 1024 * 1024

/**
 * MiMo's ASR speaks the chat wire (probe: the standard transcription route
 * 404s). Detected from the model name so the same knobs cover a standard
 * OpenAI-compatible `/audio/transcriptions` endpoint too — URL+MODEL decide
 * the wire, no extra knob (VOICE-M3b posture).
 */
export function isMimoAsrWire(model: string): boolean {
  return /^mimo-/i.test(model) && /asr/i.test(model)
}

/**
 * Transcode an IM voice note (ogg/opus or anything ffmpeg sniffs) to the wav
 * shape MiMo's ASR accepts. RIFF input passes through untouched — already wav.
 * Throws on failure; the transcribe wrapper maps ENOENT to "未装 ffmpeg".
 */
export async function toWavSpeech(input: Buffer, runner: FfmpegRunner = spawnFfmpegRunner): Promise<Buffer> {
  if (input.subarray(0, 4).toString('latin1') === 'RIFF') return input
  const args = [
    '-hide_banner',
    '-loglevel', 'error',
    '-i', 'pipe:0',
    '-ac', '1',
    '-ar', '16000',
    '-acodec', 'pcm_s16le',
    '-f', 'wav',
    'pipe:1',
  ] as const
  const res = await runner(args, input)
  if (res.code !== 0) {
    throw new Error(`ffmpeg exited ${res.code}: ${res.stderr.slice(0, 200)}`)
  }
  if (res.stdout.length === 0) throw new Error('ffmpeg produced no audio bytes')
  return res.stdout
}

export interface ButlerHearingConfig {
  /** OpenAI-compatible base, e.g. `https://token-plan-cn.xiaomimimo.com/v1`. */
  baseUrl: string
  /** Bearer key ('' sends no auth header for local servers). */
  apiKey: string
  /** ASR model id, e.g. `mimo-v2.5-asr`. Required on the wire — no default. */
  model: string
  /** ASR request timeout (ms). Default 30_000. */
  timeoutMs?: number
  /** Injectable for tests (defaults to global `fetch`). */
  fetchImpl?: typeof fetch
  /** Injectable transcoder (tests run without a real ffmpeg). */
  ffmpeg?: FfmpegRunner
}

/** Pull the transcript out of a chat-wire response's message content. */
function contentToText(content: unknown): string | undefined {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts = content
      .map((b) => (b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : ''))
      .filter((t) => t.length > 0)
    if (parts.length > 0) return parts.join('')
  }
  return undefined
}

/**
 * One ASR call: wav bytes in → transcript out. Throws on HTTP / timeout /
 * unreadable response; the key travels ONLY in the Authorization header.
 */
export async function asrTranscribe(config: ButlerHearingConfig, wav: Buffer): Promise<string> {
  const base = config.baseUrl.replace(/\/+$/, '')
  const mimo = isMimoAsrWire(config.model)
  const doFetch = config.fetchImpl ?? fetch
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), config.timeoutMs ?? DEFAULT_ASR_TIMEOUT_MS)
  try {
    let res: Response
    if (mimo) {
      res = await doFetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: config.model,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'input_audio', input_audio: { data: wav.toString('base64'), format: 'wav' } },
              ],
            },
          ],
        }),
        signal: ac.signal,
      })
    } else {
      const form = new FormData()
      form.set('model', config.model)
      form.set('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'voice.wav')
      res = await doFetch(`${base}/audio/transcriptions`, {
        method: 'POST',
        headers: config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {},
        body: form,
        signal: ac.signal,
      })
    }
    if (!res.ok) throw new Error(`ASR HTTP ${res.status}`)
    if (mimo) {
      const json = (await res.json()) as { choices?: Array<{ message?: { content?: unknown } }> }
      const text = contentToText(json?.choices?.[0]?.message?.content)
      if (text === undefined) throw new Error('ASR returned no transcript (mimo wire)')
      return text
    }
    const json = (await res.json()) as { text?: unknown }
    if (typeof json?.text !== 'string') throw new Error('ASR returned no transcript')
    return json.text
  } finally {
    clearTimeout(timer)
  }
}

/**
 * What one transcription attempt produced.
 *  - `text`: the transcript — feed it into the normal message pipeline.
 *  - `skipped`: the INPUT is unsuitable by design (empty / oversized / silent) —
 *    expected and quiet.
 *  - `failed`: an INFRA problem (ffmpeg / HTTP / timeout) — worth a warn.
 * Either non-text kind means: the message flows on without a transcript.
 */
export type HearingResult =
  | { kind: 'text'; text: string }
  | { kind: 'skipped'; reason: string }
  | { kind: 'failed'; reason: string }

export interface ButlerHearing {
  /** Full bytes→transcript chain. NEVER throws (fail-soft is the contract). */
  transcribe(bytes: Buffer): Promise<HearingResult>
  /** Boot disclosure — names the ASR host + that voice audio is sent to it. */
  disclosure: string
  /** True when voice audio leaves the box (any non-loopback ASR endpoint). */
  dataLeavesBox: boolean
}

/** Build a {@link ButlerHearing} from explicit config (tests / direct callers). */
export function buildButlerHearing(config: ButlerHearingConfig): ButlerHearing {
  const local = isLocalEmbedderUrl(config.baseUrl)
  let host = config.baseUrl
  try {
    host = new URL(config.baseUrl).host
  } catch {
    /* keep the raw string for the disclosure */
  }
  const disclosure = local
    ? `阿同语音收听: ${config.model} @ ${host}（本地 ASR — 语音不离盒）`
    : `阿同语音收听: ${config.model} @ ${host}（远程 ASR — 成员语音会逐条发往该主机转写）`
  return {
    disclosure,
    dataLeavesBox: !local,
    async transcribe(bytes: Buffer): Promise<HearingResult> {
      if (bytes.length === 0) return { kind: 'skipped', reason: '空音频' }
      if (bytes.length > MAX_VOICE_INPUT_BYTES) {
        return { kind: 'skipped', reason: `语音超过 ${MAX_VOICE_INPUT_BYTES / 1024 / 1024}MB 上限` }
      }
      let wav: Buffer
      try {
        wav = await toWavSpeech(bytes, config.ffmpeg)
      } catch (err) {
        const e = err as NodeJS.ErrnoException
        if (e?.code === 'ENOENT') {
          return { kind: 'failed', reason: '未装 ffmpeg — 语音转写需要它转码 wav' }
        }
        return { kind: 'failed', reason: `转码失败: ${e instanceof Error ? e.message : String(err)}` }
      }
      let text: string
      try {
        text = await asrTranscribe(config, wav)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        const reason = /abort/i.test(msg)
          ? `ASR 超时(${config.timeoutMs ?? DEFAULT_ASR_TIMEOUT_MS}ms)`
          : `ASR 失败: ${msg}`
        return { kind: 'failed', reason }
      }
      const trimmed = text.trim()
      if (trimmed.length === 0) return { kind: 'skipped', reason: '转写结果为空(可能是静音)' }
      return { kind: 'text', text: trimmed }
    },
  }
}

/**
 * Construct the opt-in butler hearing from env. Reuses the voice leg's shared
 * credentials (`GOTONG_BUTLER_VOICE_URL` / `_KEY` — same host, same key in
 * production) plus `GOTONG_BUTLER_ASR_MODEL` to gate the ASR leg on its own:
 * TTS without ASR = leave ASR_MODEL unset; ASR without TTS = set URL/KEY/
 * ASR_MODEL and leave VOICE_MODEL/_VOICE unset. All three or undefined
 * (byte-identical). Pure — no logging; the caller surfaces the disclosure.
 */
export function butlerHearingFromEnv(env: NodeJS.ProcessEnv = process.env): ButlerHearing | undefined {
  const baseUrl = (env.GOTONG_BUTLER_VOICE_URL ?? '').trim()
  const apiKey = (env.GOTONG_BUTLER_VOICE_KEY ?? '').trim()
  const model = (env.GOTONG_BUTLER_ASR_MODEL ?? '').trim()
  if (!baseUrl || !apiKey || !model) return undefined
  return buildButlerHearing({ baseUrl, apiKey, model })
}
