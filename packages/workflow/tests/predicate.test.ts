import { describe, expect, it } from 'vitest'

import {
  WorkflowPredicateError,
  evaluatePredicate,
  parsePredicate,
  type ResolutionContext,
} from '../src/index.js'

function ctx(
  trigger: unknown,
  steps: Record<string, unknown> = {},
): ResolutionContext {
  return {
    triggerPayload: trigger,
    stepOutputs: new Map(Object.entries(steps)),
  }
}

describe('predicate — literal evaluation', () => {
  it('parses and evaluates bare literals', () => {
    expect(evaluatePredicate('true', ctx({}))).toBe(true)
    expect(evaluatePredicate('false', ctx({}))).toBe(false)
    expect(evaluatePredicate('null', ctx({}))).toBe(false)
    expect(evaluatePredicate('1', ctx({}))).toBe(true)
    expect(evaluatePredicate('0', ctx({}))).toBe(false)
    expect(evaluatePredicate('"hi"', ctx({}))).toBe(true)
    expect(evaluatePredicate('""', ctx({}))).toBe(false)
  })

  it("'null' is distinct from undefined (and from false)", () => {
    expect(evaluatePredicate('null == null', ctx({}))).toBe(true)
    expect(evaluatePredicate('null == false', ctx({}))).toBe(false)
    expect(evaluatePredicate('null != false', ctx({}))).toBe(true)
  })
})

describe('predicate — equality with $refs', () => {
  it('compares trigger payload fields against string literals', () => {
    const c = ctx({ priority: 'high', urgent: true })
    expect(evaluatePredicate('$trigger.payload.priority == "high"', c)).toBe(true)
    expect(evaluatePredicate('$trigger.payload.priority == "low"', c)).toBe(false)
    expect(evaluatePredicate('$trigger.payload.priority != "low"', c)).toBe(true)
  })

  it('compares step outputs against booleans / numbers', () => {
    const c = ctx({}, { s1: { ok: true, score: 42 } })
    expect(evaluatePredicate('$s1.output.ok == true', c)).toBe(true)
    expect(evaluatePredicate('$s1.output.score == 42', c)).toBe(true)
    expect(evaluatePredicate('$s1.output.score != 41', c)).toBe(true)
  })

  it('cross-type equality is strict (no coercion)', () => {
    const c = ctx({ n: 1 }, {})
    expect(evaluatePredicate('$trigger.payload.n == "1"', c)).toBe(false)
    expect(evaluatePredicate('$trigger.payload.n != "1"', c)).toBe(true)
  })

  it('missing refs are undefined → all equalities false', () => {
    const c = ctx({})
    expect(evaluatePredicate('$trigger.payload.nope == "anything"', c)).toBe(false)
    expect(evaluatePredicate('$trigger.payload.nope != "anything"', c)).toBe(true)
    expect(evaluatePredicate('$trigger.payload.nope == null', c)).toBe(false) // undefined !== null
  })
})

describe('predicate — boolean logic', () => {
  it('AND short-circuits on falsy left', () => {
    const c = ctx({ a: false })
    expect(evaluatePredicate('$trigger.payload.a == true && $trigger.payload.b == "x"', c)).toBe(false)
  })

  it('OR short-circuits on truthy left', () => {
    const c = ctx({ a: true })
    expect(evaluatePredicate('$trigger.payload.a == true || $trigger.payload.b == "x"', c)).toBe(true)
  })

  it('NOT inverts truthiness', () => {
    expect(evaluatePredicate('!true', ctx({}))).toBe(false)
    expect(evaluatePredicate('!false', ctx({}))).toBe(true)
    expect(evaluatePredicate('!null', ctx({}))).toBe(true)
    const c = ctx({}, { s1: { ok: false } })
    expect(evaluatePredicate('!($s1.output.ok == true)', c)).toBe(true)
  })

  it('parentheses override precedence', () => {
    const c = ctx({ a: true, b: false, c: true })
    // without parens: a == true && b == true || c == true  → true
    // with parens around the OR: a == true && (b == true || c == true) → true
    expect(evaluatePredicate('$trigger.payload.a == true && ($trigger.payload.b == true || $trigger.payload.c == true)', c)).toBe(true)
    expect(evaluatePredicate('($trigger.payload.b == true) && ($trigger.payload.c == true || $trigger.payload.a == true)', c)).toBe(false)
  })
})

describe('predicate — error cases', () => {
  it('rejects empty input', () => {
    expect(() => parsePredicate('')).toThrow(WorkflowPredicateError)
  })

  it('rejects bare identifiers other than true/false/null', () => {
    expect(() => parsePredicate('foo')).toThrow(/unexpected identifier/)
  })

  it('rejects unbalanced parens', () => {
    expect(() => parsePredicate('(true == true')).toThrow(/expected '\)'/)
  })

  it('rejects unterminated strings', () => {
    expect(() => parsePredicate('$x == "open')).toThrow(/unterminated string/)
  })

  it('rejects trailing junk', () => {
    expect(() => parsePredicate('true zzz')).toThrow()
  })
})

describe('predicate — compile-once / eval-many', () => {
  it('a compiled predicate can be re-evaluated against fresh contexts', () => {
    const p = parsePredicate('$trigger.payload.go == true')
    expect(p.eval(ctx({ go: true }))).toBe(true)
    expect(p.eval(ctx({ go: false }))).toBe(false)
    expect(p.source).toBe('$trigger.payload.go == true')
  })
})
