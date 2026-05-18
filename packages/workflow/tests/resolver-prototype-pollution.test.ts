/**
 * H1 regression — workflow resolver prototype pollution.
 *
 * Pre-3.4 `resolveRefs` did:
 *
 *     const out: Record<string, unknown> = {}
 *     for (const [k, v] of Object.entries(value)) {
 *       out[k] = resolveRefs(v, ctx)
 *     }
 *
 * `JSON.parse('{"__proto__":{"polluted":true}}')` produces an object
 * whose OWN-property key is literally `__proto__`. `Object.entries`
 * faithfully enumerates it, and `out["__proto__"] = …` then invokes
 * the `__proto__` setter on Object.prototype — every fresh `{}` in
 * the realm inherits the attacker's fields from that point on.
 *
 * `triggerPayload` reaches the resolver from the inbound TASK body,
 * so this is reachable from a malicious agent.
 *
 * The fix:
 *   1. Build the output container with a null prototype
 *      (`Object.create(null)`), sealing the chain.
 *   2. Skip the three known carriers (`__proto__`, `constructor`,
 *      `prototype`) so they don't even land as own properties.
 *
 * See AUDIT-v3.3.md finding H1.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { resolveRefs, type ResolutionContext } from '../src/index.js'

function ctx(triggerPayload: unknown): ResolutionContext {
  return { triggerPayload, stepOutputs: new Map() }
}

describe('H1 — resolveRefs prototype-pollution defence', () => {
  // Take a snapshot of Object.prototype before each test and restore it
  // after — even if a test ACCIDENTALLY pollutes the prototype, the
  // next test gets a clean slate.
  let baselineProtoKeys: string[]

  beforeEach(() => {
    baselineProtoKeys = Object.getOwnPropertyNames(Object.prototype)
  })

  afterEach(() => {
    // Strip any keys added during the test. Tolerant: if the fix
    // works, this is a no-op.
    for (const k of Object.getOwnPropertyNames(Object.prototype)) {
      if (!baselineProtoKeys.includes(k)) {
        // @ts-expect-error — surgical cleanup
        delete Object.prototype[k]
      }
    }
  })

  it('does NOT pollute Object.prototype when payload has a __proto__ key', () => {
    const evilPayload = JSON.parse(
      '{"__proto__":{"polluted":"yes","admin":true}}',
    ) as Record<string, unknown>
    // Sanity-check: the parsed object DOES carry __proto__ as an
    // own property. Older Node versions skipped it; pin the test
    // to the case we actually care about.
    expect(Object.prototype.hasOwnProperty.call(evilPayload, '__proto__')).toBe(true)

    resolveRefs(evilPayload, ctx({}))

    // After running the resolver, a brand-new object MUST NOT
    // inherit the attacker's fields.
    const probe = {} as Record<string, unknown>
    expect(probe.polluted).toBeUndefined()
    expect(probe.admin).toBeUndefined()
    expect(Object.prototype).not.toHaveProperty('polluted')
    expect(Object.prototype).not.toHaveProperty('admin')
  })

  it('does NOT pollute via nested __proto__ keys deep in the payload', () => {
    // The recursion path matters too — a nested object with
    // __proto__ also runs through the same code branch.
    const nestedEvil = JSON.parse(
      '{"safe":{"deeper":{"__proto__":{"deepPollute":"yes"}}}}',
    ) as Record<string, unknown>

    resolveRefs(nestedEvil, ctx({}))

    const probe = {} as Record<string, unknown>
    expect(probe.deepPollute).toBeUndefined()
  })

  it('does NOT pollute via constructor.prototype', () => {
    // The other classic carrier — `constructor.prototype = {x: 1}`
    // mutates Function.prototype.
    const evil = JSON.parse(
      '{"constructor":{"prototype":{"polluted":"via-constructor"}}}',
    ) as Record<string, unknown>

    resolveRefs(evil, ctx({}))

    const probe = {} as Record<string, unknown>
    expect(probe.polluted).toBeUndefined()
  })

  it('does NOT pollute via a top-level `prototype` key either', () => {
    // Less common but the audit recommended denylisting all three.
    const evil = JSON.parse(
      '{"prototype":{"polluted":"top-prototype"}}',
    ) as Record<string, unknown>

    resolveRefs(evil, ctx({}))

    const probe = {} as Record<string, unknown>
    expect(probe.polluted).toBeUndefined()
  })

  it('strips the carrier keys from the output (they do not survive)', () => {
    // The audit fix denylists __proto__ / constructor / prototype.
    // We don't try to preserve them as data fields — see the source
    // comment for why that's an acceptable trade.
    const input = JSON.parse(
      '{"keep":"yes","__proto__":{"x":1},"constructor":{"y":2},"prototype":{"z":3}}',
    ) as Record<string, unknown>

    const out = resolveRefs(input, ctx({})) as Record<string, unknown>

    expect(out.keep).toBe('yes')
    expect(Object.prototype.hasOwnProperty.call(out, '__proto__')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(out, 'constructor')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(out, 'prototype')).toBe(false)
  })

  it('still resolves legitimate $refs from a polluted-looking payload', () => {
    // The fix must not break normal resolution. A payload mixing a
    // carrier key with a real $ref should resolve the ref and drop
    // the carrier — silently, no throw.
    const trigger = { user: 'alice' }
    const out = resolveRefs(
      JSON.parse('{"__proto__":{"x":1},"who":"$trigger.payload.user"}'),
      ctx(trigger),
    ) as Record<string, unknown>

    expect(out.who).toBe('alice')
    expect(Object.prototype.hasOwnProperty.call(out, '__proto__')).toBe(false)
  })

  it('output container has a null prototype (defence in depth)', () => {
    // Even if a future regression weakens the denylist, the null
    // prototype keeps the SETTER unreachable. Verify directly.
    const out = resolveRefs(
      JSON.parse('{"a":1}'),
      ctx({}),
    ) as Record<string, unknown>

    expect(Object.getPrototypeOf(out)).toBeNull()
    expect(out.a).toBe(1)
  })
})
