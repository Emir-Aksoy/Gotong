import type { LlmProvider, LlmRequest, LlmResponse } from './types.js'

export interface MockProviderOptions {
  /**
   * Either a fixed string, or a function that derives the response text from
   * the incoming request. The function form is the easiest way to write a
   * "smart-ish" mock for examples (e.g. echo the topic, capitalize, etc.).
   */
  reply: string | ((req: LlmRequest) => string)
  /** Optional artificial delay before resolving. Useful for demos. */
  delayMs?: number
  /**
   * If set, mock will reject with this error instead of returning a response.
   * Used to exercise the LlmAgent's error → failed TaskResult mapping in tests.
   */
  throwError?: string
  /** Override the reported `stopReason`. Defaults to 'end_turn'. */
  stopReason?: LlmResponse['stopReason']
  /** Override the provider name. Defaults to 'mock'. */
  name?: string
}

/**
 * Deterministic in-process LlmProvider for tests and the `llm-mock` example.
 * Does not require any external dependency or network call.
 */
export class MockLlmProvider implements LlmProvider {
  readonly name: string

  constructor(private readonly opts: MockProviderOptions) {
    this.name = opts.name ?? 'mock'
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    if (this.opts.delayMs) {
      await new Promise((r) => setTimeout(r, this.opts.delayMs))
    }
    if (this.opts.throwError) {
      throw new Error(this.opts.throwError)
    }
    const text =
      typeof this.opts.reply === 'function' ? this.opts.reply(req) : this.opts.reply
    return {
      text,
      stopReason: this.opts.stopReason ?? 'end_turn',
      usage: {
        inputTokens: estimateTokens(req),
        outputTokens: Math.ceil(text.length / 4),
      },
    }
  }
}

function estimateTokens(req: LlmRequest): number {
  let chars = req.system?.length ?? 0
  for (const m of req.messages) chars += m.content.length
  return Math.ceil(chars / 4)
}
