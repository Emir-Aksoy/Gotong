/**
 * WIZ-M4 — 装配胶水的单测：五个活源 → CatalogInputs → 接好线的向导 service。
 *
 * 钉死的承诺：
 *   1. 五源投影正确（模板卡片 agent 名 displayName 优先、连接器 specName 走
 *      spec.name、RES 行原样透传）
 *   2. 逐源容错：单个源抛错只丢那一角，目录不整体失败
 *   3. createWorkflowWizard 端到端：prepare 的目录文本真来自活源；
 *      existingWorkflowIds 抛错被吞（best-effort）
 */

import { describe, expect, it } from 'vitest'

import { collectCatalogInputs, createWorkflowWizard, type WizardCatalogSources } from '../src/wizard-wiring.js'

const SOURCES: WizardCatalogSources = {
  participants: () => [
    { id: 'writer', kind: 'agent', capabilities: ['draft'] },
    { id: 'alice', kind: 'human', capabilities: ['approve'] },
  ],
  mcpServers: async () => [{ spec: { name: 'filesystem', description: '读写共享目录' } }],
  inventory: async () => ({
    llmKeys: [{ provider: 'deepseek', envSet: true, vaultConfigured: false }],
    localEndpoints: [{ label: 'ollama', url: 'http://127.0.0.1:11434', reachable: true }],
    cliAgents: [{ command: 'claude', label: 'Claude Code', found: false }],
  }),
  templateCards: () => [
    {
      id: 'legal-pack',
      name: '法务包',
      description: '合同审查一键跑',
      agents: [{ id: 'lawyer', displayName: '律师', capabilities: ['law-review'] }],
    },
  ],
  connectors: () => [
    { id: 'obsidian', name: 'Obsidian 笔记', whatFor: '读你的笔记库', needsEnv: ['OBSIDIAN_API_KEY'], spec: { name: 'obsidian' } },
  ],
}

describe('collectCatalogInputs', () => {
  it('projects all five sources into CatalogInputs shapes', async () => {
    const inputs = await collectCatalogInputs(SOURCES)
    expect(inputs.participants).toEqual([
      { id: 'writer', kind: 'agent', capabilities: ['draft'] },
      { id: 'alice', kind: 'human', capabilities: ['approve'] },
    ])
    expect(inputs.installedMcpServers).toEqual([{ name: 'filesystem', description: '读写共享目录' }])
    expect(inputs.resources?.llmKeys).toEqual([{ provider: 'deepseek', envSet: true, vaultConfigured: false }])
    expect(inputs.resources?.cliAgents?.[0]?.found).toBe(false) // 原样透传，过滤是目录的事
    // 模板 agent 名：displayName 优先（那是给人看的名）
    expect(inputs.presetTemplates?.[0]?.agents).toEqual([{ name: '律师', capabilities: ['law-review'] }])
    expect(inputs.presetConnectors).toEqual([
      { id: 'obsidian', name: 'Obsidian 笔记', whatFor: '读你的笔记库', specName: 'obsidian', needsEnv: ['OBSIDIAN_API_KEY'] },
    ])
  })

  it('displayName 缺席时模板 agent 名回落到 id', async () => {
    const inputs = await collectCatalogInputs({
      ...SOURCES,
      templateCards: () => [{ id: 't1', agents: [{ id: 'raw-id', capabilities: ['x'] }] }],
    })
    expect(inputs.presetTemplates?.[0]?.agents?.[0]?.name).toBe('raw-id')
  })

  it('单源抛错只丢那一角，其余源照常（目录宁缺一角不整体失败）', async () => {
    const inputs = await collectCatalogInputs({
      ...SOURCES,
      participants: () => {
        throw new Error('hub down')
      },
      inventory: async () => {
        throw new Error('probe timeout')
      },
    })
    expect(inputs.participants).toEqual([])
    expect(inputs.resources).toBeUndefined()
    // 其余源不受牵连
    expect(inputs.installedMcpServers).toHaveLength(1)
    expect(inputs.presetTemplates).toHaveLength(1)
  })
})

describe('createWorkflowWizard', () => {
  it('prepare 的目录文本真来自活源；existingWorkflowIds 抛错被吞', async () => {
    const wizard = createWorkflowWizard({
      assist: { assist: async () => ({ draftStatus: 'no_yaml', yaml: '', explanation: '?' }) },
      sources: SOURCES,
      existingWorkflowIds: async () => {
        throw new Error('list failed')
      },
    })
    const p = await wizard.prepare({ task: '合同审一遍', by: 'u1' })
    expect(p.catalogText).toContain('- writer [draft]')
    expect(p.catalogText).toContain('- alice [approve]')
    expect(p.catalogText).toContain('legal-pack')
    expect(p.catalogText).toContain('obsidian')
    // CLI 没找到（found:false）→ 诚实边界：不进目录
    expect(p.catalogText).not.toContain('Claude Code')
    // existingWorkflowIds 抛错不挡 compose（best-effort）
    const c = await wizard.compose({ task: '合同审一遍', by: 'u1' })
    expect(c.ok).toBe(false)
    if (!c.ok) expect(c.reason).toBe('needs_user') // fake 回 no_yaml——走到了 assist，说明没被 ids 失败绊住
  })
})
