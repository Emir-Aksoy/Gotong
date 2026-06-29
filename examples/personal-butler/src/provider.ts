/**
 * A deterministic stand-in for a real LLM. It reads the request the butler
 * builds and scripts the butler's tool calls by keyword — no API key, fully
 * reproducible. In production this is any `LlmProvider` (Anthropic / DeepSeek /
 * MiMo); the butler's loop and gating are identical.
 *
 * Two branches:
 *   - A FRESH user turn (string content) → decide what to do by keyword:
 *     a governed `delete_agent`, a benign `check_calendar`, a recall from the
 *     frozen memory block, or a plain acknowledgement (which `captureTurns`
 *     records to episodic memory).
 *   - A CONTINUATION turn (the last user message carries `tool_result`s) →
 *     close out, reflecting whether the tool succeeded or was declined.
 */

import type { LlmMessage, LlmProvider, LlmRequest, LlmStreamChunk } from '@aipehub/llm'

function lastUserMessage(req: LlmRequest): LlmMessage | undefined {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    if (req.messages[i]!.role === 'user') return req.messages[i]
  }
  return undefined
}

export class ButlerMockProvider implements LlmProvider {
  readonly name = 'butler-mock'

  async *stream(req: LlmRequest): AsyncIterable<LlmStreamChunk> {
    const last = lastUserMessage(req)
    const content = last?.content

    // ── continuation: a tool already ran this round → close out ──
    if (Array.isArray(content) && content.some((b) => (b as { type?: string }).type === 'tool_result')) {
      const blob = JSON.stringify(content)
      if (blob.includes('"isError":true')) {
        yield { type: 'text', text: '好的,那我就不动它了。' }
      } else if (blob.includes('deleted ')) {
        yield { type: 'text', text: '已经帮你删掉了。' }
      } else if (blob.includes('日程')) {
        yield { type: 'text', text: '我看过你的日程了,上面写着结果。' }
      } else {
        yield { type: 'text', text: '好了。' }
      }
      yield { type: 'end', stopReason: 'end_turn' }
      return
    }

    const text = typeof content === 'string' ? content : ''

    // ── sensitive: delete an agent → governed tool (PARKS for approval) ──
    if (/删|delete/i.test(text)) {
      const handle = (text.match(/[a-zA-Z][\w-]+/) ?? [])[0]
      if (handle) {
        yield { type: 'tool_use', toolUse: { type: 'tool_use', id: 'g1', name: 'delete_agent', input: { handle } } }
        yield { type: 'end', stopReason: 'tool_use' }
        return
      }
    }

    // ── benign: check the calendar → inline tool ──
    if (/日程|安排|calendar/i.test(text)) {
      yield { type: 'tool_use', toolUse: { type: 'tool_use', id: 'b1', name: 'check_calendar', input: {} } }
      yield { type: 'end', stopReason: 'tool_use' }
      return
    }

    // ── recall: answer from the frozen memory block in the system prompt ──
    if (/项目|之前|记得|叫啥/.test(text)) {
      const sys = req.system ?? ''
      yield {
        type: 'text',
        text: sys.includes('奶茶店') ? '你之前在忙的是那个奶茶店项目。' : '抱歉,我这边没有相关记忆。',
      }
      yield { type: 'end', stopReason: 'end_turn' }
      return
    }

    // ── otherwise: acknowledge; `captureTurns` records this turn to episodic ──
    yield { type: 'text', text: '好的,我记下了。' }
    yield { type: 'end', stopReason: 'end_turn' }
  }
}
