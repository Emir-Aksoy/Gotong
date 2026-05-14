/**
 * Regression test for the `case-context` helper.
 *
 * Uses a hand-rolled in-memory `MemoryHandle` (no plugin attach, no
 * disk I/O) so the suite is fast and free of fs flake — the helper's
 * contract is what we're verifying, not the file backend (the file
 * backend has its own contract test).
 */

import { describe, expect, it } from 'vitest'

import type {
  MemoryEntry,
  MemoryHandle,
  MemoryKind,
  MemoryQuery,
  NewMemoryEntry,
} from '@aipehub/services-sdk'

import {
  formatCaseContextBlock,
  recallCaseConversation,
  recallCaseStepOutputs,
  recordCaseConversation,
  recordCaseStepOutput,
  type CaseContextBinding,
} from '../src/services/case-context.js'

// In-memory MemoryHandle — the minimum surface case-context calls.
function createInMemoryMemory(): MemoryHandle & { _all(): MemoryEntry[] } {
  const entries: MemoryEntry[] = []
  let counter = 0
  return {
    async recall(query: MemoryQuery): Promise<MemoryEntry[]> {
      const k = query.k ?? 20
      const kinds = query.kinds
      const since = query.since ?? 0
      const text = query.text?.toLowerCase()
      return entries
        .filter((e) => !kinds || kinds.includes(e.kind))
        .filter((e) => e.ts >= since)
        .filter((e) => !text || e.text.toLowerCase().includes(text))
        .sort((a, b) => b.ts - a.ts)
        .slice(0, k)
    },
    async remember(entry: NewMemoryEntry): Promise<MemoryEntry> {
      counter += 1
      const ts = Date.now() + counter // unique monotonic
      const persisted: MemoryEntry = {
        id: entry.id ?? `e${counter}`,
        kind: entry.kind,
        text: entry.text,
        ts,
        ...(entry.meta !== undefined ? { meta: entry.meta } : {}),
      }
      entries.push(persisted)
      return persisted
    },
    async list(opts: { kind?: MemoryKind; limit?: number } = {}): Promise<MemoryEntry[]> {
      const limit = opts.limit ?? 100
      return entries
        .filter((e) => !opts.kind || e.kind === opts.kind)
        .sort((a, b) => b.ts - a.ts)
        .slice(0, limit)
    },
    async forget(id: string): Promise<void> {
      const ix = entries.findIndex((e) => e.id === id)
      if (ix >= 0) entries.splice(ix, 1)
    },
    async clear(kind?: MemoryKind): Promise<void> {
      if (!kind) {
        entries.length = 0
      } else {
        for (let i = entries.length - 1; i >= 0; i--) {
          if (entries[i]!.kind === kind) entries.splice(i, 1)
        }
      }
    },
    _all(): MemoryEntry[] {
      return [...entries]
    },
  }
}

