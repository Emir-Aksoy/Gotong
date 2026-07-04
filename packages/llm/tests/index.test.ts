/**
 * Smoke-test the public re-exports. `@gotong/llm`'s surface is small
 * but provider packages and downstream consumers deep-import these
 * symbols — a dropped re-export silently breaks builds.
 */

import { describe, expect, it } from 'vitest'

import * as llm from '../src/index.js'

describe('@gotong/llm public surface', () => {
  it('exports LlmAgent class', () => {
    expect(typeof llm.LlmAgent).toBe('function')
  })

  it('exports MockLlmProvider class', () => {
    expect(typeof llm.MockLlmProvider).toBe('function')
  })

  it('LlmAgent is a subclass of @gotong/core AgentParticipant', async () => {
    const { AgentParticipant } = await import('@gotong/core')
    expect(llm.LlmAgent.prototype).toBeInstanceOf(AgentParticipant)
  })

  it('MockLlmProvider satisfies the LlmProvider contract structurally', () => {
    const p = new llm.MockLlmProvider({ reply: '' })
    // Provider contract (Phase 8 M8): name + stream() — `complete` is gone.
    expect(typeof p.name).toBe('string')
    expect(typeof p.stream).toBe('function')
  })

  it('exports drainStream helper (Phase 8 — replacement for complete())', () => {
    expect(typeof llm.drainStream).toBe('function')
  })
})
