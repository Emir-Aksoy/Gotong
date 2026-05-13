import { describe, expect, it } from 'vitest'

import { WorkflowRefError, resolveRefs, type ResolutionContext } from '../src/index.js'

function ctx(
  trigger: unknown,
  steps: Record<string, unknown> = {},
): ResolutionContext {
  return {
    triggerPayload: trigger,
    stepOutputs: new Map(Object.entries(steps)),
  }
}

describe('resolveRefs — pass-through', () => {
  it('leaves plain literals untouched', () => {
    expect(resolveRefs(42, ctx({}))).toBe(42)
    expect(resolveRefs(true, ctx({}))).toBe(true)
    expect(resolveRefs(null, ctx({}))).toBe(null)
    expect(resolveRefs('plain text', ctx({}))).toBe('plain text')
  })

  it('walks arrays and objects', () => {
    const v = { a: [1, 2, { b: 'x' }] }
    const out = resolveRefs(v, ctx({}))
    expect(out).toEqual(v)
    expect(out).not.toBe(v) // a new copy
  })
})

describe('resolveRefs — $trigger', () => {
  it('substitutes $trigger.payload with the whole payload (preserves type)', () => {
    const c = ctx({ topic: 'TS', urgent: true })
    expect(resolveRefs('$trigger.payload', c)).toEqual({ topic: 'TS', urgent: true })
  })

  it('substitutes a nested $trigger.payload.field', () => {
    const c = ctx({ topic: 'TS', meta: { who: 'alice' } })
    expect(resolveRefs('$trigger.payload.topic', c)).toBe('TS')
    expect(resolveRefs('$trigger.payload.meta.who', c)).toBe('alice')
  })

  it('returns undefined for a missing field (does not throw)', () => {
    const c = ctx({ topic: 'TS' })
    expect(resolveRefs('$trigger.payload.nope', c)).toBeUndefined()
  })
})

describe('resolveRefs — $stepId.output', () => {
  it('substitutes a simple step output', () => {
    const c = ctx({}, { draft: { text: 'hello' } })
    expect(resolveRefs('$draft.output', c)).toEqual({ text: 'hello' })
    expect(resolveRefs('$draft.output.text', c)).toBe('hello')
  })

  it('throws on unknown step id', () => {
    const c = ctx({})
    expect(() => resolveRefs('$nosuch.output', c)).toThrow(WorkflowRefError)
  })

  it('substitutes a parallel branch output', () => {
    const c = ctx({}, {
      fanout: { a: { score: 1 }, b: { score: 2 } },
    })
    expect(resolveRefs('$fanout.a.output', c)).toEqual({ score: 1 })
    expect(resolveRefs('$fanout.b.output.score', c)).toBe(2)
  })

  it('throws on bad parallel branch ref shape', () => {
    const c = ctx({}, { fanout: { a: { score: 1 } } })
    expect(() => resolveRefs('$fanout.zzz.output', c)).toThrow(/no branch 'zzz'/)
  })
})

describe('resolveRefs — inside structures', () => {
  it('substitutes refs inside object values', () => {
    const c = ctx(
      { topic: 'TS' },
      { draft: { text: 'a draft' } },
    )
    const tmpl = {
      original: '$trigger.payload.topic',
      review_of: '$draft.output',
      static: 'literal',
    }
    expect(resolveRefs(tmpl, c)).toEqual({
      original: 'TS',
      review_of: { text: 'a draft' },
      static: 'literal',
    })
  })

  it('substitutes refs inside arrays', () => {
    const c = ctx({ topic: 'TS' }, { d1: 'one', d2: 'two' })
    expect(resolveRefs(['$d1.output', '$d2.output'], c)).toEqual(['one', 'two'])
  })
})

describe('resolveRefs — inline templating', () => {
  it('replaces a ref embedded in a longer string with JSON.stringify of the value', () => {
    const c = ctx({}, { draft: { text: 'hello' } })
    expect(resolveRefs('请评审: $draft.output', c)).toBe('请评审: {"text":"hello"}')
  })

  it('keeps string-valued refs as bare strings (no extra quotes) in inline templating', () => {
    const c = ctx({}, { greet: 'hi' })
    expect(resolveRefs('Say: $greet.output now.', c)).toBe('Say: hi now.')
  })

  it('does not touch strings that lack any $', () => {
    expect(resolveRefs('no refs here', ctx({}))).toBe('no refs here')
  })
})
