/**
 * butler-onboarding — CARE-M4 开箱陪跑的单元面(纯派生 + 状态文件 + 探针 +
 * 活体校验闭包 + 工具集),零 LLM、零网络。
 *
 * 钉住的姿态:
 *   - 缺口判定继承 admin-health 的诚实阶梯:可选字段**缺席 = 未知 ≠ 缺口**
 *     (host 没接 IM 子系统时不许唠叨「去接 IM」);
 *   - onboarding-state 损坏当空(宁重不漏,同 patrol-state);
 *   - 探针的所有失败路径都归于 null——陪跑绝不拖垮正常聊天;
 *   - 缺口清零由探针自动写完成态,此后每回合止步于一次 state 读;
 *   - check_llm_key 失败走 CARE-M1 翻译表,不长第二张文案表。
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { AdminHealthSurface, HealthSnapshot } from '../src/admin-health.js'
import {
  buildButlerOnboardingProbe,
  buildButlerOnboardingToolset,
  buildOnboardingCard,
  buildOnboardingKeyCheck,
  deriveOnboardingGaps,
  readOnboardingState,
  writeOnboardingState,
  type OnboardingProbeTarget,
} from '../src/personal-butler-onboarding.js'

function snap(o: Partial<HealthSnapshot> = {}): HealthSnapshot {
  return {
    agents: [],
    agentsMissingKey: 0,
    managedCount: 1,
    onlineCount: 1,
    mcpServers: [],
    mcpUnwired: 0,
    spaceWritable: true,
    spacePath: '/tmp/x',
    checkedAt: '2026-07-06T00:00:00.000Z',
    ...o,
  }
}

describe('deriveOnboardingGaps — 诚实阶梯', () => {
  it('可选字段缺席 = 未知 ≠ 缺口(host 没接的子系统不唠叨)', () => {
    const g = deriveOnboardingGaps(snap()) // 无 imBridges / workflowCount 字段
    expect(g.noIm).toBe(false)
    expect(g.noTemplates).toBe(false)
    expect(g.noLlmKey).toBe(false)
    expect(g.any).toBe(false)
  })

  it('零托管 agent 或全员缺 key → key 缺口;有一行能解析就不算', () => {
    expect(deriveOnboardingGaps(snap({ managedCount: 0 })).noLlmKey).toBe(true)
    expect(deriveOnboardingGaps(snap({ managedCount: 2, agentsMissingKey: 2 })).noLlmKey).toBe(true)
    expect(deriveOnboardingGaps(snap({ managedCount: 2, agentsMissingKey: 1 })).noLlmKey).toBe(false)
  })

  it('接了但为空才是缺口(imBridges [] / workflowCount 0)', () => {
    const g = deriveOnboardingGaps(snap({ imBridges: [], workflowCount: 0 }))
    expect(g.noIm).toBe(true)
    expect(g.noTemplates).toBe(true)
    expect(deriveOnboardingGaps(snap({ imBridges: [{ platform: 'telegram' }], workflowCount: 3 })).any).toBe(false)
  })
})

describe('buildOnboardingCard — 现状卡只列真实缺口', () => {
  it('三缺口全在:卡含标记、三行缺口、编号剧本、两个工具名', () => {
    const s = snap({ managedCount: 1, agentsMissingKey: 1, imBridges: [], workflowCount: 0 })
    const card = buildOnboardingCard(deriveOnboardingGaps(s), s)
    expect(card).toContain('【现状卡 · 开箱陪跑】')
    expect(card).toContain('LLM key:0/1')
    expect(card).toContain('IM 通道')
    expect(card).toContain('工作流模板')
    expect(card).toContain('1. ')
    expect(card).toContain('3. ')
    expect(card).toContain('check_llm_key')
    expect(card).toContain('set_onboarding_done')
  })

  it('只缺 key:不提 IM / 模板的缺口行,剧本只有一关', () => {
    const s = snap({ managedCount: 1, agentsMissingKey: 1, imBridges: [{ platform: 'telegram' }], workflowCount: 2 })
    const card = buildOnboardingCard(deriveOnboardingGaps(s), s)
    expect(card).toContain('LLM key')
    expect(card).not.toContain('- IM 通道')
    expect(card).not.toContain('- 工作流模板')
    expect(card).toContain('1. ')
    expect(card).not.toContain('2. ')
  })
})

describe('onboarding-state 文件姿态', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'gotong-onb-state-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('缺失 / 损坏 / 形状不对 一律当「未完成」(null)', async () => {
    const f = join(root, 'butler', 'onboarding-state.json')
    expect(await readOnboardingState(f)).toBeNull()
    await writeOnboardingState(f, { done: true, reason: 'declined', at: 't' })
    await writeFile(f, 'not-json{{{', 'utf8')
    expect(await readOnboardingState(f)).toBeNull()
    await writeFile(f, JSON.stringify({ done: false, reason: 'declined', at: 't' }), 'utf8')
    expect(await readOnboardingState(f)).toBeNull()
  })

  it('写读回环', async () => {
    const f = join(root, 'butler', 'onboarding-state.json')
    await writeOnboardingState(f, { done: true, reason: 'gaps_cleared', at: '2026-07-06T01:00:00.000Z' })
    const s = await readOnboardingState(f)
    expect(s).toEqual({ done: true, reason: 'gaps_cleared', at: '2026-07-06T01:00:00.000Z' })
  })
})

describe('buildButlerOnboardingProbe — 注入判定全零 LLM', () => {
  let root: string
  let stateFile: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'gotong-onb-probe-'))
    stateFile = join(root, 'butler', 'onboarding-state.json')
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  function surfaceOf(holder: { snap: HealthSnapshot }, counter: { n: number }): AdminHealthSurface {
    return {
      async snapshot() {
        counter.n++
        return holder.snap
      },
    }
  }

  it('有缺口且未完成 → 注入现状卡;缺口在卡里', async () => {
    const holder = { snap: snap({ managedCount: 0, imBridges: [], workflowCount: 0 }) }
    const counter = { n: 0 }
    const probe = buildButlerOnboardingProbe({ stateFile, health: () => surfaceOf(holder, counter) })
    const card = await probe()
    expect(card).toContain('【现状卡')
    expect(counter.n).toBe(1)
  })

  it('已「不用了」→ null,连体检都不做(止步于 state 读)', async () => {
    await writeOnboardingState(stateFile, { done: true, reason: 'declined', at: 't' })
    const counter = { n: 0 }
    const holder = { snap: snap({ managedCount: 0 }) }
    const probe = buildButlerOnboardingProbe({ stateFile, health: () => surfaceOf(holder, counter) })
    expect(await probe()).toBeNull()
    expect(counter.n).toBe(0)
  })

  it('health 未接 / snapshot 抛错 → null(陪跑不拖垮聊天)', async () => {
    const noHealth = buildButlerOnboardingProbe({ stateFile, health: () => undefined })
    expect(await noHealth()).toBeNull()
    const sick: AdminHealthSurface = {
      async snapshot(): Promise<HealthSnapshot> {
        throw new Error('boom')
      },
    }
    const probe = buildButlerOnboardingProbe({ stateFile, health: () => sick })
    expect(await probe()).toBeNull()
  })

  it('缺口清零 → 自动写 gaps_cleared,之后回合止步于 state 读', async () => {
    const holder = { snap: snap({ managedCount: 1, agentsMissingKey: 0, imBridges: [{ platform: 'telegram' }], workflowCount: 2 }) }
    const counter = { n: 0 }
    const probe = buildButlerOnboardingProbe({
      stateFile,
      health: () => surfaceOf(holder, counter),
      now: () => Date.parse('2026-07-06T02:00:00.000Z'),
    })
    expect(await probe()).toBeNull()
    const state = JSON.parse(await readFile(stateFile, 'utf8')) as { reason: string }
    expect(state.reason).toBe('gaps_cleared')
    expect(await probe()).toBeNull()
    expect(counter.n).toBe(1) // 第二回合没再体检
  })
})

describe('buildOnboardingKeyCheck — 解析 → 只读探测', () => {
  const okTarget: OnboardingProbeTarget = {
    status: 'ok',
    agentId: 'helper',
    provider: 'deepseek',
    apiKey: 'sk-live-123456',
    baseURL: 'https://api.deepseek.com/v1',
  }

  it('目标解析非 ok(no_agent / mock / no_key)原样透传,不打探测', async () => {
    let probed = 0
    for (const t of [
      { status: 'no_agent' },
      { status: 'mock', agentId: 'demo' },
      { status: 'no_key', agentId: 'a', provider: 'openai' },
    ] as OnboardingProbeTarget[]) {
      const check = buildOnboardingKeyCheck({
        resolveTarget: async () => t,
        probe: async () => {
          probed++
          return { ok: true, modelCount: 1, latencyMs: 1 }
        },
      })
      expect((await check()).status).toBe(t.status)
    }
    expect(probed).toBe(0)
  })

  it('ok 目标 + 探测通过/失败 → ok(带模型数)/ fail(带原始错误)', async () => {
    const good = buildOnboardingKeyCheck({
      resolveTarget: async () => okTarget,
      probe: async (input) => {
        expect(input.baseURL).toBe('https://api.deepseek.com/v1')
        return { ok: true, modelCount: 7, latencyMs: 42 }
      },
    })
    const g = await good('helper')
    expect(g).toMatchObject({ status: 'ok', agentId: 'helper', provider: 'deepseek', modelCount: 7 })

    const bad = buildOnboardingKeyCheck({
      resolveTarget: async () => okTarget,
      probe: async () => ({ ok: false, error: { status: 401, message: 'nope' }, latencyMs: 5 }),
    })
    const b = await bad()
    expect(b.status).toBe('fail')
    if (b.status === 'fail') expect((b.error as { status: number }).status).toBe(401)
  })

  it('resolveTarget 抛错 → no_agent(不炸工具)', async () => {
    const check = buildOnboardingKeyCheck({
      resolveTarget: async () => {
        throw new Error('space busted')
      },
    })
    expect((await check()).status).toBe('no_agent')
  })
})

describe('buildButlerOnboardingToolset — 两个工具的口径', () => {
  let root: string
  let stateFile: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'gotong-onb-tools-'))
    stateFile = join(root, 'butler', 'onboarding-state.json')
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  function textOf(r: { content: { type: string; text?: string }[] }): string {
    return r.content.map((b) => b.text ?? '').join('')
  }

  it('set_onboarding_done → 写 declined + 友好确认', async () => {
    const t = buildButlerOnboardingToolset({ stateFile, keyCheck: () => undefined, lang: 'zh' })
    const r = await t.callTool('set_onboarding_done', {})
    expect(r.isError).toBeUndefined()
    expect(textOf(r)).toContain('记下了')
    const s = JSON.parse(await readFile(stateFile, 'utf8')) as { reason: string }
    expect(s.reason).toBe('declined')
  })

  it('check_llm_key:校验通道未就绪 → 诚实说等等(isError)', async () => {
    const t = buildButlerOnboardingToolset({ stateFile, keyCheck: () => undefined, lang: 'zh' })
    const r = await t.callTool('check_llm_key', {})
    expect(r.isError).toBe(true)
    expect(textOf(r)).toContain('还没就绪')
  })

  it('check_llm_key 失败 → CARE-M1 翻译文案(401 → 认证失败)', async () => {
    const t = buildButlerOnboardingToolset({
      stateFile,
      keyCheck: () => async () => ({
        status: 'fail',
        agentId: 'helper',
        provider: 'deepseek',
        error: { status: 401, message: 'Invalid API key' },
      }),
      lang: 'zh',
    })
    const r = await t.callTool('check_llm_key', { agentId: 'helper' })
    expect(r.isError).toBe(true)
    expect(textOf(r)).toContain('❌')
    expect(textOf(r)).toContain('认证失败')
    expect(textOf(r)).toContain('修复:')
  })

  it('check_llm_key 通过 → ✅ + 模型数 + 「没有消耗 token」', async () => {
    const t = buildButlerOnboardingToolset({
      stateFile,
      keyCheck: () => async () => ({
        status: 'ok',
        agentId: 'helper',
        provider: 'deepseek',
        modelCount: 5,
        latencyMs: 88,
      }),
      lang: 'zh',
    })
    const r = await t.callTool('check_llm_key', {})
    expect(r.isError).toBeUndefined()
    expect(textOf(r)).toContain('✅')
    expect(textOf(r)).toContain('5 个模型')
    expect(textOf(r)).toContain('没有消耗 token')
  })

  it('mock / no_key / no_agent 各有诚实答复', async () => {
    const make = (out: { status: 'mock'; agentId: string } | { status: 'no_key'; agentId: string; provider: string } | { status: 'no_agent' }) =>
      buildButlerOnboardingToolset({ stateFile, keyCheck: () => async () => out, lang: 'zh' })
    expect(textOf(await make({ status: 'mock', agentId: 'demo' }).callTool('check_llm_key', {}))).toContain('mock')
    expect(textOf(await make({ status: 'no_key', agentId: 'a', provider: 'openai' }).callTool('check_llm_key', {}))).toContain('还没有能解析到的 key')
    expect(textOf(await make({ status: 'no_agent' }).callTool('check_llm_key', {}))).toContain('还没有任何托管')
  })
})
