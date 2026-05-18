/**
 * H4 regression — MCP `dispatch_task` input was unbounded.
 *
 * Pre-3.4 `payload: z.unknown()` and `title: z.string()` had no upper
 * bound. An LLM in a long agent loop could mint MB-sized payloads
 * which the Hub would happily accept, write to `transcript.jsonl`
 * on disk, AND broadcast to every connected participant. One stuck
 * loop could fill the workspace dir + saturate every agent's inbox.
 *
 * The fix:
 *   - `payload` runs through `.refine(JSON.stringify(v).length <=
 *     MAX_DISPATCH_PAYLOAD_BYTES)`. Values that can't be JSON-encoded
 *     (circular refs, BigInt, functions) also fail closed — we don't
 *     try to guess.
 *   - `title` is `.max(MAX_DISPATCH_TITLE_LENGTH)`.
 *
 * See AUDIT-v3.3.md finding H4.
 */

import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import {
  DISPATCH_TASK_INPUT_SHAPE,
  MAX_DISPATCH_PAYLOAD_BYTES,
  MAX_DISPATCH_TITLE_LENGTH,
} from '../src/tools.js'

const schema = z.object(DISPATCH_TASK_INPUT_SHAPE)

function valid<T extends Record<string, unknown>>(overrides: T) {
  // Minimal valid input — `strategy` + `recipient` is the smallest set
  // that survives `buildStrategy`. Tests focus on the H4 caps.
  return {
    strategy: 'direct' as const,
    recipient: 'alice',
    ...overrides,
  }
}

describe('H4 — DISPATCH_TASK_INPUT_SHAPE caps', () => {
  describe('exported constants', () => {
    it('MAX_DISPATCH_PAYLOAD_BYTES matches the WS maxPayload default (256 KiB)', () => {
      expect(MAX_DISPATCH_PAYLOAD_BYTES).toBe(256 * 1024)
    })

    it('MAX_DISPATCH_TITLE_LENGTH is 2000 characters', () => {
      // The audit recommended 2000 chars; pin it so a future
      // typo (`200` instead of `2000`) breaks a test, not prod.
      expect(MAX_DISPATCH_TITLE_LENGTH).toBe(2000)
    })
  })

  describe('payload size cap', () => {
    it('accepts a payload well under the cap', () => {
      const small = { question: 'is this thing on?' }
      const r = schema.safeParse(valid({ payload: small }))
      expect(r.success).toBe(true)
    })

    it('accepts a payload at the boundary (exactly the cap)', () => {
      // JSON-serialised string length tracks toward the boundary.
      // We size a string field so the whole JSON envelope sits
      // exactly at the cap.
      const envelopeOverhead = JSON.stringify({ x: '' }).length // 8
      const padding = 'a'.repeat(MAX_DISPATCH_PAYLOAD_BYTES - envelopeOverhead)
      const boundary = { x: padding }
      // Sanity: the produced JSON is exactly at the cap.
      expect(JSON.stringify(boundary).length).toBe(MAX_DISPATCH_PAYLOAD_BYTES)

      const r = schema.safeParse(valid({ payload: boundary }))
      expect(r.success).toBe(true)
    })

    it('rejects a payload one byte over the cap', () => {
      const envelopeOverhead = JSON.stringify({ x: '' }).length
      const padding = 'a'.repeat(MAX_DISPATCH_PAYLOAD_BYTES - envelopeOverhead + 1)
      const tooBig = { x: padding }
      expect(JSON.stringify(tooBig).length).toBe(MAX_DISPATCH_PAYLOAD_BYTES + 1)

      const r = schema.safeParse(valid({ payload: tooBig }))
      expect(r.success).toBe(false)
      if (!r.success) {
        const msg = r.error.issues.map((i) => i.message).join(' ')
        expect(msg).toContain(String(MAX_DISPATCH_PAYLOAD_BYTES))
        expect(msg).toContain('H4')
      }
    })

    it('rejects a flagrantly oversized payload (1 MB)', () => {
      const huge = { x: 'a'.repeat(1_000_000) }
      const r = schema.safeParse(valid({ payload: huge }))
      expect(r.success).toBe(false)
    })

    it('rejects a payload containing values that cannot be JSON-serialised', () => {
      // BigInt makes JSON.stringify throw; refine returns Infinity
      // and the schema rejects. We prefer fail-closed over guessing.
      const r = schema.safeParse(valid({ payload: { n: 1n } as unknown }))
      expect(r.success).toBe(false)
    })

    it('rejects circular references via the same fail-closed path', () => {
      const cyc: Record<string, unknown> = { a: 1 }
      cyc.self = cyc
      const r = schema.safeParse(valid({ payload: cyc }))
      expect(r.success).toBe(false)
    })

    it('omitting payload is fine (optional)', () => {
      const r = schema.safeParse(valid({}))
      expect(r.success).toBe(true)
    })
  })

  describe('title length cap', () => {
    it('accepts a normal title', () => {
      const r = schema.safeParse(valid({ title: 'review this draft' }))
      expect(r.success).toBe(true)
    })

    it('accepts a title at exactly MAX_DISPATCH_TITLE_LENGTH', () => {
      const r = schema.safeParse(
        valid({ title: 'a'.repeat(MAX_DISPATCH_TITLE_LENGTH) }),
      )
      expect(r.success).toBe(true)
    })

    it('rejects a title one character over the cap', () => {
      const r = schema.safeParse(
        valid({ title: 'a'.repeat(MAX_DISPATCH_TITLE_LENGTH + 1) }),
      )
      expect(r.success).toBe(false)
      if (!r.success) {
        const msg = r.error.issues.map((i) => i.message).join(' ')
        expect(msg).toContain(String(MAX_DISPATCH_TITLE_LENGTH))
      }
    })

    it('rejects a flagrantly long title (1 MB)', () => {
      const r = schema.safeParse(
        valid({ title: 'a'.repeat(1_000_000) }),
      )
      expect(r.success).toBe(false)
    })

    it('omitting title is fine (optional)', () => {
      const r = schema.safeParse(valid({}))
      expect(r.success).toBe(true)
    })
  })

  describe('back-compat — other fields unchanged', () => {
    it('weight still capped at [0.1, 10]', () => {
      expect(schema.safeParse(valid({ weight: 0.05 })).success).toBe(false)
      expect(schema.safeParse(valid({ weight: 11 })).success).toBe(false)
      expect(schema.safeParse(valid({ weight: 5 })).success).toBe(true)
    })

    it('timeoutMs still capped at [1000, 600_000]', () => {
      expect(schema.safeParse(valid({ timeoutMs: 500 })).success).toBe(false)
      expect(schema.safeParse(valid({ timeoutMs: 999_999 })).success).toBe(false)
      expect(schema.safeParse(valid({ timeoutMs: 30_000 })).success).toBe(true)
    })

    it('strategy enum still gates the strategy field', () => {
      const r = schema.safeParse({ strategy: 'unknown', recipient: 'x' } as unknown)
      expect(r.success).toBe(false)
    })
  })
})
