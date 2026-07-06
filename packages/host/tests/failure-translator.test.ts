/**
 * CARE-M1 — 失败翻译官的表驱动回归(双语快照姿态)。
 *
 * 断言锚定「文案里承载修复动作的关键词」而非整句全文:整句快照会让
 * 每次措辞微调都红一片,而关键词(认证/额度/限流/超时/模型名/原文)
 * 才是翻错 kind 时真正会消失的东西。全 kind × zh/en 逐格过,任何一格
 * 缺文案或答非所问都红。
 */

import { describe, expect, it } from 'vitest'

import type { LlmErrorKind } from '@gotong/llm'
import {
  translateLlmFailure,
  translateLlmFailureKind,
  type FailureLang,
} from '../src/failure-translator.js'

const ALL_KINDS: LlmErrorKind[] = ['auth', 'quota', 'rate_limited', 'network', 'model_not_found', 'timeout', 'unknown']

/** 每格必须命中的关键词——kind 翻错时这些词会消失。 */
const ANCHORS: Record<LlmErrorKind, Record<FailureLang, { headline: RegExp; fix: RegExp }>> = {
  auth: {
    zh: { headline: /API key|认证/, fix: /Agents|setting check/ },
    en: { headline: /API key|authentication/i, fix: /Agents|setting check/ },
  },
  quota: {
    zh: { headline: /余额|额度/, fix: /充值|供应商/ },
    en: { headline: /credit|quota/i, fix: /Top up|provider/i },
  },
  rate_limited: {
    zh: { headline: /限流/, fix: /稍等|再试/ },
    en: { headline: /rate-limit/i, fix: /retry|Wait/i },
  },
  network: {
    zh: { headline: /连不上|网络/, fix: /doctor/ },
    en: { headline: /reach|network/i, fix: /doctor/ },
  },
  model_not_found: {
    zh: { headline: /模型名/, fix: /Agents/ },
    en: { headline: /model/i, fix: /Agents/ },
  },
  timeout: {
    zh: { headline: /超时/, fix: /重试/ },
    en: { headline: /Timed out/i, fix: /Retry/i },
  },
  unknown: {
    zh: { headline: /不认识/, fix: /管理员|日志/ },
    en: { headline: /recognize/i, fix: /admin|logs/i },
  },
}

describe('translateLlmFailureKind — 全 kind × 双语', () => {
  for (const kind of ALL_KINDS) {
    for (const lang of ['zh', 'en'] as const) {
      it(`${kind} / ${lang}`, () => {
        const t = translateLlmFailureKind(kind, lang)
        expect(t.kind).toBe(kind)
        expect(t.headline.length).toBeGreaterThan(0)
        expect(t.fix.length).toBeGreaterThan(0)
        expect(t.headline).toMatch(ANCHORS[kind][lang].headline)
        expect(t.fix).toMatch(ANCHORS[kind][lang].fix)
        // kind 已知的入口不带 detail——原文兜底是 unknown 走完整入口的专利。
        expect(t.detail).toBeUndefined()
      })
    }
  }
})

describe('translateLlmFailure — 分类 + 文案一步到位', () => {
  it('401 → auth 文案(zh)', () => {
    const err = Object.assign(new Error('invalid x-api-key'), { status: 401 })
    const t = translateLlmFailure(err, 'zh')
    expect(t.kind).toBe('auth')
    expect(t.headline).toContain('API key')
    expect(t.detail).toBeUndefined()
  })

  it('ECONNREFUSED → network 文案(en)', () => {
    const err = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), { code: 'ECONNREFUSED' }),
    })
    const t = translateLlmFailure(err, 'en')
    expect(t.kind).toBe('network')
    expect(t.fix).toContain('doctor')
  })

  it('认不出的错 → unknown + 原文兜底(不装懂的铁律)', () => {
    const err = new Error('quantum flux capacitor misaligned')
    for (const lang of ['zh', 'en'] as const) {
      const t = translateLlmFailure(err, lang)
      expect(t.kind).toBe('unknown')
      expect(t.detail).toContain('quantum flux capacitor misaligned')
    }
  })

  it('非 Error 值(字符串 throw)也不炸且带原文', () => {
    const t = translateLlmFailure('oops from provider', 'zh')
    expect(t.kind).toBe('unknown')
    expect(t.detail).toBe('oops from provider')
  })
})
