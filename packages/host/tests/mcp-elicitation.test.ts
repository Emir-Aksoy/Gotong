/**
 * ELIC — declineElicitations 策略单测。wire 层(能力声明/round-trip/
 * handler 崩溃折 cancel/url 拒斥)在 @gotong/mcp-client 的真 stdio 测试
 * 里;这里只钉宿主策略自己的合同:恒 decline + warn 带上下文 + 绝不把
 * 答案内容(没有)或 key 样物带进日志。
 */

import { describe, expect, it } from 'vitest'

import { declineElicitations } from '../src/mcp-elicitation.js'

function warnCollector(): {
  warns: Array<{ msg: string; data?: Record<string, unknown> }>
  log: { warn: (msg: string, data?: Record<string, unknown>) => void }
} {
  const warns: Array<{ msg: string; data?: Record<string, unknown> }> = []
  return { warns, log: { warn: (msg, data) => void warns.push({ msg, ...(data ? { data } : {}) }) } }
}

describe('ELIC — declineElicitations', () => {
  it('declines every request — strictly {action: decline}, no content key', async () => {
    const { log } = warnCollector()
    const policy = declineElicitations(log, 'butler-1')
    const answer = await policy({
      serverName: 'notion',
      message: 'Which workspace?',
      requestedSchema: { type: 'object', properties: { workspace: { type: 'string' } } },
    })
    expect(answer).toEqual({ action: 'decline' })
    expect('content' in answer).toBe(false)
  })

  it('warn carries agentId + serverName + question + FIELD NAMES (never values — there are none)', async () => {
    const { warns, log } = warnCollector()
    const policy = declineElicitations(log, 'butler-1')
    await policy({
      serverName: 'notion',
      message: 'Which workspace?',
      requestedSchema: {
        type: 'object',
        properties: { workspace: { type: 'string' }, region: { type: 'string' } },
        required: ['workspace'],
      },
    })
    expect(warns).toHaveLength(1)
    expect(warns[0]!.msg).toContain('auto-declined')
    expect(warns[0]!.data).toMatchObject({
      agentId: 'butler-1',
      serverName: 'notion',
      message: 'Which workspace?',
      fields: ['workspace', 'region'],
    })
  })

  it('stays calm on a degenerate schema (no properties) and without an agentId', async () => {
    const { warns, log } = warnCollector()
    const policy = declineElicitations(log)
    const answer = await policy({
      serverName: 'odd',
      message: 'hm?',
      requestedSchema: { type: 'object', properties: {} },
    })
    expect(answer).toEqual({ action: 'decline' })
    expect(warns[0]!.data).toMatchObject({ serverName: 'odd', fields: [] })
    expect(warns[0]!.data).not.toHaveProperty('agentId')
  })
})
