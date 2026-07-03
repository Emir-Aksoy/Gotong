/**
 * WIZ-M1 — 统一组件目录纯函数的单测。
 *
 * 钉死的承诺：
 *   1. 五源合并，kind / status 归类正确（人是 human，不是 agent 的亚种）
 *   2. 诚实边界：不可用资源（端点不通 / CLI 不在 / key 没设）不进目录
 *   3. 已装去重：spec.name 命中已装 MCP 的预置连接器不再列
 *   4. 确定性：同输入必同输出（组间固定序 + 组内 id 序）
 *   5. 渲染：已装 / 预置分节，预置节头写明需批准；截断诚实标注
 */

import { describe, expect, it } from 'vitest'

import {
  buildComponentCatalog,
  installedCapabilities,
  renderCatalogForPrompt,
  type CatalogInputs,
} from '../src/component-catalog.js'

const FULL: CatalogInputs = {
  participants: [
    { id: 'writer', kind: 'agent', capabilities: ['draft', 'revise'], description: '中文写手' },
    { id: 'alice', kind: 'human', capabilities: ['approve'] },
    { id: 'bridge', kind: 'external', capabilities: ['translate'] }, // 未知 kind → agent 兜底
  ],
  installedMcpServers: [{ name: 'filesystem', description: '读写共享目录' }],
  resources: {
    llmKeys: [
      { provider: 'deepseek', envSet: true, vaultConfigured: false },
      { provider: 'openai', envSet: false, vaultConfigured: false }, // 不可用 → 不进
    ],
    localEndpoints: [
      { label: 'ollama', url: 'http://127.0.0.1:11434', reachable: true },
      { label: 'vllm', url: 'http://127.0.0.1:8000', reachable: false }, // 不通 → 不进
    ],
    cliAgents: [
      { command: 'claude', label: 'Claude Code', found: true },
      { command: 'codex', label: 'Codex CLI', found: false }, // 不在 PATH → 不进
    ],
  },
  presetTemplates: [{ id: 'editorial-flow', name: '编辑部流程', description: '起草→评审一键跑' }],
  presetConnectors: [
    { id: 'obsidian', name: 'Obsidian 笔记', whatFor: '读你的笔记库', specName: 'obsidian', needsEnv: ['OBSIDIAN_API_KEY'] },
    { id: 'fs-preset', name: '文件系统', whatFor: '读写本地文件', specName: 'filesystem' }, // 已装同名 → 去重
  ],
}

describe('buildComponentCatalog', () => {
  it('merges five sources with correct kind/status; humans are humans', () => {
    const cat = buildComponentCatalog(FULL)
    const byId = new Map(cat.map((e) => [`${e.kind}:${e.id}`, e]))

    expect(byId.get('human:alice')?.status).toBe('installed')
    expect(byId.get('human:alice')?.capabilities).toEqual(['approve'])
    expect(byId.get('agent:writer')?.description).toBe('中文写手')
    expect(byId.get('agent:bridge')).toBeDefined() // 未知 kind 兜底成 agent
    expect(byId.get('mcp:filesystem')?.status).toBe('installed')
    expect(byId.get('endpoint:ollama')?.note).toBe('http://127.0.0.1:11434')
    expect(byId.get('cli:Claude Code')?.note).toBe('claude')
    expect(byId.get('llm-provider:deepseek')?.status).toBe('installed')
    expect(byId.get('template:editorial-flow')?.install).toEqual({ via: 'template', ref: 'editorial-flow' })
    expect(byId.get('connector:obsidian')?.install).toEqual({ via: 'connector', ref: 'obsidian' })
    expect(byId.get('connector:obsidian')?.note).toContain('OBSIDIAN_API_KEY')
  })

  it('honest boundary: unusable resources are excluded', () => {
    const cat = buildComponentCatalog(FULL)
    expect(cat.find((e) => e.id === 'vllm')).toBeUndefined()
    expect(cat.find((e) => e.id === 'Codex CLI')).toBeUndefined()
    expect(cat.find((e) => e.kind === 'llm-provider' && e.id === 'openai')).toBeUndefined()
  })

  it('dedupes preset connectors already installed by spec name', () => {
    const cat = buildComponentCatalog(FULL)
    expect(cat.find((e) => e.kind === 'connector' && e.id === 'fs-preset')).toBeUndefined()
    // 而没被去重的预置连接器还在
    expect(cat.find((e) => e.kind === 'connector' && e.id === 'obsidian')).toBeDefined()
  })

  it('is deterministic: same input → identical output; groups ordered, ids sorted', () => {
    const a = buildComponentCatalog(FULL)
    const b = buildComponentCatalog(FULL)
    expect(a).toEqual(b)
    // 人排最前，预置排最后
    expect(a[0]!.kind).toBe('human')
    expect(a[a.length - 1]!.status).toBe('available')
    // 组内 id 有序（agent 组：bridge < writer）
    const agents = a.filter((e) => e.kind === 'agent').map((e) => e.id)
    expect(agents).toEqual([...agents].sort((x, y) => x.localeCompare(y)))
  })

  it('empty inputs → empty catalog', () => {
    expect(buildComponentCatalog({})).toEqual([])
  })
})

describe('renderCatalogForPrompt', () => {
  it('renders installed and preset sections separately; preset header says approval needed', () => {
    const text = renderCatalogForPrompt(buildComponentCatalog(FULL))
    expect(text).toContain('=== 本 hub 已有组件（现在就能用）===')
    expect(text).toContain('=== 预置组件（还没装；提议使用需经用户批准安装）===')
    expect(text).toContain('- alice [approve]')
    expect(text).toContain('- writer [draft, revise] — 中文写手')
    expect(text).toContain('editorial-flow')
    // 预置节在已装节之后
    expect(text.indexOf('已有组件')).toBeLessThan(text.indexOf('预置组件'))
  })

  it('includeAvailable=false hides the preset section entirely', () => {
    const text = renderCatalogForPrompt(buildComponentCatalog(FULL), { includeAvailable: false })
    expect(text).not.toContain('预置组件')
    expect(text).not.toContain('editorial-flow')
  })

  it('caps each kind at maxPerKind with an honest truncation marker', () => {
    const many: CatalogInputs = {
      participants: Array.from({ length: 5 }, (_, i) => ({
        id: `a${i}`,
        kind: 'agent',
        capabilities: ['x'],
      })),
    }
    const text = renderCatalogForPrompt(buildComponentCatalog(many), { maxPerKind: 3 })
    expect(text).toContain('…等 5 个（已截断）')
    expect(text).toContain('- a0 [x]')
    expect(text).not.toContain('- a4')
  })

  it('empty catalog renders the explicit empty marker (not a blank string)', () => {
    const text = renderCatalogForPrompt([])
    expect(text).toContain('（空 —— 这个 hub 还没有任何可用组件）')
  })
})

describe('installedCapabilities', () => {
  it('collects capabilities from installed humans+agents only', () => {
    const caps = installedCapabilities(buildComponentCatalog(FULL))
    expect(caps.has('draft')).toBe(true)
    expect(caps.has('approve')).toBe(true) // 人也算资源
    expect(caps.has('translate')).toBe(true)
    expect(caps.size).toBe(4) // draft, revise, approve, translate
  })
})
