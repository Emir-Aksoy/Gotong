import type {
  LlmProvider,
  LlmRequest,
  LlmResponse,
  LlmToolUseBlock,
} from './types.js'

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
  /**
   * Tool-use scripting. When set, the mock returns the next entry from the
   * list each time `complete()` is called. Entry semantics:
   *   - `tool_use` entries: emit `toolUses` and set `stopReason: 'tool_use'`.
   *   - `text` entries: behave like the `reply` shortcut — text response,
   *     `stopReason: 'end_turn'` (or whatever the entry overrides).
   * Once exhausted, falls back to `reply`. Lets tests script a multi-turn
   * tool-use loop without spinning up a real provider.
   */
  script?: ReadonlyArray<MockScriptEntry>
}

export type MockScriptEntry =
  | {
      kind: 'tool_use'
      toolUses: LlmToolUseBlock[]
      /** Optional companion text that accompanies the tool calls. */
      text?: string
    }
  | {
      kind: 'text'
      text: string
      stopReason?: LlmResponse['stopReason']
    }

/**
 * Deterministic in-process LlmProvider for tests and the `llm-mock` example.
 * Does not require any external dependency or network call.
 */
export class MockLlmProvider implements LlmProvider {
  readonly name: string
  private scriptCursor = 0

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
    // Scripted entry, if any remain.
    const entry = this.opts.script?.[this.scriptCursor]
    if (entry) {
      this.scriptCursor++
      if (entry.kind === 'tool_use') {
        const res: LlmResponse = {
          text: entry.text ?? '',
          stopReason: 'tool_use',
          toolUses: entry.toolUses,
          usage: {
            inputTokens: estimateTokens(req),
            outputTokens: 16, // arbitrary stand-in
          },
        }
        return res
      }
      // entry.kind === 'text'
      return {
        text: entry.text,
        stopReason: entry.stopReason ?? 'end_turn',
        usage: {
          inputTokens: estimateTokens(req),
          outputTokens: Math.ceil(entry.text.length / 4),
        },
      }
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
  for (const m of req.messages) {
    if (typeof m.content === 'string') {
      chars += m.content.length
    } else {
      // Sum text-block lengths; ignore tool_use / tool_result for token
      // estimation since their JSON envelope is small + variable.
      for (const block of m.content) {
        if (block.type === 'text') chars += block.text.length
        else if (block.type === 'tool_result' && typeof block.content === 'string') {
          chars += block.content.length
        }
      }
    }
  }
  return Math.ceil(chars / 4)
}
