/**
 * `predicate` — tiny boolean expression evaluator for `step.when` strings.
 *
 * Grammar (recursive descent, no left-recursion):
 *
 *   or      := and ('||' and)*
 *   and     := not ('&&' not)*
 *   not     := '!' not | comp
 *   comp    := primary (('==' | '!=') primary)?
 *   primary := literal | ref | '(' or ')'
 *   literal := string("…") | number | true | false | null
 *   ref     := '$' [A-Za-z0-9_.:-]+
 *
 * Semantics:
 *   - `$ref` is resolved via the same `lookupRef` the payload resolver
 *     uses. A missing ref evaluates to `undefined`; comparing `undefined`
 *     to anything (including another `undefined`) yields `false`.
 *   - `==` and `!=` are **strict type-aware** equality. `1 == "1"` is
 *     `false`; this prevents YAML-author surprises ("did I quote it?").
 *   - `null == null` is `true`. `null` does not equal `undefined`.
 *   - Logical ops short-circuit. The whole expression's value is coerced
 *     to a boolean for the final result:
 *       - bool: itself
 *       - null / undefined: false
 *       - number: `n !== 0`
 *       - string: non-empty
 *       - object / array: always truthy (mirrors JS)
 *
 * The parser deliberately does NOT support arithmetic, comparisons
 * other than equality, or function calls. Workflow `when` predicates
 * are gates, not computation — anything more belongs in a step.
 */

import { lookupRef, type ResolutionContext } from './resolver.js'
import { WorkflowRefError } from './types.js'

export class WorkflowPredicateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkflowPredicateError'
  }
}

// --- tokeniser ------------------------------------------------------------

type TokKind =
  | 'or'
  | 'and'
  | 'eq'
  | 'neq'
  | 'not'
  | 'lparen'
  | 'rparen'
  | 'string'
  | 'number'
  | 'true'
  | 'false'
  | 'null'
  | 'ref'

interface Token {
  kind: TokKind
  /** Literal value for `string` / `number`; ref text (incl. `$`) for `ref`. */
  value?: unknown
  /** 0-based index into the source — for error messages. */
  pos: number
}

const REF_BODY = /[A-Za-z0-9_.:-]/

