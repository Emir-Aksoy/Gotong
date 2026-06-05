import { describe, it, expect } from 'vitest'

import {
  JSONRPC_VERSION,
  ACP_ERROR,
  buildRequest,
  buildNotification,
  buildResult,
  buildErrorResponse,
  textBlock,
  promptText,
  updateText,
  selectedOutcome,
  cancelledOutcome,
  parseAcpMessage,
  isRequest,
  isNotification,
  isResponse,
  isErrorResponse,
  type AcpMessage,
  type AcpSessionUpdate,
} from '../src/acp-protocol.js'

describe('builders', () => {
  it('buildRequest omits params when undefined', () => {
    expect(buildRequest(1, 'initialize')).toEqual({ jsonrpc: '2.0', id: 1, method: 'initialize' })
    expect(buildRequest('x', 'session/prompt', { sessionId: 's' })).toEqual({
      jsonrpc: '2.0',
      id: 'x',
      method: 'session/prompt',
      params: { sessionId: 's' },
    })
  })

  it('buildNotification omits params when undefined', () => {
    expect(buildNotification('session/cancel')).toEqual({ jsonrpc: '2.0', method: 'session/cancel' })
    expect(buildNotification('session/cancel', { sessionId: 's' })).toEqual({
      jsonrpc: '2.0',
      method: 'session/cancel',
      params: { sessionId: 's' },
    })
  })

  it('buildResult / buildErrorResponse shape', () => {
    expect(buildResult(7, { sessionId: 'mock-1' })).toEqual({ jsonrpc: '2.0', id: 7, result: { sessionId: 'mock-1' } })
    expect(buildErrorResponse(7, ACP_ERROR.METHOD_NOT_FOUND, 'nope')).toEqual({
      jsonrpc: '2.0',
      id: 7,
      error: { code: -32601, message: 'nope' },
    })
    // error response id may be null (parse error before id is known)
    expect(buildErrorResponse(null, ACP_ERROR.PARSE, 'bad', { at: 3 }).error.data).toEqual({ at: 3 })
  })
})

describe('content blocks', () => {
  it('promptText concatenates only text blocks', () => {
    expect(promptText([textBlock('hello '), textBlock('world')])).toBe('hello world')
    expect(promptText([])).toBe('')
  })

  it('updateText pulls text from message/thought chunks, undefined otherwise', () => {
    const chunk: AcpSessionUpdate = { sessionUpdate: 'agent_message_chunk', content: textBlock('hi') }
    expect(updateText(chunk)).toBe('hi')
    const thought: AcpSessionUpdate = { sessionUpdate: 'agent_thought_chunk', content: textBlock('thinking') }
    expect(updateText(thought)).toBe('thinking')
    const toolCall: AcpSessionUpdate = { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'edit file' }
    expect(updateText(toolCall)).toBeUndefined()
  })
})

describe('permission outcomes', () => {
  it('builds selected / cancelled', () => {
    expect(selectedOutcome('opt-allow')).toEqual({ outcome: { outcome: 'selected', optionId: 'opt-allow' } })
    expect(cancelledOutcome()).toEqual({ outcome: { outcome: 'cancelled' } })
  })
})

describe('parse + discriminate', () => {
  it('parseAcpMessage rejects non-objects and wrong jsonrpc', () => {
    expect(parseAcpMessage(null)).toBeNull()
    expect(parseAcpMessage('hi')).toBeNull()
    expect(parseAcpMessage({ jsonrpc: '1.0', id: 1, method: 'x' })).toBeNull()
    expect(parseAcpMessage({ jsonrpc: JSONRPC_VERSION, id: 1, method: 'x' })).not.toBeNull()
  })

  it('classifies request / notification / success / error round-trip', () => {
    const req = parseAcpMessage(buildRequest(1, 'session/prompt', { sessionId: 's' })) as AcpMessage
    expect(isRequest(req)).toBe(true)
    expect(isNotification(req)).toBe(false)
    expect(isResponse(req)).toBe(false)

    const note = parseAcpMessage(buildNotification('session/update', { sessionId: 's', update: {} })) as AcpMessage
    expect(isNotification(note)).toBe(true)
    expect(isRequest(note)).toBe(false)
    expect(isResponse(note)).toBe(false)

    const ok = parseAcpMessage(buildResult(1, { stopReason: 'end_turn' })) as AcpMessage
    expect(isResponse(ok)).toBe(true)
    expect(isRequest(ok)).toBe(false)
    if (isResponse(ok)) expect(isErrorResponse(ok)).toBe(false)

    const err = parseAcpMessage(buildErrorResponse(1, ACP_ERROR.INTERNAL, 'boom')) as AcpMessage
    expect(isResponse(err)).toBe(true)
    if (isResponse(err)) expect(isErrorResponse(err)).toBe(true)
  })

  it('a reverse permission request classifies as a request', () => {
    const perm = parseAcpMessage(
      buildRequest('p1', 'session/request_permission', {
        sessionId: 's',
        toolCall: { title: 'rm -rf build', kind: 'execute' },
        options: [{ optionId: 'a', name: 'Allow', kind: 'allow_once' }],
      }),
    ) as AcpMessage
    expect(isRequest(perm)).toBe(true)
  })
})
