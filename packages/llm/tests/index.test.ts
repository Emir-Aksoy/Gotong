/**
 * Smoke-test the public re-exports. `@aipehub/llm`'s surface is small
 * but provider packages and downstream consumers deep-import these
 * symbols — a dropped re-export silently breaks builds.
 */

import { describe, expect, it } from 'vitest'

import * as llm from '../src/index.js'

describe('@aipehub/llm public surface', () => {
  it('exports LlmAgent class', () => {
    expect(typeof llm.LlmAgent).toBe('function')
  })

  it('exports MockLlmProvider class', () => {
    expect(typeof llm.MockLlmProvider).toBe('function')
  })

  it('LlmAgent is a subclass of @aipehub/core AgentParticipant', async () => {
    const { AgentParticipant } = await import('@aipehub/core')
    expect(llm.LlmAgent.prototype).toBeInstanceOf(AgentParticipant)
  })

  it('MockLlmProvider satisfies the LlmProvider contract structurally', () => {
    const p = new llm.MockLlmProvider({ reply: '' })
    // Provider contract: name + complete()
    expect(typeof p.name).toBe('string')
    expect(typeof p.complete).toBe('function')
  })
})