function tokenise(src: string): Token[] {
  const toks: Token[] = []
  let i = 0
  while (i < src.length) {
    const ch = src[i]!
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i += 1
      continue
    }
    const start = i
    if (ch === '(') { toks.push({ kind: 'lparen', pos: start }); i += 1; continue }
    if (ch === ')') { toks.push({ kind: 'rparen', pos: start }); i += 1; continue }
    if (ch === '=' && src[i + 1] === '=') { toks.push({ kind: 'eq', pos: start }); i += 2; continue }
    if (ch === '!' && src[i + 1] === '=') { toks.push({ kind: 'neq', pos: start }); i += 2; continue }
    if (ch === '!') { toks.push({ kind: 'not', pos: start }); i += 1; continue }
    if (ch === '&' && src[i + 1] === '&') { toks.push({ kind: 'and', pos: start }); i += 2; continue }
    if (ch === '|' && src[i + 1] === '|') { toks.push({ kind: 'or', pos: start }); i += 2; continue }

    // string literal
    if (ch === '"' || ch === "'") {
      const quote = ch
      i += 1
      let str = ''
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\' && i + 1 < src.length) {
          // basic escapes: \\ \" \' \n \t
          const esc = src[i + 1]!
          if (esc === 'n') str += '\n'
          else if (esc === 't') str += '\t'
          else str += esc
          i += 2
        } else {
          str += src[i]
          i += 1
        }
      }
      if (i >= src.length) {
        throw new WorkflowPredicateError(
          `unterminated string literal at position ${start}`,
        )
      }
      i += 1 // skip closing quote
      toks.push({ kind: 'string', value: str, pos: start })
      continue
    }

    // number literal (positive or negative)
    if ((ch >= '0' && ch <= '9') || (ch === '-' && src[i + 1] && src[i + 1]! >= '0' && src[i + 1]! <= '9')) {
      let j = i
      if (src[j] === '-') j += 1
      while (j < src.length && src[j] && (src[j]! >= '0' && src[j]! <= '9')) j += 1
      if (src[j] === '.') {
        j += 1
        while (j < src.length && src[j] && (src[j]! >= '0' && src[j]! <= '9')) j += 1
      }
      const num = Number(src.slice(i, j))
      if (!Number.isFinite(num)) {
        throw new WorkflowPredicateError(
          `bad number literal at position ${i}: '${src.slice(i, j)}'`,
        )
      }
      toks.push({ kind: 'number', value: num, pos: i })
      i = j
      continue
    }

    // identifier-shaped keywords: true / false / null
    if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z')) {
      let j = i
      while (j < src.length && src[j] && /[A-Za-z0-9_]/.test(src[j]!)) j += 1
      const word = src.slice(i, j)
      if (word === 'true') toks.push({ kind: 'true', pos: i })
      else if (word === 'false') toks.push({ kind: 'false', pos: i })
      else if (word === 'null') toks.push({ kind: 'null', pos: i })
      else {
        throw new WorkflowPredicateError(
          `unexpected identifier '${word}' at position ${i} (only true/false/null accepted; use $ref for variables)`,
        )
      }
      i = j
      continue
    }

    // ref: $stuff.dotted.path
    if (ch === '$') {
      let j = i + 1
      while (j < src.length && src[j] && REF_BODY.test(src[j]!)) j += 1
      if (j === i + 1) {
        throw new WorkflowPredicateError(
          `'$' at position ${i} must be followed by a ref path`,
        )
      }
      toks.push({ kind: 'ref', value: src.slice(i, j), pos: i })
      i = j
      continue
    }

    throw new WorkflowPredicateError(
      `unexpected character '${ch}' at position ${i}`,
    )
  }
  return toks
}

// --- parser ---------------------------------------------------------------

type AstNode =
  | { type: 'lit'; value: string | number | boolean | null }
  | { type: 'ref'; ref: string }
  | { type: 'eq' | 'neq' | 'and' | 'or'; left: AstNode; right: AstNode }
  | { type: 'not'; expr: AstNode }

class Parser {
  private i = 0
  constructor(private readonly toks: Token[], private readonly src: string) {}

  parse(): AstNode {
    const expr = this.parseOr()
    if (this.i < this.toks.length) {
      const t = this.toks[this.i]!
      throw new WorkflowPredicateError(
        `unexpected token at position ${t.pos} — trailing input?`,
      )
    }
    return expr
  }

  private peek(): Token | undefined {
    return this.toks[this.i]
  }

  private consume(kind: TokKind): Token | undefined {
    const t = this.toks[this.i]
    if (t && t.kind === kind) { this.i += 1; return t }
    return undefined
  }

  private parseOr(): AstNode {
    let left = this.parseAnd()
    while (this.consume('or')) {
      const right = this.parseAnd()
      left = { type: 'or', left, right }
    }
    return left
  }

  private parseAnd(): AstNode {
    let left = this.parseNot()
    while (this.consume('and')) {
      const right = this.parseNot()
      left = { type: 'and', left, right }
    }
    return left
  }

  private parseNot(): AstNode {
    if (this.consume('not')) {
      const inner = this.parseNot()
      return { type: 'not', expr: inner }
    }
    return this.parseComp()
  }

  private parseComp(): AstNode {
    const left = this.parsePrimary()
    const eq = this.consume('eq')
    if (eq) {
      const right = this.parsePrimary()
      return { type: 'eq', left, right }
    }
    const neq = this.consume('neq')
    if (neq) {
      const right = this.parsePrimary()
      return { type: 'neq', left, right }
    }
    return left
  }

