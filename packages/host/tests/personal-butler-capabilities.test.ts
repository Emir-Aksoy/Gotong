/**
 * B1 能力发现 / help — the `list_my_capabilities` tool renders a "我能帮你做这些"
 * list DERIVED from the butler's live tool names, so it never advertises a
 * capability that isn't wired.
 *
 * Pins: (1) only capabilities whose signal tool is live appear (no over-promise);
 * (2) connected MCP servers are named from the `<server>__<tool>` prefixes;
 * (3) an empty tool set still answers honestly; (4) the tool returns the card.
 */

import { describe, expect, it } from 'vitest'

import {
  buildButlerCapabilitiesToolset,
  renderCapabilityCard,
} from '../src/personal-butler-capabilities.js'

describe('renderCapabilityCard', () => {
  it('lists only the capabilities whose signal tool is live', () => {
    const card = renderCapabilityCard(['set_reminder', 'show_my_memory'])
    expect(card).toContain('定时提醒')
    expect(card).toContain('你记得我什么')
    // Not wired → not advertised.
    expect(card).not.toContain('工作流')
    expect(card).not.toContain('对端 hub')
  })

  it('marks governed verbs as needing confirmation (honest about the gate)', () => {
    const card = renderCapabilityCard(['create_workflow'])
    expect(card).toContain('搭个新工作流')
    expect(card).toContain('过目')
  })

  it('names connected MCP servers from the <server>__<tool> prefixes', () => {
    const card = renderCapabilityCard([
      'set_reminder',
      'notion-notes__search',
      'notion-notes__get_page',
      'google-calendar__list_events',
    ])
    expect(card).toContain('你连接的外部工具')
    expect(card).toContain('notion-notes')
    expect(card).toContain('google-calendar')
    // De-duplicated: one server listed once, not per tool.
    expect(card.match(/notion-notes/g)?.length).toBe(1)
  })

  it('answers honestly when no member-facing verb is wired', () => {
    const card = renderCapabilityCard([])
    expect(card).toContain('陪你聊天')
    expect(card).not.toContain('- ')
  })

  it('ignores non-namespaced names when detecting connectors', () => {
    // A plain builtin name has no `__`, so it must not be read as a server.
    const card = renderCapabilityCard(['set_reminder'])
    expect(card).not.toContain('你连接的外部工具')
  })
})

describe('list_my_capabilities tool', () => {
  it('returns the rendered card for the live tool names', async () => {
    const ts = buildButlerCapabilitiesToolset({
      toolNames: () => ['set_reminder', 'run_my_workflow'],
    })
    const r = await ts.callTool('list_my_capabilities', {})
    expect(r.isError).toBeUndefined()
    const text = r.content[0]?.type === 'text' ? r.content[0].text : ''
    expect(text).toContain('定时提醒')
    expect(text).toContain('跑你的工作流')
  })

  it('reflects the CURRENT tool set each call (lazy getter)', async () => {
    let names: string[] = ['set_reminder']
    const ts = buildButlerCapabilitiesToolset({ toolNames: () => names })
    const before = await ts.callTool('list_my_capabilities', {})
    expect((before.content[0] as { text: string }).text).not.toContain('跑你的工作流')
    names = ['set_reminder', 'run_my_workflow'] // a surface came online
    const after = await ts.callTool('list_my_capabilities', {})
    expect((after.content[0] as { text: string }).text).toContain('跑你的工作流')
  })

  it('an unknown tool name is a tool error, not a throw', async () => {
    const ts = buildButlerCapabilitiesToolset({ toolNames: () => [] })
    const r = await ts.callTool('nope', {})
    expect(r.isError).toBe(true)
  })
})
