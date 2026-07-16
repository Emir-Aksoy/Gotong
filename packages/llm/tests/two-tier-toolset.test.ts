/**
 * AFR-M2 两层化纯核的会红的门:
 * ① 目录 ∪ 一等 = 全集(长尾每个工具都出现在目录与 use_tool enum 里,零静默丢);
 * ② 转发与直调逐字节一致(结果对象同引用、isError 原样、异常原样上抛);
 * ③ 快照静止(首次 listTools 后目录/enum/路由表不再变形 —— 缓存前缀稳定);
 * ④ 冲突大声抛(跨 child 重名、遮蔽保留名都是装配 bug,绝不静默错路由)。
 */
import { describe, expect, it } from 'vitest'

import {
  LIST_TOOL_DIRECTORY,
  TwoTierToolNameCollisionError,
  TwoTierToolset,
  USE_TOOL,
} from '../src/two-tier-toolset.js'
import type {
  LlmAgentToolset,
  LlmToolCallResult,
  LlmToolDefinition,
} from '../src/types.js'

interface FakeToolset extends LlmAgentToolset {
  calls: Array<{ name: string; args: Record<string, unknown> }>
}

function makeToolset(
  tools: LlmToolDefinition[],
  impl?: (name: string, args: Record<string, unknown>) => LlmToolCallResult | Promise<LlmToolCallResult>,
): FakeToolset {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  return {
    calls,
    listTools: () => tools,
    callTool: async (name, args) => {
      calls.push({ name, args })
      if (impl) return impl(name, args)
      return { content: [{ type: 'text', text: `ran ${name}` }] }
    },
  }
}

const REMINDER_TOOL: LlmToolDefinition = {
  name: 'set_reminder',
  description: '给成员设一个提醒。红线:只提醒,绝不替成员执行任何对外动作。',
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: '提醒内容' },
      channel: { type: 'string', enum: ['im', 'web'], description: '投递渠道' },
      count: { type: 'integer', description: '重复次数' },
    },
    required: ['text'],
  },
}

const NO_ARG_TOOL: LlmToolDefinition = {
  name: 'list_things',
  description: '列出东西。',
  inputSchema: { type: 'object', properties: {} },
}

