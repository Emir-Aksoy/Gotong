import { drainStream } from './types.js'
import type {
  LlmProvider,
  LlmRequest,
  LlmResponse,
  LlmStreamChunk,
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
  /**
   * Phase 8 — split a text reply into N stream chunks so tests can
   * observe incremental delivery. Default: 1 (one chunk per text reply).
   * Ignored for `tool_use` script entries (they always emit as a single
   * `tool_use` chunk since the tool-use loop needs the complete block).
   */
  textChunkCount?: number
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

  /**
   * Phase 8 — streaming entry point. All MockLlmProvider behavior is
   * driven from here; `complete()` simply drains the same iterator so
   * the two methods can never disagree (no double-bookkeeping).
   *
   * Throws synchronously when `throwError` is set so the LlmAgent's
   * existing thrown-error path (failed TaskResult, onAuthFailure) still
   * exercises in tests that exercise it.
   */
  stream(req: LlmRequest, _signal?: AbortSignal): AsyncIterable<LlmStreamChunk> {
    // Mirror the legacy complete() error semantics — throw synchronously,
    // BEFORE the iterator is constructed, so existing tests asserting
    // `await expect(provider.complete(req)).rejects.toThrow(...)` continue
    // to work after we route them through stream().
    if (this.opts.throwError) {
      throw new Error(this.opts.throwError)
    }
    return this.makeStream(req)
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    return drainStream(this.stream(req))
  }

  /**
   * Internal: build the chunk iterator. Pulled out so `stream()` can
   * throw synchronously on `throwError` while the actual generator
   * runs lazily.
   */
  private async *makeStream(req: LlmRequest): AsyncIterable<LlmStreamChunk> {
    if (this.opts.delayMs) {
      await new Promise((r) => setTimeout(r, this.opts.delayMs))
    }
    // Scripted entry, if any remain.
    const entry = this.opts.script?.[this.scriptCursor]
    if (entry) {
      this.scriptCursor++
      if (entry.kind === 'tool_use') {
        if (entry.text) yield { type: 'text', text: entry.text }
        for (const tu of entry.toolUses) {
          yield { type: 'tool_use', toolUse: tu }
        }
        yield {
          type: 'usage',
          usage: {
            inputTokens: estimateTokens(req),
            outputTokens: 16, // arbitrary stand-in, matches legacy behavior
          },
        }
        yield { type: 'end', stopReason: 'tool_use' }
        return
      }
      // entry.kind === 'text'
      yield* this.streamText(entry.text)
      yield {
        type: 'usage',
        usage: {
          inputTokens: estimateTokens(req),
          outputTokens: Math.ceil(entry.text.length / 4),
        },
      }
      yield { type: 'end', stopReason: entry.stopReason ?? 'end_turn' }
      return
    }
    // Fallback to the reply shortcut.
    const text =
      typeof this.opts.reply === 'function' ? this.opts.reply(req) : this.opts.reply
    yield* this.streamText(text)
    yield {
      type: 'usage',
      usage: {
        inputTokens: estimateTokens(req),
        outputTokens: Math.ceil(text.length / 4),
      },
    }
    yield { type: 'end', stopReason: this.opts.stopReason ?? 'end_turn' }
  }

  /**
   * Split a string into `textChunkCount` roughly-equal `'text'` chunks so
   * tests can observe incremental arrival. Empty `text` emits zero chunks
   * (the contract in `LlmStreamTextChunk` forbids empty-string chunks).
   */
  private *streamText(text: string): Iterable<LlmStreamChunk> {
    if (!text) return
    const n = Math.max(1, this.opts.textChunkCount ?? 1)
    if (n === 1) {
      yield { type: 'text', text }
      return
    }
    const size = Math.ceil(text.length / n)
    for (let i = 0; i < text.length; i += size) {
      const slice = text.slice(i, i + size)
      if (slice.length > 0) yield { type: 'text', text: slice }
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
