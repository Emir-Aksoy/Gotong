/**
 * SEN-M1 — hub 红灯感知两张嘴:尾卡探针(纯读巡检牌面文件,失败/陈旧/空
 * 一律 null = prompt 字节不变)+ benign hub_health(与面板同一份快照,牌面
 * 判定复用 derivePatrolCards)。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HealthSnapshot } from '../src/admin-health.js'
import {
  PATROL_STATE_FRESH_MS,
  buildButlerHubSenseProbe,
  buildButlerHubHealthToolset,
  buildHubSenseCard,
  renderHubHealth,
} from '../src/personal-butler-hub-sense.js'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gotong-hub-sense-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function writeState(cards: Record<string, { severity: string; label: string; since: number }>): string {
  const file = join(root, 'patrol-state.json')
  writeFileSync(file, JSON.stringify({ cards }))
  return file
}

const RED = { severity: 'red', label: '空间目录不可写', since: 1 }
const Y1 = { severity: 'yellow', label: 'Agent「a」缺 API key', since: 1 }
const Y2 = { severity: 'yellow', label: 'MCP「m」未接线', since: 1 }
const Y3 = { severity: 'yellow', label: 'IM 通道全无', since: 1 }

describe('SEN-M1 — 尾卡探针(纯读巡检牌面)', () => {
  it('牌面文件不存在 → null(巡检没跑过/没接,无声)', async () => {
    const probe = buildButlerHubSenseProbe({ stateFile: join(root, 'nope.json') })
    expect(await probe()).toBeNull()
  })

  it('损坏 JSON → null(损坏当空,绝不炸对话)', async () => {
    const file = join(root, 'patrol-state.json')
    writeFileSync(file, '{oops')
    const probe = buildButlerHubSenseProbe({ stateFile: file })
    expect(await probe()).toBeNull()
  })

  it('空牌面 → null(一切正常不注入,prompt 字节不变)', async () => {
    const file = writeState({})
    const probe = buildButlerHubSenseProbe({ stateFile: file })
    expect(await probe()).toBeNull()
  })

  it('有红+黄牌 → 卡:红牌逐行点名、黄牌计数点前 2、带规则行', async () => {
    const file = writeState({ 'space:unwritable': RED, 'agent-key:a': Y1, 'mcp-unwired:m': Y2, 'im:none': Y3 })
    const probe = buildButlerHubSenseProbe({ stateFile: file })
    const card = await probe()
    expect(card).toContain('【hub 状态 · 系统注入】')
    expect(card).toContain('🔴 空间目录不可写')
    expect(card).toContain('🟡 3 项:')
    expect(card).toContain(' 等') // 黄牌 >2 → 点前 2 + 「等」
    expect(card).toContain('别把这卡说成用户说的话')
  })

  it('尾卡永不点名目录工具(指路指空原则,防文案漂移)', () => {
    const card = buildHubSenseCard([
      { severity: 'red', label: RED.label },
      { severity: 'yellow', label: Y1.label },
    ])
    expect(card).not.toContain('hub_health')
    expect(card).not.toContain('use_tool')
  })

  it('牌面文件陈旧(mtime 超 3× 巡检节律)→ null:巡检不在班,旧牌不当现状', async () => {
    const file = writeState({ 'space:unwritable': RED })
    const probe = buildButlerHubSenseProbe({
      stateFile: file,
      now: () => Date.now() + PATROL_STATE_FRESH_MS + 60_000,
    })
    expect(await probe()).toBeNull()
    // 同一份文件,新鲜时钟下照常出卡(证明 null 是新鲜门而非别的岔路)。
    const fresh = buildButlerHubSenseProbe({ stateFile: file })
    expect(await fresh()).toContain('🔴')
  })

  it('黄牌 ≤2 → 全点名不带「等」', async () => {
    const file = writeState({ 'agent-key:a': Y1 })
    const probe = buildButlerHubSenseProbe({ stateFile: file })
    const card = await probe()
    expect(card).toContain('🟡 1 项:Agent「a」缺 API key')
    expect(card).not.toContain(' 等')
  })
})

function snap(over: Partial<HealthSnapshot> = {}): HealthSnapshot {
  return {
    agents: [],
    agentsMissingKey: 0,
    managedCount: 0,
    onlineCount: 0,
    mcpServers: [],
    mcpUnwired: 0,
    spaceWritable: true,
    spacePath: join(root, 'space'),
    checkedAt: new Date(0).toISOString(),
    ...over,
  }
}

const NOW = 1_700_000_000_000

describe('SEN-M1 — renderHubHealth(纯投影,与面板同源)', () => {
  it('全绿:✅ 无问题牌 + 必有统计行;可选字段缺席 = 整行跳过(诚实未知)', () => {
    const text = renderHubHealth(snap(), NOW)
    expect(text).toContain('✅ 没有问题牌')
    expect(text).toContain('托管 agent 0 台')
    expect(text).toContain('MCP 服务 0 台')
    expect(text).toContain('空间目录:可写')
    expect(text).not.toContain('工作流')
    expect(text).not.toContain('IM 通道')
    expect(text).not.toContain('LLM 断供')
    expect(text).not.toContain('模型路由')
  })

  it('问题牌走 derivePatrolCards 同源 fact(空间不可写 → 红牌全文)', () => {
    const text = renderHubHealth(snap({ spaceWritable: false }), NOW)
    expect(text).toContain('🔴 空间目录写不进了')
    expect(text).toContain('空间目录:写不进')
    expect(text).not.toContain('✅')
  })

  it('缺 key agent → 黄牌 + 统计行计数', () => {
    const text = renderHubHealth(
      snap({
        agents: [{ id: 'a', provider: 'anthropic', missingKey: true, online: true }],
        agentsMissingKey: 1,
        managedCount: 1,
        onlineCount: 1,
      }),
      NOW,
    )
    expect(text).toContain('🟡 Agent「a」')
    expect(text).toContain('托管 agent 1 台:在线 1,缺 API key 1')
  })

  it('LLM 断供三态:null → 「无」;行 → 分钟数;未知病名印原码不炸', () => {
    expect(renderHubHealth(snap({ llmOutage: null }), NOW)).toContain('LLM 断供:无')
    const down = renderHubHealth(snap({ llmOutage: { kind: 'auth', since: NOW - 34 * 60_000 } }), NOW)
    expect(down).toContain('断供中约 34 分钟')
    const weird = renderHubHealth(snap({ llmOutage: { kind: 'martian', since: NOW - 60_000 } }), NOW)
    expect(weird).toContain('martian') // 未知 kind 如实印原码,渲染不炸
  })

  it('模型路由:[] → 全部健康;有行 → 计数 + 指路 list_my_llms(目录内互相点名)', () => {
    expect(renderHubHealth(snap({ routing: [] }), NOW)).toContain('模型路由:全部候选健康')
    const degraded = renderHubHealth(
      snap({
        routing: [
          { agentId: 'a', candidate: 'anthropic', index: 0, state: 'open', since: 1 },
          { agentId: 'a', candidate: 'openai-compatible:x', index: 1, state: 'degraded', since: 1 },
        ],
      }),
      NOW,
    )
    expect(degraded).toContain('2 个候选降级/熔断中')
    expect(degraded).toContain('list_my_llms')
  })

  it('IM 通道:[] → 「无(还没配)」;有 → 平台点名;工作流/run 计数行', () => {
    const text = renderHubHealth(
      snap({ imBridges: [{ platform: 'telegram' }], workflowCount: 5, publishedWorkflowCount: 4, runCount: 12 }),
      NOW,
    )
    expect(text).toContain('IM 通道:telegram')
    expect(text).toContain('工作流 5 条(可跑 4),运行记录 12 次')
    expect(renderHubHealth(snap({ imBridges: [] }), NOW)).toContain('IM 通道:无(还没配)')
  })
})

describe('SEN-M1 — hub_health 工具(惰性面 + 失败姿态)', () => {
  it('listTools 只有 hub_health;未知名 → isError', async () => {
    const ts = buildButlerHubHealthToolset({ health: () => undefined })
    expect(ts.listTools().map((t) => t.name)).toEqual(['hub_health'])
    const r = await ts.callTool('nope', {})
    expect(r.isError).toBe(true)
  })

  it('体检面未就绪 → 诚实话术 isError(装配早期不炸)', async () => {
    const ts = buildButlerHubHealthToolset({ health: () => undefined })
    const r = await ts.callTool('hub_health', {})
    expect(r.isError).toBe(true)
    expect(JSON.stringify(r.content)).toContain('还没就绪')
  })

  it('snapshot 抛错 → 失败话术 isError + warn(advisory 不连累对话)', async () => {
    const warns: string[] = []
    const ts = buildButlerHubHealthToolset({
      health: () => ({ snapshot: async () => { throw new Error('boom') } }),
      logger: { warn: (m) => void warns.push(m) },
    })
    const r = await ts.callTool('hub_health', {})
    expect(r.isError).toBe(true)
    expect(warns.length).toBe(1)
  })

  it('正常:返回与面板同源的体检卡', async () => {
    const ts = buildButlerHubHealthToolset({
      health: () => ({ snapshot: async () => snap({ spaceWritable: false }) }),
      now: () => NOW,
    })
    const r = await ts.callTool('hub_health', {})
    expect(r.isError).toBeUndefined()
    const text = JSON.stringify(r.content)
    expect(text).toContain('hub 体检(与管理面板同一份快照)')
    expect(text).toContain('空间目录写不进了')
  })
})