  private parsePrimary(): AstNode {
    if (this.consume('lparen')) {
      const inner = this.parseOr()
      if (!this.consume('rparen')) {
        throw new WorkflowPredicateError(`expected ')' near end of input`)
      }
      return inner
    }
    const t = this.peek()
    if (!t) {
      throw new WorkflowPredicateError(
        `expected a literal, ref, or '(' but hit end of input in '${this.src}'`,
      )
    }
    if (t.kind === 'string' || t.kind === 'number') {
      this.i += 1
      return { type: 'lit', value: t.value as string | number }
    }
    if (t.kind === 'true') { this.i += 1; return { type: 'lit', value: true } }
    if (t.kind === 'false') { this.i += 1; return { type: 'lit', value: false } }
    if (t.kind === 'null') { this.i += 1; return { type: 'lit', value: null } }
    if (t.kind === 'ref') {
      this.i += 1
      return { type: 'ref', ref: t.value as string }
    }
    throw new WorkflowPredicateError(
      `unexpected token at position ${t.pos} (kind: ${t.kind}) in '${this.src}'`,
    )
  }
}

// --- evaluator ------------------------------------------------------------

function evalNode(node: AstNode, ctx: ResolutionContext): unknown {
  switch (node.type) {
    case 'lit':
      return node.value
    case 'ref':
      try {
        return lookupRef(node.ref, ctx)
      } catch (err) {
        // A missing ref in a `when` is OK — treat as `undefined`. We do
        // NOT swallow other refs errors (bad shape, e.g. `$step.foo`
        // when the step is parallel-typed).
        if (err instanceof WorkflowRefError && /has not produced output|got null\/undefined|cannot read/.test(err.message)) {
          return undefined
        }
        throw err
      }
    case 'not':
      return !coerceBool(evalNode(node.expr, ctx))
    case 'and': {
      const l = evalNode(node.left, ctx)
      if (!coerceBool(l)) return false
      return coerceBool(evalNode(node.right, ctx))
    }
    case 'or': {
      const l = evalNode(node.left, ctx)
      if (coerceBool(l)) return true
      return coerceBool(evalNode(node.right, ctx))
    }
    case 'eq':
      return strictEqual(evalNode(node.left, ctx), evalNode(node.right, ctx))
    case 'neq':
      return !strictEqual(evalNode(node.left, ctx), evalNode(node.right, ctx))
  }
}

/** Strict, type-aware equality. Distinct types compare unequal. */
function strictEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  // null vs undefined: not equal (predicate-author should test missing
  // with `== null` explicitly; we keep null distinct from undefined).
  if (typeof a !== typeof b) return false
  if (a === null || b === null) return a === b
  // Same primitive types, different values
  return false
}

function coerceBool(v: unknown): boolean {
  if (v === undefined || v === null) return false
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v !== 0 && !Number.isNaN(v)
  if (typeof v === 'string') return v.length > 0
  // Objects / arrays / functions: truthy.
  return true
}

// --- public API -----------------------------------------------------------

/**
 * Parse a `when` expression once. The result can be re-evaluated against
 * many contexts cheaply. Used by the runner to skip pre-flight parse
 * work on every step invocation.
 */
export function parsePredicate(src: string): CompiledPredicate {
  const toks = tokenise(src)
  if (toks.length === 0) {
    throw new WorkflowPredicateError(`empty 'when' expression`)
  }
  const ast = new Parser(toks, src).parse()
  return new CompiledPredicate(src, ast)
}

export class CompiledPredicate {
  constructor(public readonly source: string, private readonly ast: AstNode) {}
  /** Evaluate against a context. Returns the final boolean. */
  eval(ctx: ResolutionContext): boolean {
    return coerceBool(evalNode(this.ast, ctx))
  }
}

/**
 * One-shot helper: parse + evaluate. Most callers use the runner, which
 * caches a `CompiledPredicate` per step at load time — but tests and
 * one-offs are clearer with `evaluatePredicate(src, ctx)`.
 */
export function evaluatePredicate(src: string, ctx: ResolutionContext): boolean {
  return parsePredicate(src).eval(ctx)
}