describe('TwoTierToolset(AFR-M2 两层化纯核)', () => {
  it('一等面恰好两个工具,use_tool enum = 长尾全集(门①:无静默丢)', async () => {
    const tail = makeToolset([REMINDER_TOOL, NO_ARG_TOOL])
    const tail2 = makeToolset([
      { name: 'other_tool', description: 'x', inputSchema: { type: 'object', properties: {} } },
    ])
    const two = new TwoTierToolset({ benignLongTail: [tail, tail2] })
    const defs = await two.listTools()
    expect(defs.map((d) => d.name)).toEqual([LIST_TOOL_DIRECTORY, USE_TOOL])
    const useDef = defs[1]!
    const props = useDef.inputSchema.properties as Record<string, Record<string, unknown>>
    expect(props.name!.enum).toEqual(['set_reminder', 'list_things', 'other_tool'])
    expect((useDef.inputSchema.required as string[])).toEqual(['name'])
  })

  it('目录渲染:每个长尾工具都在,description 全文保留(红线不截断),参数签名带必填/枚举', async () => {
    const two = new TwoTierToolset({ benignLongTail: [makeToolset([REMINDER_TOOL, NO_ARG_TOOL])] })
    const res = await two.callTool(LIST_TOOL_DIRECTORY, {})
    expect(res.isError).toBeUndefined()
    const text = (res.content[0] as { text: string }).text
    expect(text).toContain('set_reminder')
    // 全文含红线句 —— 截断丢红线是门②的反面教材
    expect(text).toContain('红线:只提醒,绝不替成员执行任何对外动作。')
    expect(text).toContain('text: string(必填)')
    expect(text).toContain('"im"|"web"')
    expect(text).toContain('list_things')
    expect(text).toContain('参数:无')
    expect(text).toContain('共 2 个')
  })

  it('转发逐字节一致:结果对象同引用、isError 原样透传、异常原样上抛(门②)', async () => {
    const okResult: LlmToolCallResult = {
      content: [{ type: 'text', text: 'exact payload' }, { type: 'text', text: 'second block' }],
    }
    const errResult: LlmToolCallResult = {
      content: [{ type: 'text', text: 'tool-level failure' }],
      isError: true,
    }
    const tail = makeToolset([REMINDER_TOOL, NO_ARG_TOOL], (name) => {
      if (name === 'set_reminder') return okResult
      return errResult
    })
    const two = new TwoTierToolset({ benignLongTail: [tail] })

    const forwarded = await two.callTool(USE_TOOL, { name: 'set_reminder', args: { text: 'hi' } })
    expect(forwarded).toBe(okResult) // 同一个对象引用 —— 不包不改

    const errForwarded = await two.callTool(USE_TOOL, { name: 'list_things' })
    expect(errForwarded).toBe(errResult)

    const boom = new Error('kaboom')
    const throwing = makeToolset(
      [{ name: 'explode', inputSchema: { type: 'object', properties: {} } }],
      () => {
        throw boom
      },
    )
    const two2 = new TwoTierToolset({ benignLongTail: [throwing] })
    await expect(two2.callTool(USE_TOOL, { name: 'explode' })).rejects.toBe(boom)
  })

  it('args 省略时按 {} 转发;内层拿到的 args 与直调一致', async () => {
    const tail = makeToolset([NO_ARG_TOOL])
    const two = new TwoTierToolset({ benignLongTail: [tail] })
    await two.callTool(USE_TOOL, { name: 'list_things' })
    expect(tail.calls).toEqual([{ name: 'list_things', args: {} }])
  })

  it('未知目录名:isError + 可用清单 + 指路 list_tool_directory,不转发', async () => {
    const tail = makeToolset([REMINDER_TOOL])
    const two = new TwoTierToolset({ benignLongTail: [tail] })
    const res = await two.callTool(USE_TOOL, { name: 'nope' })
    expect(res.isError).toBe(true)
    const text = (res.content[0] as { text: string }).text
    expect(text).toContain('nope')
    expect(text).toContain('set_reminder')
    expect(text).toContain(LIST_TOOL_DIRECTORY)
    expect(tail.calls).toHaveLength(0)
  })

  it('礼貌校验:缺必填/类型不符/枚举越界拒绝且不转发,报错带该工具参数签名', async () => {
    const tail = makeToolset([REMINDER_TOOL])
    const two = new TwoTierToolset({ benignLongTail: [tail] })

    const missing = await two.callTool(USE_TOOL, { name: 'set_reminder', args: {} })
    expect(missing.isError).toBe(true)
    expect((missing.content[0] as { text: string }).text).toContain('必填缺失')
    expect((missing.content[0] as { text: string }).text).toContain('text: string(必填)')

    const wrongType = await two.callTool(USE_TOOL, {
      name: 'set_reminder',
      args: { text: 42 },
    })
    expect(wrongType.isError).toBe(true)
    expect((wrongType.content[0] as { text: string }).text).toContain('期望 string')

    const badEnum = await two.callTool(USE_TOOL, {
      name: 'set_reminder',
      args: { text: 'x', channel: 'fax' },
    })
    expect(badEnum.isError).toBe(true)
    expect((badEnum.content[0] as { text: string }).text).toContain('"im" | "web"')

    const badInt = await two.callTool(USE_TOOL, {
      name: 'set_reminder',
      args: { text: 'x', count: 1.5 },
    })
    expect(badInt.isError).toBe(true)

    expect(tail.calls).toHaveLength(0)
  })

  it('fail-open:多余 key、不认识的 schema 关键字一律放行转发(校验绝不比一等暴露更严)', async () => {
    const exotic: LlmToolDefinition = {
      name: 'exotic',
      inputSchema: {
        type: 'object',
        properties: {
          s: { type: 'string', minLength: 99, format: 'email' }, // 不认识的关键字:不校验
          u: { anyOf: [{ type: 'string' }, { type: 'number' }] }, // 无 type:放行
        },
        required: ['s'],
      },
    }
    const tail = makeToolset([exotic])
    const two = new TwoTierToolset({ benignLongTail: [tail] })
    const res = await two.callTool(USE_TOOL, {
      name: 'exotic',
      args: { s: 'a', u: { deep: true }, extra_key: 'fine' },
    })
    expect(res.isError).toBeUndefined()
    expect(tail.calls).toEqual([
      { name: 'exotic', args: { s: 'a', u: { deep: true }, extra_key: 'fine' } },
    ])
  })

  it('use_tool 自身参数病:name 缺失/args 非对象 → isError 不炸回合', async () => {
    const two = new TwoTierToolset({ benignLongTail: [makeToolset([REMINDER_TOOL])] })
    const noName = await two.callTool(USE_TOOL, {})
    expect(noName.isError).toBe(true)
    const arrArgs = await two.callTool(USE_TOOL, { name: 'set_reminder', args: [1, 2] })
    expect(arrArgs.isError).toBe(true)
    expect((arrArgs.content[0] as { text: string }).text).toContain('必须是对象')
  })

  it('未知一等名:镜像 ComposedToolset 回 isError', async () => {
    const two = new TwoTierToolset({ benignLongTail: [] })
    const res = await two.callTool('made_up', {})
    expect(res.isError).toBe(true)
    expect((res.content[0] as { text: string }).text).toContain('unknown tool: made_up')
  })

  it('跨 child 重名:TwoTierToolNameCollisionError 大声抛(门④)', async () => {
    const a = makeToolset([REMINDER_TOOL])
    const b = makeToolset([{ ...REMINDER_TOOL }])
    const two = new TwoTierToolset({ benignLongTail: [a, b] })
    await expect(two.listTools()).rejects.toThrow(TwoTierToolNameCollisionError)
    await expect(two.listTools()).rejects.toThrow(/set_reminder/)
  })

  it('长尾遮蔽保留名(use_tool / list_tool_directory):同样大声抛,childIndices 含 -1', async () => {
    const shadow = makeToolset([
      { name: USE_TOOL, inputSchema: { type: 'object', properties: {} } },
    ])
    const two = new TwoTierToolset({ benignLongTail: [shadow] })
    const err = await two.listTools().then(
      () => null,
      (e: unknown) => e as TwoTierToolNameCollisionError,
    )
    expect(err).toBeInstanceOf(TwoTierToolNameCollisionError)
    expect(err!.collisions).toEqual([{ name: USE_TOOL, childIndices: [-1, 0] }])
  })

  it('快照静止:child 事后長出新工具,目录/enum/路由全不变形(门③缓存前缀稳定)', async () => {
    const mutable: LlmToolDefinition[] = [{ ...NO_ARG_TOOL }]
    const tail: FakeToolset = {
      calls: [],
      listTools: () => [...mutable],
      callTool: async (name) => ({ content: [{ type: 'text', text: `ran ${name}` }] }),
    }
    const two = new TwoTierToolset({ benignLongTail: [tail] })
    const first = await two.listTools()
    mutable.push({ name: 'late_arrival', inputSchema: { type: 'object', properties: {} } })
    const second = await two.listTools()
    expect(second).toEqual(first)
    const dir = await two.callTool(LIST_TOOL_DIRECTORY, {})
    expect((dir.content[0] as { text: string }).text).not.toContain('late_arrival')
    const res = await two.callTool(USE_TOOL, { name: 'late_arrival' })
    expect(res.isError).toBe(true)
  })

  it('异步 listTools 的 child 照常进目录', async () => {
    const tail: LlmAgentToolset = {
      listTools: async () => [REMINDER_TOOL],
      callTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    }
    const two = new TwoTierToolset({ benignLongTail: [tail] })
    const defs = await two.listTools()
    const props = defs[1]!.inputSchema.properties as Record<string, Record<string, unknown>>
    expect(props.name!.enum).toEqual(['set_reminder'])
  })

  it('runForTask 全转发:每个带 runForTask 的 child 都包住 fn,第一个 child 在最外层(能力零阉割)', async () => {
    const order: string[] = []
    const scoped = (label: string): LlmAgentToolset => ({
      listTools: () => [],
      callTool: async () => ({ content: [] }),
      runForTask: async (_task, fn) => {
        order.push(`${label}:in`)
        try {
          return await fn()
        } finally {
          order.push(`${label}:out`)
        }
      },
    })
    const plain = makeToolset([NO_ARG_TOOL]) // 无 runForTask:跳过不碍事
    const two = new TwoTierToolset({ benignLongTail: [scoped('a'), plain, scoped('b')] })
    const task = { id: 't1', from: 'user:x' }
    const out = await two.runForTask(task, async () => {
      order.push('fn')
      return 42
    })
    expect(out).toBe(42)
    expect(order).toEqual(['a:in', 'b:in', 'fn', 'b:out', 'a:out'])
  })

  it('空长尾:一等面照常可用,enum 省略,目录如实说空', async () => {
    const two = new TwoTierToolset({ benignLongTail: [] })
    const defs = await two.listTools()
    const props = defs[1]!.inputSchema.properties as Record<string, Record<string, unknown>>
    expect(props.name!.enum).toBeUndefined()
    const dir = await two.callTool(LIST_TOOL_DIRECTORY, {})
    expect((dir.content[0] as { text: string }).text).toContain('空')
  })
})
