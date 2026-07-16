/**
 * WSE 承重门 — 「联网搜索成为阿同 key 即用能力」的三个纯核面:
 *
 *   1. detect — 目录条目声明的凭证 env(`needsEnv`)全都非空 ⇒ 该条目的 spec
 *      原样入列;key 在 spec 里只以 `${NAME}` 占位存在,**明文值结构性进不来**;
 *      没设 key ⇒ `[]` ⇒ 全链路字节不变。
 *   2. classify — 官方搜索 server(tavily/brave)的工具兜底判 read。这是分级
 *      断点的修复:两家官方 server 都没标 readOnlyHint、工具名又不以 read 动词
 *      开头,默认分级 fail-safe 全落 governed = 每搜一次 park 一次。豁免只接
 *      「毫无信号」的兜底段 —— server 显式声明的 write(destructiveHint /
 *      readOnlyHint:false)永远尊重;名单外 server 走默认分级原样。
 *   3. merge — bonus 只补缺,同名让位(成员/管理员自己配的 server 永远赢)。
 *
 * 另钉目录同源:specs / env 名 / server 名全从 BUILTIN_MCP_CONNECTORS 派生,
 * 目录条目改形状(id / needsEnv / spec.name)这里要红。
 */

import { describe, expect, it } from 'vitest'

import type { McpServerSpec } from '@gotong/core'
import { BUILTIN_MCP_CONNECTORS } from '@gotong/web'

import {
  classifyButlerMcpTool,
  detectButlerWebSearchSpecs,
  mergeButlerBonusMcpSpecs,
  WEB_SEARCH_READONLY_SERVERS,
} from '../src/butler-web-search.js'

const byId = (id: string) => BUILTIN_MCP_CONNECTORS.find((c) => c.id === id)

describe('WSE — 目录同源(specs/名单从 BUILTIN_MCP_CONNECTORS 派生)', () => {
  it('两条官方搜索连接器仍在目录里,形状未漂', () => {
    const tavily = byId('tavily-web-search')
    const brave = byId('brave-web-search')
    expect(tavily).toBeDefined()
    expect(brave).toBeDefined()
    expect(tavily!.category).toBe('web')
    expect(brave!.category).toBe('web')
    // 数据离盒披露是这两条的结构性事实(搜索词发往第三方云)。
    expect(tavily!.dataLeavesBox).toBe(true)
    expect(brave!.dataLeavesBox).toBe(true)
    expect(tavily!.needsEnv).toEqual(['TAVILY_API_KEY'])
    expect(brave!.needsEnv).toEqual(['BRAVE_API_KEY'])
  })

  it('只读 server 名单 = 目录条目的 spec.name(单一事实源)', () => {
    expect([...WEB_SEARCH_READONLY_SERVERS]).toEqual(['tavily', 'brave'])
  })
})

