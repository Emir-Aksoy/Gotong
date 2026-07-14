/**
 * Anti-rot acceptance gate for LSA-M3's curated LLM-provider catalog.
 *
 * `CURATED_LLM_PROVIDERS` is a HAND-AUTHORED constant a MEMBER acts on — they'll
 * open the signup URL and paste the base URL into an agent config. So a wrong base
 * URL is a real harm, not a cosmetic bug. This test PINS the id set AND every base
 * URL (a silent edit becomes a visible diff), and enforces the load-bearing safety
 * property: the rendered card ALWAYS carries the two red lines (阿同 never registers /
 * scrapes keys; 阿同 only reads keys — writing stays owner+vault).
 */

import { describe, expect, it } from 'vitest'

import {
  CURATED_LLM_PROVIDERS,
  buildButlerLlmCatalogToolset,
  renderProviderCatalog,
  type LlmProviderTier,
} from '../src/personal-butler-llm-catalog.js'

// Pinning ids makes "someone quietly added/removed a provider" a test diff.
const EXPECTED_IDS = ['openrouter', 'groq', 'cerebras', 'together', 'deepseek']

// Pin every base URL — a member pastes these into an agent config, so a wrong one
// silently breaks their setup. Verified against official docs 2026-07-14.
const EXPECTED_BASE_URLS: Record<string, string> = {
  openrouter: 'https://openrouter.ai/api/v1',
  groq: 'https://api.groq.com/openai/v1',
  cerebras: 'https://api.cerebras.ai/v1',
  together: 'https://api.together.ai/v1',
  deepseek: 'https://api.deepseek.com',
}

const ALLOWED_TIERS: readonly LlmProviderTier[] = ['free-quota', 'trial', 'low-cost']

describe('curated LLM-provider catalog (LSA-M3)', () => {
  it('ships exactly the curated set, in order, with unique ids', () => {
    expect(CURATED_LLM_PROVIDERS.map((p) => p.id)).toEqual(EXPECTED_IDS)
    expect(new Set(CURATED_LLM_PROVIDERS.map((p) => p.id)).size).toBe(EXPECTED_IDS.length)
  })

  it('pins every verified base URL (a member pastes these — wrong = harm)', () => {
    for (const p of CURATED_LLM_PROVIDERS) {
      expect(p.baseUrl, `${p.id} base URL`).toBe(EXPECTED_BASE_URLS[p.id])
    }
  })

  it('every entry is complete: name / whatFor / costTruth / signup + steps / env', () => {
    for (const p of CURATED_LLM_PROVIDERS) {
      expect(p.name.length, `${p.id} name`).toBeGreaterThan(0)
      expect(p.whatFor.length, `${p.id} whatFor`).toBeGreaterThan(0)
      expect(p.costTruth.length, `${p.id} costTruth`).toBeGreaterThan(0)
      expect(p.signupSteps.length, `${p.id} signupSteps`).toBeGreaterThanOrEqual(1)
      expect(ALLOWED_TIERS, `${p.id} tier`).toContain(p.tier)
    }
  })

  it('base + signup URLs are https; env hint is an UPPER_SNAKE var NAME (not a value)', () => {
    for (const p of CURATED_LLM_PROVIDERS) {
      expect(p.baseUrl.startsWith('https://'), `${p.id} baseUrl https`).toBe(true)
      expect(p.signupUrl.startsWith('https://'), `${p.id} signupUrl https`).toBe(true)
      // A bare env var NAME — never an actual secret value.
      expect(p.envHint, `${p.id} envHint`).toMatch(/^[A-Z][A-Z0-9_]*$/)
    }
  })

  // The load-bearing safety assertion: the card the member sees ALWAYS states both
  // red lines, so the model can't drift into "I'll just register it for you" and the
  // human always knows credential write stays theirs.
  it('the rendered card always carries the two red lines + how-to-wire', () => {
    const card = renderProviderCatalog(CURATED_LLM_PROVIDERS)
    // ① 阿同 never registers / scrapes keys.
    expect(card).toContain('注册和填 key 得你来')
    expect(card).toContain('绝不去网上')
    // ② read-only on keys — writing stays owner+vault.
    expect(card).toContain('只读不写')
    // The wiring guidance (OpenAI 兼容 + base URL + env var).
    expect(card).toContain('OpenAI 兼容')
  })

  it('the rendered card names every provider, its tier, signup URL and env var', () => {
    const card = renderProviderCatalog(CURATED_LLM_PROVIDERS)
    for (const p of CURATED_LLM_PROVIDERS) {
      expect(card, `${p.id} name`).toContain(p.name)
      expect(card, `${p.id} signup`).toContain(p.signupUrl)
      expect(card, `${p.id} env`).toContain(p.envHint)
    }
    // Honest tier labels present.
    expect(card).toContain('免费额度')
    expect(card).toContain('试用额度')
    expect(card).toContain('低价')
  })

  it('the toolset exposes discover_llm_providers and returns the card', async () => {
    const ts = buildButlerLlmCatalogToolset()
    expect(ts.listTools().map((t) => t.name)).toEqual(['discover_llm_providers'])
    const out = await ts.callTool('discover_llm_providers', {})
    expect(out.isError).toBeFalsy()
    const t = out.content[0]
    expect(t.type).toBe('text')
    if (t.type === 'text') {
      expect(t.text).toContain('OpenRouter')
      expect(t.text).toContain('只读不写')
    }
  })

  it('an unknown tool name is refused', async () => {
    const ts = buildButlerLlmCatalogToolset()
    const out = await ts.callTool('nope', {})
    expect(out.isError).toBe(true)
  })
})