describe('case-context helpers', () => {
  it('records and recalls conversation entries scoped to a case', async () => {
    const memory = createInMemoryMemory()
    const binding: CaseContextBinding = { caseId: 'case-A', memory }

    await recordCaseConversation(binding, {
      source: 'user',
      text: '我想加一个外卖业务',
      stepId: 'intake',
    })
    await recordCaseConversation(binding, {
      source: 'coach',
      text: '收到，外卖会被带入 draft 阶段考虑',
      stepId: 'intake',
    })

    const conv = await recallCaseConversation(binding)
    expect(conv).toHaveLength(2)
    expect(conv[0]!.source).toBe('user')
    expect(conv[0]!.text).toBe('我想加一个外卖业务')
    expect(conv[0]!.stepId).toBe('intake')
    expect(conv[1]!.source).toBe('coach')
    // Order should be oldest-first
    expect(conv[0]!.at <= conv[1]!.at).toBe(true)
  })

  it('isolates entries by caseId — caseA does not see caseB', async () => {
    const memory = createInMemoryMemory()
    const a: CaseContextBinding = { caseId: 'case-A', memory }
    const b: CaseContextBinding = { caseId: 'case-B', memory }

    await recordCaseConversation(a, { source: 'user', text: 'A: 餐饮' })
    await recordCaseConversation(b, { source: 'user', text: 'B: 零售' })
    await recordCaseConversation(a, { source: 'coach', text: 'A: 收到餐饮' })

    const convA = await recallCaseConversation(a)
    const convB = await recallCaseConversation(b)
    expect(convA.map((e) => e.text)).toEqual(['A: 餐饮', 'A: 收到餐饮'])
    expect(convB.map((e) => e.text)).toEqual(['B: 零售'])
  })

  it('records and recalls step outputs separately from conversation', async () => {
    const memory = createInMemoryMemory()
    const binding: CaseContextBinding = { caseId: 'case-X', memory }

    await recordCaseStepOutput(binding, {
      stepId: 'intake',
      text: '## 我想先了解几件事\n1. ...',
    })
    await recordCaseConversation(binding, {
      source: 'user',
      text: '帮我补一条问题',
    })
    await recordCaseStepOutput(binding, {
      stepId: 'research',
      text: '## 关键洞察\n...',
    })

    const conv = await recallCaseConversation(binding)
    expect(conv).toHaveLength(1)
    expect(conv[0]!.source).toBe('user')

    const stepOuts = await recallCaseStepOutputs(binding)
    expect(stepOuts.map((s) => s.stepId)).toEqual(['intake', 'research'])
    expect(stepOuts[0]!.text).toMatch(/^## 我想先了解/)
  })

  it('formatCaseContextBlock produces a readable prompt prefix', () => {
    const block = formatCaseContextBlock({
      conversation: [
        { source: 'user', text: '加一条外卖业务', at: '2026-05-14T10:00:00Z', id: 'e1', stepId: 'intake' },
        { source: 'coach', text: '已记下，draft 阶段会涵盖', at: '2026-05-14T10:01:00Z', id: 'e2', stepId: 'intake' },
        { source: 'manager', text: '建议派给 industry-research', at: '2026-05-14T10:02:00Z', id: 'e3' },
      ],
      stepOutputs: [
        { stepId: 'intake', text: '完整问题清单（200 字以上）', at: '2026-05-14T10:00:30Z', id: 's1' },
      ],
    })
    expect(block).toContain('当前 case 的已有上下文')
    expect(block).toContain('对话历史')
    expect(block).toContain('已完成步骤产物')
    expect(block).toContain('[user@intake] 加一条外卖业务')
    expect(block).toContain('[coach@intake] 已记下')
    expect(block).toContain('[manager] 建议派给 industry-research')
    expect(block).toContain('[intake] 完整问题清单')
  })

  it('formatCaseContextBlock returns empty string when nothing is provided', () => {
    expect(formatCaseContextBlock({ conversation: [] })).toBe('')
  })

  it('respects includeStepOutputs filter', () => {
    const block = formatCaseContextBlock({
      conversation: [],
      stepOutputs: [
        { stepId: 'intake', text: 'I', at: 't1', id: 's1' },
        { stepId: 'research', text: 'R', at: 't2', id: 's2' },
        { stepId: 'draft', text: 'D', at: 't3', id: 's3' },
      ],
      includeStepOutputs: ['intake', 'research'],
    })
    expect(block).toContain('[intake]')
    expect(block).toContain('[research]')
    expect(block).not.toContain('[draft]')
  })

  it('truncates long step output text in the formatted block', () => {
    const longText = 'A'.repeat(500)
    const block = formatCaseContextBlock({
      conversation: [],
      stepOutputs: [{ stepId: 'draft', text: longText, at: 't', id: 's' }],
    })
    expect(block).toContain('…')
    // The truncation cap is 280 chars, so the block should be shorter than full longText
    expect(block.length).toBeLessThan(longText.length + 200)
  })

  it('round-trips meta into the underlying memory entry shape', async () => {
    const memory = createInMemoryMemory()
    const binding: CaseContextBinding = { caseId: 'case-meta', memory }
    await recordCaseConversation(binding, {
      source: 'analyst',
      text: '行业洞察摘要',
      stepId: 'research',
    })
    const raw = memory._all()
    expect(raw).toHaveLength(1)
    const meta = raw[0]!.meta as Record<string, unknown>
    expect(meta.caseId).toBe('case-meta')
    expect(meta.topic).toBe('conversation')
    expect(meta.source).toBe('analyst')
    expect(meta.stepId).toBe('research')
    expect(typeof meta.at).toBe('string')
  })
})
