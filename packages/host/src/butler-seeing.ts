/**
 * butler-seeing.ts — VIS-M1: the opt-in image-to-text core that lets the
 * butler "see" a member's IM photo/screenshot (mirror of butler-hearing.ts,
 * same track rules — docs/zh/ATONG-VOICE.md family).
 *
 * Chain (pure, injectable — seeing is description-as-a-service, the butler's
 * own model never receives image bytes):
 *
 *   image bytes (Lark photos are jpeg, stickers webp)
 *   → POST <base>/chat/completions with the STANDARD OpenAI-compatible
 *     vision shape: a USER message carrying `image_url` as a base64 data URI
 *     plus a fixed Chinese instruction (describe + transcribe visible text)
 *   → description text, fed into the normal text pipeline.
 *
 * Why "看图=转写" instead of passing the image straight to the main brain:
 * production's LongCat is a text model, and swapping the whole candidate
 * chain to a VL model just to read receipts is the tail wagging the dog. A
 * designated vision model folds the image into TEXT once, then every
 * downstream stage (session window, episodic capture, governed tools) works
 * unchanged — exactly how ASR folds voice into text. Unlike ASR there is no
 * MiMo-special wire here: `image_url` IS the standard, one wire fits
 * MiMo-VL / Qwen-VL / GPT-4o alike, so no model-name sniffing.
 *
 * Boundaries (same as butler-voice / butler-hearing):
 *  - opt-in, unset = byte-identical: `butlerSeeingFromEnv` needs the shared
 *    GOTONG_BUTLER_VOICE_URL/_KEY plus GOTONG_BUTLER_VISION_MODEL, else
 *    undefined.
 *  - fail-soft: `describe` NEVER throws — `skipped` (unsuitable by design) /
 *    `failed` (infra) both mean the message flows on undescribed.
 *  - data-leaves-box disclosure: enabling seeing sends every inbound photo
 *    to the vision host; the disclosure string names it.
 *  - key travels ONLY in the Authorization header — never URL, never body.
 *  - 看≠授权: a described image is just text input; governed actions the
 *    member asks for on the back of it still park.
 */

import { isLocalEmbedderUrl } from './butler-embedder.js'

/** Vision request timeout — one image, one bounded description. */
const DEFAULT_VISION_TIMEOUT_MS = 30_000

/**
 * Input cap for one image. A phone photo is 2–5MB; 10MB covers originals
 * while keeping the base64 JSON body (~4/3×) bounded. A constant, not a knob.
 */
export const MAX_IMAGE_INPUT_BYTES = 10 * 1024 * 1024

/**
 * Bound the description length server-side. Long enough to transcribe a
 * receipt or menu, short enough that one sticker can't buy a novel.
 */
export const VISION_MAX_TOKENS = 500

/**
 * The fixed instruction sent WITH the image. Chinese (the butler's home
 * language); asks for content + verbatim transcription of visible text
 * (receipts / screenshots / menus are the daily cases) and licenses honesty
 * over confabulation — same posture as the session-window recall hint.
 */
export const VISION_PROMPT =
  '用中文简要准确地描述这张图片的内容。' +
  '如果图里有文字(截图、单据、菜单、聊天记录等),把关键文字原样转录出来。' +
  '看不清的部分如实说看不清,不要编造。'

/** Pull the description out of a chat-wire response's message content. */
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

export interface ButlerSeeingConfig {
  /** OpenAI-compatible base, e.g. `https://token-plan-cn.xiaomimimo.com/v1`. */
  baseUrl: string
  /** Bearer key ('' sends no auth header for local servers). */
  apiKey: string
  /** Vision-capable model id, e.g. `mimo-v2.5-vl`. Required on the wire. */
  model: string
  /** Vision request timeout (ms). Default 30_000. */
  timeoutMs?: number
  /** Injectable for tests (defaults to global `fetch`). */
  fetchImpl?: typeof fetch
}

/**
 * One vision call: image bytes + mime in → description out. Throws on HTTP /
 * timeout / unreadable response; the key travels ONLY in the Authorization
 * header (the image itself rides the body as a data URI — no upload step,
 * no separate storage the bytes could linger in).
 */
