/**
 * Phase 9 M1 — multimodal content block types + helpers.
 *
 * Tests the additions to `@aipehub/llm/types`:
 *   - LlmImageBlock / LlmAudioBlock / LlmFileRefBlock are valid
 *     LlmContentBlock union members
 *   - isMultimodalBlock type guard
 *   - extractInlineBase64Size byte math + edge cases
 *   - MultimodalNotSupportedError + MultimodalInlineSizeError shape
 *
 * Provider translation (M2 / M3) is covered in the per-provider test
 * files; here we just verify the neutral surface.
 */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MULTIMODAL_INLINE_BYTE_CAP,
  MultimodalInlineSizeError,
  MultimodalNotSupportedError,
  extractInlineBase64Size,
  isMultimodalBlock,
  type LlmAudioBlock,
  type LlmContentBlock,
  type LlmFileRefBlock,
  type LlmImageBlock,
  type LlmTextBlock,
  type LlmToolUseBlock,
} from '../src/index.js'

describe('Phase 9 M1: multimodal content blocks', () => {
  describe('union acceptance', () => {
    // These are compile-time tests really — if the union doesn't include
    // the new shapes, this file fails to type-check.
    it('accepts LlmImageBlock with base64 source', () => {
      const block: LlmContentBlock = {
        type: 'image',
        source: { kind: 'base64', data: 'aGVsbG8=', mime: 'image/png' },
      }
      expect(block.type).toBe('image')
    })

    it('accepts LlmImageBlock with url source', () => {
      const block: LlmImageBlock = {
        type: 'image',
        source: { kind: 'url', url: 'https://example.com/cat.png' },
      }
      const accepted: LlmContentBlock = block
      expect(accepted.type).toBe('image')
    })

    it('accepts LlmImageBlock with artifact_ref source', () => {
      const block: LlmContentBlock = {
        type: 'image',
        source: { kind: 'artifact_ref', artifactId: 'photos/me.png', mime: 'image/png' },
      }
      expect(block.type).toBe('image')
    })

    it('accepts LlmAudioBlock with format hint', () => {
      const block: LlmAudioBlock = {
        type: 'audio',
        source: { kind: 'base64', data: 'AAAA', mime: 'audio/wav' },
        format: 'wav',
      }
      const accepted: LlmContentBlock = block
      expect(accepted.type).toBe('audio')
    })

    it('accepts LlmFileRefBlock with required mime', () => {
      const block: LlmFileRefBlock = {
        type: 'file_ref',
        artifactId: 'docs/spec.pdf',
        mime: 'application/pdf',
      }
      const accepted: LlmContentBlock = block
      expect(accepted.type).toBe('file_ref')
    })
  })

  describe('isMultimodalBlock', () => {
    it('returns true for image / audio / file_ref', () => {
      const image: LlmImageBlock = {
        type: 'image',
        source: { kind: 'url', url: 'https://example.com/a.png' },
      }
      const audio: LlmAudioBlock = {
        type: 'audio',
        source: { kind: 'url', url: 'https://example.com/a.wav' },
      }
      const fileRef: LlmFileRefBlock = {
        type: 'file_ref',
        artifactId: 'x',
        mime: 'text/plain',
      }
      expect(isMultimodalBlock(image)).toBe(true)
      expect(isMultimodalBlock(audio)).toBe(true)
      expect(isMultimodalBlock(fileRef)).toBe(true)
    })

    it('returns false for text / tool_use / tool_result', () => {
      const text: LlmTextBlock = { type: 'text', text: 'hi' }
      const toolUse: LlmToolUseBlock = {
        type: 'tool_use',
        id: 'tx',
        name: 'f',
        input: {},
      }
      expect(isMultimodalBlock(text)).toBe(false)
      expect(isMultimodalBlock(toolUse)).toBe(false)
      expect(isMultimodalBlock({
        type: 'tool_result',
        toolUseId: 'tx',
        content: 'ok',
      })).toBe(false)
    })

    it('narrows the type on the true branch', () => {
      const block: LlmContentBlock = {
        type: 'image',
        source: { kind: 'url', url: 'https://example.com/a.png' },
      }
      if (isMultimodalBlock(block)) {
        // If the guard narrows correctly, this read is type-safe (no `any`).
        const t: 'image' | 'audio' | 'file_ref' = block.type
        expect(t).toBe('image')
      } else {
        expect.fail('expected multimodal block')
      }
    })
  })

  describe('extractInlineBase64Size', () => {
    it('returns 0 for non-multimodal blocks', () => {
      expect(extractInlineBase64Size({ type: 'text', text: 'hi' })).toBe(0)
      expect(extractInlineBase64Size({
        type: 'tool_use', id: 'x', name: 'y', input: {},
      })).toBe(0)
    })

    it('returns 0 for url source', () => {
      const block: LlmImageBlock = {
        type: 'image',
        source: { kind: 'url', url: 'https://example.com/a.png' },
      }
      expect(extractInlineBase64Size(block)).toBe(0)
    })

    it('returns 0 for artifact_ref source', () => {
      const block: LlmImageBlock = {
        type: 'image',
        source: { kind: 'artifact_ref', artifactId: 'x.png', mime: 'image/png' },
      }
      expect(extractInlineBase64Size(block)).toBe(0)
    })

    it('computes byte length for base64 with no padding', () => {
      // 'abcd' base64 = 3 raw bytes ("i\xb7\x1d" doesn't matter — just length).
      const block: LlmImageBlock = {
        type: 'image',
        source: { kind: 'base64', data: 'abcd', mime: 'image/png' },
      }
      expect(extractInlineBase64Size(block)).toBe(3)
    })

    it('handles one padding char', () => {
      // 'abc=' = 2 raw bytes
      const block: LlmImageBlock = {
        type: 'image',
        source: { kind: 'base64', data: 'abc=', mime: 'image/png' },
      }
      expect(extractInlineBase64Size(block)).toBe(2)
    })

    it('handles two padding chars', () => {
      // 'aGk=' is "hi" (2 bytes); 'YQ==' is "a" (1 byte).
      const block: LlmImageBlock = {
        type: 'image',
        source: { kind: 'base64', data: 'YQ==', mime: 'image/png' },
      }
      expect(extractInlineBase64Size(block)).toBe(1)
    })

    it('strips RFC2045 soft-wrapped whitespace before sizing', () => {
      // 76-col wrap with newlines / spaces should not throw off the count.
      const raw = 'abcd'.repeat(4) // 12 bytes encoded
      const wrapped = raw.split('').join('\n  ')
      const block: LlmImageBlock = {
        type: 'image',
        source: { kind: 'base64', data: wrapped, mime: 'image/png' },
      }
      expect(extractInlineBase64Size(block)).toBe(12)
    })

    it('returns 0 for empty base64 (no false cap-exceeded)', () => {
      const block: LlmImageBlock = {
        type: 'image',
        source: { kind: 'base64', data: '', mime: 'image/png' },
      }
      expect(extractInlineBase64Size(block)).toBe(0)
    })

    it('returns 0 for malformed base64 (caller-corrupted)', () => {
      // '!!!!' is not valid base64; we'd rather return 0 + let the provider
      // reject the body than emit a misleading byte count that triggers a
      // false MultimodalInlineSizeError.
      const block: LlmImageBlock = {
        type: 'image',
        source: { kind: 'base64', data: '!!!!', mime: 'image/png' },
      }
      expect(extractInlineBase64Size(block)).toBe(0)
    })

    it('audio block base64 size matches image block formula', () => {
      const audio: LlmAudioBlock = {
        type: 'audio',
        source: { kind: 'base64', data: 'abcd', mime: 'audio/wav' },
      }
      expect(extractInlineBase64Size(audio)).toBe(3)
    })

    it('file_ref returns 0 even with theoretically-relevant data', () => {
      // file_ref has no inline source at all — always 0.
      const block: LlmFileRefBlock = {
        type: 'file_ref',
        artifactId: 'x',
        mime: 'image/png',
      }
      expect(extractInlineBase64Size(block)).toBe(0)
    })
  })

  describe('default inline cap', () => {
    it('is 1 MB and an integer byte count', () => {
      expect(DEFAULT_MULTIMODAL_INLINE_BYTE_CAP).toBe(1024 * 1024)
      expect(Number.isInteger(DEFAULT_MULTIMODAL_INLINE_BYTE_CAP)).toBe(true)
    })
  })

  describe('MultimodalNotSupportedError', () => {
    it('carries provider + block + code', () => {
      const err = new MultimodalNotSupportedError('anthropic', 'audio')
      expect(err.code).toBe('MULTIMODAL_NOT_SUPPORTED')
      expect(err.providerName).toBe('anthropic')
      expect(err.blockType).toBe('audio')
      expect(err.message).toContain('anthropic')
      expect(err.message).toContain('audio')
      expect(err.name).toBe('MultimodalNotSupportedError')
    })

    it('appends detail when supplied', () => {
      const err = new MultimodalNotSupportedError('anthropic', 'audio', 'no audio API yet')
      expect(err.message).toContain('no audio API yet')
    })

    it('is catchable as Error and as the subclass', () => {
      try {
        throw new MultimodalNotSupportedError('test', 'image')
      } catch (e) {
        expect(e).toBeInstanceOf(Error)
        expect(e).toBeInstanceOf(MultimodalNotSupportedError)
      }
    })
  })

  describe('MultimodalInlineSizeError', () => {
    it('extends MultimodalNotSupportedError so parent catch handles it', () => {
      const err = new MultimodalInlineSizeError('openai', 2_000_000, 1_048_576)
      expect(err).toBeInstanceOf(MultimodalNotSupportedError)
      expect(err.code).toBe('MULTIMODAL_NOT_SUPPORTED')
      expect(err.inlineByteSize).toBe(2_000_000)
      expect(err.capBytes).toBe(1_048_576)
      expect(err.message).toContain('2000000')
      expect(err.message).toContain('1048576')
      expect(err.message).toMatch(/artifact_ref/i)
    })

    it('always reports blockType as image (size error fires on inline only)', () => {
      const err = new MultimodalInlineSizeError('openai', 100, 50)
      expect(err.blockType).toBe('image')
    })
  })
})