describe('WSE — detectButlerWebSearchSpecs(env 快路探测)', () => {
  it('没设 key → [](opt-in 字节不变)', () => {
    expect(detectButlerWebSearchSpecs({})).toEqual([])
    expect(detectButlerWebSearchSpecs({ UNRELATED: 'x' })).toEqual([])
  })

  it('空白串不算设了 key', () => {
    expect(detectButlerWebSearchSpecs({ TAVILY_API_KEY: '' })).toEqual([])
    expect(detectButlerWebSearchSpecs({ TAVILY_API_KEY: '   ' })).toEqual([])
  })

  it('TAVILY_API_KEY 在 → 目录的 tavily 托管 http spec;key 只以占位存在', () => {
    const specs = detectButlerWebSearchSpecs({ TAVILY_API_KEY: 'tvly-real-secret-123' })
    expect(specs).toHaveLength(1)
    expect(specs[0]).toBe(byId('tavily-web-search')!.spec) // 原样引用,零复刻
    const wire = JSON.stringify(specs)
    expect(wire).toContain('${TAVILY_API_KEY}') // 占位
    expect(wire).not.toContain('tvly-real-secret-123') // 明文结构性进不来
    // 隐私红线延续:key 走 Authorization 头,绝不进 URL query。
    expect(wire).not.toMatch(/mcp\.tavily\.com[^"]*tavilyApiKey/)
  })

  it('BRAVE_API_KEY 在 → 目录的 brave stdio spec', () => {
    const specs = detectButlerWebSearchSpecs({ BRAVE_API_KEY: 'brv-real-secret' })
    expect(specs).toHaveLength(1)
    expect(specs[0]).toBe(byId('brave-web-search')!.spec)
    expect(JSON.stringify(specs)).not.toContain('brv-real-secret')
  })

  it('双 key → 两条都挂(tavily 先,目录序)', () => {
    const specs = detectButlerWebSearchSpecs({
      TAVILY_API_KEY: 'a',
      BRAVE_API_KEY: 'b',
    })
    expect(specs.map((s) => s.name)).toEqual(['tavily', 'brave'])
  })
})

describe('WSE — classifyButlerMcpTool(搜索 server 只读兜底)', () => {
  it('搜索 server 的无信号工具兜底 read(含未来新工具,server 级不锁名)', () => {
    expect(classifyButlerMcpTool({ name: 'tavily__tavily_search' })).toBe('read')
    expect(classifyButlerMcpTool({ name: 'tavily__tavily_extract' })).toBe('read')
    expect(classifyButlerMcpTool({ name: 'tavily__whatever_future_tool' })).toBe('read')
    expect(classifyButlerMcpTool({ name: 'brave__brave_web_search' })).toBe('read')
    expect(classifyButlerMcpTool({ name: 'brave__brave_summarizer' })).toBe('read')
  })

  it('server 显式声明的 write 赢名单(未来真加了破坏性工具照 govern)', () => {
    expect(
      classifyButlerMcpTool({ name: 'tavily__x', annotations: { destructiveHint: true } }),
    ).toBe('write')
    expect(
      classifyButlerMcpTool({ name: 'brave__x', annotations: { readOnlyHint: false } }),
    ).toBe('write')
  })

  it('名单外 server 走默认分级原样(启发 read / fail-safe write 不受影响)', () => {
    expect(classifyButlerMcpTool({ name: 'notes__create_note' })).toBe('write')
    expect(classifyButlerMcpTool({ name: 'notes__list_notes' })).toBe('read')
    expect(classifyButlerMcpTool({ name: 'bare_tool_no_prefix' })).toBe('write')
    expect(
      classifyButlerMcpTool({ name: 'notes__anything', annotations: { readOnlyHint: true } }),
    ).toBe('read')
  })
})

describe('WSE — mergeButlerBonusMcpSpecs(同名让位)', () => {
  const spec = (name: string, command: string): McpServerSpec => ({ name, command, args: [] })

  it('bonus 为空 → 原数组同一引用(非管家路径零分配零变化)', () => {
    const resolved = [spec('a', '/a')]
    expect(mergeButlerBonusMcpSpecs(resolved, [])).toBe(resolved)
  })

  it('bonus 补缺:resolved 空时全部追加', () => {
    const out = mergeButlerBonusMcpSpecs([], [spec('tavily', '/t'), spec('brave', '/b')])
    expect(out.map((s) => s.name)).toEqual(['tavily', 'brave'])
  })

  it('同名让位:用户自己的 server 原样保留,bonus 只补没有的', () => {
    const mine = spec('tavily', '/my-own-tavily-proxy')
    const out = mergeButlerBonusMcpSpecs(
      [mine],
      [spec('tavily', '/catalog'), spec('brave', '/b')],
    )
    expect(out).toHaveLength(2)
    expect(out[0]).toBe(mine) // 用户那份赢,连引用都不换
    expect(out[1]!.name).toBe('brave')
  })
})