export async function visionDescribe(
  config: ButlerSeeingConfig,
  image: Buffer,
  mime: string,
): Promise<string> {
  const base = config.baseUrl.replace(/\/+$/, '')
  const doFetch = config.fetchImpl ?? fetch
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), config.timeoutMs ?? DEFAULT_VISION_TIMEOUT_MS)
  try {
    const res = await doFetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: VISION_MAX_TOKENS,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: VISION_PROMPT },
              {
                type: 'image_url',
                image_url: { url: `data:${mime};base64,${image.toString('base64')}` },
              },
            ],
          },
        ],
      }),
      signal: ac.signal,
    })
    if (!res.ok) throw new Error(`vision HTTP ${res.status}`)
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: unknown } }> }
    const text = contentToText(json?.choices?.[0]?.message?.content)
    if (text === undefined) throw new Error('vision returned no description')
    return text
  } finally {
    clearTimeout(timer)
  }
}

/**
 * What one description attempt produced (mirror of `HearingResult` so the
 * bridge-side fold reads identically):
 *  - `text`: the description — feed it into the normal message pipeline.
 *  - `skipped`: the INPUT is unsuitable by design (empty / oversized /
 *    non-image mime / blank description) — expected and quiet.
 *  - `failed`: an INFRA problem (HTTP / timeout) — worth a warn.
 * Either non-text kind means: the message flows on undescribed.
 */
export type SeeingResult =
  | { kind: 'text'; text: string }
  | { kind: 'skipped'; reason: string }
  | { kind: 'failed'; reason: string }

export interface ButlerSeeing {
  /** Full bytes→description chain. NEVER throws (fail-soft is the contract). */
  describe(bytes: Buffer, mime: string): Promise<SeeingResult>
  /** Boot disclosure — names the vision host + that member photos are sent. */
  disclosure: string
  /** True when image bytes leave the box (any non-loopback endpoint). */
  dataLeavesBox: boolean
}

/** Build a {@link ButlerSeeing} from explicit config (tests / direct callers). */
export function buildButlerSeeing(config: ButlerSeeingConfig): ButlerSeeing {
  const local = isLocalEmbedderUrl(config.baseUrl)
  let host = config.baseUrl
  try {
    host = new URL(config.baseUrl).host
  } catch {
    /* keep the raw string for the disclosure */
  }
  const disclosure = local
    ? `阿同图片识别: ${config.model} @ ${host}（本地视觉 — 图片不离盒）`
    : `阿同图片识别: ${config.model} @ ${host}（远程视觉 — 成员发来的图片会逐张发往该主机识别）`
  return {
    disclosure,
    dataLeavesBox: !local,
    async describe(bytes: Buffer, mime: string): Promise<SeeingResult> {
      if (bytes.length === 0) return { kind: 'skipped', reason: '空图片' }
      if (bytes.length > MAX_IMAGE_INPUT_BYTES) {
        return { kind: 'skipped', reason: `图片超过 ${MAX_IMAGE_INPUT_BYTES / 1024 / 1024}MB 上限` }
      }
      if (!/^image\//i.test(mime)) {
        return { kind: 'skipped', reason: `非图片类型(${mime})` }
      }
      let text: string
      try {
        text = await visionDescribe(config, bytes, mime)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        const reason = /abort/i.test(msg)
          ? `识别超时(${config.timeoutMs ?? DEFAULT_VISION_TIMEOUT_MS}ms)`
          : `识别失败: ${msg}`
        return { kind: 'failed', reason }
      }
      const trimmed = text.trim()
      if (trimmed.length === 0) return { kind: 'skipped', reason: '识别结果为空' }
      return { kind: 'text', text: trimmed }
    },
  }
}

/**
 * Construct the opt-in butler seeing from env. Reuses the voice leg's shared
 * credentials (`GOTONG_BUTLER_VOICE_URL` / `_KEY` — same vendor host, same
 * key in production) plus `GOTONG_BUTLER_VISION_MODEL` to gate the vision
 * leg on its own: voice without vision = leave VISION_MODEL unset; vision
 * without voice = set URL/KEY/VISION_MODEL and leave VOICE_MODEL/_VOICE/
 * ASR_MODEL unset. All three or undefined (byte-identical). Pure — no
 * logging; the caller surfaces the disclosure.
 */
export function butlerSeeingFromEnv(env: NodeJS.ProcessEnv = process.env): ButlerSeeing | undefined {
  const baseUrl = (env.GOTONG_BUTLER_VOICE_URL ?? '').trim()
  const apiKey = (env.GOTONG_BUTLER_VOICE_KEY ?? '').trim()
  const model = (env.GOTONG_BUTLER_VISION_MODEL ?? '').trim()
  if (!baseUrl || !apiKey || !model) return undefined
  return buildButlerSeeing({ baseUrl, apiKey, model })
}
