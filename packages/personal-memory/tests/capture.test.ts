import type { Task } from '@gotong/core'
import { describe, expect, it } from 'vitest'

import {
  buildTurnCapture,
  extractReplyText,
  extractUserText,
  isHeartbeatPayload,
} from '../src/index.js'

function task(payload: unknown, opts: { id?: string; from?: string; title?: string } = {}): Task {
  return {
    id: opts.id ?? 't1',
    from: opts.from ?? 'user:alice',
    strategy: { kind: 'explicit', to: 'butler' },
    payload,
    ...(opts.title !== undefined ? { title: opts.title } : {}),
  }
}

describe('buildTurnCapture', () => {
  it('builds an episodic entry with User/Butler lines + traceable meta', () => {
    const e = buildTurnCapture({
      userText: 'remember milk',
      replyText: 'noted',
      taskId: 't9',
      from: 'user:alice',
    })
    expect(e).not.toBeNull()
    expect(e!.kind).toBe('episodic')
    expect(e!.text).toBe('User: remember milk\nButler: noted')
    expect(e!.meta).toMatchObject({ turn: true, taskId: 't9', from: 'user:alice' })
  })

  it('collapses newlines so the entry text stays one tidy block', () => {
    const e = buildTurnCapture({ userText: 'line one\n  line two', replyText: 'a\nb' })
    expect(e!.text).toBe('User: line one line two\nButler: a b')
  })

  it('returns null when there is nothing to record (both sides empty)', () => {
    expect(buildTurnCapture({ userText: '   ', replyText: '' })).toBeNull()
  })

  it('keeps the entry even when one side is empty', () => {
    const e = buildTurnCapture({ userText: 'just a question', replyText: '' })
    expect(e!.text).toBe('User: just a question')
  })

  it('merges caller meta (e.g. a per-user namespace key) over the turn marker', () => {
    const e = buildTurnCapture({
      userText: 'hi',
      replyText: 'hey',
      meta: { user: 'alice', source: 'im' },
    })
    expect(e!.meta).toMatchObject({ turn: true, user: 'alice', source: 'im' })
  })

  it('respects maxChars by truncating each side, marking the cut', () => {
    const e = buildTurnCapture({
      userText: 'a'.repeat(500),
      replyText: 'b'.repeat(500),
      maxChars: 40,
    })
    // half = 20 per side → each side truncated to 20 chars incl. the ellipsis.
    expect(e!.text).toContain('…')
    expect(e!.text.length).toBeLessThan(60)
    expect(e!.text.startsWith('User: ')).toBe(true)
    expect(e!.text).toContain('\nButler: ')
  })
})

describe('extractUserText', () => {
  it('reads a bare string payload', () => {
    expect(extractUserText(task('just text'))).toBe('just text')
  })

  it('prefers prompt, then topic', () => {
    expect(extractUserText(task({ prompt: 'p', topic: 't' }))).toBe('p')
    expect(extractUserText(task({ topic: 't' }))).toBe('t')
  })

  it('pulls the last user message from a messages array', () => {
    const payload = {
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'reply' },
        { role: 'user', content: 'second' },
      ],
    }
    expect(extractUserText(task(payload))).toBe('second')
  })

  it('reads text blocks out of a structured message content', () => {
    const payload = {
      messages: [{ role: 'user', content: [{ type: 'text', text: 'block text' }] }],
    }
    expect(extractUserText(task(payload))).toBe('block text')
  })

  it('falls back to the task title, then empty string', () => {
    expect(extractUserText(task({ unrelated: 1 }, { title: 'the title' }))).toBe('the title')
    expect(extractUserText(task({ unrelated: 1 }))).toBe('')
  })
})

describe('extractReplyText', () => {
  it('reads a bare string', () => {
    expect(extractReplyText('hello')).toBe('hello')
  })
  it('reads an LlmTaskOutput-shaped object', () => {
    expect(extractReplyText({ text: 'world', stopReason: 'end_turn', by: 'x' })).toBe('world')
  })
  it('returns empty for anything unreadable', () => {
    expect(extractReplyText({ nope: 1 })).toBe('')
    expect(extractReplyText(undefined)).toBe('')
  })
})

describe('isHeartbeatPayload', () => {
  it('detects a heartbeat tick', () => {
    expect(isHeartbeatPayload(task({ heartbeat: true, prompt: 'x' }))).toBe(true)
  })
  it('is false for a normal conversation turn', () => {
    expect(isHeartbeatPayload(task({ heartbeat: false }))).toBe(false)
    expect(isHeartbeatPayload(task('hi'))).toBe(false)
    expect(isHeartbeatPayload(task({ prompt: 'hi' }))).toBe(false)
  })
})
