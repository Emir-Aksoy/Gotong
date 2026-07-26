/**
 * ELIC — declineElicitations 策略单测。wire 层(能力声明/round-trip/
 * handler 崩溃折 cancel/url 拒斥)在 @gotong/mcp-client 的真 stdio 测试
 * 里;这里只钉宿主策略自己的合同:恒 decline + warn 带上下文 + 绝不把
 * 答案内容(没有)或 key 样物带进日志。
 */

import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

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
      messageChars: 'Which workspace?'.length,
      fields: ['workspace', 'region'],
      fieldCount: 2,
    })
  })

  it('sanitizes hostile peer content: control chars stripped, overlength truncated, raw sizes kept', async () => {
    const { warns, log } = warnCollector()
    const policy = declineElicitations(log)
    const hostileMessage = `line1\n\u001b[31mANSI\u0007bell\u0000nul  spaced${'x'.repeat(300)}`
    const props: Record<string, { type: string }> = {}
    for (let i = 0; i < 12; i++) props[`field_${i}_${'y'.repeat(100)}`] = { type: 'string' }
    await policy({
      serverName: 'hostile',
      message: hostileMessage,
      requestedSchema: { type: 'object', properties: props },
    })
    const data = warns[0]!.data!
    const message = data.message as string
    // 单行、无控制字符、截断到上限(截断位补 …)
    expect(message).not.toMatch(/[\u0000-\u001f\u007f]/)
    expect(message.length).toBeLessThanOrEqual(120)
    expect(message.endsWith('…')).toBe(true)
    expect(message).toContain('line1 ')
    // 截断不是隐瞒:原始长度如实保留
    expect(data.messageChars).toBe(hostileMessage.length)
    // 字段数封顶 + 单字段名截断,原始计数保留
    const fields = data.fields as string[]
    expect(fields).toHaveLength(8)
    for (const f of fields) {
      expect(f.length).toBeLessThanOrEqual(40)
      expect(f).not.toMatch(/[\u0000-\u001f\u007f]/)
    }
    expect(data.fieldCount).toBe(12)
  })

  it('TRIPWIRE — every McpToolset construction in host src carries an elicitation policy', async () => {
    // 宿主里任何一个 McpToolset 构造点漏掉 elicitation,该 toolset 的能力集
    // 就退回 {},规范正确的连接器会拿到「client 不支持」而不是 decline。
    // 扫源钉死:每个 `new McpToolset(` 的参数体里必须出现 `elicitation:`。
    const srcDir = join(__dirname, '..', 'src')
    const files = (await readdir(srcDir)).filter((f) => f.endsWith('.ts'))
    const sites: Array<{ file: string; ok: boolean }> = []
    for (const f of files) {
      const text = await readFile(join(srcDir, f), 'utf8')
      let idx = 0
      for (;;) {
        const at = text.indexOf('new McpToolset(', idx)
        if (at === -1) break
        // 构造参数是单个 options 字面量;向后看一段窗口内是否带 elicitation 键。
        const window = text.slice(at, at + 400)
        sites.push({ file: f, ok: window.includes('elicitation:') })
        idx = at + 1
      }
    }
    expect(sites.length).toBeGreaterThanOrEqual(2) // agent 路径 + 跨 hub proxy
    for (const s of sites) {
      expect(s, `new McpToolset in ${s.file} lacks an elicitation policy`).toMatchObject({ ok: true })
    }
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
